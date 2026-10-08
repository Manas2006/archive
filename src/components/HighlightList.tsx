import { useMemo, useState } from 'react';
import * as repo from '@/lib/repo';
import { labelOf, noteOf } from '@/lib/exports';
import { positionOf, quoteOf } from '@/lib/anchoring/text';
import { HIGHLIGHT_LABELS, type Annotation, type HighlightLabel } from '@/lib/types';
import { LABEL_SWATCH } from '@/lib/anchoring/highlighter';
import { AutoSaveTextarea, LabelDot, cx, timeAgo } from './common';
import { Icon } from './Icon';

export function setLabelBody(a: Annotation, label: HighlightLabel): Annotation['body'] {
  return [...a.body.filter((b) => b.purpose !== 'tagging'), { type: 'TextualBody', purpose: 'tagging', value: label }];
}

export function setNoteBody(a: Annotation, note: string): Annotation['body'] {
  const rest = a.body.filter((b) => b.purpose !== 'commenting');
  return note.trim() ? [...rest, { type: 'TextualBody', purpose: 'commenting', value: note, format: 'text/markdown' }] : rest;
}

export function LabelPicker({ value, onChange }: { value: HighlightLabel; onChange: (l: HighlightLabel) => void }) {
  return (
    <div className="flex items-center gap-1">
      {HIGHLIGHT_LABELS.map((l) => (
        <button
          key={l.id}
          type="button"
          title={l.name}
          onClick={() => onChange(l.id)}
          className={cx('flex h-5 w-5 items-center justify-center rounded-full transition hover:scale-110', value === l.id && 'ring-2 ring-stone-700 ring-offset-1 dark:ring-white dark:ring-offset-stone-900')}
          style={{ background: LABEL_SWATCH[l.id] }}
        />
      ))}
    </div>
  );
}

function HighlightCard({ a, orphan, onJump, onExplain }: { a: Annotation; orphan?: boolean; onJump?: (id: string) => void; onExplain?: (a: Annotation) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const label = labelOf(a);
  const note = noteOf(a);
  const quote = quoteOf(a.target.selector)?.exact.replace(/\s+/g, ' ').trim() ?? '';
  const long = quote.length > 260;
  return (
    <li className="group relative rounded-md border border-stone-200 bg-white py-2 pl-3 pr-2 dark:border-stone-700 dark:bg-stone-900">
      <span className="absolute inset-y-1.5 left-0 w-1 rounded-full" style={{ background: LABEL_SWATCH[label] }} />
      <button
        type="button"
        className={cx('block w-full text-left text-[13px] leading-relaxed text-stone-800 dark:text-stone-100', !onJump && 'cursor-text')}
        onClick={() => onJump?.(a.id)}
        title={onJump ? 'Jump to highlight' : undefined}
      >
        {long && !expanded ? `${quote.slice(0, 260)}…` : quote}
      </button>
      {long && (
        <button type="button" className="mt-0.5 text-xs text-stone-500 hover:text-stone-800" onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
      {editing ? (
        <div className="mt-2">
          <AutoSaveTextarea value={note} rows={2} placeholder="Add a note (Markdown)…" onSave={(v) => repo.setAnnotationNote(a.id, v)} />
          <button type="button" className="mt-1 text-xs text-stone-500 hover:text-stone-800" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      ) : note ? (
        <button type="button" className="mt-1.5 block w-full rounded bg-stone-50 px-2 py-1 text-left text-[13px] text-stone-700 dark:bg-stone-800 dark:text-stone-200" onClick={() => setEditing(true)}>
          {note}
        </button>
      ) : null}
      <div className="mt-1.5 flex items-center gap-2">
        <LabelPicker value={label} onChange={(l) => repo.setAnnotationLabel(a.id, l)} />
        <span className="ml-auto text-xs text-stone-400">{orphan ? 'Not placed on this version' : timeAgo(a.createdAt)}</span>
        <div className="flex items-center opacity-70 transition group-hover:opacity-100">
          {!note && !editing && (
            <button type="button" className="mg-btn-ghost px-1 py-0.5" title="Add note" onClick={() => setEditing(true)}>
              <Icon name="note" size={14} />
            </button>
          )}
          {onExplain && (
            <button type="button" className="mg-btn-ghost px-1 py-0.5" title="Explain with AI" onClick={() => onExplain(a)}>
              <Icon name="sparkle" size={14} />
            </button>
          )}
          <button type="button" className="mg-btn-ghost px-1 py-0.5 hover:text-rose-600" title="Delete highlight" onClick={() => repo.deleteAnnotation(a.id)}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}

export function HighlightList({
  annotations,
  orphanIds,
  onJump,
  onExplain,
}: {
  annotations: Annotation[];
  orphanIds?: string[];
  onJump?: (id: string) => void;
  onExplain?: (a: Annotation) => void;
}) {
  const [filter, setFilter] = useState<HighlightLabel | 'all'>('all');
  const highlights = useMemo(
    () =>
      annotations
        .filter((a) => a.target.selector)
        .sort((a, b) => (positionOf(a.target.selector)?.start ?? 0) - (positionOf(b.target.selector)?.start ?? 0) || a.createdAt.localeCompare(b.createdAt)),
    [annotations],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const a of highlights) c[labelOf(a)] = (c[labelOf(a)] ?? 0) + 1;
    return c;
  }, [highlights]);
  const orphans = new Set(orphanIds ?? []);
  const shown = highlights.filter((a) => filter === 'all' || labelOf(a) === filter);
  const placed = shown.filter((a) => !orphans.has(a.id));
  const unplaced = shown.filter((a) => orphans.has(a.id));

  if (!highlights.length) {
    return (
      <div className="px-4 py-8 text-center text-sm text-stone-500 dark:text-stone-400">
        Select text on the paper to highlight it. Pick a label (Problem, Method, Result, Interesting, Weakness) to feed your factoid.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1">
        <button type="button" className={cx('mg-chip', filter === 'all' && 'border-stone-400 bg-white font-semibold dark:bg-stone-700')} onClick={() => setFilter('all')}>
          All {highlights.length}
        </button>
        {HIGHLIGHT_LABELS.filter((l) => counts[l.id]).map((l) => (
          <button key={l.id} type="button" className={cx('mg-chip', filter === l.id && 'border-stone-400 bg-white font-semibold dark:bg-stone-700')} onClick={() => setFilter(l.id)}>
            <LabelDot label={l.id} size={8} /> {l.name} {counts[l.id]}
          </button>
        ))}
      </div>
      <ul className="flex flex-col gap-2">
        {placed.map((a) => (
          <HighlightCard key={a.id} a={a} onJump={onJump} onExplain={onExplain} />
        ))}
      </ul>
      {unplaced.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-300">
            <Icon name="alert" size={13} /> Couldn't place {unplaced.length} on this version of the paper
          </div>
          <ul className="flex flex-col gap-2 opacity-80">
            {unplaced.map((a) => (
              <HighlightCard key={a.id} a={a} orphan onExplain={onExplain} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
