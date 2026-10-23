// Export a paper's PDF with the user's highlights and notes written in as real
// PDF annotations (a Highlight per passage, one Text note for paper-level notes),
// so they show up in Acrobat, Preview, Google Drive's preview, GoodNotes and the
// like. The page content is left as it is. pdf-lib is large: callers should load
// this module with a dynamic import.

import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFString, type PDFPage, type PDFRef } from 'pdf-lib';
import { anchorQuote, normalize, positionOf, quoteOf, type Normalized } from './anchoring/text';
import { LABEL_SWATCH } from './anchoring/highlighter';
import { labelOf, noteOf } from './exports';
import { HIGHLIGHT_LABELS, type Annotation, type Paper } from './types';

/** The parts of pdf.js used here: pass `pdfjs-dist` in the browser, its legacy build in Node. */
export interface PdfJsLike {
  getDocument(src: any): { promise: Promise<PdfJsDocument> };
}

interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
  destroy(): Promise<void>;
}

interface PdfJsPage {
  getTextContent(params: { includeMarkedContent: boolean; disableNormalization: boolean }): Promise<{
    items: unknown[];
    styles?: Record<string, { fontFamily?: string }>;
  }>;
}

export interface AnnotatePdfOptions {
  pdfjs: PdfJsLike;
  /** Author shown on every annotation (/T). Defaults to each annotation's creator name. */
  author?: string;
  /** Extra paper-level note, added to the sticky note on page 1. */
  paperNote?: string;
  /** Document title metadata. */
  title?: string;
  /** Extra pdf.js getDocument() parameters. In the extension, cMap and standard font URLs default to its bundled copies. */
  docParams?: Record<string, unknown>;
}

export interface AnnotatePdfResult {
  bytes: Uint8Array;
  /** Highlights written (one that spans pages counts once). Paper-level notes are not counted. */
  placed: number;
  /** Ids of annotations that could not be located (or written). */
  missed: string[];
  /** Set when nothing could be written; `bytes` is then the original file. */
  reason?: 'encrypted';
}

const OPACITY = 0.4;
const NOTE_ICON = 20;
const NOTE_MARGIN = 14;
const LABEL_NAMES = new Map<string, string>(HIGHLIGHT_LABELS.map((l) => [l.id, l.name]));

// ---- Document text, built exactly like the reader's ----

interface TextItem {
  page: number; // 0-based
  /** [start, end) of item.str in the document text */
  start: number;
  end: number;
  str: string;
  transform: number[];
  width: number;
  height: number;
  /** pdf.js's fallback family for the item's font: 'serif', 'sans-serif' or 'monospace' */
  family?: string;
}

interface DocText {
  text: string;
  items: TextItem[];
}

function defaultDocParams(): Record<string, unknown> {
  const params: Record<string, unknown> = { verbosity: 0 };
  const runtime = (globalThis as { chrome?: typeof chrome }).chrome?.runtime;
  if (runtime?.getURL) {
    params.cMapUrl = runtime.getURL('/pdfjs/cmaps/');
    params.cMapPacked = true;
    params.standardFontDataUrl = runtime.getURL('/pdfjs/standard_fonts/');
  }
  return params;
}

/**
 * Page texts joined by "\n", with the same getTextContent options and item
 * concatenation as pageTexts() and PdfAnnotator in entrypoints/reader/pdf.ts, so
 * TextPositionSelectors made in the reader index into this text.
 */
async function readText(pdfjs: PdfJsLike, data: Uint8Array, params?: Record<string, unknown>): Promise<DocText> {
  const doc = await pdfjs.getDocument({ ...defaultDocParams(), ...params, data, isEvalSupported: false }).promise;
  try {
    const pages: { text: string; items: Omit<TextItem, 'start' | 'end'>[]; offsets: number[] }[] = new Array(doc.numPages);
    const work = Array.from({ length: doc.numPages }, (_, i) => i);
    const worker = async () => {
      for (let i = work.shift(); i !== undefined; i = work.shift()) {
        const page = await doc.getPage(i + 1);
        const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
        let text = '';
        const items: Omit<TextItem, 'start' | 'end'>[] = [];
        const offsets: number[] = [];
        for (const it of tc.items as any[]) {
          if (typeof it.str !== 'string') continue;
          offsets.push(text.length);
          const family = tc.styles?.[it.fontName]?.fontFamily;
          items.push({ page: i, str: it.str, transform: it.transform, width: it.width, height: it.height, family });
          text += it.str;
        }
        pages[i] = { text, items, offsets };
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const items: TextItem[] = [];
    let pos = 0;
    for (const p of pages) {
      p.items.forEach((it, k) => {
        const start = pos + p.offsets[k];
        items.push({ ...it, start, end: start + it.str.length });
      });
      pos += p.text.length + 1; // "\n" between pages
    }
    return { text: pages.map((p) => p.text).join('\n'), items };
  } finally {
    await doc.destroy();
  }
}

function locate(a: Annotation, doc: DocText, norm: Normalized): { start: number; end: number } | null {
  const quote = quoteOf(a.target.selector);
  if (!quote) return null;
  // offsets from the HTML rendering index into different text: rely on the quote there
  const hint = a.target.state?.medium === 'pdf' ? positionOf(a.target.selector) : null;
  return anchorQuote(doc.text, quote, hint, norm);
}

// ---- Geometry ----

/**
 * A highlighted run of text in the item's own frame: u runs along the baseline,
 * v points up the glyphs. s0..s1 are positions along u, b0..b1 along v.
 */
interface Box {
  page: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  s0: number;
  s1: number;
  b0: number;
  b1: number;
  size: number;
}

// Box extent around the baseline, in ems. Text fonts put caps and ascenders near
// 0.7 em and descenders near 0.22 em; a little more on each side covers the glyphs
// and keeps boxes of lines set at the usual 1.1 to 1.2 em leading from overlapping.
// (pdf.js's font ascent/descent depend on which font data it has, so they aren't used.)
const ASCENT = 0.85;
const DESCENT = 0.25;

// Advance widths (1/1000 em) of ASCII 32 to 126 in Times-Roman and Helvetica, from
// the standard font metrics. pdf.js gives only each item's total width; sharing it
// out by these instead of equally lines boxes up with the glyphs much better, since
// most papers are set in fonts with similar proportions.
const SERIF_WIDTHS = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278,
  564, 564, 564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944,
  722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389,
  278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];
const SANS_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278,
  584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944,
  667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500,
  278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

function charWidth(code: number, ch: string, table: number[]): number {
  if (code >= 32 && code <= 126) return table[code - 32];
  if (code >= 0xdc00 && code <= 0xdfff) return 0; // second half of a surrogate pair
  if (code >= 0x2e80) return 1000; // CJK and other full-width scripts
  // accented letters and ligatures: the letters they're made of
  let w = 0;
  for (const p of ch.normalize('NFKD')) {
    const c = p.charCodeAt(0);
    if (c >= 32 && c <= 126) w += table[c - 32];
  }
  return w || 500;
}

/** Cumulative advance at each character boundary of str, in 1/1000 em. */
function advances(str: string, family?: string): number[] {
  const out = [0];
  const mono = !!family && /mono/i.test(family);
  const table = family && /sans/i.test(family) ? SANS_WIDTHS : SERIF_WIDTHS;
  for (let i = 0; i < str.length; i++) out.push(out[i] + (mono ? 600 : charWidth(str.charCodeAt(i), str[i], table)));
  return out;
}

/** Box around item.str[from, to). */
function itemBox(it: TextItem, from: number, to: number): Box | null {
  const str = it.str;
  while (from < to && /\s/.test(str[from])) from++;
  while (to > from && /\s/.test(str[to - 1])) to--;
  if (to <= from || !Array.isArray(it.transform) || it.transform.length < 6) return null;
  const [a, b, c, d, e, f] = it.transform;
  if (![a, b, c, d, e, f].every(Number.isFinite)) return null;
  const scaleX = Math.hypot(a, b);
  const size = it.height > 0 ? it.height : Math.hypot(c, d) || scaleX;
  if (!(size > 0) || !Number.isFinite(size)) return null;
  const ux = scaleX ? a / scaleX : 1;
  const uy = scaleX ? b / scaleX : 0;
  const flip = ux * d - uy * c < 0 ? -1 : 1; // mirrored text: glyphs point the other way
  const vx = -uy * flip;
  const vy = ux * flip;
  const adv = advances(str, it.family);
  const total = adv[str.length] || 1;
  // items without an advance width still get a box, estimated from the font size
  const width = it.width > 0 ? it.width : (total * (scaleX || size)) / 1000;
  const s = e * ux + f * uy;
  const base = e * vx + f * vy;
  return {
    page: it.page,
    ux,
    uy,
    vx,
    vy,
    s0: s + (width * adv[from]) / total,
    s1: s + (width * adv[to]) / total,
    b0: base - DESCENT * size,
    b1: base + ASCENT * size,
    size,
  };
}

/** Same page, same direction, overlapping vertically and close along the line. */
function sameLine(p: Box, q: Box): boolean {
  if (p.page !== q.page) return false;
  if (p.ux * q.ux + p.uy * q.uy < 0.999 || p.vx * q.vx + p.vy * q.vy < 0.999) return false;
  const overlap = Math.min(p.b1, q.b1) - Math.max(p.b0, q.b0);
  if (overlap < 0.5 * Math.min(p.b1 - p.b0, q.b1 - q.b0)) return false;
  const em = Math.max(p.size, q.size);
  return q.s0 <= p.s1 + em && q.s1 >= p.s0 - em;
}

function boxesFor(items: TextItem[], start: number, end: number): Box[] {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].end <= start) lo = mid + 1;
    else hi = mid;
  }
  const out: Box[] = [];
  for (let i = lo; i < items.length && items[i].start < end; i++) {
    const it = items[i];
    const box = itemBox(it, Math.max(start, it.start) - it.start, Math.min(end, it.end) - it.start);
    if (!box) continue;
    const prev = out[out.length - 1];
    if (prev && sameLine(prev, box)) {
      prev.s0 = Math.min(prev.s0, box.s0);
      prev.s1 = Math.max(prev.s1, box.s1);
      prev.b0 = Math.min(prev.b0, box.b0);
      prev.b1 = Math.max(prev.b1, box.b1);
      prev.size = Math.max(prev.size, box.size);
    } else out.push(box);
  }
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100 || 0;

/** QuadPoints for a box: top-left, top-right, bottom-left, bottom-right (the order Acrobat and pdf.js use). */
function quadOf(q: Box): number[] {
  const pt = (s: number, b: number) => [r2(q.ux * s + q.vx * b), r2(q.uy * s + q.vy * b)];
  return [...pt(q.s0, q.b1), ...pt(q.s1, q.b1), ...pt(q.s0, q.b0), ...pt(q.s1, q.b0)];
}

// ---- Writing ----

function rgb(hex: string): number[] {
  const v = parseInt(/^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? 'facc15', 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => Math.round((x / 255) * 1000) / 1000);
}

/** A PDF text string: a literal for plain ASCII, UTF-16 hex otherwise. */
function pdfText(s: string): PDFString | PDFHexString {
  if (/^[\x20-\x7e\n\r\t]*$/.test(s)) {
    return PDFString.of(s.replace(/[\\()]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t'));
  }
  return PDFHexString.fromText(s);
}

function pdfDate(iso?: string | null): PDFString {
  const d = iso ? new Date(iso) : new Date();
  return PDFString.fromDate(Number.isNaN(d.getTime()) ? new Date() : d);
}

function highlightAppearance(quads: number[], color: number[]): string {
  const ops = ['q', '/GS0 gs', `${color.join(' ')} rg`];
  for (let i = 0; i < quads.length; i += 8) {
    const [x1, y1, x2, y2, x3, y3, x4, y4] = quads.slice(i, i + 8);
    ops.push(`${x1} ${y1} m ${x2} ${y2} l ${x4} ${y4} l ${x3} ${y3} l h`);
  }
  ops.push('f', 'Q');
  return ops.join('\n');
}

function addHighlight(pdf: PDFDocument, page: PDFPage, boxes: Box[], a: Annotation, name: string, author: string): PDFRef {
  const ctx = pdf.context;
  const quads = boxes.flatMap(quadOf);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < quads.length; i += 2) {
    x0 = Math.min(x0, quads[i]);
    x1 = Math.max(x1, quads[i]);
    y0 = Math.min(y0, quads[i + 1]);
    y1 = Math.max(y1, quads[i + 1]);
  }
  const rect = [Math.floor(x0 - 1), Math.floor(y0 - 1), Math.ceil(x1 + 1), Math.ceil(y1 + 1)];
  const label = labelOf(a);
  const labelName = LABEL_NAMES.get(label) ?? 'Highlight';
  const color = rgb(LABEL_SWATCH[label] ?? LABEL_SWATCH.plain);
  const contents = [label === 'plain' ? '' : labelName, noteOf(a).trim()].filter(Boolean).join('\n');
  // our own appearance (multiply blend, like pdf.js and Acrobat) so viewers that
  // only paint appearance streams show the highlight too
  const ap = ctx.register(
    ctx.stream(highlightAppearance(quads, color), {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: rect,
      Resources: { ExtGState: { GS0: { Type: 'ExtGState', CA: OPACITY, ca: OPACITY, BM: 'Multiply' } } },
    }),
  );
  return ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Highlight',
      Rect: rect,
      QuadPoints: quads,
      C: color,
      CA: OPACITY,
      F: 4,
      Border: [0, 0, 0],
      P: page.ref,
      NM: pdfText(name),
      Subj: pdfText(labelName),
      ...(author ? { T: pdfText(author) } : {}),
      ...(contents ? { Contents: pdfText(contents) } : {}),
      CreationDate: pdfDate(a.createdAt),
      M: pdfDate(a.updatedAt),
      AP: { N: ap },
    }),
  );
}

/** Icon-sized rect at the top-left margin as the page is shown (after /Rotate). */
function noteRect(page: PDFPage): number[] {
  const { x, y, width, height } = page.getCropBox();
  const m = Math.max(0, Math.min(NOTE_MARGIN, (Math.min(width, height) - NOTE_ICON) / 2));
  const left = x + m;
  const right = x + width - m - NOTE_ICON;
  const bottom = y + m;
  const top = y + height - m - NOTE_ICON;
  const rot = ((page.getRotation().angle % 360) + 360) % 360;
  const [nx, ny] = rot === 90 ? [left, bottom] : rot === 180 ? [right, bottom] : rot === 270 ? [right, top] : [left, top];
  return [r2(nx), r2(ny), r2(nx + NOTE_ICON), r2(ny + NOTE_ICON)];
}

const NOTE_COLOR = rgb(LABEL_SWATCH.plain);

/** A small sticky-note icon, for viewers that only paint appearance streams. */
const NOTE_APPEARANCE = [
  'q',
  `${NOTE_COLOR.join(' ')} rg 0.55 0.42 0.02 RG 1 w`,
  '1.5 1.5 17 17 re B',
  '1.2 w',
  '5 14 m 15 14 l S',
  '5 10 m 15 10 l S',
  '5 6 m 11.5 6 l S',
  'Q',
].join('\n');

function addPaperNote(pdf: PDFDocument, page: PDFPage, contents: string, author: string, updatedAt?: string): PDFRef {
  const ctx = pdf.context;
  const ap = ctx.register(
    ctx.stream(NOTE_APPEARANCE, { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, NOTE_ICON, NOTE_ICON] }),
  );
  return ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Text',
      Rect: noteRect(page),
      Name: 'Note',
      Open: false,
      C: NOTE_COLOR,
      F: 28, // print, no zoom, no rotate (how sticky notes behave anyway)
      P: page.ref,
      NM: pdfText('mg-paper-notes'),
      Subj: pdfText('Notes'),
      ...(author ? { T: pdfText(author) } : {}),
      Contents: pdfText(contents),
      M: pdfDate(updatedAt),
      AP: { N: ap },
    }),
  );
}

/** Append to the page's own Annots array, keeping existing entries such as links. */
function appendAnnots(page: PDFPage, refs: PDFRef[]) {
  const existing = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  const annots = page.doc.context.obj([]);
  if (existing) for (let i = 0; i < existing.size(); i++) annots.push(existing.get(i));
  for (const r of refs) annots.push(r);
  page.node.set(PDFName.of('Annots'), annots);
}

/**
 * The PDF with each highlight (and its note) as a Highlight annotation and all
 * paper-level notes in one sticky note on page 1. Encrypted PDFs come back
 * unchanged with every annotation in `missed` and `reason: 'encrypted'`; other
 * unreadable files throw.
 */
export async function annotatePdf(pdfBytes: Uint8Array, annotations: Annotation[], opts: AnnotatePdfOptions): Promise<AnnotatePdfResult> {
  const live = annotations.filter((a) => !a.deletedAt);
  const highlights = live.filter((a) => a.target.selector?.length);
  const paperNotes = live.filter((a) => !a.target.selector?.length && noteOf(a).trim());
  const encrypted = (): AnnotatePdfResult => ({ bytes: pdfBytes, placed: 0, missed: live.map((a) => a.id), reason: 'encrypted' });

  const pdf = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  // pdf-lib can't encrypt what it adds, so new strings would come out garbled
  if (pdf.isEncrypted) return encrypted();

  let doc: DocText | null = null;
  if (highlights.length) {
    try {
      doc = await readText(opts.pdfjs, new Uint8Array(pdfBytes), opts.docParams); // a copy: pdf.js may detach the buffer it gets
    } catch (e) {
      if ((e as Error)?.name === 'PasswordException') return encrypted();
      throw e;
    }
  }

  const pages = pdf.getPages();
  const perPage = new Map<number, PDFRef[]>();
  const add = (i: number, ref: PDFRef) => {
    const list = perPage.get(i);
    if (list) list.push(ref);
    else perPage.set(i, [ref]);
  };
  const missed: string[] = [];
  let placed = 0;

  if (doc) {
    const norm = normalize(doc.text);
    const located: { a: Annotation; start: number; boxes: Box[] }[] = [];
    for (const a of highlights) {
      const r = locate(a, doc, norm);
      const boxes = r ? boxesFor(doc.items, r.start, r.end) : [];
      if (r && boxes.length && boxes.every((b) => pages[b.page])) located.push({ a, start: r.start, boxes });
      else missed.push(a.id);
    }
    located.sort((x, y) => x.start - y.start); // reading order, for viewers' comment lists
    for (const { a, boxes } of located) {
      const author = opts.author ?? a.creator?.name ?? '';
      // a highlight that crosses pages becomes one per page, sharing the note
      const byPage = new Map<number, Box[]>();
      for (const b of boxes) byPage.set(b.page, [...(byPage.get(b.page) ?? []), b]);
      let part = 0;
      for (const [i, list] of byPage) {
        part++;
        add(i, addHighlight(pdf, pages[i], list, a, part === 1 ? a.id : `${a.id}#${part}`, author));
      }
      placed++;
    }
  }

  const noteText = [opts.paperNote ?? '', ...paperNotes.map(noteOf)].map((s) => s.trim()).filter(Boolean).join('\n\n');
  if (noteText && pages.length) {
    const latest = paperNotes.map((a) => a.updatedAt).sort().pop();
    add(0, addPaperNote(pdf, pages[0], noteText, opts.author ?? paperNotes[0]?.creator?.name ?? '', latest));
  }

  if (!perPage.size && !opts.title) return { bytes: pdfBytes, placed, missed };
  for (const [i, refs] of perPage) appendAnnots(pages[i], refs);
  if (opts.title) pdf.setTitle(opts.title);
  pdf.setModificationDate(new Date());
  const bytes = await pdf.save({ updateFieldAppearances: false, addDefaultPage: false });
  return { bytes, placed, missed };
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** `${citeKey}.pdf`, safe on every filesystem (falls back to the arXiv id or "paper"). */
export function pdfFileName(paper: Paper): string {
  const clean = (s?: string | null) =>
    (s ?? '')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .slice(0, 120)
      .replace(/[-._]+$/, '');
  let base = clean(paper.citeKey) || clean(paper.arxivId) || clean(paper.id) || 'paper';
  if (RESERVED.test(base)) base = `${base}-paper`;
  return `${base}.pdf`;
}
