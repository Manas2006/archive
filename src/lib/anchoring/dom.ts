// DOM text index: maps character offsets in a root's visible text to text nodes.

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'BUTTON', 'SELECT', 'TEMPLATE', 'IFRAME', 'svg', 'SVG',
  'annotation', 'annotation-xml', 'ANNOTATION', 'ANNOTATION-XML',
]);

export function isSkipped(el: Element | null, root: Node): boolean {
  for (let e = el; e && e !== root; e = e.parentElement) {
    if (SKIP_TAGS.has(e.tagName)) return true;
    if (e.hasAttribute('data-mg-ui')) return true;
    const cls = e.classList;
    if (cls && (cls.contains('sr-only') || cls.contains('ltx_page_logo') || cls.contains('mg-skip'))) return true;
  }
  return false;
}

export function textNodesUnder(root: Node, within?: Range): Text[] {
  const doc = root.ownerDocument ?? (root as Document);
  const skipCache = new Map<Element | null, boolean>();
  const skipped = (el: Element | null) => {
    let v = skipCache.get(el);
    if (v === undefined) skipCache.set(el, (v = isSkipped(el, root)));
    return v;
  };
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      if (skipped(n.parentElement)) return NodeFilter.FILTER_REJECT;
      if (within && !within.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

export class TextIndex {
  readonly nodes: Text[];
  readonly starts: number[];
  readonly text: string;

  constructor(readonly root: Node) {
    this.nodes = textNodesUnder(root);
    this.starts = new Array(this.nodes.length);
    let pos = 0;
    let text = '';
    for (let i = 0; i < this.nodes.length; i++) {
      this.starts[i] = pos;
      const v = this.nodes[i].nodeValue ?? '';
      text += v;
      pos += v.length;
    }
    this.text = text;
  }

  /** Offset of a DOM boundary point within the index text. */
  pointToOffset(container: Node, offset: number): number {
    if (container.nodeType === Node.TEXT_NODE) {
      const i = this.nodes.indexOf(container as Text);
      if (i >= 0) return this.starts[i] + Math.min(offset, (container.nodeValue ?? '').length);
    }
    // Find the first indexed text node at or after the point.
    const doc = this.root.ownerDocument ?? (this.root as Document);
    const r = doc.createRange();
    try {
      r.setStart(container, offset);
    } catch {
      return 0;
    }
    let lo = 0;
    let hi = this.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let cmp: number;
      try {
        cmp = r.comparePoint(this.nodes[mid], 0);
      } catch {
        cmp = 1;
      }
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo < this.nodes.length ? this.starts[lo] : this.text.length;
  }

  rangeToOffsets(range: Range): { start: number; end: number } | null {
    const start = this.pointToOffset(range.startContainer, range.startOffset);
    const end = this.pointToOffset(range.endContainer, range.endOffset);
    if (end <= start) return null;
    return { start, end };
  }

  private locate(offset: number, preferNext: boolean): { node: Text; offset: number } | null {
    if (!this.nodes.length) return null;
    let lo = 0;
    let hi = this.nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    let i = lo;
    const len = (n: number) => (this.nodes[n].nodeValue ?? '').length;
    if (preferNext) {
      while (i < this.nodes.length - 1 && offset - this.starts[i] >= len(i)) i++;
    } else {
      while (i > 0 && offset - this.starts[i] <= 0 && offset > 0) i--;
    }
    return { node: this.nodes[i], offset: Math.max(0, Math.min(len(i), offset - this.starts[i])) };
  }

  offsetsToRange(start: number, end: number): Range | null {
    const s = this.locate(start, true);
    const e = this.locate(end, false);
    if (!s || !e) return null;
    const doc = this.root.ownerDocument ?? (this.root as Document);
    const r = doc.createRange();
    r.setStart(s.node, s.offset);
    r.setEnd(e.node, e.offset);
    return r;
  }
}

/**
 * Text of a range with MathML replaced by its TeX source (for AI prompts and
 * quotes in exports), falling back to the plain string.
 */
export function rangeToReadableText(range: Range): string {
  const frag = range.cloneContents();
  frag.querySelectorAll('math').forEach((m) => {
    const tex = m.getAttribute('alttext');
    m.replaceWith(document.createTextNode(tex ? ` $${tex}$ ` : m.textContent ?? ''));
  });
  frag.querySelectorAll('button, .sr-only, script, style, [data-mg-ui]').forEach((n) => n.remove());
  return (frag.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function elementToReadableText(root: Element): string {
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('math').forEach((m) => {
    const tex = m.getAttribute('alttext');
    m.replaceWith(document.createTextNode(tex ? ` $${tex}$ ` : m.textContent ?? ''));
  });
  clone.querySelectorAll('button, .sr-only, script, style, nav, header, footer, [data-mg-ui], .ltx_page_footer, .ltx_bibliography').forEach((n) => n.remove());
  // keep paragraph structure
  clone.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, figcaption, .ltx_para, .ltx_caption, tr').forEach((n) => n.append(document.createTextNode('\n')));
  return (clone.textContent ?? '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
