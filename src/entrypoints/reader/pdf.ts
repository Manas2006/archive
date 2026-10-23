// PDF.js setup and PDF annotation anchoring for the reader page.

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { TextIndex } from '@/lib/anchoring/dom';
import { anchorQuote, describeQuote, normalize, positionOf, quoteOf, type Normalized } from '@/lib/anchoring/text';
import { highlightRange, removeHighlight, setHighlightAttrs, type HighlightHandle } from '@/lib/anchoring/highlighter';
import { annotationAttrs } from '@/lib/anchoring/annotator';
import { isIOS, isTouchDevice } from '@/lib/platform';
import type { Annotation, Selector } from '@/lib/types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
// pdf_viewer.mjs reads the library from globalThis
(globalThis as any).pdfjsLib = pdfjsLib;

export type Viewer = any; // pdfjs PDFViewer
export type EventBusT = any;

export async function createViewer(container: HTMLDivElement, viewerEl: HTMLDivElement) {
  const { PDFViewer, EventBus, PDFLinkService } = await import('pdfjs-dist/web/pdf_viewer.mjs');
  const eventBus: EventBusT = new EventBus();
  const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 });
  const viewer: Viewer = new PDFViewer({
    container,
    viewer: viewerEl,
    eventBus,
    linkService,
    textLayerMode: 1,
    removePageBorders: false,
    annotationMode: pdfjsLib.AnnotationMode.ENABLE,
    // phones and tablets run out of canvas memory on zoomed pages (blank pages on iOS); pdf.js's own viewer uses 5 MP there
    ...(isTouchDevice() || isIOS() ? { maxCanvasPixels: 5242880 } : {}),
  });
  linkService.setViewer(viewer);
  return { viewer, eventBus, linkService };
}

/**
 * Two-finger pinch zoom on touch screens. pdf.js scales the pages with CSS during
 * the gesture and redraws them once it settles. Returns a function that turns it off.
 */
export function enablePinchZoom(container: HTMLElement, viewer: Viewer, min = 0.4, max = 4): () => void {
  const TouchManager = (pdfjsLib as any).TouchManager;
  if (typeof TouchManager !== 'function') return () => {};
  const ac = new AbortController();
  let factor = 1;
  try {
    new TouchManager({
      container,
      signal: ac.signal,
      onPinchStart: () => {
        factor = 1;
      },
      onPinching: (origin: [number, number], prevDistance: number, distance: number) => {
        factor *= distance / prevDistance;
        const cur: number = viewer.currentScale;
        const want = cur * factor;
        const next = Math.max(min, Math.min(max, Math.round(want * 100) / 100));
        if (next === cur) {
          if (want < min || want > max) factor = 1; // at the limit: don't bank the extra
          return;
        }
        factor = want / next;
        viewer.updateScale({ drawingDelay: 400, scaleFactor: next / cur, origin });
      },
    });
  } catch {
    return () => {}; // older browsers (no AbortSignal.any): the browser's own zoom still works
  }
  // Safari zooms the whole page on its own gesture events unless they're cancelled
  container.addEventListener('gesturestart', (e) => e.preventDefault(), { signal: ac.signal });
  return () => ac.abort();
}

export async function loadPdf(src: string, onProgress?: (loaded: number, total: number) => void): Promise<PDFDocumentProxy> {
  return openPdf(await fetchPdfData(src, onProgress));
}

/** Download a PDF (with progress), checking that it really is one. */
export async function fetchPdfData(src: string, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  // send OpenReview cookies so PDFs visible to the signed-in user (e.g. during review) load too
  const res = await fetch(src, { credentials: /^https:\/\/openreview\.net\//.test(src) ? 'include' : 'same-origin' });
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('This PDF needs you to be signed in.'), { status: res.status });
  if (!res.ok) throw new Error(`Couldn't download the PDF (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  let data: Uint8Array;
  if (res.body && total) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.(loaded, total);
    }
    data = new Uint8Array(loaded);
    let o = 0;
    for (const c of chunks) {
      data.set(c, o);
      o += c.length;
    }
  } else {
    data = new Uint8Array(await res.arrayBuffer());
  }
  const head = new TextDecoder().decode(data.slice(0, 1024));
  if (!head.includes('%PDF')) throw new Error("That link didn't return a PDF.");
  return data;
}

/** Open PDF bytes with pdf.js. pdf.js takes ownership of the buffer, so pass a copy if you need it later. */
export function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjsLib.getDocument({
    data,
    cMapUrl: chrome.runtime.getURL('/pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('/pdfjs/standard_fonts/'),
    isEvalSupported: false,
  }).promise;
}

export interface PageText {
  text: string;
  /** offsets (within the page) where a text-layer line ends; used to put spaces back into quotes */
  eols: number[];
}

/** Page texts exactly as the text layer will render them (same options as PDFViewer). */
export async function pageTexts(doc: PDFDocumentProxy): Promise<PageText[]> {
  const out: PageText[] = new Array(doc.numPages);
  const work = Array.from({ length: doc.numPages }, (_, i) => i);
  const worker = async () => {
    for (let i = work.shift(); i !== undefined; i = work.shift()) {
      const page = await doc.getPage(i + 1);
      const tc = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
      let text = '';
      const eols: number[] = [];
      for (const it of tc.items as any[]) {
        if (typeof it.str !== 'string') continue;
        text += it.str;
        if (it.hasEOL) eols.push(text.length);
      }
      out[i] = { text, eols };
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

/** Readable text for AI: page texts with line structure approximated from item EOLs. */
export async function readableText(doc: PDFDocumentProxy): Promise<string> {
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let s = '';
    for (const it of tc.items as any[]) {
      if (typeof it.str !== 'string') continue;
      s += it.str;
      if (it.hasEOL) s += s.endsWith('-') ? '' : ' ';
    }
    parts.push(s.replace(/-\s(?=[a-z])/g, '').replace(/\s+/g, ' ').trim());
  }
  return parts.join('\n\n');
}

/** The passage a link asked to show (not an annotation; it fades after a few seconds). */
const FLASH_ID = 'mg-find';

interface AnchorInfo {
  start: number;
  end: number;
  attrs: Record<string, string>;
  sig: string;
}

export class PdfAnnotator {
  readonly docText: string;
  readonly pageStarts: number[];
  readonly pages: string[];
  private eolSet = new Set<number>();
  private norm: Normalized | null = null;
  private anchors = new Map<string, AnchorInfo>();
  private orphans = new Set<string>();
  private rendered = new Map<number, Map<string, HighlightHandle>>();

  constructor(
    private viewer: Viewer,
    pageData: PageText[],
    readonly version?: number,
  ) {
    this.pages = pageData.map((p) => p.text);
    this.pageStarts = [];
    let pos = 0;
    for (const p of pageData) {
      this.pageStarts.push(pos);
      for (const e of p.eols) this.eolSet.add(pos + e);
      pos += p.text.length + 1; // "\n" between pages
    }
    this.docText = this.pages.join('\n');
  }

  /**
   * Text between two offsets with spaces restored at line ends (the text layer has none),
   * for quotes people read. Anchoring ignores whitespace, so this doesn't affect matching.
   */
  readable(start: number, end: number): string {
    const t = this.docText;
    let out = '';
    for (let i = start; i < end; i++) {
      if (i > start && this.eolSet.has(i) && !/\s/.test(t[i - 1]) && !/\s/.test(t[i]) && t[i - 1] !== '-') out += ' ';
      out += t[i];
    }
    return out;
  }

  private normalized() {
    if (!this.norm) this.norm = normalize(this.docText);
    return this.norm;
  }

  textLayerDiv(pageIndex: number): HTMLElement | null {
    const pv = this.viewer.getPageView(pageIndex);
    const div: HTMLElement | undefined = pv?.textLayer?.div;
    return div && div.isConnected && div.childNodes.length ? div : null;
  }

  pageOfOffset(off: number): number {
    let lo = 0;
    let hi = this.pageStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pageStarts[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private anchor(a: Annotation): { start: number; end: number } | null {
    const quote = quoteOf(a.target.selector);
    if (!quote) return null;
    const same = a.target.state?.medium === 'pdf' && (this.version === undefined || a.target.state?.version === undefined || a.target.state.version === this.version);
    return anchorQuote(this.docText, quote, same ? positionOf(a.target.selector) : null, this.normalized());
  }

  setAnnotations(annotations: Annotation[]) {
    const wanted = new Map(annotations.filter((a) => a.target.selector && !a.deletedAt).map((a) => [a.id, a] as const));
    for (const id of [...this.anchors.keys()]) {
      if (!wanted.has(id) && id !== FLASH_ID) {
        this.anchors.delete(id);
        this.removeRendered(id);
      }
    }
    for (const id of [...this.orphans]) if (!wanted.has(id)) this.orphans.delete(id);
    for (const [id, a] of wanted) {
      const attrs = annotationAttrs(a);
      const sig = JSON.stringify(attrs);
      const cur = this.anchors.get(id);
      if (cur) {
        if (cur.sig !== sig) {
          cur.attrs = attrs;
          cur.sig = sig;
          for (const map of this.rendered.values()) {
            const h = map.get(id);
            if (h) setHighlightAttrs(h, attrs);
          }
        }
        continue;
      }
      if (this.orphans.has(id)) continue;
      const r = this.anchor(a);
      if (r) this.anchors.set(id, { ...r, attrs, sig });
      else this.orphans.add(id);
    }
    this.renderAll();
  }

  /** Add a just-created annotation at known offsets. */
  addAt(id: string, start: number, end: number, a: Annotation) {
    const attrs = annotationAttrs(a);
    this.anchors.set(id, { start, end, attrs, sig: JSON.stringify(attrs) });
    this.renderAll();
  }

  rename(tempId: string, realId: string) {
    const a = this.anchors.get(tempId);
    if (a) {
      this.anchors.delete(tempId);
      this.anchors.set(realId, a);
    }
    for (const map of this.rendered.values()) {
      const h = map.get(tempId);
      if (!h) continue;
      map.delete(tempId);
      h.id = realId;
      for (const el of h.elements) el.setAttribute('data-mg-id', realId);
      map.set(realId, h);
    }
  }

  removeRendered(id: string) {
    for (const map of this.rendered.values()) {
      const h = map.get(id);
      if (h) {
        removeHighlight(h);
        map.delete(id);
      }
    }
  }

  removeOne(id: string) {
    this.anchors.delete(id);
    this.removeRendered(id);
  }

  renderAll() {
    const n = this.pages.length;
    for (let i = 0; i < n; i++) if (this.textLayerDiv(i)) this.renderPage(i);
  }

  renderPage(i: number) {
    const div = this.textLayerDiv(i);
    if (!div) return;
    let map = this.rendered.get(i);
    if (!map) this.rendered.set(i, (map = new Map()));
    for (const [id, h] of [...map]) if (!h.elements.some((e) => e.isConnected)) map.delete(id);
    const ps = this.pageStarts[i];
    const pe = ps + this.pages[i].length;
    const todo = [...this.anchors].filter(([id, a]) => !map!.has(id) && a.start < pe && a.end > ps);
    if (!todo.length) return;
    const index = new TextIndex(div);
    const exact = index.text === this.pages[i];
    const local: [string, AnchorInfo, number, number][] = [];
    for (const [id, a] of todo) {
      let ls = Math.max(0, a.start - ps);
      let le = Math.min(this.pages[i].length, a.end - ps);
      if (!exact) {
        // text layer differs slightly (rare): locate the slice by quote within this page
        const slice = this.pages[i].slice(ls, le);
        const r = anchorQuote(index.text, { type: 'TextQuoteSelector', exact: slice, prefix: '', suffix: '' }, null);
        if (!r) continue;
        ls = r.start;
        le = r.end;
      }
      if (le > ls) local.push([id, a, ls, le]);
    }
    // resolve each against a fresh index right before wrapping (overlaps would collapse live ranges)
    for (const [id, a, ls, le] of local) {
      const range = new TextIndex(div).offsetsToRange(ls, le);
      if (!range) continue;
      const h = highlightRange(range, div, id, a.attrs);
      if (h.elements.length) map.set(id, h);
    }
  }

  private pageIndexOf(node: Node): number | null {
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const page = el?.closest('.page') as HTMLElement | null;
    const n = Number(page?.dataset.pageNumber);
    return Number.isFinite(n) && n > 0 ? n - 1 : null;
  }

  private offsetOf(container: Node, offset: number): number | null {
    const p = this.pageIndexOf(container);
    if (p === null) return null;
    const div = this.textLayerDiv(p);
    if (!div) return null;
    return this.pageStarts[p] + new TextIndex(div).pointToOffset(container, offset);
  }

  describe(range: Range): { selectors: Selector[]; start: number; end: number; page: number } | null {
    let start = this.offsetOf(range.startContainer, range.startOffset);
    let end = this.offsetOf(range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) return null;
    const t = this.docText;
    while (start < end && /\s/.test(t[start])) start++;
    while (end > start && /\s/.test(t[end - 1])) end--;
    if (end <= start) return null;
    const [quote, position] = describeQuote(t, start, end);
    const C = 32;
    quote.exact = this.readable(start, end);
    quote.prefix = this.readable(Math.max(0, start - C), start);
    quote.suffix = this.readable(end, Math.min(t.length, end + C));
    return { selectors: [quote, position], start, end, page: this.pageOfOffset(start) + 1 };
  }

  get orphanIds() {
    return [...this.orphans];
  }

  elementsFor(id: string): Element[] {
    const out: Element[] = [];
    for (const map of this.rendered.values()) {
      const h = map.get(id);
      if (h) out.push(...h.elements.filter((e) => e.isConnected));
    }
    return out;
  }

  focus(id: string | null) {
    for (const map of this.rendered.values()) for (const [hid, h] of map) for (const el of h.elements) el.classList.toggle('mg-focus', hid === id);
  }

  /** Scroll to an annotation, rendering its page first if needed. */
  scrollTo(id: string): boolean {
    const a = this.anchors.get(id);
    if (!a) return false;
    const pulse = () => {
      const els = this.elementsFor(id);
      if (!els.length) return false;
      els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      els.forEach((el) => {
        el.classList.add('mg-pulse');
        setTimeout(() => el.classList.remove('mg-pulse'), 2000);
      });
      return true;
    };
    if (pulse()) return true;
    this.viewer.scrollPageIntoView({ pageNumber: this.pageOfOffset(a.start) + 1 });
    let tries = 0;
    const timer = setInterval(() => {
      if (pulse() || ++tries > 30) clearInterval(timer);
    }, 150);
    return true;
  }

  /** Scroll to a quoted passage and flash it for a few seconds (links from "Ask your library"). */
  showQuote(exact: string): boolean {
    const r = anchorQuote(this.docText, { type: 'TextQuoteSelector', exact, prefix: '', suffix: '' }, null, this.normalized());
    if (!r) return false;
    const id = FLASH_ID;
    this.removeOne(id);
    const flash = { id, body: [{ type: 'TextualBody', purpose: 'tagging', value: 'plain' }], target: { source: '', selector: [] } } as unknown as Annotation;
    this.addAt(id, r.start, r.end, flash);
    this.scrollTo(id);
    setTimeout(() => this.removeOne(id), 4000);
    return true;
  }

  /** Offset where the references section starts (for reading progress), or the end. */
  referencesPage(): number {
    for (let i = Math.floor(this.pages.length * 0.4); i < this.pages.length; i++) {
      if (/\b(References|Bibliography)\b/.test(this.pages[i])) return i;
    }
    return this.pages.length - 1;
  }
}
