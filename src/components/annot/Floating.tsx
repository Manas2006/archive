import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

/** Position a floating element near a viewport rect, flipping above/below and clamping to the viewport. */
export function Floating({ rect, children, prefer = 'above', className = '', onMouseEnter, onMouseLeave, keepSelection }: { rect: Rect; children: ReactNode; prefer?: 'above' | 'below'; className?: string; onMouseEnter?: () => void; onMouseLeave?: () => void; keepSelection?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 8;
    let top = prefer === 'above' ? rect.top - h - gap : rect.top + rect.height + gap;
    if (prefer === 'above' && top < 8) top = rect.top + rect.height + gap;
    if (prefer === 'below' && top + h > vh - 8) top = Math.max(8, rect.top - h - gap);
    top = Math.max(8, Math.min(top, vh - h - 8));
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));
    setPos({ left, top });
  }, [rect.left, rect.top, rect.width, rect.height, prefer, children]);
  return (
    <div
      ref={ref}
      data-mg-ui
      className={cx('fixed z-[2147483600]', className)}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      onMouseDown={keepSelection ? (e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'TEXTAREA' && tag !== 'INPUT' && tag !== 'SELECT') e.preventDefault();
      } : undefined}
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
  onLabel,
  onNote,
  onExplain,
  onEvidence,
}: {
  rect: Rect;
  ai: boolean;
  onLabel: (l: HighlightLabel) => void;
  onNote: () => void;
  onExplain: () => void;
  onEvidence: () => void;
}) {
  return (
    <Floating rect={rect} keepSelection>
      <div className="flex items-center gap-0.5 rounded-lg border border-stone-200 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900">
        {HIGHLIGHT_LABELS.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onLabel(l.id)}
            title={`${l.name} (${l.key})`}
            className="group flex h-7 items-center gap-1 rounded px-1.5 text-xs text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            <span className="h-3.5 w-3.5 rounded-full ring-1 ring-black/5" style={{ background: LABEL_SWATCH[l.id] }} />
            {l.id !== 'plain' && <span className="hidden group-hover:inline">{l.name}</span>}
          </button>
        ))}
        <span className="mx-0.5 h-5 w-px bg-stone-200 dark:bg-stone-700" />
        <button type="button" onClick={onNote} title="Highlight and add a note" className="flex h-7 items-center gap-1 rounded px-1.5 text-xs text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800">
          <Icon name="note" size={14} /> Note
        </button>
        {ai && (
          <>
            <button type="button" onClick={onExplain} title="Explain this passage" className="flex h-7 items-center gap-1 rounded px-1.5 text-xs text-accent-800 hover:bg-accent-50 dark:text-accent-200 dark:hover:bg-accent-900/40">
              <Icon name="sparkle" size={14} /> Explain
            </button>
            <button type="button" onClick={onEvidence} title="Where's the evidence for this claim?" className="flex h-7 items-center gap-1 rounded px-1.5 text-xs text-accent-800 hover:bg-accent-50 dark:text-accent-200 dark:hover:bg-accent-900/40">
              <Icon name="search" size={14} /> Evidence
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
      <div className="w-80 rounded-lg border border-stone-200 bg-white p-3 shadow-xl dark:border-stone-700 dark:bg-stone-900">
        <div className="flex items-center gap-2">
          <LabelPicker value={label} onChange={onLabel} />
          <span className="text-xs text-stone-500">{HIGHLIGHT_LABELS.find((l) => l.id === label)?.name}</span>
          <button type="button" className="ml-auto text-stone-400 hover:text-stone-700 dark:hover:text-white" onClick={onClose} aria-label="Close">
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
            <button type="button" className="mg-btn-ghost px-1.5 py-0.5 text-xs" onClick={() => setEditing(true)}>
              <Icon name="note" size={13} /> Add note
            </button>
          )}
          {ai && (
            <button type="button" className="mg-btn-ghost px-1.5 py-0.5 text-xs" onClick={onExplain}>
              <Icon name="sparkle" size={13} /> Explain
            </button>
          )}
          <button type="button" className="mg-btn-ghost ml-auto px-1.5 py-0.5 text-xs hover:text-rose-600" onClick={onDelete}>
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
              <button type="button" className="mg-btn-ghost px-1.5 py-0.5 text-xs" onClick={onOpenPanel} title="Continue in the side panel">
                <Icon name="panel" size={13} />
              </button>
            )}
            <button type="button" className="mg-btn-ghost px-1.5 py-0.5" onClick={onClose} aria-label="Close">
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
