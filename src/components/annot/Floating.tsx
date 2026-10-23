import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type SyntheticEvent } from 'react';
import { HIGHLIGHT_LABELS, type Annotation, type HighlightLabel } from '@/lib/types';
import { LABEL_SWATCH } from '@/lib/anchoring/highlighter';
import { labelOf, noteOf } from '@/lib/exports';
import { quoteOf } from '@/lib/anchoring/text';
import { Icon } from '../Icon';
import { AutoSaveTextarea, cx } from '../common';
import { LabelPicker } from '../HighlightList';
import { ThreadView, type useThread } from '../ThreadView';

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Buttons get at least a 40px touch target on phones and tablets. */
const TOUCH_TARGET = '[@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10';

const FORM_TAGS = new Set(['TEXTAREA', 'INPUT', 'SELECT']);

/** Keep the text selection when a toolbar button is pressed (mouse, touch or pen). */
function keepSelectionHandler(e: SyntheticEvent) {
  if (!FORM_TAGS.has((e.target as HTMLElement).tagName)) e.preventDefault();
}

/** The visible part of the page (pinch zoom and the on-screen keyboard shrink it on phones), in layout-viewport px. */
function visibleArea() {
  const vv = window.visualViewport;
  return vv
    ? { x: vv.offsetLeft, y: vv.offsetTop, w: vv.width, h: vv.height }
    : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
}

/** Position a floating element near a viewport rect, flipping above/below and clamping to the visible viewport. */
export function Floating({
  rect,
  children,
  prefer = 'above',
  gap = 8,
  className = '',
  onMouseEnter,
  onMouseLeave,
  keepSelection,
}: {
  rect: Rect;
  children: ReactNode;
  prefer?: 'above' | 'below';
  /** Space between the rect and the element (touch selections need room for the selection handles). */
  gap?: number;
  className?: string;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  keepSelection?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const h = () => setViewportTick((t) => t + 1);
    vv.addEventListener('resize', h);
    vv.addEventListener('scroll', h);
    return () => {
      vv.removeEventListener('resize', h);
      vv.removeEventListener('scroll', h);
    };
  }, []);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const v = visibleArea();
    const m = 8;
    let top = prefer === 'above' ? rect.top - h - gap : rect.top + rect.height + gap;
    if (prefer === 'above' && top < v.y + m) top = rect.top + rect.height + gap;
    if (prefer === 'below' && top + h > v.y + v.h - m) top = Math.max(v.y + m, rect.top - h - gap);
    top = Math.max(v.y + m, Math.min(top, v.y + v.h - h - m));
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(v.x + m, Math.min(left, v.x + v.w - w - m));
    setPos({ left, top });
  }, [rect.left, rect.top, rect.width, rect.height, prefer, gap, children, viewportTick]);
  return (
    <div
      ref={ref}
      data-mg-ui
      className={cx('fixed z-[2147483600]', className)}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseDown={keepSelection ? keepSelectionHandler : undefined}
      // touch and pen: mouse events come too late (or not at all); the click still arrives
      onPointerDown={keepSelection ? (e: ReactPointerEvent) => e.pointerType !== 'mouse' && keepSelectionHandler(e) : undefined}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
    </div>
  );
}

export function SelectionToolbar({
  rect,
  ai,
  touch = false,
  onLabel,
  onNote,
  onExplain,
  onEvidence,
}: {
  rect: Rect;
  ai: boolean;
  /** Selection made by touch or pen: bigger buttons, placed below the selection (the OS shows its own menu above). */
  touch?: boolean;
  onLabel: (l: HighlightLabel) => void;
  onNote: () => void;
  onExplain: () => void;
  onEvidence: () => void;
}) {
  const btn = touch ? 'h-10 min-w-10 justify-center px-2' : 'h-7 px-1.5';
  return (
    <Floating rect={rect} keepSelection prefer={touch ? 'below' : 'above'} gap={touch ? 28 : 8}>
      <div
        data-mg-toolbar
        className={cx(
          'flex items-center gap-0.5 rounded-lg border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900',
          touch && 'max-w-[calc(100vw-16px)] flex-wrap justify-center',
        )}
      >
        {HIGHLIGHT_LABELS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onLabel(l.id)}
            title={`${l.name} (${l.key})`}
            aria-label={l.name}
            className={cx('group flex items-center gap-1 rounded text-xs text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800', btn)}
          >
            <span className={cx('rounded-full ring-1 ring-black/5', touch ? 'h-5 w-5' : 'h-3.5 w-3.5')} style={{ background: LABEL_SWATCH[l.id] }} />
            {l.id !== 'plain' && <span className={touch ? 'hidden sm:inline' : 'hidden group-hover:inline'}>{l.name}</span>}
          </button>
        ))}
        <span className="mx-0.5 h-5 w-px bg-stone-200 dark:bg-stone-700" />
        <button type="button" onClick={onNote} title="Highlight and add a note" className={cx('flex items-center gap-1 rounded text-xs text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800', btn)}>
          <Icon name="note" size={touch ? 16 : 14} /> Note
        </button>
        {ai && (
          <>
            <button type="button" onClick={onExplain} title="Explain this passage" className={cx('flex items-center gap-1 rounded text-xs text-accent-800 hover:bg-accent-50 dark:text-accent-200 dark:hover:bg-accent-900/40', btn)}>
              <Icon name="sparkle" size={touch ? 16 : 14} /> Explain
            </button>
            <button type="button" onClick={onEvidence} title="Where's the evidence for this claim?" className={cx('flex items-center gap-1 rounded text-xs text-accent-800 hover:bg-accent-50 dark:text-accent-200 dark:hover:bg-accent-900/40', btn)}>
              <Icon name="search" size={touch ? 16 : 14} /> Evidence
            </button>
          </>
        )}
      </div>
    </Floating>
  );
}

export function HighlightPopover({
  rect,
  annotation,
  ai,
  startEditing,
  onLabel,
  onNote,
  onDelete,
  onExplain,
  onClose,
}: {
  rect: Rect;
  annotation: Annotation;
  ai: boolean;
  startEditing?: boolean;
  onLabel: (label: HighlightLabel) => void;
  onNote: (note: string) => void;
  onDelete: () => void;
  onExplain: () => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState(!!startEditing || !!noteOf(annotation));
  const label = labelOf(annotation);
  return (
    <Floating rect={rect} prefer="below">
      <div className="w-80 max-w-[calc(100vw-16px)] rounded-lg border border-stone-200 bg-white p-3 shadow-xl dark:border-stone-700 dark:bg-stone-900">
        <div className="flex items-center gap-2">
          <LabelPicker value={label} onChange={onLabel} />
          <span className="text-xs text-stone-500">{HIGHLIGHT_LABELS.find((l) => l.id === label)?.name}</span>
          <button type="button" className={cx('ml-auto inline-flex items-center justify-center text-stone-400 hover:text-stone-700 dark:hover:text-white', TOUCH_TARGET)} onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
        {editing ? (
          <div className="mt-2">
            <AutoSaveTextarea value={noteOf(annotation)} rows={3} placeholder="Note (Markdown)…" onSave={onNote} />
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-1">
          {!editing && (
            <button type="button" className={cx('mg-btn-ghost px-1.5 py-0.5 text-xs', TOUCH_TARGET)} onClick={() => setEditing(true)}>
              <Icon name="note" size={13} /> Add note
            </button>
          )}
          {ai && (
            <button type="button" className={cx('mg-btn-ghost px-1.5 py-0.5 text-xs', TOUCH_TARGET)} onClick={onExplain}>
              <Icon name="sparkle" size={13} /> Explain
            </button>
          )}
          <button type="button" className={cx('mg-btn-ghost ml-auto px-1.5 py-0.5 text-xs hover:text-rose-600', TOUCH_TARGET)} onClick={onDelete}>
            <Icon name="trash" size={13} /> Delete
          </button>
        </div>
      </div>
    </Floating>
  );
}

export function AiPopover({ rect, t, title, onClose, onOpenPanel }: { rect: Rect; t: ReturnType<typeof useThread>; title: string; onClose: () => void; onOpenPanel?: () => void }) {
  return (
    <Floating rect={rect} prefer="below">
      <div className="flex max-h-[min(70vh,560px)] w-[440px] max-w-[calc(100vw-16px)] flex-col rounded-lg border border-stone-200 bg-white shadow-2xl dark:border-stone-700 dark:bg-stone-900">
        <div className="flex items-center gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-700">
          <Icon name="sparkle" size={14} className="text-accent-600" />
          <span className="text-sm font-semibold">{title}</span>
          <div className="ml-auto flex items-center gap-1">
            {onOpenPanel && (
              <button type="button" className={cx('mg-btn-ghost px-1.5 py-0.5 text-xs', TOUCH_TARGET)} onClick={onOpenPanel} title="Continue in the side panel">
                <Icon name="panel" size={13} />
              </button>
            )}
            <button type="button" className={cx('mg-btn-ghost px-1.5 py-0.5', TOUCH_TARGET)} onClick={onClose} aria-label="Close">
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto px-3 py-3">
          <ThreadView t={t} compact />
        </div>
      </div>
    </Floating>
  );
}

export function quoteText(a: Annotation): string {
  return quoteOf(a.target.selector)?.exact ?? '';
}
