// Renders a paper's annotations onto a DOM root and turns selections into
// annotations. Used on arXiv HTML pages (one root) and, per page, in the PDF reader.

import { TextIndex } from './dom';
import { anchorQuote, describeQuote, normalize, positionOf, quoteOf, type Normalized } from './text';
import { highlightRange, removeHighlight, setHighlightAttrs, type HighlightHandle } from './highlighter';
import type { Annotation, HighlightLabel, Selector } from '../types';

export function annotationAttrs(a: Annotation): Record<string, string> {
  const label = (a.body.find((b) => b.purpose === 'tagging')?.value ?? 'plain') as HighlightLabel;
  const note = a.body.find((b) => b.purpose === 'commenting')?.value;
  return { 'data-mg-label': label, 'data-mg-note': note ? '1' : '0' };
}

function signature(a: Annotation): string {
  return JSON.stringify(annotationAttrs(a));
}

export interface AnchorReport {
  anchored: string[];
  orphans: string[];
}

export class HtmlAnnotator {
  private handles = new Map<string, HighlightHandle>();
  private sigs = new Map<string, string>();
  private orphans = new Set<string>();
  private index: TextIndex | null = null;
  private norm: Normalized | null = null;

  constructor(
    readonly root: Element,
    readonly medium: 'html' | 'pdf' = 'html',
    readonly version?: number,
  ) {}

  private normFor = '';

  private getIndex(): TextIndex {
    if (!this.index) this.index = new TextIndex(this.root);
    return this.index;
  }

  /** Invalidate after the DOM changes (wrapping keeps text identical, but nodes change). */
  private dirty() {
    this.index = null;
  }

  get text(): string {
    return this.getIndex().text;
  }

  private normalized(): Normalized {
    const text = this.getIndex().text;
    if (!this.norm || this.normFor !== text) {
      this.norm = normalize(text);
      this.normFor = text;
    }
    return this.norm;
  }

  /** Bring the rendered highlights in line with `annotations`. */
  sync(annotations: Annotation[]): AnchorReport {
    const wanted = new Map(annotations.filter((a) => a.target.selector && !a.deletedAt).map((a) => [a.id, a] as const));
    // removals
    for (const [id, h] of this.handles) {
      if (!wanted.has(id)) {
        removeHighlight(h);
        this.handles.delete(id);
        this.sigs.delete(id);
        this.dirty();
      }
    }
    for (const id of [...this.orphans]) if (!wanted.has(id)) this.orphans.delete(id);
    // updates
    for (const [id, a] of wanted) {
      const h = this.handles.get(id);
      if (h && this.sigs.get(id) !== signature(a)) {
        setHighlightAttrs(h, annotationAttrs(a));
        this.sigs.set(id, signature(a));
      }
    }
    // additions: anchor everything to text offsets first (wrapping never changes the text, so
    // offsets stay valid), then resolve each offset pair against a fresh index right before
    // wrapping it. Holding live ranges across wraps would collapse nested/overlapping ones.
    const toAdd = [...wanted.values()].filter((a) => !this.handles.has(a.id) && !this.orphans.has(a.id));
    if (toAdd.length) {
      const index = this.getIndex();
      const placed: [Annotation, { start: number; end: number }][] = [];
      for (const a of toAdd) {
        const off = this.anchorOffsets(a, index);
        if (off) placed.push([a, off]);
        else this.orphans.add(a.id);
      }
      for (const [a, off] of placed) {
        const range = this.getIndex().offsetsToRange(off.start, off.end);
        const h = range ? highlightRange(range, this.root, a.id, annotationAttrs(a)) : null;
        this.dirty();
        if (h && (h.elements.length || h.mathElements.length)) {
          this.handles.set(a.id, h);
          this.sigs.set(a.id, signature(a));
        } else this.orphans.add(a.id);
      }
    }
    return { anchored: [...this.handles.keys()], orphans: [...this.orphans] };
  }

  /** Retry orphans (e.g. after more of the page loaded). */
  retryOrphans(annotations: Annotation[]): AnchorReport {
    this.orphans.clear();
    return this.sync(annotations);
  }

  private anchorOffsets(a: Annotation, index: TextIndex): { start: number; end: number } | null {
    const quote = quoteOf(a.target.selector);
    if (!quote) return null;
    const sameRendering = a.target.state?.medium === this.medium && (this.version === undefined || a.target.state?.version === undefined || a.target.state.version === this.version);
    const hint = sameRendering ? positionOf(a.target.selector) : null;
    return anchorQuote(index.text, quote, hint, this.normalized());
  }

  private anchor(a: Annotation, index: TextIndex): Range | null {
    const res = this.anchorOffsets(a, index);
    return res ? index.offsetsToRange(res.start, res.end) : null;
  }

  /** Describe a selection range as W3C selectors relative to this root. */
  describe(range: Range): Selector[] | null {
    const index = this.getIndex();
    const off = index.rangeToOffsets(range);
    if (!off) return null;
    // trim whitespace at the edges
    let { start, end } = off;
    const t = index.text;
    while (start < end && /\s/.test(t[start])) start++;
    while (end > start && /\s/.test(t[end - 1])) end--;
    if (end <= start) return null;
    return describeQuote(t, start, end);
  }

  /** Render a just-created annotation immediately (optimistic). */
  add(a: Annotation, range?: Range): boolean {
    this.orphans.delete(a.id);
    if (this.handles.has(a.id)) return true;
    const r = range ?? this.anchor(a, this.getIndex());
    if (!r) {
      this.orphans.add(a.id);
      return false;
    }
    const h = highlightRange(r, this.root, a.id, annotationAttrs(a));
    this.dirty();
    if (!h.elements.length && !h.mathElements.length) {
      this.orphans.add(a.id);
      return false;
    }
    this.handles.set(a.id, h);
    this.sigs.set(a.id, signature(a));
    return true;
  }

  /** Swap a temporary id for the stored one. */
  rename(tempId: string, realId: string) {
    const h = this.handles.get(tempId);
    if (!h) return;
    for (const el of h.elements) el.setAttribute('data-mg-id', realId);
    for (const m of h.mathElements) {
      const ids = (m.getAttribute('data-mg-ids') ?? '').split(' ').map((x) => (x === tempId ? realId : x));
      m.setAttribute('data-mg-ids', ids.join(' '));
    }
    h.id = realId;
    this.handles.delete(tempId);
    this.handles.set(realId, h);
    const sig = this.sigs.get(tempId);
    this.sigs.delete(tempId);
    if (sig) this.sigs.set(realId, sig);
  }

  removeOne(id: string) {
    const h = this.handles.get(id);
    if (h) {
      removeHighlight(h);
      this.handles.delete(id);
      this.sigs.delete(id);
      this.dirty();
    }
  }

  elementsFor(id: string): Element[] {
    const h = this.handles.get(id);
    return h ? [...h.elements, ...h.mathElements] : [];
  }

  has(id: string): boolean {
    return this.handles.has(id);
  }

  get orphanIds(): string[] {
    return [...this.orphans];
  }

  scrollTo(id: string): boolean {
    const els = this.elementsFor(id);
    if (!els.length) return false;
    els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    for (const el of els) {
      el.classList.add('mg-pulse');
      setTimeout(() => el.classList.remove('mg-pulse'), 2000);
    }
    return true;
  }

  focus(id: string | null) {
    for (const [hid, h] of this.handles) {
      for (const el of [...h.elements, ...h.mathElements]) el.classList.toggle('mg-focus', hid === id);
    }
  }

  destroy() {
    for (const h of this.handles.values()) removeHighlight(h);
    this.handles.clear();
    this.sigs.clear();
    this.orphans.clear();
    this.dirty();
  }
}
