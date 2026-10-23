import { XMLParser } from 'fast-xml-parser';
import { fetchText, spacer } from '../net';
import { parseArxivId } from '../ids';

export interface ArxivMeta {
  id: string;
  version: number;
  title: string;
  authors: string[];
  abstract: string;
  published: string; // ISO
  updated: string;
  comments?: string;
  journalRef?: string;
  doi?: string;
  primaryCategory?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['entry', 'author', 'link', 'category'].includes(name),
  textNodeName: '#text',
});

const clean = (s: unknown) => String(typeof s === 'object' && s !== null ? (s as any)['#text'] ?? '' : s ?? '')
  .replace(/\s+/g, ' ')
  .trim();

export function parseArxivAtom(xml: string): ArxivMeta[] {
  const doc = parser.parse(xml);
  const entries: any[] = doc?.feed?.entry ?? [];
  const out: ArxivMeta[] = [];
  for (const e of entries) {
    const idUrl = clean(e.id);
    const ref = parseArxivId(idUrl);
    const title = clean(e.title);
    if (!ref || !title || title.toLowerCase() === 'error') continue;
    out.push({
      id: ref.id,
      version: ref.version ?? 1,
      title,
      authors: (e.author ?? []).map((a: any) => clean(a.name)).filter(Boolean),
      abstract: clean(e.summary),
      published: clean(e.published),
      updated: clean(e.updated),
      comments: clean(e['arxiv:comment']) || undefined,
      journalRef: clean(e['arxiv:journal_ref']) || undefined,
      doi: clean(e['arxiv:doi']) || undefined,
      primaryCategory: e['arxiv:primary_category']?.['@_term'] ?? e.category?.[0]?.['@_term'],
    });
  }
  return out;
}

export async function fetchArxiv(ids: string[]): Promise<ArxivMeta[]> {
  if (!ids.length) return [];
  const url = `https://export.arxiv.org/api/query?id_list=${ids.map(encodeURIComponent).join(',')}&max_results=${ids.length}`;
  return parseArxivAtom(await fetchText(url, { timeoutMs: 20000 }));
}

// arXiv asks API clients to wait 3 seconds between calls
const ARXIV_GAP_MS = 3100;
let arxivGapOverride: number | null = null;
const arxivTurn = spacer();

/** For tests: force the gap between arXiv search calls (null restores the default). */
export function setArxivMinGap(ms: number | null) {
  arxivGapOverride = ms;
}

/**
 * Newest submissions in a category whose abstract mentions any of the terms.
 * Extension only: export.arxiv.org doesn't allow CORS, so the web app can't call it.
 */
export async function searchArxivRecent(category: string, terms: string[], max = 50): Promise<ArxivMeta[]> {
  const cat = category.replace(/[^A-Za-z.-]/g, '');
  if (!cat) return [];
  const clauses = [...new Set(terms.map((t) => t.replace(/["()]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))].map((t) => `abs:"${t}"`);
  const query = clauses.length ? `cat:${cat} AND (${clauses.join(' OR ')})` : `cat:${cat}`;
  const q = encodeURIComponent(query).replace(/%20/g, '+').replace(/\(/g, '%28').replace(/\)/g, '%29');
  await arxivTurn(arxivGapOverride ?? ARXIV_GAP_MS);
  const url = `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&start=0&max_results=${max}`;
  return parseArxivAtom(await fetchText(url, { timeoutMs: 30000 }));
}

export { extractCodeLinks } from '../codeLinks';
