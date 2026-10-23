// The text selection behind the highlight toolbar, for mouse, keyboard, touch and pen.
//
// Mouse and keyboard selections show the toolbar on mouseup/keyup. Touch and pen
// selections (phones, iPads, Apple Pencil) never send a mouseup, so the toolbar
// appears once `selectionchange` has been quiet for a moment. Tapping the toolbar
// collapses the native selection before the tap's click arrives, so a collapse
// right after a pointerdown on our own UI is ignored; the toolbar acts on its
// saved copy of the range.

import { useEffect, useRef, useState } from 'react';
import type { Rect } from '@/components/annot/Floating';

export type PointerKind = 'mouse' | 'touch' | 'pen';

export interface TextSelection {
  range: Range;
  rect: Rect;
  /** How the selection was made; touch and pen get a larger toolbar below the selection. */
  pointer: PointerKind;
}

const SETTLE_MS = 350;
const UI_TAP_MS = 800;

let lastPointer: PointerKind = 'mouse';
let lastUiPointerAt = 0;
let tracking = false;

/** Is the event inside Archive's own floating UI (toolbar, popovers, the content script's shadow root)? */
export function inArchiveUi(e: Event): boolean {
  return e.composedPath().some((n) => (n as Element).hasAttribute?.('data-mg-ui'));
}

function trackPointers() {
  if (tracking) return;
  tracking = true;
  const onPointer = (e: PointerEvent) => {
    lastPointer = e.pointerType === 'touch' || e.pointerType === 'pen' ? e.pointerType : 'mouse';
    if (inArchiveUi(e)) lastUiPointerAt = Date.now();
  };
  document.addEventListener('pointerdown', onPointer, true);
  if (typeof PointerEvent === 'undefined') {
    // very old WebKit: touch events only
    document.addEventListener(
      'touchstart',
      (e) => {
        lastPointer = (e.touches[0] as Touch & { touchType?: string })?.touchType === 'stylus' ? 'pen' : 'touch';
        if (inArchiveUi(e)) lastUiPointerAt = Date.now();
      },
      { capture: true, passive: true },
    );
  }
}

export function lastPointerKind(): PointerKind {
  return lastPointer;
}

const toRect = (r: DOMRect): Rect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** Mouse: the first line (the toolbar sits above it). Touch: the whole selection (the toolbar goes below, clear of the OS callout). */
export function selectionRect(range: Range, pointer: PointerKind = 'mouse'): Rect {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (pointer === 'mouse' || !rects.length) return toRect(rects[0] ?? range.getBoundingClientRect());
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const right = Math.max(...rects.map((r) => r.right));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

export interface UseTextSelectionOptions {
  enabled: boolean;
  /** Is this range part of the paper text (and not Archive's own UI)? */
  accept: (range: Range) => boolean;
  /** Where to listen for scrolling (default: window). */
  scrollTarget?: () => EventTarget | null;
  /** On scroll: hide the toolbar, or keep it next to the selection. 'auto' hides it for mouse selections only. */
  onScroll?: 'clear' | 'follow' | 'auto';
}

export function useTextSelection(opts: UseTextSelectionOptions): [TextSelection | null, (s: TextSelection | null) => void] {
  const [sel, setSel] = useState<TextSelection | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const selRef = useRef(sel);
  selRef.current = sel;

  useEffect(() => {
    if (!opts.enabled) return;
    trackPointers();
    let settle: ReturnType<typeof setTimeout> | undefined;

    const read = (): TextSelection | null => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount || s.toString().trim().length < 2) return null;
      const range = s.getRangeAt(0);
      if (!optsRef.current.accept(range)) return null;
      return { range: range.cloneRange(), rect: selectionRect(range, lastPointer), pointer: lastPointer };
    };
    const check = () => setSel(read());

    const onUp = (e: Event) => {
      if (inArchiveUi(e)) return;
      setTimeout(check, 10);
    };
    const onSelChange = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) {
        clearTimeout(settle);
        // a tap on the toolbar collapses the selection just before its click: keep the toolbar for that click
        if (Date.now() - lastUiPointerAt < UI_TAP_MS) return;
        setSel(null);
        return;
      }
      if (lastPointer === 'mouse') return; // mouseup and keyup take it from here
      // touch or pen: hide while the handles move, show once the selection settles
      if (selRef.current) setSel(null);
      clearTimeout(settle);
      settle = setTimeout(check, SETTLE_MS);
    };
    // a tap elsewhere after the selection is gone (touch leaves no selectionchange then)
    const onDown = (e: PointerEvent) => {
      if (!selRef.current || inArchiveUi(e)) return;
      const s = window.getSelection();
      if (!s || s.isCollapsed) setSel(null);
    };
    let raf = 0;
    const onScroll = () => {
      const cur = selRef.current;
      if (!cur) return;
      const mode = optsRef.current.onScroll ?? 'follow';
      if (mode === 'clear' || (mode === 'auto' && cur.pointer === 'mouse')) {
        setSel(null);
        return;
      }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setSel((c) => (c ? { ...c, rect: selectionRect(c.range, c.pointer) } : c)));
    };

    const scroller = optsRef.current.scrollTarget?.() ?? window;
    document.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    document.addEventListener('selectionchange', onSelChange);
    document.addEventListener('pointerdown', onDown);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(settle);
      cancelAnimationFrame(raf);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onUp);
      document.removeEventListener('selectionchange', onSelChange);
      document.removeEventListener('pointerdown', onDown);
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [opts.enabled]);

  return [sel, setSel];
}
