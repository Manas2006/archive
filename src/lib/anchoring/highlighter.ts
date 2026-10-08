// Wraps ranges in <mark> elements. MathML can't contain <mark>, so math inside a
// highlighted range gets a class on the <math> element instead.

import { isSkipped } from './dom';

export const HL_CLASS = 'mg-hl';
export const HL_MATH_CLASS = 'mg-hl-math';

export interface HighlightHandle {
  id: string;
  elements: Element[];
  mathElements: Element[];
}

function textNodesInRange(range: Range, root: Node): Text[] {
  const container = range.commonAncestorContainer;
  const base = container.nodeType === Node.TEXT_NODE ? container.parentNode! : container;
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(base, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
      if (!range.intersectsNode(n)) return NodeFilter.FILTER_REJECT;
      if (isSkipped(n.parentElement, root)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  if (container.nodeType === Node.TEXT_NODE) return [container as Text];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

const BLOCKISH = /^(TABLE|TBODY|THEAD|TR|UL|OL|DL|SECTION|ARTICLE|DIV|FIGURE)$/;

export function highlightRange(input: Range, root: Node, id: string, attrs: Record<string, string> = {}): HighlightHandle {
  // Split boundary text nodes so marks cover exactly the range. Boundaries are tracked
  // explicitly rather than relying on live-range updates during splitText.
  let sc = input.startContainer;
  let so = input.startOffset;
  let ec = input.endContainer;
  let eo = input.endOffset;
  if (ec.nodeType === Node.TEXT_NODE && eo > 0 && eo < (ec.nodeValue ?? '').length) {
    (ec as Text).splitText(eo);
  }
  if (sc.nodeType === Node.TEXT_NODE && so > 0 && so < (sc.nodeValue ?? '').length) {
    const tail = (sc as Text).splitText(so);
    if (ec === sc) {
      ec = tail;
      eo -= so;
    }
    sc = tail;
    so = 0;
  }
  const range = (root.ownerDocument ?? (root as Document)).createRange();
  range.setStart(sc, so);
  range.setEnd(ec, eo);
  const nodes = textNodesInRange(range, root).filter((n) => {
    // skip nodes entirely outside after splitting
    if (n === range.startContainer && range.startOffset >= (n.nodeValue ?? '').length) return false;
    if (n === range.endContainer && range.endOffset === 0) return false;
    // whitespace between block elements: wrapping it breaks table/list layout
    if (!/\S/.test(n.nodeValue ?? '') && n.parentElement && BLOCKISH.test(n.parentElement.tagName)) return false;
    return true;
  });
  const handle: HighlightHandle = { id, elements: [], mathElements: [] };
  const doc = root.ownerDocument ?? (root as Document);
  for (const node of nodes) {
    const math = node.parentElement?.closest('math');
    if (math) {
      if (!handle.mathElements.includes(math)) {
        math.classList.add(HL_MATH_CLASS);
        const ids = (math.getAttribute('data-mg-ids') ?? '').split(' ').filter(Boolean);
        ids.push(id);
        math.setAttribute('data-mg-ids', ids.join(' '));
        for (const [k, v] of Object.entries(attrs)) math.setAttribute(k, v);
        handle.mathElements.push(math);
      }
      continue;
    }
    const mark = doc.createElement('mark');
    mark.className = HL_CLASS;
    mark.setAttribute('data-mg-id', id);
    for (const [k, v] of Object.entries(attrs)) mark.setAttribute(k, v);
    node.parentNode!.insertBefore(mark, node);
    mark.appendChild(node);
    handle.elements.push(mark);
  }
  return handle;
}

export function removeHighlight(handle: HighlightHandle) {
  for (const mark of handle.elements) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    (parent as Element).normalize?.();
  }
  for (const math of handle.mathElements) {
    const ids = (math.getAttribute('data-mg-ids') ?? '').split(' ').filter((x) => x && x !== handle.id);
    if (ids.length) math.setAttribute('data-mg-ids', ids.join(' '));
    else {
      math.removeAttribute('data-mg-ids');
      math.classList.remove(HL_MATH_CLASS);
    }
  }
  handle.elements = [];
  handle.mathElements = [];
}

export function setHighlightAttrs(handle: HighlightHandle, attrs: Record<string, string | null>) {
  for (const el of [...handle.elements, ...handle.mathElements]) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null) el.removeAttribute(k);
      else el.setAttribute(k, v);
    }
  }
}

/** Ids of highlights at an element (innermost first). */
export function highlightIdsAt(target: Element | null): string[] {
  const ids: string[] = [];
  for (let e = target; e; e = e.parentElement) {
    if (e.classList?.contains(HL_CLASS)) ids.push(e.getAttribute('data-mg-id')!);
    if (e.classList?.contains(HL_MATH_CLASS)) ids.push(...(e.getAttribute('data-mg-ids') ?? '').split(' ').filter(Boolean));
  }
  return [...new Set(ids)];
}

/** Page CSS for highlights. Injected into the document (marks live outside the shadow root). */
export const HIGHLIGHT_CSS = `
mark.mg-hl, math.mg-hl-math {
  background-color: var(--mg-c, rgba(250, 204, 21, 0.42));
  color: inherit;
  border-radius: 2px;
  cursor: pointer;
  padding: 0;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
  transition: background-color 120ms ease, box-shadow 120ms ease;
}
[data-mg-label="plain"] { --mg-c: rgba(250, 204, 21, 0.42); }
[data-mg-label="problem"] { --mg-c: rgba(244, 63, 94, 0.28); }
[data-mg-label="method"] { --mg-c: rgba(14, 165, 233, 0.28); }
[data-mg-label="result"] { --mg-c: rgba(34, 197, 94, 0.30); }
[data-mg-label="interesting"] { --mg-c: rgba(249, 115, 22, 0.32); }
[data-mg-label="weakness"] { --mg-c: rgba(139, 92, 246, 0.28); }
mark.mg-hl[data-mg-note="1"] { text-decoration: underline dotted rgba(0,0,0,.45); text-underline-offset: 3px; }
mark.mg-hl.mg-focus, math.mg-hl-math.mg-focus { box-shadow: 0 0 0 2px rgba(31, 95, 88, 0.85); }
@keyframes mg-pulse { 0% { box-shadow: 0 0 0 0 rgba(31,95,88,.7);} 100% { box-shadow: 0 0 0 10px rgba(31,95,88,0);} }
mark.mg-hl.mg-pulse { animation: mg-pulse 900ms ease-out 2; }
.textLayer mark.mg-hl { color: transparent; }
`;

export const LABEL_SWATCH: Record<string, string> = {
  plain: '#facc15',
  problem: '#f43f5e',
  method: '#0ea5e9',
  result: '#22c55e',
  interesting: '#f97316',
  weakness: '#8b5cf6',
};
