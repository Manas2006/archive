// The "For you" feed. The daily check looks for new papers by followed authors
// and for papers Semantic Scholar recommends for each project; the extension
// also searches fresh arXiv submissions that fit a project. Candidates stay out
// of the library until the user saves one.

import { toAuthor } from './bibtex';
import { buildS2Paper, savePaper } from './capture';
import { emitChange } from './changes';
import { db } from './db';
import { mergeAuthorIds, resolveFollow } from './follows';
import { arxivUrls, normalizeDoi, nowIso } from './ids';
import { isWebApp } from './platform';
import * as repo from './repo';
import { getSettings } from './settings';
import { searchArxivRecent, type ArxivMeta } from './sources/arxiv';
import { aliasesFromS2, canonicalFromS2, s2AuthorPapers, s2Embeddings, s2Get, s2Recommendations, s2Venue, type S2Paper } from './sources/s2';
import { heuristicScores } from './sorting/relevance';
import { Corpus, paperDoc, topTerms } from './sorting/tfidf';
import { shortVenue } from './venue';
import type { Author, FeedItem, FeedReason, LibraryEntry, Paper, Project } from './types';

export interface FeedReport {
  added: number;
  byAuthor: number; // new items found through followed authors
  byProject: number; // new items found for projects
  errors: string[];
}

const DAY_MS = 86_400_000;
const FIRST_CHECK_DAYS = 30; // first look at an author covers the last 30 days
const OVERLAP_DAYS = 3; // later looks start a few days before the last one (S2 indexes late)
const ARXIV_FRESH_DAYS = 7;
const PRUNE_DAYS = 60; // unread suggestions older than this are dropped
export const PER_PROJECT = 5; // project suggestions per project per run (S2 and arXiv together)
const MAX_FOLLOWS_PER_RUN = 40; // least recently checked first; the rest wait for the next run
const MAX_POSITIVE = 20;
const MAX_NEGATIVE = 50;
const REC_LIMIT = 30;
const ARXIV_MAX = 50;
const LEXICAL_MARGIN = 0.15; // arXiv papers scored on words alone need this much more
const MAX_FAILURES = 3; // consecutive author failures before giving up for this run (likely rate limited)

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const round = (x: number) => Math.round(x * 1000) / 1000;

function yearOf(iso?: string | null): number | null {
  if (!iso) return null;
  const y = new Date(iso).getUTCFullYear();
  return Number.isFinite(y) ? y : null;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

interface Candidate {
  ids: Set<string>; // every id we know: arxiv:, doi:, s2:
  title: string;
  authors: Author[];
  abstract: string;
  year: number | null;
  published: string | null;
  venue: string | null;
  arxivId?: string;
  s2Id?: string;
  doi?: string;
  embedding?: number[];
  authorReasons: FeedReason[];
  projectReasons: FeedReason[];
  found: Map<string, 's2' | 'arxiv'>; // project id → which search found it
}

const canonicalOf = (c: Candidate) => (c.arxivId ? `arxiv:${c.arxivId}` : c.doi ? `doi:${c.doi}` : `s2:${c.s2Id}`);

function fromS2(p: S2Paper): Candidate | null {
  if (!p?.paperId || !p.title) return null;
  const doi = p.externalIds?.DOI ? normalizeDoi(p.externalIds.DOI) : undefined;
  const year = p.year ?? yearOf(p.publicationDate);
  return {
    ids: new Set([canonicalFromS2(p), ...aliasesFromS2(p)]),
    title: p.title,
    authors: (p.authors ?? []).map((a) => ({ ...toAuthor(a.name), ...(a.authorId ? { s2Id: a.authorId } : {}) })),
    abstract: p.abstract ?? '',
    year,
    published: p.publicationDate ?? null,
    venue: shortVenue(s2Venue(p), year, p.publicationVenue?.alternate_names ?? []),
    arxivId: p.externalIds?.ArXiv,
    s2Id: p.paperId,
    doi,
    embedding: p.embedding?.vector?.length ? p.embedding.vector : undefined,
    authorReasons: [],
    projectReasons: [],
    found: new Map(),
  };
}

function fromArxiv(m: ArxivMeta): Candidate {
  const doi = m.doi ? normalizeDoi(m.doi) : undefined;
  return {
    ids: new Set([`arxiv:${m.id}`, ...(doi ? [`doi:${doi}`] : [])]),
    title: m.title,
    authors: m.authors.map(toAuthor),
    abstract: m.abstract,
    year: yearOf(m.published),
    published: m.published || null,
    venue: null,
    arxivId: m.id,
    doi,
    authorReasons: [],
    projectReasons: [],
    found: new Map(),
  };
}

/** Candidates from every source, merged when two sources return the same paper. */
class Pool {
  private byId = new Map<string, Candidate>();
  readonly list: Candidate[] = [];

  add(c: Candidate): Candidate {
    const cur = [...c.ids].map((id) => this.byId.get(id)).find(Boolean);
    if (!cur) {
      this.list.push(c);
      for (const id of c.ids) this.byId.set(id, c);
      return c;
    }
    for (const id of c.ids) {
      cur.ids.add(id);
      this.byId.set(id, cur);
    }
    cur.arxivId ??= c.arxivId;
    cur.s2Id ??= c.s2Id;
    cur.doi ??= c.doi;
    cur.embedding ??= c.embedding;
    cur.published ??= c.published;
    cur.venue ??= c.venue;
    cur.year ??= c.year;
    if (!cur.abstract && c.abstract) cur.abstract = c.abstract;
    // S2 author lists carry author ids
    if (c.authors.some((a) => a.s2Id) && !cur.authors.some((a) => a.s2Id)) cur.authors = c.authors;
    for (const r of c.authorReasons) {
      if (r.kind === 'author' && !cur.authorReasons.some((x) => x.kind === 'author' && x.followId === r.followId)) cur.authorReasons.push(r);
    }
    for (const [pid, src] of c.found) if (!cur.found.has(pid)) cur.found.set(pid, src);
    return cur;
  }
}

/** What the user has already seen: library papers (removed ones too) and feed items. */
interface Known {
  library: Set<string>;
  feed: Map<string, FeedItem>; // by every id of the item, soft-deleted (pruned) ones included
}

function feedItemIds(it: Pick<FeedItem, 'id' | 's2Id' | 'arxivId' | 'doi'>): string[] {
  const out = [it.id];
  if (it.s2Id) out.push(`s2:${it.s2Id}`);
  if (it.arxivId) out.push(`arxiv:${it.arxivId}`);
  if (it.doi) out.push(`doi:${normalizeDoi(it.doi)}`);
  return out;
}

async function loadKnown(): Promise<Known> {
  const d = db();
  const rows = await d.library.toArray();
  const papers = await repo.getPapers(rows.map((r) => r.paperId));
  const library = new Set<string>();
  for (const p of papers) {
    library.add(p.id);
    p.aliases.forEach((a) => library.add(a));
    if (p.s2Id) library.add(`s2:${p.s2Id}`);
    if (p.s2?.paperId) library.add(`s2:${p.s2.paperId}`);
    if (p.arxivId) library.add(`arxiv:${p.arxivId}`);
    if (p.doi) library.add(`doi:${normalizeDoi(p.doi)}`);
  }
  const feed = new Map<string, FeedItem>();
  for (const it of await d.feed.toArray()) for (const id of feedItemIds(it)) if (!feed.has(id) || !it.deletedAt) feed.set(id, it);
  return { library, feed };
}

const existingItem = (c: Candidate, k: Known) => [...c.ids].map((id) => k.feed.get(id)).find(Boolean);

/** In the library, or a feed item the user saved, dismissed or let expire. */
function seen(c: Candidate, k: Known): boolean {
  if ([...c.ids].some((id) => k.library.has(id))) return true;
  const it = existingItem(c, k);
  return !!it && (!!it.deletedAt || it.status !== 'new');
}

function asPaper(c: Candidate): Paper {
  return {
    id: canonicalOf(c),
    aliases: [...c.ids],
    title: c.title,
    abstract: c.abstract,
    authors: c.authors,
    year: c.year,
    s2: c.embedding ? { paperId: c.s2Id ?? '', embedding: c.embedding, checkedAt: '' } : undefined,
  } as Paper;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

function isRecent(p: S2Paper, since: number, first: boolean, now: number): boolean {
  if (p.publicationDate) {
    const t = Date.parse(p.publicationDate);
    return Number.isFinite(t) && t >= since;
  }
  if (!p.year) return false;
  const thisYear = new Date(now).getUTCFullYear();
  return first ? p.year === thisYear : p.year >= new Date(since).getUTCFullYear() && p.year <= thisYear;
}

async function collectAuthors(pool: Pool, known: Known, report: FeedReport, now: number) {
  const follows = (await repo.listFollows()).sort((a, b) => (a.lastCheckedAt ?? '').localeCompare(b.lastCheckedAt ?? ''));
  const stamp = new Date(now).toISOString();
  let failures = 0;
  for (const f0 of follows.slice(0, MAX_FOLLOWS_PER_RUN)) {
    if (failures >= MAX_FAILURES) {
      report.errors.push('Semantic Scholar is not answering; the remaining authors wait for the next check');
      break;
    }
    let f = f0;
    try {
      if (!f.s2AuthorId) {
        f = await resolveFollow(f);
        if (!f.s2AuthorId) {
          // no profile with this name yet: move it to the back of the queue
          await repo.updateFollow(f.id, { lastCheckedAt: stamp });
          failures = 0;
          continue;
        }
      }
      const first = !f.lastCheckedAt;
      const since = first ? now - FIRST_CHECK_DAYS * DAY_MS : Date.parse(f.lastCheckedAt!) - OVERLAP_DAYS * DAY_MS;
      const papers = await s2AuthorPapers(f.s2AuthorId, { limit: 100 });
      failures = 0;
      for (const p of papers) {
        if (!isRecent(p, since, first, now)) continue;
        const c = fromS2(p);
        if (!c || seen(c, known)) continue;
        c.authorReasons.push({ kind: 'author', followId: f.id, name: f.name });
        pool.add(c);
      }
      await repo.updateFollow(f.id, { lastCheckedAt: stamp });
    } catch (e) {
      failures++;
      report.errors.push(`author ${f.name}: ${msg(e)}`);
    }
  }
}

interface Library {
  projects: Project[];
  entries: LibraryEntry[];
  papers: Map<string, Paper>;
  corpus: Corpus;
  members: Map<string, Paper[]>; // project id → member papers, seeds first, then newest
}

async function loadLibrary(): Promise<Library> {
  const projects = await repo.listProjects();
  const entries = await repo.listEntries();
  const ids = new Set([...entries.map((e) => e.paperId), ...projects.flatMap((p) => p.seedPaperIds)]);
  const papers = new Map((await repo.getPapers([...ids])).filter((p) => !p.deletedAt).map((p) => [p.id, p] as const));
  const corpus = new Corpus([...papers.values()].map(paperDoc));
  const members = new Map<string, Paper[]>();
  for (const proj of projects) {
    const filed = entries
      .filter((e) => e.projectIds.includes(proj.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((e) => e.paperId);
    const list = [...new Set([...proj.seedPaperIds, ...filed])].map((id) => papers.get(id)).filter((p): p is Paper => !!p);
    members.set(proj.id, list);
  }
  return { projects, entries, papers, corpus, members };
}

async function collectRecommendations(pool: Pool, known: Known, lib: Library, report: FeedReport) {
  const dismissed = [...new Map([...known.feed.values()].map((it) => [it.id, it] as const)).values()]
    .filter((it) => it.status === 'dismissed' && it.s2Id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_NEGATIVE)
    .map((it) => it.s2Id!);
  for (const proj of lib.projects) {
    const positive = [...new Set(lib.members.get(proj.id)!.map((m) => m.s2Id ?? m.s2?.paperId).filter((x): x is string => !!x))].slice(0, MAX_POSITIVE);
    if (!positive.length) continue;
    try {
      for (const p of await s2Recommendations(positive, dismissed, REC_LIMIT)) {
        const c = fromS2(p);
        if (!c || seen(c, known)) continue;
        c.found.set(proj.id, 's2');
        pool.add(c);
      }
    } catch (e) {
      report.errors.push(`recommendations for ${proj.name}: ${msg(e)}`);
    }
  }
}

function dominantCategory(papers: Paper[]): string | null {
  const counts = new Map<string, number>();
  for (const p of papers) if (p.primaryCategory) counts.set(p.primaryCategory, (counts.get(p.primaryCategory) ?? 0) + 1);
  let best: string | null = null;
  for (const [cat, n] of counts) if (!best || n > counts.get(best)!) best = cat;
  return best;
}

async function collectArxiv(pool: Pool, known: Known, lib: Library, report: FeedReport, now: number) {
  const cutoff = now - ARXIV_FRESH_DAYS * DAY_MS;
  for (const proj of lib.projects) {
    const members = lib.members.get(proj.id)!;
    const cat = dominantCategory(members);
    if (!cat) continue;
    const group = members.map((m) => lib.corpus.vector(paperDoc(m)));
    if (proj.description.trim()) group.push(lib.corpus.vector(`${proj.name}. ${proj.description}`));
    const terms = topTerms(group, 4);
    if (!terms.length) continue;
    try {
      for (const m of await searchArxivRecent(cat, terms, ARXIV_MAX)) {
        const t = Date.parse(m.published);
        if (!Number.isFinite(t) || t < cutoff) continue;
        const c = fromArxiv(m);
        if (seen(c, known)) continue;
        c.found.set(proj.id, 'arxiv');
        pool.add(c);
      }
    } catch (e) {
      report.errors.push(`arXiv search for ${proj.name}: ${msg(e)}`);
      break; // arXiv is down or blocking us; don't wait on it once per project
    }
  }
}

/** One batch call for the embeddings S2 has. Very new arXiv papers often have none yet. */
async function addEmbeddings(cands: Candidate[], report: FeedReport) {
  const want = cands
    .filter((c) => !c.embedding)
    .map((c) => ({ c, id: c.s2Id ?? (c.arxivId ? `arXiv:${c.arxivId}` : null) }))
    .filter((x): x is { c: Candidate; id: string } => !!x.id);
  if (!want.length) return;
  try {
    const vectors = await s2Embeddings([...new Set(want.map((x) => x.id))]);
    for (const { c, id } of want) c.embedding = vectors.get(id) ?? c.embedding;
  } catch (e) {
    report.errors.push(`embeddings: ${msg(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/** Soft-delete unread suggestions older than PRUNE_DAYS, logged like repo writes. */
async function pruneFeed(now: number): Promise<number> {
  const d = db();
  const cutoff = new Date(now - PRUNE_DAYS * DAY_MS).toISOString();
  const keys: string[] = [];
  await d.transaction('rw', d.feed, d.changes, async () => {
    const at = nowIso();
    for (const it of await d.feed.where('foundAt').below(cutoff).toArray()) {
      if (it.deletedAt || it.status !== 'new') continue;
      await d.feed.put({ ...it, deletedAt: at, updatedAt: at });
      await d.changes.add({ table: 'feed', key: it.id, op: 'delete', at, synced: 0 });
      keys.push(it.id);
    }
  });
  if (keys.length) emitChange({ table: 'feed', keys, paperIds: [] });
  return keys.length;
}

function urlsFor(c: Candidate): FeedItem['urls'] {
  const u: FeedItem['urls'] = {};
  if (c.arxivId) {
    const a = arxivUrls(c.arxivId);
    u.abs = a.abs;
    u.pdf = a.pdf;
  } else if (c.doi) u.abs = `https://doi.org/${c.doi}`;
  if (c.s2Id) u.s2 = `https://www.semanticscholar.org/paper/${c.s2Id}`;
  return u;
}

/**
 * Look for new papers by followed authors and for each project, and add them
 * to the "For you" feed. Skips papers already in the library and suggestions
 * the user saved or dismissed. `force` runs even when the feed is turned off.
 */
export async function refreshFeed(opts: { force?: boolean } = {}): Promise<FeedReport> {
  const report: FeedReport = { added: 0, byAuthor: 0, byProject: 0, errors: [] };
  const s = await getSettings();
  if (!s.feedEnabled && !opts.force) return report;
  const now = Date.now();
  await pruneFeed(now).catch((e) => report.errors.push(`cleanup: ${msg(e)}`));

  const known = await loadKnown();
  const pool = new Pool();
  await collectAuthors(pool, known, report, now);
  const lib = await loadLibrary();
  if (lib.projects.length) {
    await collectRecommendations(pool, known, lib, report);
    if (!isWebApp()) await collectArxiv(pool, known, lib, report, now);
  }

  const cands = pool.list.filter((c) => !seen(c, known));
  if (lib.projects.length) await addEmbeddings(cands, report);

  // score every candidate against every project
  const fit = new Map<Candidate, Map<string, number>>();
  for (const c of cands) {
    const scores = lib.projects.length
      ? heuristicScores({ paper: asPaper(c), projects: lib.projects, papers: lib.papers, entries: lib.entries, corpus: lib.corpus })
      : [];
    fit.set(c, new Map(scores.map((x) => [x.projectId, x.score] as const)));
  }

  // project suggestions: above the threshold, best first, capped per project
  const threshold = s.suggestThreshold * 0.9;
  for (const proj of lib.projects) {
    const picks = cands
      .filter((c) => c.found.has(proj.id))
      .filter((c) => {
        // already suggested for this project in an earlier run
        const it = existingItem(c, known);
        return !it?.reasons.some((r) => r.kind === 'project' && r.projectId === proj.id);
      })
      .map((c) => ({ c, score: fit.get(c)?.get(proj.id) ?? 0 }))
      .filter(({ c, score }) => score >= (c.found.get(proj.id) === 'arxiv' && !c.embedding ? threshold + LEXICAL_MARGIN : threshold))
      .sort((a, b) => b.score - a.score)
      .slice(0, PER_PROJECT);
    for (const { c, score } of picks) c.projectReasons.push({ kind: 'project', projectId: proj.id, score: round(score) });
  }

  const items: FeedItem[] = [];
  const fresh = new Map<string, FeedItem>();
  for (const c of cands) {
    const reasons = [...c.authorReasons, ...c.projectReasons];
    if (!reasons.length) continue;
    const best = Math.max(0, ...(fit.get(c)?.values() ?? []));
    let score = c.authorReasons.length ? (lib.projects.length ? 0.6 + 0.4 * best : 0.7) : 0;
    for (const r of c.projectReasons) if (r.kind === 'project') score = Math.max(score, r.score);
    const existing = existingItem(c, known);
    const item: FeedItem = {
      ...(await repo.newMeta()),
      id: existing?.id ?? canonicalOf(c),
      title: c.title,
      authors: c.authors,
      abstract: c.abstract,
      year: c.year,
      published: c.published,
      venue: c.venue,
      ...(c.arxivId ? { arxivId: c.arxivId } : {}),
      ...(c.s2Id ? { s2Id: c.s2Id } : {}),
      ...(c.doi ? { doi: c.doi } : {}),
      urls: urlsFor(c),
      reasons,
      score: round(score),
      status: 'new',
      foundAt: nowIso(),
      ...(c.embedding ? { embedding: c.embedding } : {}),
    };
    items.push(item);
    if (!existing) {
      const prev = fresh.get(item.id);
      fresh.set(item.id, prev ? { ...prev, reasons: [...prev.reasons, ...item.reasons] } : item);
    }
  }
  if (items.length) {
    try {
      report.added = await repo.addFeedItems(items);
    } catch (e) {
      report.errors.push(`saving suggestions: ${msg(e)}`);
      return report;
    }
  }
  for (const it of fresh.values()) {
    if (it.reasons.some((r) => r.kind === 'author')) report.byAuthor++;
    if (it.reasons.some((r) => r.kind === 'project')) report.byProject++;
  }
  return report;
}

// ---------------------------------------------------------------------------
// Acting on suggestions
// ---------------------------------------------------------------------------

function s2FromItem(it: FeedItem): S2Paper {
  return {
    paperId: it.s2Id ?? it.id.replace(/^s2:/, ''),
    externalIds: { ...(it.arxivId ? { ArXiv: it.arxivId } : {}), ...(it.doi ? { DOI: it.doi } : {}) },
    title: it.title,
    abstract: it.abstract,
    year: it.year,
    publicationDate: it.published,
    venue: it.venue,
    authors: it.authors.map((a) => ({ name: a.name, authorId: a.s2Id ?? null })),
  };
}

/**
 * Save a suggestion into the library and mark it saved. Returns the paper id.
 * The caller starts enrichment (enqueueEnrich).
 */
export async function saveFeedItem(id: string): Promise<string> {
  const it = await repo.getFeedItem(id);
  if (!it) throw new Error('This paper is no longer in For you.');
  const pageMeta = { title: it.title, authors: it.authors.map((a) => a.name), abstract: it.abstract, published: it.published ?? undefined };
  const findSaved = async (ids: string[]) => {
    for (const x of ids) {
      const p = await repo.getPaper(x);
      if (p) return p;
    }
    return undefined;
  };

  let paperId: string;
  const existing = await findSaved(feedItemIds(it));
  if (existing) paperId = (await savePaper({ paperId: existing.id })).paper.id;
  else if (it.arxivId) paperId = (await savePaper({ paperId: `arxiv:${it.arxivId}`, pageMeta })).paper.id;
  else {
    const s2 = (it.s2Id ? await s2Get(it.s2Id).catch(() => null) : null) ?? s2FromItem(it);
    const again = await findSaved([canonicalFromS2(s2), ...aliasesFromS2(s2)]);
    if (again) paperId = (await savePaper({ paperId: again.id })).paper.id;
    else if (s2.externalIds?.ArXiv) paperId = (await savePaper({ paperId: `arxiv:${s2.externalIds.ArXiv}`, pageMeta })).paper.id;
    else {
      const paper = await repo.putPaper(await buildS2Paper(s2));
      await repo.ensureEntry(paper.id);
      paperId = paper.id;
    }
  }

  // keep the S2 author ids the suggestion already had
  const ids = it.authors.map((a) => ({ name: a.name, authorId: a.s2Id ?? null }));
  const saved = await repo.getPaper(paperId);
  if (saved && ids.some((a) => a.authorId) && mergeAuthorIds(saved.authors, ids)) {
    await repo.updatePaper(paperId, (cur) => ({ authors: mergeAuthorIds(cur.authors, ids) ?? cur.authors }));
  }
  await repo.setFeedStatus(id, 'saved');
  return paperId;
}

export async function dismissFeedItem(id: string): Promise<void> {
  await repo.setFeedStatus(id, 'dismissed');
}
