import type { PageKind } from './types';

const NEW_ARXIV = /(\d{4}\.\d{4,5})(?:v(\d+))?/;
const OLD_ARXIV = /([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v(\d+))?/;

export interface ArxivRef {
  id: string; // without version
  version?: number;
}

export function parseArxivId(input: string): ArxivRef | null {
  const s = input.trim().replace(/^arxiv:/i, '');
  const m = s.match(NEW_ARXIV) ?? s.match(OLD_ARXIV);
  if (!m) return null;
  return { id: m[1], version: m[2] ? Number(m[2]) : undefined };
}

export interface ParsedUrl {
  kind: PageKind;
  paperId: string;
  arxiv?: ArxivRef;
  openreviewId?: string;
}

export function parsePaperUrl(rawUrl: string): ParsedUrl | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'arxiv.org' || host === 'export.arxiv.org') {
    const m = url.pathname.match(/^\/(abs|pdf|html)\/(.+?)(?:\.pdf)?\/?$/);
    if (!m) return null;
    const ref = parseArxivId(m[2]);
    if (!ref) return null;
    const kind: PageKind = m[1] === 'abs' ? 'arxiv-abs' : m[1] === 'pdf' ? 'arxiv-pdf' : 'arxiv-html';
    return { kind, paperId: `arxiv:${ref.id}`, arxiv: ref };
  }
  if (host === 'openreview.net') {
    const id = url.searchParams.get('id');
    if (!id) return null;
    if (url.pathname === '/forum') return { kind: 'openreview-forum', paperId: `openreview:${id}`, openreviewId: id };
    if (url.pathname === '/pdf') return { kind: 'openreview-pdf', paperId: `openreview:${id}`, openreviewId: id };
  }
  return null;
}

export function isPdfUrl(rawUrl: string): boolean {
  const p = parsePaperUrl(rawUrl);
  return p?.kind === 'arxiv-pdf' || p?.kind === 'openreview-pdf';
}

export function arxivUrls(id: string, version?: number) {
  const v = version ? `v${version}` : '';
  return {
    abs: `https://arxiv.org/abs/${id}${v}`,
    pdf: `https://arxiv.org/pdf/${id}${v}`,
    html: `https://arxiv.org/html/${id}${v}`,
  };
}

export function openreviewUrls(id: string) {
  return {
    openreview: `https://openreview.net/forum?id=${id}`,
    pdf: `https://openreview.net/pdf?id=${id}`,
  };
}

export function readerUrl(src: string, paperId?: string | null): string {
  const base = chrome.runtime.getURL('/reader.html');
  const q = new URLSearchParams({ src });
  if (paperId) q.set('paper', paperId);
  return `${base}?${q.toString()}`;
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalize a DOI to its lowercase bare form. */
export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .toLowerCase();
}
