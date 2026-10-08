import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { READING_STATUSES, type HighlightLabel, type Paper, type ReadingStatus } from '@/lib/types';
import { LABEL_SWATCH } from '@/lib/anchoring/highlighter';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin text-current" aria-label="Loading">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export const STATUS_STYLE: Record<ReadingStatus, string> = {
  inbox: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200',
  toread: 'bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  reading: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  read: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
};

export function StatusSelect({ value, onChange, size = 'md' }: { value: ReadingStatus; onChange: (s: ReadingStatus) => void; size?: 'sm' | 'md' }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ReadingStatus)}
      className={cx(
        'cursor-pointer rounded-md border border-transparent font-medium focus:outline-none focus:ring-2 focus:ring-accent-200',
        size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm',
        STATUS_STYLE[value],
      )}
      aria-label="Reading status"
    >
      {READING_STATUSES.map((s) => (
        <option key={s.id} value={s.id}>
          {s.label}
        </option>
      ))}
    </select>
  );
}

export function WillCiteButton({ value, onChange, compact }: { value: boolean; onChange: (v: boolean) => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={cx(
        'inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium transition',
        value
          ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-100'
          : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-stone-800',
      )}
      title={value ? 'Marked to cite' : 'Mark to cite'}
      aria-pressed={value}
    >
      <Icon name="star" size={15} className={value ? 'fill-amber-400 text-amber-500' : ''} />
      {!compact && (value ? 'Will cite' : 'Cite')}
    </button>
  );
}

export function VenueBadge({ paper }: { paper: Paper }) {
  if (paper.venueStatus === 'accepted' && paper.venue) {
    return <span className="rounded bg-accent-50 px-1.5 py-0.5 text-xs font-medium text-accent-800 dark:bg-accent-900/40 dark:text-accent-100">{paper.venue}</span>;
  }
  if (paper.venueStatus === 'under-review') {
    return <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">Under review</span>;
  }
  if (paper.venueStatus === 'rejected') {
    return <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">Not accepted</span>;
  }
  if (paper.arxivId) return <span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">arXiv preprint</span>;
  return null;
}

export function authorLine(paper: Paper, max = 4): string {
  const names = paper.authors.map((a) => a.name);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max - 1).join(', ')}, … ${names[names.length - 1]}`;
}

export function LabelDot({ label, size = 10 }: { label: HighlightLabel; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: LABEL_SWATCH[label] }} />;
}

export function CopyButton({ text, getText, label = 'Copy', className = 'mg-btn', onCopied }: { text?: string; getText?: () => Promise<void> | void; label?: string; className?: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        if (getText) await getText();
        else if (text !== undefined) await navigator.clipboard.writeText(text);
        setDone(true);
        onCopied?.();
        setTimeout(() => setDone(false), 1400);
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={14} />
      {done ? 'Copied' : label}
    </button>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; hidden?: boolean }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="flex gap-0.5 border-b border-stone-200 px-2 dark:border-stone-700" role="tablist">
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={value === t.id}
            onClick={() => onChange(t.id)}
            className={cx(
              '-mb-px border-b-2 px-2.5 py-2 text-sm font-medium transition',
              value === t.id
                ? 'border-accent-600 text-stone-900 dark:text-white'
                : 'border-transparent text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100',
            )}
          >
            {t.label}
          </button>
        ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-stone-900/40 p-4 pt-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('mg-card w-full shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')} role="dialog" aria-modal>
        <div className="flex items-center justify-between border-b border-stone-200 px-4 py-3 dark:border-stone-700">
          <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">{title}</h2>
          <button className="mg-btn-ghost" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ icon = 'book', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center text-stone-500 dark:text-stone-400">
      <Icon name={icon} size={28} className="text-stone-300 dark:text-stone-600" />
      <div className="text-sm font-medium text-stone-700 dark:text-stone-200">{title}</div>
      {children && <div className="max-w-xs text-sm">{children}</div>}
    </div>
  );
}

/** Textarea that saves after typing pauses. */
export function AutoSaveTextarea({ value, onSave, placeholder, rows = 3, className = '' }: { value: string; onSave: (v: string) => void; placeholder?: string; rows?: number; className?: string }) {
  const [v, setV] = useState(value);
  const [state, setState] = useState<'idle' | 'dirty' | 'saved'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const last = useRef(value);
  useEffect(() => {
    if (value !== last.current) {
      setV(value);
      last.current = value;
    }
  }, [value]);
  const flush = (next: string) => {
    if (next === last.current) return;
    last.current = next;
    onSave(next);
    setState('saved');
    setTimeout(() => setState('idle'), 1200);
  };
  return (
    <div className="relative">
      <textarea
        className={cx('mg-input resize-y leading-relaxed', className)}
        rows={rows}
        value={v}
        placeholder={placeholder}
        onChange={(e) => {
          setV(e.target.value);
          setState('dirty');
          clearTimeout(timer.current);
          const next = e.target.value;
          timer.current = setTimeout(() => flush(next), 700);
        }}
        onBlur={() => {
          clearTimeout(timer.current);
          flush(v);
        }}
      />
      {state === 'saved' && <span className="absolute bottom-2 right-2 text-xs text-stone-400">Saved</span>}
    </div>
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; description?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start justify-between gap-4', disabled && 'opacity-60')}>
      <span>
        <span className="block text-sm font-medium text-stone-900 dark:text-stone-100">{label}</span>
        {description && <span className="mt-0.5 block text-sm text-stone-500 dark:text-stone-400">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 inline-flex h-6 w-11 shrink-0 rounded-full transition', checked ? 'bg-accent-600' : 'bg-stone-300 dark:bg-stone-600')}
      >
        <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </label>
  );
}
