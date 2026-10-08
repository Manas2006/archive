import { fetchJson, HttpError, sleep } from '../net';
import { getSettings } from '../settings';
import { normalizeDoi } from '../ids';

const BASE = 'https://api.semanticscholar.org/graph/v1';

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
  authors?: { name: string }[];
  citationCount?: number;
  embedding?: { model: string; vector: number[] } | null;
  publicationTypes?: string[] | null;
}

export const S2_FIELDS =
  'paperId,externalIds,title,abstract,venue,publicationVenue,journal,year,publicationDate,authors,citationCount,publicationTypes';

async function headers(): Promise<HeadersInit> {
  const s = await getSettings();
  return s.s2ApiKey ? { 'x-api-key': s.s2ApiKey } : {};
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
    return await fetchJson<S2Paper>(`${BASE}/paper/${encodeURIComponent(id)}?fields=${fields}`, { headers: await headers(), retries: 3 });
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
    const res = await fetchJson<(S2Paper | null)[]>(`${BASE}/paper/batch?fields=${fields}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await headers()) },
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
    const r = await fetchJson<{ data: { citedPaper: S2Paper }[] }>(
      `${BASE}/paper/${encodeURIComponent(id)}/references?fields=paperId,externalIds,title&limit=1000`,
      { headers: await headers(), retries: 3 },
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
    const r = await fetchJson<{ data: S2Paper[] }>(
      `${BASE}/paper/search/match?query=${encodeURIComponent(title.slice(0, 300))}&fields=${S2_FIELDS}`,
      { headers: await headers(), retries: 2 },
    );
    return r.data?.[0] ?? null;
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}

/** True when S2 says the paper appeared somewhere other than arXiv. */
export function s2Venue(p: S2Paper): string | null {
  const v = p.publicationVenue?.name || p.venue || p.journal?.name || '';
  if (!v) return null;
  if (/arxiv|corr|ssrn|biorxiv|medrxiv|preprint/i.test(v)) return null;
  return v;
}
