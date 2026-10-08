// Topic clustering: spherical k-means over SPECTER embeddings (or TF-IDF vectors
// when embeddings are missing), deterministic so topics don't reshuffle on every run.

import { addSparse, Corpus, cosineDense, cosineSparse, normalizeSparse, paperDoc, topTerms, type SparseVec } from './tfidf';
import type { Paper } from '../types';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export function chooseK(n: number): number {
  if (n < 6) return 1;
  return Math.max(2, Math.min(12, Math.round(Math.sqrt(n / 1.6))));
}

type Space<V> = { sim: (a: V, b: V) => number; mean: (vs: V[]) => V };

const denseSpace: Space<number[]> = {
  sim: cosineDense,
  mean: (vs) => {
    const d = vs[0].length;
    const m = new Array(d).fill(0);
    for (const v of vs) for (let i = 0; i < d; i++) m[i] += v[i];
    const n = Math.sqrt(m.reduce((a, x) => a + x * x, 0)) || 1;
    return m.map((x) => x / n);
  },
};

const sparseSpace: Space<SparseVec> = {
  sim: cosineSparse,
  mean: (vs) => {
    const acc: SparseVec = new Map();
    for (const v of vs) addSparse(acc, v);
    return normalizeSparse(acc);
  },
};

function kmeans<V>(vecs: V[], k: number, space: Space<V>, seed = 7): number[] {
  const n = vecs.length;
  const rand = rng(seed);
  // k-means++ init
  const centers: V[] = [vecs[Math.floor(rand() * n)]];
  while (centers.length < k) {
    const d = vecs.map((v) => 1 - Math.max(...centers.map((c) => space.sim(v, c))));
    const total = d.reduce((a, b) => a + Math.max(0, b) ** 2, 0);
    let r = rand() * total;
    let idx = 0;
    for (; idx < n - 1; idx++) {
      r -= Math.max(0, d[idx]) ** 2;
      if (r <= 0) break;
    }
    centers.push(vecs[idx]);
  }
  let assign = new Array(n).fill(0);
  for (let iter = 0; iter < 40; iter++) {
    const next = vecs.map((v) => {
      let best = 0;
      let bs = -Infinity;
      centers.forEach((c, j) => {
        const s = space.sim(v, c);
        if (s > bs) {
          bs = s;
          best = j;
        }
      });
      return best;
    });
    const changed = next.some((a, i) => a !== assign[i]);
    assign = next;
    for (let j = 0; j < k; j++) {
      const members = vecs.filter((_, i) => assign[i] === j);
      if (members.length) centers[j] = space.mean(members);
    }
    if (!changed && iter > 0) break;
  }
  return assign;
}

export interface ClusterResult {
  groups: { paperIds: string[]; keywords: string[] }[];
  space: 'embedding' | 'tfidf';
}

export function clusterPapers(papers: Paper[], corpus?: Corpus): ClusterResult {
  if (!papers.length) return { groups: [], space: 'tfidf' };
  const c = corpus ?? new Corpus(papers.map(paperDoc));
  const sparse = papers.map((p) => c.vector(paperDoc(p)));
  const k = Math.min(chooseK(papers.length), papers.length);
  const withEmb = papers.filter((p) => p.s2?.embedding?.length).length;
  let assign: number[];
  let space: ClusterResult['space'];
  if (withEmb === papers.length && k > 1) {
    assign = kmeans(papers.map((p) => p.s2!.embedding!), k, denseSpace);
    space = 'embedding';
  } else {
    assign = k > 1 ? kmeans(sparse, k, sparseSpace) : papers.map(() => 0);
    space = 'tfidf';
  }
  const groups: ClusterResult['groups'] = [];
  for (let j = 0; j < k; j++) {
    const idx = assign.map((a, i) => (a === j ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) continue;
    groups.push({ paperIds: idx.map((i) => papers[i].id), keywords: topTerms(idx.map((i) => sparse[i]), 3) });
  }
  return { groups, space };
}

/** Best existing topic for one paper, by mean similarity to each topic's members. */
export function nearestTopic(
  paper: Paper,
  topics: { id: string; memberIds: string[] }[],
  papers: Map<string, Paper>,
  corpus: Corpus,
): { topicId: string; sim: number } | null {
  let best: { topicId: string; sim: number } | null = null;
  const pv = corpus.vector(paperDoc(paper));
  for (const t of topics) {
    const members = t.memberIds.map((id) => papers.get(id)).filter((p): p is Paper => !!p && p.id !== paper.id);
    if (!members.length) continue;
    let sims: number[];
    let threshold: number;
    if (paper.s2?.embedding && members.every((m) => m.s2?.embedding)) {
      sims = members.map((m) => cosineDense(paper.s2!.embedding!, m.s2!.embedding!));
      threshold = 0.78;
    } else {
      sims = members.map((m) => cosineSparse(pv, corpus.vector(paperDoc(m))));
      threshold = 0.08;
    }
    const top = sims.sort((a, b) => b - a).slice(0, 3);
    const sim = top.reduce((a, b) => a + b, 0) / top.length;
    if (sim >= threshold && (!best || sim / threshold > best.sim)) best = { topicId: t.id, sim: sim / threshold };
  }
  return best;
}

export function overlap(a: string[], b: string[]): number {
  const A = new Set(a);
  const inter = b.filter((x) => A.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
}
