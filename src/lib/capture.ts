// Turning a page (or an identifier) into a saved paper.

import { arxivBibtex, baseCiteKey, genericBibtex, normalizeForeignBib, toAuthor, uniqueCiteKey } from './bibtex';
import { arxivUrls, normalizeDoi, nowIso, openreviewUrls, parseArxivId, parsePaperUrl } from './ids';
import * as repo from './repo';
import { extractCodeLinks, fetchArxiv } from './sources/arxiv';
import { fetchOpenReview } from './sources/openreview';
import { aliasesFromS2, canonicalFromS2, s2Venue, type S2Paper } from './sources/s2';
import { shortVenue } from './venue';
import type { LibraryEntry, PageMeta, Paper } from './types';

export interface SaveInput {
  url?: string;
  paperId?: string;
  pageMeta?: PageMeta;
}

export interface SaveResult {
  paper: Paper;
  entry: LibraryEntry;
  created: boolean;
}

function yearOf(iso?: string | null): number | null {
  if (!iso) return null;
  const y = new Date(iso).getFullYear();
  return Number.isFinite(y) ? y : null;
}

async function buildArxivPaper(arxivId: string, version: number | undefined, pageMeta?: PageMeta): Promise<Paper> {
  let meta: Awaited<ReturnType<typeof fetchArxiv>>[number] | undefined;
  try {
    [meta] = await fetchArxiv([arxivId]);
  } catch (e) {
    console.warn('[marginalia] arXiv API failed, using page metadata', e);
  }
  const title = meta?.title ?? pageMeta?.title ?? arxivId;
  const authors = (meta?.authors ?? pageMeta?.authors ?? []).map(toAuthor);
  const published = meta?.published ?? pageMeta?.published ?? null;
  const year = yearOf(published);
  const taken = await repo.takenCiteKeys();
  const citeKey = uniqueCiteKey(baseCiteKey(authors, year, title), taken);
  const doi = meta?.doi ? normalizeDoi(meta.doi) : undefined;
  return {
    ...(await repo.newMeta()),
    id: `arxiv:${arxivId}`,
    aliases: doi ? [`doi:${doi}`] : [],
    source: 'arxiv',
    title,
    authors,
    abstract: meta?.abstract ?? pageMeta?.abstract ?? '',
    year,
    published,
    arxivId,
    arxivVersion: meta?.version ?? version,
    primaryCategory: meta?.primaryCategory,
    comments: meta?.comments ?? pageMeta?.comments,
    doi,
    venue: null,
    venueStatus: 'preprint',
    urls: arxivUrls(arxivId),
    codeLinks: extractCodeLinks(meta?.abstract, meta?.comments, ...(pageMeta?.codeLinks ?? [])),
    citeKey,
    bibtex: arxivBibtex({ citeKey, title, authors, year, arxivId, primaryCategory: meta?.primaryCategory }),
    bibtexSource: 'arxiv',
    firstFigureUrl: pageMeta?.firstFigureUrl,
  };
}

async function buildOpenReviewPaper(forumId: string, pageMeta?: PageMeta): Promise<Paper> {
  let meta: Awaited<ReturnType<typeof fetchOpenReview>> = null;
  try {
    meta = await fetchOpenReview(forumId);
  } catch (e) {
    console.warn('[marginalia] OpenReview API failed, using page metadata', e);
  }
  const title = meta?.title || pageMeta?.title || forumId;
  const authors = (meta?.authors?.length ? meta.authors : pageMeta?.authors ?? []).map(toAuthor);
  const year = meta?.year ?? yearOf(pageMeta?.published);
  const taken = await repo.takenCiteKeys();
  const citeKey = uniqueCiteKey(baseCiteKey(authors, year, title), taken);
  const accepted = meta?.status === 'accepted';
  const venueName = meta?.venue ? meta.venue.replace(/\s+(poster|oral|spotlight|notable.*|top.*)$/i, '') : null;
  const bibtex =
    (meta?.bibtex && normalizeForeignBib(meta.bibtex, citeKey)) ||
    genericBibtex({
      citeKey,
      type: accepted ? 'inproceedings' : 'misc',
      title,
      authors,
      year,
      venue: accepted ? venueName : meta?.venue ?? 'OpenReview',
      url: `https://openreview.net/forum?id=${forumId}`,
    });
  return {
    ...(await repo.newMeta()),
    id: `openreview:${forumId}`,
    aliases: [],
    source: 'openreview',
    title,
    authors,
    abstract: meta?.abstract || pageMeta?.abstract || '',
    year,
    published: meta?.published ?? null,
    openreviewId: forumId,
    venue: accepted ? venueName : null,
    venueStatus: meta?.status ?? 'unknown',
    urls: { ...openreviewUrls(forumId), ...(meta?.pdfUrl ? { pdf: meta.pdfUrl } : {}) },
    codeLinks: extractCodeLinks(meta?.abstract, ...(pageMeta?.codeLinks ?? [])),
    citeKey,
    bibtex,
    bibtexSource: meta?.bibtex ? 'openreview' : 'manual',
  };
}

/** Create a paper record from Semantic Scholar data (citation hovercards). */
export async function buildS2Paper(s: S2Paper): Promise<Paper> {
  const id = canonicalFromS2(s);
  if (id.startsWith('arxiv:')) return buildArxivPaper(id.slice(6), undefined, { title: s.title, abstract: s.abstract ?? undefined });
  const authors = (s.authors ?? []).map((a) => toAuthor(a.name));
  const year = s.year ?? null;
  const title = s.title ?? 'Untitled';
  const taken = await repo.takenCiteKeys();
  const citeKey = uniqueCiteKey(baseCiteKey(authors, year, title), taken);
  const venue = s2Venue(s);
  const displayVenue = shortVenue(venue, year, s.publicationVenue?.alternate_names ?? []);
  const doi = s.externalIds?.DOI ? normalizeDoi(s.externalIds.DOI) : undefined;
  return {
    ...(await repo.newMeta()),
    id,
    aliases: aliasesFromS2(s).filter((a) => a !== id),
    source: id.startsWith('doi:') ? 'doi' : 's2',
    title,
    authors,
    abstract: s.abstract ?? '',
    year,
    published: s.publicationDate ?? null,
    doi,
    s2Id: s.paperId,
    dblpKey: s.externalIds?.DBLP,
    venue: displayVenue,
    venueStatus: venue ? 'accepted' : 'unknown',
    urls: { s2: `https://www.semanticscholar.org/paper/${s.paperId}`, ...(doi ? { abs: `https://doi.org/${doi}` } : {}) },
    codeLinks: [],
    citeKey,
    bibtex: genericBibtex({
      citeKey,
      type: s.publicationTypes?.includes('JournalArticle') ? 'article' : venue ? 'inproceedings' : 'misc',
      title,
      authors,
      year,
      venue,
      doi,
    }),
    bibtexSource: 's2',
  };
}

/**
 * Save a paper to the library. Fetches metadata if the paper is new, and
 * (re)creates the personal library entry. Enrichment runs afterwards.
 */
export async function savePaper(input: SaveInput): Promise<SaveResult> {
  let paperId = input.paperId ?? null;
  let arxiv: { id: string; version?: number } | null = null;
  let orId: string | null = null;
  if (input.url) {
    const parsed = parsePaperUrl(input.url);
    if (parsed) {
      paperId = parsed.paperId;
      arxiv = parsed.arxiv ?? null;
      orId = parsed.openreviewId ?? null;
    }
  }
  if (!paperId) throw new Error('This page is not an arXiv or OpenReview paper.');
  if (!arxiv && paperId.startsWith('arxiv:')) arxiv = parseArxivId(paperId);
  if (!orId && paperId.startsWith('openreview:')) orId = paperId.slice('openreview:'.length);

  let paper = await repo.getPaper(paperId);
  if (!paper) {
    if (arxiv) paper = await buildArxivPaper(arxiv.id, arxiv.version, input.pageMeta);
    else if (orId) paper = await buildOpenReviewPaper(orId, input.pageMeta);
    else throw new Error(`Can't fetch metadata for ${paperId}`);
    // another record may already claim one of our aliases (e.g. the OpenReview version of an arXiv paper)
    paper = await repo.putPaper(paper);
  } else if (input.pageMeta?.firstFigureUrl && !paper.firstFigureUrl) {
    paper = (await repo.updatePaper(paper.id, { firstFigureUrl: input.pageMeta.firstFigureUrl })) ?? paper;
  }
  const { entry, created } = await repo.ensureEntry(paper.id);
  return { paper, entry, created };
}

/** Ensure a paper record exists (without adding it to the library). Used by annotations and the reader. */
export async function ensurePaper(input: SaveInput): Promise<Paper> {
  const parsed = input.url ? parsePaperUrl(input.url) : null;
  const id = parsed?.paperId ?? input.paperId;
  if (id) {
    const existing = await repo.getPaper(id);
    if (existing) return existing;
  }
  const { paper } = await savePaper(input);
  return paper;
}
