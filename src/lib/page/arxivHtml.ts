// Helpers for arXiv's HTML (LaTeXML) rendering and other paper pages.

import { elementToReadableText } from '../anchoring/dom';
import { extractCodeLinks } from '../codeLinks';
import type { PageMeta } from '../types';

export function articleRoot(doc: Document = document): Element {
  return doc.querySelector('article.ltx_document') ?? doc.querySelector('.ltx_page_content') ?? doc.querySelector('main') ?? doc.body;
}

const metaAll = (name: string) => [...document.querySelectorAll(`meta[name="${name}"]`)].map((m) => m.getAttribute('content') ?? '').filter(Boolean);
const meta = (name: string) => metaAll(name)[0];

function absUrl(src: string | null): string | undefined {
  if (!src) return undefined;
  try {
    return new URL(src, location.href).href;
  } catch {
    return undefined;
  }
}

export function extractPageMeta(kind: string): PageMeta {
  const m: PageMeta = {};
  m.title = meta('citation_title') ?? undefined;
  const authors = metaAll('citation_author');
  if (authors.length) {
    // citation_author is "Last, First" on arXiv
    m.authors = authors.map((a) => (a.includes(',') ? a.split(',').slice(1).join(' ').trim() + ' ' + a.split(',')[0].trim() : a).trim());
  }
  m.abstract = meta('citation_abstract') ?? undefined;
  m.published = meta('citation_date') ?? meta('citation_online_date') ?? undefined;
  if (kind === 'arxiv-abs') {
    m.abstract = m.abstract ?? document.querySelector('blockquote.abstract')?.textContent?.replace(/^\s*Abstract:\s*/i, '').trim();
    m.comments = document.querySelector('td.comments')?.textContent?.trim();
  }
  if (kind === 'arxiv-html') {
    const root = articleRoot();
    m.title = m.title ?? root.querySelector('.ltx_title_document')?.textContent?.replace(/\s+/g, ' ').trim();
    if (!m.authors?.length) {
      m.authors = [...root.querySelectorAll('.ltx_personname')]
        .map((e) => (e.childNodes[0]?.textContent ?? e.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter((s) => s && s.length < 80);
    }
    m.abstract = m.abstract ?? root.querySelector('.ltx_abstract p, .ltx_abstract .ltx_p')?.textContent?.replace(/\s+/g, ' ').trim();
    const fig = root.querySelector('figure.ltx_figure img');
    m.firstFigureUrl = absUrl(fig?.getAttribute('src') ?? null);
    m.codeLinks = extractCodeLinks(...[...root.querySelectorAll('a[href]')].slice(0, 400).map((a) => a.getAttribute('href') ?? ''));
  }
  if (kind === 'openreview-forum') {
    m.title = m.title ?? document.querySelector('.forum-title h2, h2.citation_title')?.textContent?.trim();
    m.abstract = m.abstract ?? meta('description') ?? undefined;
  }
  return m;
}

export function articleFullText(): string {
  return elementToReadableText(articleRoot());
}

/** Where reading "ends": the bibliography, so appendices don't count against progress. */
export function readingEnd(): number {
  const bib = document.querySelector('.ltx_bibliography, section.ltx_bibliography');
  const top = bib ? bib.getBoundingClientRect().top + window.scrollY : document.documentElement.scrollHeight;
  return Math.max(top, window.innerHeight);
}

// ---- symbols ----

const DEF_RE = /\b(where|let|denotes?|denoted|define[sd]?|is defined|are defined|represents?|we use|refers? to|be the|be a|stands? for|we write|we call|is the|are the)\b/i;

function mathKey(m: Element): string {
  return (m.getAttribute('alttext') ?? '').replace(/\s+/g, '').replace(/\\(?:mathrm|text|operatorname)\{([^}]*)\}/g, '$1');
}

function visibleMathText(m: Element): string {
  const clone = m.cloneNode(true) as Element;
  clone.querySelectorAll('annotation, annotation-xml').forEach((n) => n.remove());
  return (clone.textContent ?? '').replace(/\s+/g, '');
}

export interface SymbolInfo {
  tex: string;
  defElement: Element;
  section: string;
  context: string;
  isDefinition: boolean;
  occurrences: number;
}

function paragraphOf(el: Element): Element {
  return el.closest('.ltx_para, p, .ltx_p, li, figcaption, td') ?? el.parentElement ?? el;
}

function contextAround(el: Element, radius = 170): string {
  const para = paragraphOf(el);
  const marker = '\u0001';
  const clone = para.cloneNode(true) as Element;
  // mark the occurrence in the clone by path
  const path: number[] = [];
  for (let e: Element | null = el; e && e !== para; e = e.parentElement) path.unshift([...e.parentElement!.children].indexOf(e));
  let target: Element | null = clone;
  for (const i of path) target = target?.children[i] ?? null;
  target?.replaceWith(document.createTextNode(`${marker}$${el.getAttribute('alttext') ?? ''}$`));
  clone.querySelectorAll('math').forEach((mm) => mm.replaceWith(document.createTextNode(`$${mm.getAttribute('alttext') ?? ''}$`)));
  clone.querySelectorAll('button, .sr-only').forEach((n) => n.remove());
  const text = (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  const at = Math.max(0, text.indexOf(marker));
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(marker, '')}${end < text.length ? '…' : ''}`;
}

export function sectionTitle(el: Element): string {
  const sec = el.closest('section');
  const h = sec?.querySelector(':scope > .ltx_title, :scope > h2, :scope > h3, :scope > h4');
  return h?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

/** For a hovered math element (or a token inside a long equation), find where the symbol is defined. */
export function findSymbol(target: Element, root: Element): SymbolInfo | null {
  const math = target.closest('math');
  if (!math) return null;
  let candidates: Element[];
  let tex: string;
  const all = [...root.querySelectorAll('math')];
  const key = mathKey(math);
  if (key && key.length <= 40) {
    tex = math.getAttribute('alttext') ?? '';
    candidates = all.filter((m) => mathKey(m) === key);
  } else {
    // inside a long equation: use the hovered identifier's glyphs
    const token = target.closest('mi, msub, msup, msubsup, mover, munder');
    const glyphs = token ? (token.textContent ?? '').replace(/\s+/g, '') : '';
    if (!glyphs || glyphs.length > 12) return null;
    tex = glyphs;
    candidates = all.filter((m) => m.getAttribute('display') !== 'block' && visibleMathText(m) === glyphs);
  }
  if (!candidates.length) return null;
  const def = candidates.find((c) => DEF_RE.test(contextAround(c, 90))) ?? candidates[0];
  return {
    tex,
    defElement: def,
    section: sectionTitle(def),
    context: contextAround(def),
    isDefinition: DEF_RE.test(contextAround(def, 90)),
    occurrences: candidates.length,
  };
}

// ---- citations ----

export interface BibRef {
  id: string;
  text: string;
  title?: string;
  arxivId?: string;
  doi?: string;
}

export function bibRefFor(link: HTMLAnchorElement): BibRef | null {
  const href = link.getAttribute('href') ?? '';
  const hash = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
  if (!hash.startsWith('bib.')) return null;
  const li = document.getElementById(hash);
  if (!li) return null;
  const blocks = [...li.querySelectorAll('.ltx_bibblock')].map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const text = (li.textContent ?? '').replace(/\s+/g, ' ').trim();
  const links = [...li.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
  const arxivFromLink = links.map((h) => h.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/)?.[1]).find(Boolean);
  const arxivFromText = text.match(/arxiv[:\s]*(?:preprint\s*)?(?:arxiv:)?\s*(\d{4}\.\d{4,5})/i)?.[1];
  const doi = (links.map((h) => h.match(/doi\.org\/(10\.[^\s?#]+)/)?.[1]).find(Boolean) ?? text.match(/\b(10\.\d{4,9}\/[^\s,;]+[^\s,;.])/)?.[1]) || undefined;
  let title = blocks.length >= 2 ? blocks[1] : undefined;
  if (title) title = title.replace(/[.,]\s*$/, '');
  if (!title || title.length < 8) {
    // "Authors. Year. Title. Venue." fallback: the longest sentence-like chunk
    title = text
      .split(/\.\s+/)
      .filter((s) => s.length > 15)
      .sort((a, b) => b.length - a.length)[0];
  }
  return { id: hash, text, title, arxivId: arxivFromLink ?? arxivFromText, doi };
}
