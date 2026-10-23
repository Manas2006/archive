import { fetchJson, HttpError, sleep, spacer, type FetchOpts } from '../net';
import { getSettings } from '../settings';
import { normalizeDoi } from '../ids';

const BASE = 'https://api.semanticscholar.org/graph/v1';
const RECS = 'https://api.semanticscholar.org/recommendations/v1';

export interface S2Paper {
  paperId: string;
  externalIds?: { ArXiv?: string; DOI?: string; DBLP?: string; CorpusId?: number; ACL?: string };
  title?: string;
  abstract?: string | null;
  venue?: string | null;
  publicationVenue?: { name?: string; type?: string; alternate_names?: string[] } | null;
  journal?: { name?: string; volume?: string; pages?: string } | null;
  year?: number | null;
  publicationDate?: string | null;
  /** The `authors` field always carries `authorId` (null for authors S2 hasn't matched to a profile). */
  authors?: { name: string; authorId?: string | null }[];
  citationCount?: number;
  embedding?: { model: string; vector: number[] } | null;
  publicationTypes?: string[] | null;
}

export interface S2AuthorHit {
  authorId: string;
  name: string;
  affiliations?: string[];
  paperCount?: number;
  hIndex?: number;
}

export const S2_FIELDS =
  'paperId,externalIds,title,abstract,venue,publicationVenue,journal,year,publicationDate,authors,citationCount,publicationTypes';

/** Fields for feed candidates (author papers and recommendations). */
export const S2_FEED_FIELDS = 'paperId,externalIds,title,abstract,authors,year,publicationDate,venue,publicationVenue';

// Without a key, S2 shares one rate limit across all anonymous clients and answers
// bursts with 429s (which in the web app arrive as CORS TypeErrors). Space calls out.
const NO_KEY_GAP_MS = 1100;
const KEY_GAP_MS = 0;
let gapOverride: number | null = null;
const waitTurn = spacer();

/** For tests: force the gap between S2 calls (null restores the default). */
export function setS2MinGap(ms: number | null) {
  gapOverride = ms;
}

async function s2Json<T>(url: string, opts: FetchOpts = {}): Promise<T> {
  const s = await getSettings();
  await waitTurn(gapOverride ?? (s.s2ApiKey ? KEY_GAP_MS : NO_KEY_GAP_MS));
  const headers: Record<string, string> = { ...((opts.headers as Record<string, string> | undefined) ?? {}) };
  if (s.s2ApiKey) headers['x-api-key'] = s.s2ApiKey;
  return fetchJson<T>(url, { ...opts, headers });
}

/** Canonical id → S2 lookup id. */
export function toS2Id(paperId: string): string | null {
  const [kind, ...rest] = paperId.split(':');
  const id = rest.join(':');
  if (kind === 'arxiv') return `arXiv:${id}`;
  if (kind === 'doi') return `DOI:${id}`;
  if (kind === 's2') return id;
  return null;
}

/** S2 paper → our canonical id (arXiv first, then DOI, then S2). */
export function canonicalFromS2(p: S2Paper): string {
  if (p.externalIds?.ArXiv) return `arxiv:${p.externalIds.ArXiv}`;
  if (p.externalIds?.DOI) return `doi:${normalizeDoi(p.externalIds.DOI)}`;
  return `s2:${p.paperId}`;
}

export function aliasesFromS2(p: S2Paper): string[] {
  const out = [`s2:${p.paperId}`];
  if (p.externalIds?.ArXiv) out.push(`arxiv:${p.externalIds.ArXiv}`);
  if (p.externalIds?.DOI) out.push(`doi:${normalizeDoi(p.externalIds.DOI)}`);
  return out;
}

export async function s2Get(id: string, fields = S2_FIELDS): Promise<S2Paper | null> {
  try {
    return await s2Json<S2Paper>(`${BASE}/paper/${encodeURIComponent(id)}?fields=${fields}`, { retries: 3 });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

/** Batch lookup, up to 500 ids per call. Missing ids come back as null. */
export async function s2Batch(ids: string[], fields = S2_FIELDS): Promise<(S2Paper | null)[]> {
  const out: (S2Paper | null)[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const res = await s2Json<(S2Paper | null)[]>(`${BASE}/paper/batch?fields=${fields}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: chunk }),
      retries: 3,
      timeoutMs: 30000,
    });
    out.push(...res);
    if (i + 400 < ids.length) await sleep(1200);
  }
  return out;
}

export async function s2Embeddings(ids: string[]): Promise<Map<string, number[]>> {
  const res = await s2Batch(ids, 'paperId,embedding.specter_v2');
  const map = new Map<string, number[]>();
  res.forEach((p, i) => {
    if (p?.embedding?.vector?.length) map.set(ids[i], p.embedding.vector);
  });
  return map;
}

export async function s2References(id: string): Promise<S2Paper[]> {
  try {
    const r = await s2Json<{ data: { citedPaper: S2Paper }[] }>(
      `${BASE}/paper/${encodeURIComponent(id)}/references?fields=paperId,externalIds,title&limit=1000`,
      { retries: 3 },
    );
    return (r.data ?? []).map((d) => d.citedPaper).filter((p) => p?.paperId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return [];
    throw e;
  }
}

/** Best title match (used for citation hovercards and OpenReview → arXiv linking). */
export async function s2MatchTitle(title: string): Promise<S2Paper | null> {
  try {
    const r = await s2Json<{ data: S2Paper[] }>(
      `${BASE}/paper/search/match?query=${encodeURIComponent(title.slice(0, 300))}&fields=${S2_FIELDS}`,
      { retries: 2 },
    );
    return r.data?.[0] ?? null;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

/** Author profiles matching a name, best match first. */
export async function s2AuthorSearch(name: string, opts: { limit?: number } = {}): Promise<S2AuthorHit[]> {
  // S2 finds nothing for hyphenated terms; spaces work
  const query = name.replace(/[-\u2010-\u2015]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!query) return [];
  try {
    const r = await s2Json<{ data?: S2AuthorHit[] }>(
      `${BASE}/author/search?query=${encodeURIComponent(query)}&fields=name,affiliations,paperCount,hIndex&limit=${opts.limit ?? 20}`,
      { retries: 2 },
    );
    return (r.data ?? []).filter((a) => a?.authorId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return [];
    throw e;
  }
}

/** An author's papers (S2 lists the most recent first). */
export async function s2AuthorPapers(authorId: string, opts: { limit?: number } = {}): Promise<S2Paper[]> {
  try {
    const r = await s2Json<{ data?: S2Paper[] }>(
      `${BASE}/author/${encodeURIComponent(authorId)}/papers?fields=${S2_FEED_FIELDS}&limit=${opts.limit ?? 100}`,
      { retries: 3 },
    );
    return (r.data ?? []).filter((p) => p?.paperId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return [];
    throw e;
  }
}

/** Papers like the positive examples and unlike the negative ones (S2 paper ids). */
export async function s2Recommendations(positive: string[], negative: string[], limit: number): Promise<S2Paper[]> {
  if (!positive.length) return [];
  const pos = new Set(positive);
  const r = await s2Json<{ recommendedPapers?: S2Paper[] }>(
    `${RECS}/papers/?fields=${S2_FEED_FIELDS}&limit=${Math.max(1, Math.min(500, limit))}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ positivePaperIds: [...pos], negativePaperIds: [...new Set(negative)].filter((id) => !pos.has(id)) }),
      retries: 3,
      timeoutMs: 30000,
    },
  );
  return (r.recommendedPapers ?? []).filter((p) => p?.paperId);
}

/** True when S2 says the paper appeared somewhere other than arXiv. */
export function s2Venue(p: S2Paper): string | null {
  const v = p.publicationVenue?.name || p.venue || p.journal?.name || '';
  if (!v) return null;
  if (/arxiv|corr|ssrn|biorxiv|medrxiv|preprint/i.test(v)) return null;
  return v;
}
