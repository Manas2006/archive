// Citation hovercards: resolve a reference from a paper's bibliography.

import { buildS2Paper, savePaper } from './capture';
import * as repo from './repo';
import { fetchArxiv } from './sources/arxiv';
import { aliasesFromS2, canonicalFromS2, s2Get, s2MatchTitle, s2Venue, type S2Paper } from './sources/s2';

export interface CitationRef {
  title?: string;
  arxivId?: string;
  doi?: string;
}

export interface CitationInfo {
  found: boolean;
  title: string;
  authors: string;
  year: number | null;
  venue: string | null;
  abstract: string;
  s2Id: string | null;
  paperId: string | null; // canonical id
  inLibrary: boolean;
  url: string | null;
}

const cache = new Map<string, CitationInfo>();

function authorLine(names: string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} et al.`;
}

async function inLibrary(ids: string[]): Promise<string | null> {
  for (const id of ids) {
    const p = await repo.getPaper(id);
    if (p && (await repo.getEntry(p.id))) return p.id;
  }
  return null;
}

export async function lookupCitation(ref: CitationRef): Promise<CitationInfo> {
  const cacheKey = JSON.stringify(ref);
  const hit = cache.get(cacheKey);
  if (hit) {
    // library membership can change; refresh that bit
    const lib = hit.paperId ? await inLibrary([hit.paperId]) : null;
    return { ...hit, inLibrary: !!lib };
  }
  let s2: S2Paper | null = null;
  try {
    if (ref.arxivId) s2 = await s2Get(`arXiv:${ref.arxivId}`);
    if (!s2 && ref.doi) s2 = await s2Get(`DOI:${ref.doi}`);
    if (!s2 && ref.title && ref.title.length > 12) s2 = await s2MatchTitle(ref.title);
  } catch (e) {
    console.warn('[archive] S2 lookup failed', e);
  }
  let info: CitationInfo;
  if (s2) {
    const ids = aliasesFromS2(s2);
    const lib = await inLibrary(ids);
    info = {
      found: true,
      title: s2.title ?? ref.title ?? '',
      authors: authorLine((s2.authors ?? []).map((a) => a.name)),
      year: s2.year ?? null,
      venue: s2Venue(s2),
      abstract: s2.abstract ?? '',
      s2Id: s2.paperId,
      paperId: lib ?? canonicalFromS2(s2),
      inLibrary: !!lib,
      url: s2.externalIds?.ArXiv ? `https://arxiv.org/abs/${s2.externalIds.ArXiv}` : `https://www.semanticscholar.org/paper/${s2.paperId}`,
    };
  } else if (ref.arxivId) {
    const [m] = await fetchArxiv([ref.arxivId]).catch(() => []);
    const id = `arxiv:${ref.arxivId}`;
    const lib = await inLibrary([id]);
    info = {
      found: !!m,
      title: m?.title ?? ref.title ?? '',
      authors: authorLine(m?.authors ?? []),
      year: m?.published ? new Date(m.published).getFullYear() : null,
      venue: null,
      abstract: m?.abstract ?? '',
      s2Id: null,
      paperId: id,
      inLibrary: !!lib,
      url: `https://arxiv.org/abs/${ref.arxivId}`,
    };
  } else {
    info = { found: false, title: ref.title ?? '', authors: '', year: null, venue: null, abstract: '', s2Id: null, paperId: null, inLibrary: false, url: null };
  }
  cache.set(cacheKey, info);
  return info;
}

/** Save a paper found through a citation. Returns its canonical id. */
export async function saveFromS2(idOrCanonical: string): Promise<string> {
  if (idOrCanonical.startsWith('arxiv:')) {
    const res = await savePaper({ paperId: idOrCanonical });
    return res.paper.id;
  }
  const s2 = await s2Get(idOrCanonical);
  if (!s2) throw new Error('Paper not found on Semantic Scholar');
  for (const alias of [canonicalFromS2(s2), ...aliasesFromS2(s2)]) {
    const existing = await repo.getPaper(alias);
    if (existing) {
      await repo.ensureEntry(existing.id);
      return existing.id;
    }
  }
  const paper = await buildS2Paper(s2);
  const saved = await repo.putPaper(paper);
  await repo.ensureEntry(saved.id);
  return saved.id;
}
