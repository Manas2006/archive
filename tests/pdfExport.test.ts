// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFArray, PDFDict, PDFDocument, PDFFont, PDFHexString, PDFName, PDFNumber, PDFStream, PDFString, StandardFonts, degrees } from 'pdf-lib';
import { annotatePdf, pdfFileName } from '@/lib/pdfExport';
import type { Annotation, HighlightLabel, Paper, Selector } from '@/lib/types';

// Fixtures come from tests/fixtures/pdf/make_fixtures.py (reportlab).
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/pdf');
const fixture = (name: string) => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
const docParams = { standardFontDataUrl: `${path.resolve(import.meta.dirname, '../node_modules/pdfjs-dist/standard_fonts')}/`, verbosity: 0 };
const AUTHOR = 'Ada Lovelace';

interface Item {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

/** Text and annotations as pdf.js sees them, with the reader's document text (pages joined by "\n"). */
async function inspect(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, ...docParams }).promise;
  const pages: { text: string; items: Item[]; annots: any[]; view: number[] }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
    const items = (tc.items as any[]).filter((it) => typeof it.str === 'string') as Item[];
    pages.push({ text: items.map((it) => it.str).join(''), items, annots: await page.getAnnotations(), view: page.view });
  }
  const meta = (await doc.getMetadata()) as { info: Record<string, unknown> };
  await doc.destroy();
  const starts: number[] = [];
  let pos = 0;
  for (const p of pages) {
    starts.push(pos);
    pos += p.text.length + 1;
  }
  return { pages, starts, text: pages.map((p) => p.text).join('\n'), title: meta.info.Title };
}

const highlightsOn = (page: { annots: any[] }) => page.annots.filter((a) => a.subtype === 'Highlight');

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** pdf.js hands quads back as [minX, maxY, maxX, maxY, minX, minY, maxX, minY]. */
function quadRects(q: ArrayLike<number>): Rect[] {
  const out: Rect[] = [];
  for (let i = 0; i < q.length; i += 8) out.push({ x0: q[i], y0: q[i + 5], x1: q[i + 2], y1: q[i + 1] });
  return out;
}

// The fixture's body text is Helvetica and its margin stamp Times-Roman, set without
// kerning, so the fonts' glyph widths (from pdf-lib) say exactly where each glyph is.
const metrics = await PDFDocument.create();
const HELVETICA = await metrics.embedFont(StandardFonts.Helvetica);
const TIMES = await metrics.embedFont(StandardFonts.TimesRoman);
const advance = (font: PDFFont, s: string, size: number) => [...s].reduce((w, ch) => w + font.widthOfTextAtSize(ch, size), 0);

/** Where an unrotated item's characters [from, to) are drawn. */
function charRect(it: Item, from: number, to: number, font: PDFFont = HELVETICA): Rect {
  const [size, , , , e, f] = it.transform;
  const x = (i: number) => e + advance(font, it.str.slice(0, i), size);
  return { x0: x(from), x1: x(to), y0: f - 0.2 * it.height, y1: f + 0.7 * it.height };
}

const overlaps = (a: Rect, b: Rect) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);

function itemWith(items: Item[], s: string): Item {
  const it = items.find((i) => i.str.includes(s));
  if (!it) throw new Error(`no text item contains "${s}"`);
  return it;
}

let seq = 0;
function annotation(
  exact: string | null,
  o: { prefix?: string; suffix?: string; pos?: [number, number]; medium?: 'pdf' | 'html'; label?: HighlightLabel; note?: string; deleted?: boolean } = {},
): Annotation {
  const body: Annotation['body'] = [];
  if (o.label && o.label !== 'plain') body.push({ type: 'TextualBody', purpose: 'tagging', value: o.label });
  if (o.note) body.push({ type: 'TextualBody', purpose: 'commenting', value: o.note, format: 'text/markdown' });
  const selector: Selector[] | undefined =
    exact === null
      ? undefined
      : [
          { type: 'TextQuoteSelector', exact, prefix: o.prefix ?? '', suffix: o.suffix ?? '' },
          ...(o.pos ? [{ type: 'TextPositionSelector' as const, start: o.pos[0], end: o.pos[1] }] : []),
        ];
  return {
    id: `urn:uuid:00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    type: 'Annotation',
    paperId: 'arxiv:2401.00001',
    motivation: o.note ? 'commenting' : 'highlighting',
    body,
    target: { source: 'arxiv:2401.00001', ...(selector ? { selector, state: { medium: o.medium ?? 'pdf' } } : {}) },
    creator: { id: 'local', name: 'Someone' },
    owner: 'local',
    visibility: 'private',
    groupId: null,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-02T09:30:00.000Z',
    deletedAt: o.deleted ? '2026-10-03T00:00:00.000Z' : null,
  };
}

/** A highlight made in the reader: exact text and offsets straight from the document text. */
function pdfHighlight(text: string, start: number, end: number, o: Parameters<typeof annotation>[1] = {}) {
  return annotation(text.slice(start, end), { ...o, medium: 'pdf', pos: [start, end], prefix: text.slice(Math.max(0, start - 32), start), suffix: text.slice(end, end + 32) });
}

/** Raw annotation dicts as written, read back with pdf-lib. */
async function rawAnnots(bytes: Uint8Array, pageIndex: number): Promise<PDFDict[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = doc.getPage(pageIndex).node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (!annots) return [];
  return Array.from({ length: annots.size() }, (_, i) => annots.lookup(i, PDFDict));
}
const str = (d: PDFDict, key: string) => d.lookupMaybe(PDFName.of(key), PDFString, PDFHexString)?.decodeText();
const num = (d: PDFDict, key: string) => d.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
const nums = (d: PDFDict, key: string) => {
  const arr = d.lookup(PDFName.of(key), PDFArray);
  return Array.from({ length: arr.size() }, (_, i) => arr.lookup(i, PDFNumber).asNumber());
};

const sample = fixture('sample.pdf');
const base = await inspect(sample);
const repeated = (() => {
  const s = base.text.indexOf('Because pruned blocks');
  const e = base.text.indexOf('most expensive.', s) + 'most expensive.'.length;
  return base.text.slice(s, e);
})();

describe('annotatePdf', () => {
  it('writes a labeled highlight where the reader put it, with color, note and author', async () => {
    const quote = 'lightweight scoring layer that prunes irrelevant key blocks';
    const start = base.text.indexOf(quote);
    const a = pdfHighlight(base.text, start, start + quote.length, { label: 'method', note: 'Core idea' });
    const res = await annotatePdf(sample, [a], { pdfjs, author: AUTHOR, docParams });
    expect(res).toMatchObject({ placed: 1, missed: [] });

    const out = await inspect(res.bytes);
    const [h, ...rest] = highlightsOn(out.pages[0]);
    expect(rest).toHaveLength(0);
    expect(out.pages.slice(1).flatMap(highlightsOn)).toHaveLength(0);
    expect(h.quadPoints).toHaveLength(8);
    expect(Array.from(h.color)).toEqual([14, 165, 233]); // LABEL_SWATCH.method
    expect(h.opacity).toBeCloseTo(0.4);
    expect(h.contentsObj.str).toBe('Method\nCore idea');
    expect(h.titleObj.str).toBe(AUTHOR);
    expect(h.hasAppearance).toBe(true);

    const item = itemWith(base.pages[0].items, quote);
    const from = item.str.indexOf(quote);
    const want = charRect(item, from, from + quote.length);
    const [box] = quadRects(h.quadPoints);
    expect(box.x0).toBeCloseTo(want.x0, 0);
    expect(box.x1).toBeCloseTo(want.x1, 0);
    const baseline = item.transform[5];
    expect(box.y0).toBeLessThan(baseline - 0.15 * item.height);
    expect(box.y1).toBeGreaterThan(baseline + 0.7 * item.height);
    expect(box.y1 - box.y0).toBeLessThan(1.2 * item.height); // doesn't spill into the next line

    const [raw] = (await rawAnnots(res.bytes, 0)).filter((d) => d.get(PDFName.of('Subtype'))?.toString() === '/Highlight');
    expect(str(raw, 'NM')).toBe(a.id);
    expect(str(raw, 'Subj')).toBe('Method');
    expect(str(raw, 'M')).toBe('D:20261002093000Z');
    expect(num(raw, 'F')).toBe(4);
    expect(num(raw, 'CA')).toBeCloseTo(0.4);
    // corner order as written: top-left, top-right, bottom-left, bottom-right
    const [x1, y1, x2, y2, x3, y3, x4, y4] = nums(raw, 'QuadPoints');
    expect(x1).toBe(x3);
    expect(x2).toBe(x4);
    expect(x2).toBeGreaterThan(x1);
    expect(y1).toBe(y2);
    expect(y3).toBe(y4);
    expect(y1).toBeGreaterThan(y3);
    const rect = nums(raw, 'Rect');
    expect(rect[0]).toBeLessThanOrEqual(x1);
    expect(rect[2]).toBeGreaterThanOrEqual(x2);
    const ap = raw.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
    expect(ap).toBeInstanceOf(PDFStream);
  });

  it('uses the position hint only for highlights made on the PDF', async () => {
    const first = base.text.indexOf(repeated);
    const second = base.text.indexOf(repeated, first + 1);
    expect(second).toBeGreaterThan(base.starts[2]); // first copy on page 2, second on page 3
    const fromPdf = annotation(repeated, { medium: 'pdf', pos: [second, second + repeated.length] });
    // the HTML rendering's offsets point somewhere else entirely
    const fromHtml = annotation(repeated.replace('themethod', 'the method'), { medium: 'html', pos: [second, second + repeated.length] });
    const res = await annotatePdf(sample, [fromPdf], { pdfjs, docParams });
    const out = await inspect(res.bytes);
    expect(highlightsOn(out.pages[1])).toHaveLength(0);
    expect(highlightsOn(out.pages[2])).toHaveLength(1);

    const res2 = await annotatePdf(sample, [fromHtml], { pdfjs, docParams });
    const out2 = await inspect(res2.bytes);
    expect(highlightsOn(out2.pages[1])).toHaveLength(1);
    expect(highlightsOn(out2.pages[2])).toHaveLength(0);
  });

  it('anchors an HTML quote by its text and covers every line it spans', async () => {
    const a = annotation(
      'Long-context language models often fail to retrieve facts buried in the middle of their input. We introduce filtered attention, a lightweight scoring layer',
      { medium: 'html', prefix: 'Abstract ', suffix: ' that prunes irrelevant key blocks', pos: [3, 120] },
    );
    const res = await annotatePdf(sample, [a], { pdfjs, docParams });
    expect(res).toMatchObject({ placed: 1, missed: [] });
    const out = await inspect(res.bytes);
    const [h] = highlightsOn(out.pages[0]);
    const boxes = quadRects(h.quadPoints);
    expect(boxes).toHaveLength(2);
    const line1 = itemWith(base.pages[0].items, 'Long-context language models often fail');
    const line2 = itemWith(base.pages[0].items, 'introduce filtered attention');
    expect(overlaps(boxes[0], charRect(line1, 0, line1.str.length))).toBe(true);
    expect(overlaps(boxes[1], charRect(line2, 0, line2.str.length))).toBe(true);
    expect(boxes[0].y0).toBeGreaterThan(boxes[1].y0); // reading order: top line first
    const end = line2.str.indexOf('layer') + 'layer'.length;
    expect(boxes[1].x0).toBeCloseTo(line2.transform[4], 0);
    expect(boxes[1].x1).toBeCloseTo(charRect(line2, 0, end).x1, 0);
    expect(Array.from(h.color)).toEqual([250, 204, 21]); // plain highlight
    expect(h.contentsObj.str).toBe('');
  });

  it('merges the text items of one line into a single quad', async () => {
    const quote = 'Let θ denote the parameters';
    const start = base.text.indexOf(quote);
    const res = await annotatePdf(sample, [pdfHighlight(base.text, start, start + quote.length)], { pdfjs, docParams });
    const out = await inspect(res.bytes);
    const [h] = highlightsOn(out.pages[1]);
    const boxes = quadRects(h.quadPoints);
    expect(boxes).toHaveLength(1);
    const let_ = itemWith(base.pages[1].items, 'Let');
    const rest = itemWith(base.pages[1].items, 'denote the parameters');
    expect(rest).not.toBe(let_);
    expect(boxes[0].x0).toBeCloseTo(let_.transform[4], 0);
    expect(boxes[0].x1).toBeCloseTo(charRect(rest, 0, 'denote the parameters'.length).x1, 0);
  });

  it('reports quotes that are not in the PDF as missed', async () => {
    const good = annotation('retrieval recall by 11.4 points', { medium: 'html' });
    const gone = annotation('This sentence only exists in the first version and will be removed later.', { medium: 'html' });
    const res = await annotatePdf(sample, [good, gone], { pdfjs, docParams });
    expect(res.placed).toBe(1);
    expect(res.missed).toEqual([gone.id]);
    const out = await inspect(res.bytes);
    expect(out.pages.flatMap(highlightsOn)).toHaveLength(1);
    expect(highlightsOn(out.pages[1])).toHaveLength(1);
  });

  it('splits a highlight that crosses a page break into one per page with the same note', async () => {
    const start = base.text.lastIndexOf('easy to retrofit.', base.starts[1]);
    const end = base.starts[1] + '2 Method'.length;
    const a = pdfHighlight(base.text, start, end, { label: 'result', note: 'Spans pages' });
    const res = await annotatePdf(sample, [a], { pdfjs, author: AUTHOR, docParams });
    expect(res).toMatchObject({ placed: 1, missed: [] });
    const out = await inspect(res.bytes);
    const [h1] = highlightsOn(out.pages[0]);
    const [h2] = highlightsOn(out.pages[1]);
    for (const h of [h1, h2]) {
      expect(h.contentsObj.str).toBe('Result\nSpans pages');
      expect(Array.from(h.color)).toEqual([34, 197, 94]);
    }
    const heading = itemWith(base.pages[1].items, '2 Method');
    expect(overlaps(quadRects(h2.quadPoints)[0], charRect(heading, 0, heading.str.length))).toBe(true);
    const names = [...(await rawAnnots(res.bytes, 0)), ...(await rawAnnots(res.bytes, 1))]
      .filter((d) => d.get(PDFName.of('Subtype'))?.toString() === '/Highlight')
      .map((d) => str(d, 'NM'));
    expect(names).toEqual([a.id, `${a.id}#2`]);
  });

  it('highlights rotated text along its own direction', async () => {
    const quote = 'arXiv:2401.00001v1 [cs.CL]';
    const start = base.text.indexOf(quote);
    const res = await annotatePdf(sample, [pdfHighlight(base.text, start, start + quote.length)], { pdfjs, docParams });
    const out = await inspect(res.bytes);
    const [h] = highlightsOn(out.pages[0]);
    const [box] = quadRects(h.quadPoints);
    const stamp = itemWith(base.pages[0].items, quote);
    const [, , , , e, f] = stamp.transform; // text runs up the page from (e, f), glyph tops toward -x
    const size = stamp.height;
    expect(box.x0).toBeLessThan(e - 0.6 * size);
    expect(box.x1).toBeGreaterThan(e + 0.1 * size);
    expect(box.x1).toBeLessThan(e + 0.5 * size);
    expect(box.y0).toBeCloseTo(f, 0);
    expect(box.y1).toBeCloseTo(f + advance(TIMES, quote, size), 0);
  });

  it('keeps existing links and puts paper-level notes in one sticky note on page 1', async () => {
    const links = base.pages[0].annots.filter((a) => a.subtype === 'Link');
    expect(links.length).toBeGreaterThan(0);
    const notes = [annotation(null, { note: 'Read the v2 HTML for the new intro.' }), annotation(null, { note: 'Check Table 1 numbers.' })];
    const hl = annotation('filtered attention improves retrieval recall', { medium: 'html' });
    const res = await annotatePdf(sample, [...notes, hl], { pdfjs, author: AUTHOR, paperNote: 'Compare with Smith and Doe (2024).', docParams });
    expect(res).toMatchObject({ placed: 1, missed: [] });
    const out = await inspect(res.bytes);

    const kept = out.pages[0].annots.filter((a) => a.subtype === 'Link');
    expect(kept.map((a) => [a.url, a.rect])).toEqual(links.map((a) => [a.url, a.rect]));

    const texts = out.pages.flatMap((p) => p.annots.filter((a) => a.subtype === 'Text'));
    expect(texts).toHaveLength(1);
    const [note] = out.pages[0].annots.filter((a) => a.subtype === 'Text');
    expect(note.contentsObj.str).toBe('Compare with Smith and Doe (2024).\n\nRead the v2 HTML for the new intro.\n\nCheck Table 1 numbers.');
    expect(note.titleObj.str).toBe(AUTHOR);
    const [, , w, h] = out.pages[0].view;
    expect(note.rect[0]).toBeLessThan(40);
    expect(note.rect[3]).toBeGreaterThan(h - 40);
    expect(note.rect[2]).toBeLessThan(w / 2);
    expect(highlightsOn(out.pages[1])).toHaveLength(1);
  });

  it('works on rotated pages: quads stay in page space and the note goes to the shown top-left', async () => {
    const rotated = await PDFDocument.load(sample, { updateMetadata: false });
    rotated.getPage(0).setRotation(degrees(270));
    rotated.getPage(1).setRotation(degrees(90));
    const rotatedBytes = await rotated.save();
    const quote = 'Filtered attention improves retrieval recall';
    const start = base.text.indexOf(quote);
    const mk = () => pdfHighlight(base.text, start, start + quote.length);

    const plain = await inspect((await annotatePdf(sample, [mk()], { pdfjs, docParams })).bytes);
    const res = await annotatePdf(rotatedBytes, [mk()], { pdfjs, paperNote: 'Rotated', docParams });
    expect(res).toMatchObject({ placed: 1, missed: [] });
    const out = await inspect(res.bytes);
    expect(Array.from(highlightsOn(out.pages[1])[0].quadPoints)).toEqual(Array.from(highlightsOn(plain.pages[1])[0].quadPoints));

    // page 1 is shown turned 270 degrees, so its top-left corner is the page's top-right
    const [note] = out.pages[0].annots.filter((a) => a.subtype === 'Text');
    const [, , w, h] = out.pages[0].view;
    expect(note.rect[2]).toBeLessThanOrEqual(w);
    expect(note.rect[0]).toBeGreaterThan(w - 40);
    expect(note.rect[3]).toBeGreaterThan(h - 40);
  });

  it('leaves encrypted PDFs untouched and reports every annotation as missed', async () => {
    const bytes = fixture('encrypted.pdf');
    const a = annotation('protected with an owner password', { medium: 'html' });
    const n = annotation(null, { note: 'A paper note' });
    const res = await annotatePdf(bytes, [a, n], { pdfjs, docParams });
    expect(res.placed).toBe(0);
    expect(res.missed).toEqual([a.id, n.id]);
    expect(res.reason).toBe('encrypted');
    expect(res.bytes).toEqual(bytes);
  });

  it('sets the title and leaves the page text alone', async () => {
    const a = annotation('which keeps training cheap', { medium: 'html' });
    const res = await annotatePdf(sample, [a], { pdfjs, title: 'Filtered Attention: notes (v1)', docParams });
    const out = await inspect(res.bytes);
    expect(out.title).toBe('Filtered Attention: notes (v1)');
    expect(out.text).toBe(base.text);
    expect(out.pages.map((p) => p.view)).toEqual(base.pages.map((p) => p.view));
  });

  it('skips deleted annotations and returns the file as is when there is nothing to add', async () => {
    const a = annotation('which keeps training cheap', { medium: 'html', deleted: true });
    const res = await annotatePdf(sample, [a], { pdfjs, docParams });
    expect(res).toMatchObject({ placed: 0, missed: [] });
    expect(res.bytes).toBe(sample);
  });

  it('escapes PDF string syntax and keeps non-ASCII notes intact', async () => {
    const note = 'Why (really)? \\ see "Table 1" → θ ≠ τ';
    const a = annotation('which keeps training cheap', { medium: 'html', label: 'weakness', note });
    const res = await annotatePdf(sample, [a], { pdfjs, author: 'José Müller', docParams });
    const out = await inspect(res.bytes);
    const [h] = out.pages.flatMap(highlightsOn);
    expect(h.contentsObj.str).toBe(`Weakness\n${note}`);
    expect(h.titleObj.str).toBe('José Müller');
  });
});

describe('pdfFileName', () => {
  const paper = (p: Partial<Paper>) => ({ id: 'arxiv:2401.00001', citeKey: '', ...p }) as Paper;
  it('uses the cite key', () => {
    expect(pdfFileName(paper({ citeKey: 'lovelace2024filtered' }))).toBe('lovelace2024filtered.pdf');
  });
  it('replaces characters filesystems reject', () => {
    expect(pdfFileName(paper({ citeKey: 'Smith:2024/a b?' }))).toBe('Smith-2024-a-b.pdf');
    expect(pdfFileName(paper({ citeKey: 'müller2021divergence' }))).toBe('müller2021divergence.pdf');
    expect(pdfFileName(paper({ citeKey: '..hidden' }))).toBe('hidden.pdf');
    expect(pdfFileName(paper({ citeKey: 'CON' }))).toBe('CON-paper.pdf');
  });
  it('falls back to the arXiv id or the paper id', () => {
    expect(pdfFileName(paper({ arxivId: '2401.00001' }))).toBe('2401.00001.pdf');
    expect(pdfFileName(paper({}))).toBe('arxiv-2401.00001.pdf');
    expect(pdfFileName(paper({ id: '' }))).toBe('paper.pdf');
  });
});
