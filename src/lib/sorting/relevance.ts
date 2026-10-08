// Project relevance: how well a paper fits each project. Uses Semantic Scholar
// SPECTER embeddings when available, TF-IDF otherwise, and (with AI on) a Claude rating.

import { Corpus, cosineDense, cosineSparse, paperDoc } from './tfidf';
import type { LibraryEntry, Paper, Project, ProjectSuggestion } from '../types';

export interface RelevanceInput {
  paper: Paper;
  projects: Project[];
  papers: Map<string, Paper>; // all papers, by id
  entries: LibraryEntry[];
  corpus?: Corpus;
}

const clamp = (x: number) => Math.max(0, Math.min(1, x));

export function projectMembers(project: Project, entries: LibraryEntry[], excludeId: string): string[] {
  const ids = new Set(project.seedPaperIds);
  for (const e of entries) if (e.projectIds.includes(project.id)) ids.add(e.paperId);
  ids.delete(excludeId);
  return [...ids];
}

export function heuristicScores({ paper, projects, papers, entries, corpus }: RelevanceInput): ProjectSuggestion[] {
  const c = corpus ?? new Corpus([...papers.values()].map(paperDoc));
  const pv = c.vector(paperDoc(paper));
  const out: ProjectSuggestion[] = [];
  for (const proj of projects) {
    const members = projectMembers(proj, entries, paper.id)
      .map((id) => papers.get(id))
      .filter((p): p is Paper => !!p);
    // lexical: compare against the project profile (description weighted up) and each member
    const profile = `${proj.name}. ${proj.description}. ${proj.description}. ${members.map((m) => m.title).join('. ')}`;
    const lexProfile = cosineSparse(pv, c.vector(profile));
    const lexMembers = members.length
      ? Math.max(...members.map((m) => cosineSparse(pv, c.vector(paperDoc(m)))))
      : 0;
    const lex = members.length ? Math.max(lexProfile, lexMembers) : lexProfile;
    const lexN = clamp(lex / (members.length ? 0.32 : 0.18));

    let score = lexN;
    const emb = paper.s2?.embedding;
    const memberEmb = members.map((m) => m.s2?.embedding).filter((e): e is number[] => !!e?.length);
    if (emb?.length && memberEmb.length) {
      const sims = memberEmb.map((e) => cosineDense(emb, e)).sort((a, b) => b - a);
      const top = sims.slice(0, 3);
      const sim = top.reduce((a, b) => a + b, 0) / top.length;
      const embN = clamp((sim - 0.72) / 0.2);
      score = 0.65 * embN + 0.35 * lexN;
    }
    out.push({ projectId: proj.id, score: Math.round(score * 1000) / 1000 });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function combineWithAi(h: ProjectSuggestion[], ai: Map<string, number>): ProjectSuggestion[] {
  return h
    .map((s) => (ai.has(s.projectId) ? { ...s, score: Math.round((0.4 * s.score + 0.6 * ai.get(s.projectId)!) * 1000) / 1000 } : s))
    .sort((a, b) => b.score - a.score);
}

/** Split scores into auto-filed project ids and suggestions. */
export function decideFiling(scores: ProjectSuggestion[], entry: LibraryEntry, autoThreshold: number, suggestThreshold: number) {
  const auto: string[] = [];
  const suggestions: ProjectSuggestion[] = [];
  for (const s of scores) {
    if (entry.projectIds.includes(s.projectId) || entry.dismissedProjectIds.includes(s.projectId)) continue;
    if (s.score >= autoThreshold) auto.push(s.projectId);
    else if (s.score >= suggestThreshold) suggestions.push(s);
  }
  return { auto, suggestions };
}
