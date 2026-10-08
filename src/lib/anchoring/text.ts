// Pure-string quote anchoring. Text is compared in a normalized form (NFKC,
// lowercase, whitespace and soft hyphens removed) so a quote taken from the
// HTML rendering still finds its place in PDF text and across arXiv versions.

import search from 'approx-string-match';
import type { TextPositionSelector, TextQuoteSelector } from '../types';

export interface Normalized {
  text: string;
  /** map[i] = index in the original string of normalized char i */
  map: number[];
}

const DROP = /[\s­​-‏⁠﻿]/;

export function normalize(original: string): Normalized {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < original.length; i++) {
    const ch = original[i];
    if (DROP.test(ch)) continue;
    // surrogate pairs: keep together
    let unit = ch;
    const code = ch.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < original.length) unit = ch + original[i + 1];
    const norm = unit.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
    for (let k = 0; k < norm.length; k++) {
      text += norm[k];
      map.push(i);
    }
    if (unit.length === 2) i++;
  }
  return { text, map };
}

export const normalizeString = (s: string) => normalize(s).text;

export const CONTEXT = 32;

export function describeQuote(text: string, start: number, end: number): [TextQuoteSelector, TextPositionSelector] {
  return [
    {
      type: 'TextQuoteSelector',
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT), start),
      suffix: text.slice(end, end + CONTEXT),
    },
    { type: 'TextPositionSelector', start, end },
  ];
}

export interface AnchorResult {
  start: number;
  end: number;
  /** 1 = exact, lower = fuzzier */
  score: number;
}

function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * Find a quote in `text`. `hint` (a TextPositionSelector from the same rendering)
 * is tried first and used to break ties between repeated passages.
 */
export function anchorQuote(text: string, quote: TextQuoteSelector, hint?: TextPositionSelector | null, norm?: Normalized): AnchorResult | null {
  const exact = quote.exact;
  if (!exact.trim()) return null;

  // 1. Position hint, verified against the quote.
  if (hint && hint.end <= text.length && hint.start < hint.end) {
    if (normalizeString(text.slice(hint.start, hint.end)) === normalizeString(exact)) {
      return { start: hint.start, end: hint.end, score: 1 };
    }
  }

  const N = norm ?? normalize(text);
  const q = normalizeString(exact);
  if (!q) return null;
  const pre = normalizeString(quote.prefix ?? '');
  const suf = normalizeString(quote.suffix ?? '');
  const hintNorm = hint ? approxNormIndex(N, hint.start) : null;

  const context = (s: number, e: number) => {
    const before = N.text.slice(Math.max(0, s - pre.length), s);
    const after = N.text.slice(e, e + suf.length);
    return (
      (pre.length ? commonSuffixLen(before, pre) / pre.length : 1) * 0.5 +
      (suf.length ? commonPrefixLen(after, suf) / suf.length : 1) * 0.5
    );
  };
  const score = (s: number, e: number, errors: number) => {
    const quality = 1 - errors / Math.max(q.length, 1);
    const prox = hintNorm === null ? 0.5 : 1 - Math.min(1, Math.abs(s - hintNorm) / Math.max(N.text.length, 1));
    return quality * 50 + context(s, e) * 20 + prox * 2;
  };
  // A short quote found without its surrounding text is probably a different passage
  // (e.g. its sentence was deleted in a new version): leave it unplaced rather than misplace it.
  const hasContext = pre.length + suf.length > 0;
  const contextOk = (s: number, e: number, minLen: number) => !hasContext || q.length >= minLen || context(s, e) >= 0.3;

  const toOriginal = (s: number, e: number, errors: number): AnchorResult => ({
    start: N.map[s],
    end: N.map[e - 1] + 1,
    score: 1 - errors / Math.max(q.length, 1),
  });

  // 2. Exact occurrences.
  const hits: number[] = [];
  for (let i = N.text.indexOf(q); i >= 0 && hits.length < 200; i = N.text.indexOf(q, i + 1)) hits.push(i);
  if (hits.length) {
    let best = hits[0];
    let bestScore = -Infinity;
    for (const h of hits) {
      const sc = score(h, h + q.length, 0);
      if (sc > bestScore) {
        bestScore = sc;
        best = h;
      }
    }
    return contextOk(best, best + q.length, 40) ? toOriginal(best, best + q.length, 0) : null;
  }

  // 3. Fuzzy match (quote changed slightly between versions or renderings).
  const maxErrors = Math.min(64, Math.floor(q.length * 0.25));
  if (maxErrors < 1) return null;
  const pattern = q.length > 400 ? q.slice(0, 400) : q; // very long quotes: match the opening
  const matches = search(N.text, pattern, Math.min(maxErrors, Math.floor(pattern.length * 0.25)));
  if (!matches.length) return null;
  let best = matches[0];
  let bestScore = -Infinity;
  for (const m of matches) {
    const sc = score(m.start, m.end, m.errors);
    if (sc > bestScore) {
      bestScore = sc;
      best = m;
    }
  }
  let end = best.end;
  if (pattern.length < q.length) end = Math.min(N.text.length, best.start + q.length);
  if (!contextOk(best.start, end, 60)) return null;
  return toOriginal(best.start, end, best.errors);
}

function approxNormIndex(N: Normalized, origIndex: number): number {
  // binary search map for first normalized index whose original index >= origIndex
  let lo = 0;
  let hi = N.map.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (N.map[mid] < origIndex) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function quoteOf(selectors?: { type: string }[]): TextQuoteSelector | undefined {
  return selectors?.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
}

export function positionOf(selectors?: { type: string }[]): TextPositionSelector | undefined {
  return selectors?.find((s): s is TextPositionSelector => s.type === 'TextPositionSelector');
}
