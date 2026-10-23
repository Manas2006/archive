// After a paper is saved: reviews, Semantic Scholar data, venue check, AI
// field extraction, project relevance, topic and inbox priority. Runs in the
// background from a persisted queue so a service-worker restart doesn't lose work.

import { aiProjectScores, extractFields, summarizeReviews } from './ai/features';
import * as repo from './repo';
import { aiAvailable, getSettings } from './settings';
import { fetchReviews } from './sources/openreview';
import { aliasesFromS2, canonicalFromS2, s2Get, s2MatchTitle, s2References, toS2Id, type S2Paper } from './sources/s2';
import { combineWithAi, decideFiling, heuristicScores } from './sorting/relevance';
import { computePriority } from './sorting/priority';
import { Corpus, paperDoc } from './sorting/tfidf';
import { assignTopic } from './topics';
import { checkVenue, type VenueUpgrade } from './venue';
import { nowIso } from './ids';
import type { Paper } from './types';

const QUEUE_KEY = 'enrichQueue';
const MAX_ATTEMPTS = 3;
interface QueueItem {
  id: string;
  attempts: number;
}
let draining = false;
// All queue reads and writes go through one chain so concurrent saves can't drop items.
let queueChain: Promise<unknown> = Promise.resolve();
function withQueue<T>(fn: (q: QueueItem[]) => Promise<[QueueItem[], T]> | [QueueItem[], T]): Promise<T> {
  const run = queueChain.then(async () => {
    const raw = ((await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] as (QueueItem | string)[] | undefined) ?? [];
    const q = raw.map((x) => (typeof x === 'string' ? { id: x, attempts: 0 } : x));
    const [next, out] = await fn(q);
    await chrome.storage.local.set({ [QUEUE_KEY]: next });
    return out;
  });
  queueChain = run.catch(() => undefined);
  return run;
}

export async function enqueueEnrich(paperId: string) {
  await withQueue((q) => [q.some((x) => x.id === paperId) ? q : [...q, { id: paperId, attempts: 0 }], null]);
  void drainQueue();
}

export async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      // claim the next item and count the attempt up front, so a paper whose enrichment
      // keeps getting the service worker killed is eventually dropped instead of blocking
      const item = await withQueue((q) => {
        const head = q.find((x) => x.attempts < MAX_ATTEMPTS);
        const rest = q.filter((x) => x.attempts < MAX_ATTEMPTS);
        if (!head) return [rest, null];
        return [rest.map((x) => (x.id === head.id ? { ...x, attempts: x.attempts + 1 } : x)), head];
      });
      if (!item) break;
      try {
        await enrichPaper(item.id);
      } catch (e) {
        console.warn('[archive] enrich failed for', item.id, e);
      }
      await withQueue((q) => [q.filter((x) => x.id !== item.id), null]);
    }
  } finally {
    draining = false;
  }
}

export type Notify = (u: VenueUpgrade) => void;
let notifier: Notify = () => {};
export function setVenueNotifier(n: Notify) {
  notifier = n;
}

const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

async function resolveS2(paper: Paper): Promise<S2Paper | null> {
  const direct = toS2Id(paper.id);
  if (direct) return s2Get(direct);
  for (const a of paper.aliases) {
    const id = toS2Id(a);
    if (id) {
      const r = await s2Get(id);
      if (r) return r;
    }
  }
  const m = await s2MatchTitle(paper.title);
  return m && normTitle(m.title ?? '') === normTitle(paper.title) ? m : null;
}

/** Merge S2 identifiers into the paper, without claiming ids another record owns. */
export async function applyS2(paper: Paper, s2: S2Paper): Promise<Paper> {
  const aliases = new Set(paper.aliases);
  for (const a of aliasesFromS2(s2)) {
    if (a === paper.id) continue;
    const owner = await repo.getPaper(a);
    if (!owner || owner.id === paper.id) aliases.add(a);
  }
  const patch: Partial<Paper> = {
    aliases: [...aliases],
    s2Id: s2.paperId,
    dblpKey: paper.dblpKey ?? s2.externalIds?.DBLP,
    s2: { ...(paper.s2 ?? { paperId: s2.paperId, checkedAt: nowIso() }), paperId: s2.paperId, citationCount: s2.citationCount, checkedAt: nowIso() },
  };
  if (!paper.arxivId && s2.externalIds?.ArXiv) patch.arxivId = s2.externalIds.ArXiv;
  if (!paper.abstract && s2.abstract) patch.abstract = s2.abstract;
  return (await repo.updatePaper(paper.id, patch)) ?? paper;
}

export async function enrichS2(paper: Paper, opts: { references?: boolean; embedding?: boolean } = {}): Promise<{ paper: Paper; s2: S2Paper | null }> {
  const s2 = await resolveS2(paper).catch(() => null);
  if (!s2) return { paper, s2: null };
  let p = await applyS2(paper, s2);
  if (opts.embedding !== false && !p.s2?.embedding) {
    const e = await s2Get(s2.paperId, 'paperId,embedding.specter_v2').catch(() => null);
    if (e?.embedding?.vector?.length) {
      p = (await repo.updatePaper(p.id, { s2: { ...p.s2!, embedding: e.embedding.vector } })) ?? p;
    }
  }
  if (opts.references !== false && !p.s2?.referenceIds) {
    const refs = await s2References(s2.paperId).catch(() => null);
    if (refs) {
      const ids = refs.flatMap((r) => [canonicalFromS2(r), `s2:${r.paperId}`]);
      p = (await repo.updatePaper(p.id, { s2: { ...p.s2!, referenceIds: [...new Set(ids)] } })) ?? p;
    }
  }
  return { paper: p, s2 };
}

export async function updateRelevance(paperId: string): Promise<void> {
  const s = await getSettings();
  const paper = await repo.getPaper(paperId);
  const entry = await repo.getEntry(paperId);
  if (!paper || !entry) return;
  const projects = await repo.listProjects();
  const entries = await repo.listEntries();
  const papers = new Map((await repo.getPapers(entries.map((e) => e.paperId))).map((p) => [p.id, p] as const));
  let scores = projects.length
    ? heuristicScores({ paper, projects, papers, entries, corpus: new Corpus([...papers.values()].map(paperDoc)) })
    : [];
  if (projects.length && aiAvailable(s)) {
    try {
      const seedTitles = new Map(
        projects.map((pr) => [pr.id, [...pr.seedPaperIds, ...entries.filter((e) => e.projectIds.includes(pr.id)).map((e) => e.paperId)].map((id) => papers.get(id)?.title ?? '').filter(Boolean)] as const),
      );
      scores = combineWithAi(scores, await aiProjectScores(paper, projects, seedTitles));
    } catch (e) {
      console.warn('[archive] AI relevance failed', e);
    }
  }
  // decide against the entry as it is *now* (the user may have filed it while we were scoring)
  await repo.updateEntry(paperId, (cur) => {
    const { auto, suggestions } = decideFiling(scores, cur, s.autoFileThreshold, s.suggestThreshold);
    return { projectIds: [...new Set([...cur.projectIds, ...auto])], suggestions };
  });
}

export async function updatePriorities(): Promise<void> {
  const s = await getSettings();
  const entries = await repo.listEntries();
  const papers = await repo.getPapers(entries.map((e) => e.paperId));
  const byId = new Map(papers.map((p) => [p.id, p] as const));
  const libraryIds = new Set<string>();
  for (const p of papers) {
    libraryIds.add(p.id);
    p.aliases.forEach((a) => libraryIds.add(a));
  }
  const projects = new Map((await repo.listProjects()).map((p) => [p.id, p] as const));
  for (const e of entries) {
    const p = byId.get(e.paperId);
    if (!p) continue;
    const { priority, reasons } = computePriority({ entry: e, paper: p, projects, libraryIds, followedAuthors: s.followedAuthors });
    if (priority !== e.priority || reasons.join('|') !== e.priorityReasons.join('|')) {
      await repo.updateEntry(e.paperId, { priority, priorityReasons: reasons });
    }
  }
}

export async function enrichPaper(paperId: string): Promise<void> {
  let paper = await repo.getPaper(paperId);
  if (!paper) return;
  const s = await getSettings();

  // 1. OpenReview scores and decision
  if (paper.openreviewId && !paper.review) {
    const review = await fetchReviews(paper.openreviewId, paper.venue ?? 'OpenReview').catch(() => null);
    if (review) paper = (await repo.updatePaper(paper.id, { review })) ?? paper;
  }

  // 2. Semantic Scholar: ids, embedding, references
  const { paper: p2, s2 } = await enrichS2(paper).catch(() => ({ paper: paper!, s2: null }));
  paper = p2;

  // 3. Venue upgrade
  if (paper.venueStatus !== 'accepted' || paper.bibtexSource === 'arxiv') {
    const up = await checkVenue(paper, s2).catch(() => null);
    if (up) {
      notifier(up);
      paper = (await repo.getPaper(paper.id)) ?? paper;
    }
  }

  // 4. AI: field extraction and review summary
  if (aiAvailable(s)) {
    if (!paper.extracted) {
      try {
        paper = (await repo.updatePaper(paper.id, { extracted: await extractFields(paper) })) ?? paper;
      } catch (e) {
        console.warn('[archive] extraction failed', e);
      }
    }
    if (paper.review?.digest && !paper.review.summary) {
      try {
        const summary = await summarizeReviews(paper);
        paper = (await repo.updatePaper(paper.id, { review: { ...paper.review, summary } })) ?? paper;
      } catch (e) {
        console.warn('[archive] review summary failed', e);
      }
    }
  }

  // 5. Sorting
  await updateRelevance(paper.id).catch((e) => console.warn('[archive] relevance failed', e));
  await assignTopic(paper.id).catch((e) => console.warn('[archive] topic failed', e));
  await updatePriorities().catch((e) => console.warn('[archive] priority failed', e));
}

/**
 * Re-score every saved paper against the current projects (heuristic only, no
 * API calls). Used when a project is created or edited and by the daily check.
 * Existing papers only get suggestions; automatic filing is for new saves.
 */
export async function rescoreLibrary(): Promise<number> {
  const s = await getSettings();
  const projects = await repo.listProjects();
  const entries = await repo.listEntries();
  if (!projects.length) return 0;
  const papers = new Map((await repo.getPapers(entries.map((e) => e.paperId))).map((p) => [p.id, p] as const));
  const corpus = new Corpus([...papers.values()].map(paperDoc));
  let changed = 0;
  for (const e of entries) {
    const p = papers.get(e.paperId);
    if (!p) continue;
    const scores = heuristicScores({ paper: p, projects, papers, entries, corpus });
    const { suggestions } = decideFiling(scores, e, Number.POSITIVE_INFINITY, s.suggestThreshold);
    if (JSON.stringify(suggestions) !== JSON.stringify(e.suggestions)) {
      await repo.updateEntry(e.paperId, (cur) => ({
        suggestions: suggestions.filter((x) => !cur.projectIds.includes(x.projectId) && !cur.dismissedProjectIds.includes(x.projectId)),
      }));
      changed++;
    }
  }
  return changed;
}
