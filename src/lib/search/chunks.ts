// Passage retrieval over the library (no AI). Full texts are split into
// overlapping ~1000-character chunks cut at sentence boundaries; abstracts,
// highlights and notes are chunks of their own. Ranking is BM25 over the
// unigrams and bigrams from the TF-IDF tokenizer.
//
// Terms are stored as 32-bit hashes in sorted typed arrays, one per chunk, so a
// 300-paper library with full texts fits in a few tens of MB and a query is a
// binary search per chunk and term. Chunking and tokenizing are cached per doc,
// so repeated questions over the same library only pay for the search.

import { tokenize } from '../sorting/tfidf';

export type ChunkKind = 'fulltext' | 'abstract' | 'highlight' | 'note';

export interface IndexDoc {
  paperId: string;
  kind: ChunkKind;
  text: string;
  annotationId?: string;
  /** Changes whenever the text is re-saved (FullText.savedAt, Annotation.updatedAt). Part of the cache key. */
  version?: string;
  /** Extra text indexed with this doc's chunks but not part of `text` or the offsets (e.g. the title for an abstract). */
  heading?: string;
}

export interface Chunk {
  /** Position in `index.chunks`. */
  id: number;
  paperId: string;
  kind: ChunkKind;
  /** Exactly `source.slice(offset, end)`. */
  text: string;
  annotationId?: string;
  /** Start of `text` in the source doc's text. */
  offset: number;
  end: number;
}

export interface Hit {
  chunk: Chunk;
  score: number;
}

interface Postings {
  /** Sorted unique term hashes. */
  terms: Int32Array;
  counts: Uint16Array;
  /** Number of unigram tokens (the BM25 document length). */
  length: number;
}

export interface LibraryIndex {
  chunks: Chunk[];
  /** Parallel to `chunks`. */
  postings: Postings[];
  avgLength: number;
}

export interface SearchOptions {
  k: number;
  perPaper: number;
  boostKinds?: Partial<Record<ChunkKind, number>>;
}

export const CHUNK_MIN = 900;
export const CHUNK_MAX = 1200;
export const CHUNK_OVERLAP = 150;

// BM25 parameters
const K1 = 1.2;
const B = 0.75;
/** Short chunks (one-line highlights) are scored as if at least this fraction of an average chunk, so brevity alone doesn't win. */
const MIN_LENGTH_FRACTION = 0.3;
/** Bigrams add phrase evidence on top of their two unigrams. */
const BIGRAM_WEIGHT = 0.7;

// ---------------------------------------------------------------------------
// Sentences and chunks
// ---------------------------------------------------------------------------

const SENTENCE_END = /[.!?]["'”’)\]]*\s+|\n[ \t]*\n\s*/g;
const ABBREV = /(?:^|[^a-z])(?:e\.g|i\.e|et al|etc|cf|vs|resp|approx|fig|figs|eq|eqs|sec|secs|tab|ref|refs|no|nos|ch|app|appx|thm|def|prop|lem|cor|alg|ex|viz|w\.r\.t|i\.i\.d|vol|pp|dr|prof)$/i;
const INITIAL = /(?:^|[\s(])[A-Z]$/;

/** Indices where a sentence starts (after the first), i.e. just past the whitespace that follows ., ! or ?, or a blank line. */
export function sentenceStarts(text: string): number[] {
  const out: number[] = [];
  SENTENCE_END.lastIndex = 0;
  for (let m = SENTENCE_END.exec(text); m; m = SENTENCE_END.exec(text)) {
    const at = m.index;
    const next = at + m[0].length;
    if (next >= text.length) break;
    if (text[at] === '.') {
      const before = text.slice(Math.max(0, at - 8), at);
      if (ABBREV.test(before) || INITIAL.test(before)) continue;
    }
    // "approx. the" and similar: a lowercase letter rarely starts a sentence
    if (text[at] !== '\n' && /[a-z]/.test(text[next])) continue;
    out.push(next);
  }
  return out;
}

/** Largest value v in sorted `arr` with lo < v <= hi. */
function lastIn(arr: number[], lo: number, hi: number): number | null {
  let a = 0;
  let b = arr.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (arr[mid] <= hi) a = mid + 1;
    else b = mid;
  }
  const i = a - 1;
  return i >= 0 && arr[i] > lo ? arr[i] : null;
}

/** Value in sorted `arr` within [lo, hi] closest to `target`. */
function nearestIn(arr: number[], lo: number, hi: number, target: number): number | null {
  let a = 0;
  let b = arr.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (arr[mid] < lo) a = mid + 1;
    else b = mid;
  }
  let best: number | null = null;
  for (let i = a; i < arr.length && arr[i] <= hi; i++) {
    if (best === null || Math.abs(arr[i] - target) < Math.abs(best - target)) best = arr[i];
  }
  return best;
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f' || c === ' ';

/** Start of a word at or before `hi` (and after `lo`), or null. */
function wordStartBefore(text: string, lo: number, hi: number): number | null {
  for (let i = Math.min(hi, text.length) - 1; i > lo; i--) if (isSpace(text[i - 1]) && !isSpace(text[i])) return i;
  return null;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && isSpace(text[i])) i++;
  return i;
}

function trimEndAt(text: string, start: number, end: number): number {
  while (end > start && isSpace(text[end - 1])) end--;
  return end;
}

export interface Span {
  offset: number;
  end: number;
}

/**
 * Split text into spans of about `min` to `max` characters that end at sentence
 * boundaries, each starting about `overlap` characters before the previous one
 * ended (also at a sentence start when one is near, else at a word start).
 */
export function chunkText(text: string, opts: { min?: number; max?: number; overlap?: number } = {}): Span[] {
  const min = opts.min ?? CHUNK_MIN;
  const max = opts.max ?? CHUNK_MAX;
  const overlap = opts.overlap ?? CHUNK_OVERLAP;
  const n = trimEndAt(text, 0, text.length);
  let start = skipSpace(text, 0);
  if (start >= n) return [];
  // a short tail is folded into the last chunk rather than left as a sliver
  const tail = Math.round(min * 0.28);
  if (n - start <= max + tail) return [{ offset: start, end: n }];
  const starts = sentenceStarts(text);
  const spans: Span[] = [];
  for (;;) {
    let end: number;
    if (n - start <= max + tail) end = n;
    else end = lastIn(starts, start + min, start + max) ?? wordStartBefore(text, start + min, start + max) ?? start + max;
    spans.push({ offset: start, end: trimEndAt(text, start, end) });
    if (end >= n) break;
    const target = end - overlap;
    let next = nearestIn(starts, end - overlap * 2.2, end - overlap / 3, target) ?? wordStartBefore(text, target - 60, target + 1) ?? target;
    next = skipSpace(text, next);
    if (next <= start) next = end;
    start = next;
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

/** FNV-1a, 32 bit. Collisions are negligible at library scale and only blur scores slightly. */
function hashTerm(t: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** Hash of the bigram "a b" from the hashes of a and b (asymmetric, well mixed). */
function pairHash(a: number, b: number): number {
  let x = Math.imul(a ^ 0x20, 0x01000193);
  x = Math.imul(x ^ b, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return (x ^ (x >>> 16)) | 0;
}

/**
 * Hash `tokenize` output into `out`. tokenize emits n unigrams followed by the
 * n - 1 bigrams of adjacent unigrams; bigram hashes are then derived from the
 * unigram hashes, which avoids flattening millions of concatenated strings.
 * If the output ever has another shape, every token is hashed as a string.
 * Returns the unigram count and the index where bigrams start (-1 if unknown).
 */
function hashTokens(tokens: string[], out: Int32Array): { unigrams: number; bigramFrom: number } {
  const L = tokens.length;
  const n = (L + 1) >> 1;
  const structured = L > 0 && L === 2 * n - 1 && (n < 2 || tokens[n] === `${tokens[0]} ${tokens[1]}`);
  if (structured) {
    for (let i = 0; i < n; i++) out[i] = hashTerm(tokens[i]);
    for (let i = 0; i + 1 < n; i++) out[n + i] = pairHash(out[i], out[i + 1]);
    return { unigrams: n, bigramFrom: n };
  }
  let unigrams = 0;
  for (let i = 0; i < L; i++) {
    out[i] = hashTerm(tokens[i]);
    if (tokens[i].indexOf(' ') < 0) unigrams++;
  }
  return { unigrams, bigramFrom: -1 };
}

let scratch = new Int32Array(4096);

function postingsOf(text: string, heading?: string): Postings {
  const body = tokenize(text);
  const head = heading ? tokenize(heading) : [];
  const n = body.length + head.length;
  if (scratch.length < n) scratch = new Int32Array(n * 2);
  const length = hashTokens(body, scratch).unigrams + (head.length ? hashTokens(head, scratch.subarray(body.length)).unigrams : 0);
  const hs = scratch.subarray(0, n).sort();
  let unique = 0;
  for (let i = 0; i < n; i++) if (i === 0 || hs[i] !== hs[i - 1]) unique++;
  const terms = new Int32Array(unique);
  const counts = new Uint16Array(unique);
  let u = -1;
  for (let i = 0; i < n; i++) {
    if (i === 0 || hs[i] !== hs[i - 1]) terms[++u] = hs[i];
    if (counts[u] < 65535) counts[u]++;
  }
  return { terms, counts, length };
}

function countOf(p: Postings, h: number): number {
  const t = p.terms;
  let a = 0;
  let b = t.length - 1;
  while (a <= b) {
    const mid = (a + b) >> 1;
    const v = t[mid];
    if (v === h) return p.counts[mid];
    if (v < h) a = mid + 1;
    else b = mid - 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Cache (per doc: spans and postings)
// ---------------------------------------------------------------------------

interface Prepared {
  spans: Span[];
  postings: Postings[];
}

const CACHE_MIN_CHARS = 2000; // shorter docs are cheaper to redo than to keep
const CACHE_CHAR_BUDGET = 30_000_000; // about 500 full papers
const cache = new Map<string, Prepared & { chars: number }>();
let cachedChars = 0;
const stats = { hits: 0, misses: 0 };

function cacheKey(d: IndexDoc): string {
  const t = d.text;
  return [d.kind, d.paperId, d.annotationId ?? '', d.version ?? '', t.length, d.heading ?? '', t.slice(0, 40), t.slice(-40)].join('\u0001');
}

function prepare(d: IndexDoc): Prepared {
  const cacheable = d.text.length >= CACHE_MIN_CHARS;
  const key = cacheable ? cacheKey(d) : '';
  if (cacheable) {
    const hit = cache.get(key);
    if (hit) {
      stats.hits++;
      cache.delete(key); // move to the most recently used end
      cache.set(key, hit);
      return hit;
    }
    stats.misses++;
  }
  const spans = chunkText(d.text);
  const postings = spans.map((s) => postingsOf(d.text.slice(s.offset, s.end), d.heading));
  const out = { spans, postings };
  if (cacheable) {
    cache.set(key, { ...out, chars: d.text.length });
    cachedChars += d.text.length;
    for (const [k, v] of cache) {
      if (cachedChars <= CACHE_CHAR_BUDGET) break;
      cache.delete(k);
      cachedChars -= v.chars;
    }
  }
  return out;
}

export function clearChunkCache() {
  cache.clear();
  cachedChars = 0;
  stats.hits = 0;
  stats.misses = 0;
}

export function chunkCacheStats() {
  return { docs: cache.size, chars: cachedChars, hits: stats.hits, misses: stats.misses };
}

// ---------------------------------------------------------------------------
// Index and search
// ---------------------------------------------------------------------------

export function buildIndex(docs: IndexDoc[]): LibraryIndex {
  const chunks: Chunk[] = [];
  const postings: Postings[] = [];
  let total = 0;
  for (const d of docs) {
    if (!d.text || !d.text.trim()) continue;
    const prep = prepare(d);
    for (let i = 0; i < prep.spans.length; i++) {
      const s = prep.spans[i];
      chunks.push({
        id: chunks.length,
        paperId: d.paperId,
        kind: d.kind,
        text: d.text.slice(s.offset, s.end),
        ...(d.annotationId ? { annotationId: d.annotationId } : {}),
        offset: s.offset,
        end: s.end,
      });
      postings.push(prep.postings[i]);
      total += prep.postings[i].length;
    }
  }
  return { chunks, postings, avgLength: chunks.length ? total / chunks.length || 1 : 1 };
}

interface QueryTerm {
  hash: number;
  weight: number;
}

function queryTerms(query: string | string[]): QueryTerm[] {
  const counts = new Map<number, { n: number; bigram: boolean }>();
  for (const q of Array.isArray(query) ? query : [query]) {
    const tokens = tokenize(q);
    const hashes = new Int32Array(tokens.length);
    const { bigramFrom } = hashTokens(tokens, hashes);
    const seen = new Set<number>();
    hashes.forEach((h, i) => {
      if (seen.has(h)) return;
      seen.add(h);
      const cur = counts.get(h);
      counts.set(h, { n: (cur?.n ?? 0) + 1, bigram: bigramFrom >= 0 ? i >= bigramFrom : tokens[i].includes(' ') });
    });
  }
  // a term named by several query phrases counts more, with diminishing returns
  return [...counts].map(([hash, c]) => ({ hash, weight: (1 + Math.log(c.n)) * (c.bigram ? BIGRAM_WEIGHT : 1) }));
}

/** BM25 over all chunks. `query` may be several phrases (e.g. the question plus expansions); their terms are pooled. */
export function search(index: LibraryIndex, query: string | string[], opts: SearchOptions): Hit[] {
  const N = index.chunks.length;
  const terms = queryTerms(query);
  if (!N || !terms.length || opts.k <= 0) return [];
  const scores = new Float64Array(N);
  const avg = index.avgLength;
  const norm = new Float64Array(N);
  for (let c = 0; c < N; c++) {
    const dl = Math.max(index.postings[c].length, MIN_LENGTH_FRACTION * avg);
    norm[c] = K1 * (1 - B + (B * dl) / avg);
  }
  const ids: number[] = [];
  const tfs: number[] = [];
  for (const { hash, weight } of terms) {
    ids.length = 0;
    tfs.length = 0;
    for (let c = 0; c < N; c++) {
      const tf = countOf(index.postings[c], hash);
      if (tf) {
        ids.push(c);
        tfs.push(tf);
      }
    }
    if (!ids.length) continue;
    const df = ids.length;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let j = 0; j < ids.length; j++) {
      const tf = tfs[j];
      scores[ids[j]] += (weight * idf * tf * (K1 + 1)) / (tf + norm[ids[j]]);
    }
  }
  const boosts = opts.boostKinds ?? {};
  const ranked: Hit[] = [];
  for (let c = 0; c < N; c++) {
    if (scores[c] <= 0) continue;
    const chunk = index.chunks[c];
    ranked.push({ chunk, score: scores[c] * (boosts[chunk.kind] ?? 1) });
  }
  ranked.sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);
  const perPaper = new Map<string, number>();
  const out: Hit[] = [];
  for (const h of ranked) {
    const used = perPaper.get(h.chunk.paperId) ?? 0;
    if (used >= opts.perPaper) continue;
    perPaper.set(h.chunk.paperId, used + 1);
    out.push(h);
    if (out.length >= opts.k) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/**
 * The window of `text` (at most `maxChars`, starting at a sentence start and
 * ending at a sentence end or word boundary) that shares the most terms with
 * `query`. Score 0 means nothing matched; the window is then the start of the text.
 */
export function bestWindow(text: string, query: string | string[], maxChars = 300): { start: number; end: number; score: number } {
  const want = new Map<string, number>();
  for (const q of Array.isArray(query) ? query : [query]) for (const t of tokenize(q)) want.set(t, t.includes(' ') ? 1.5 : 1);
  const starts = [skipSpace(text, 0), ...sentenceStarts(text)];
  const window = (s: number) => {
    const limit = s + maxChars;
    if (limit >= text.length) return trimEndAt(text, s, text.length);
    // end at a sentence end when that keeps at least half the room, else at a word boundary
    const e = lastIn(starts, s + maxChars / 2, limit) ?? wordStartBefore(text, s + 1, limit + 1) ?? limit;
    return trimEndAt(text, s, e);
  };
  let best = { start: starts[0], end: window(starts[0]), score: 0 };
  if (!want.size) return best;
  for (const s of starts) {
    const e = window(s);
    let score = 0;
    for (const t of new Set(tokenize(text.slice(s, e)))) score += want.get(t) ?? 0;
    if (score > best.score) best = { start: s, end: e, score };
  }
  return best;
}
