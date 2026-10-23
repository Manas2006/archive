import { useEffect, useState } from 'react';
import { CopyButton, Modal, Spinner, cx } from '@/components/common';
import { Icon } from '@/components/Icon';
import { bibFile, download } from '@/lib/exports';
import type { Project } from '@/lib/types';
import { slug, type Row } from './shared';

type Which = 'project' | 'cite' | 'selected';

export function RelatedWorkDialog({ open, onClose, project, rows, selectedIds }: { open: boolean; onClose: () => void; project: Project | null; rows: Row[]; selectedIds?: string[] }) {
  const [which, setWhich] = useState<Which>('project');
  const [topic, setTopic] = useState('');
  const [style, setStyle] = useState<'paragraphs' | 'bullets'>('paragraphs');
  const [length, setLength] = useState<'short' | 'medium' | 'long'>('medium');
  const [format, setFormat] = useState<'latex' | 'markdown'>('latex');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [warn, setWarn] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText('');
      setWarn([]);
      setErr(null);
      setWhich(selectedIds?.length ? 'selected' : 'project');
    }
  }, [open]);

  const projectRows = project ? rows.filter((r) => r.entry.projectIds.includes(project.id)) : rows;
  const pick = (w: Which) => (w === 'selected' ? rows.filter((r) => selectedIds?.includes(r.paper.id)) : w === 'cite' ? projectRows.filter((r) => r.entry.willCite) : projectRows);
  const chosen = pick(which);

  const run = async () => {
    setBusy(true);
    setErr(null);
    setText('');
    setWarn([]);
    try {
      const { draftRelatedWork } = await import('@/lib/ai/library');
      const res = await draftRelatedWork(
        { paperIds: chosen.map((r) => r.paper.id), projectId: project?.id, topic: topic.trim() || undefined, style, length, format },
        { onText: (d) => setText((t) => t + d) },
      );
      setText(res.text);
      const w: string[] = [];
      if (res.unknownKeys.length) w.push(`Removed citations to keys that aren't in this set: ${res.unknownKeys.join(', ')}.`);
      if (res.missingKeys.length) w.push(`Not cited: ${res.missingKeys.join(', ')}.`);
      setWarn(w);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const seg = <T extends string>(value: T, set: (v: T) => void, options: [T, string][]) => (
    <div className="inline-flex rounded-md border border-stone-300 p-0.5 dark:border-stone-600">
      {options.map(([v, label]) => (
        <button key={v} type="button" onClick={() => set(v)} className={cx('rounded px-2 py-0.5 text-xs font-medium', value === v ? 'bg-stone-800 text-white dark:bg-stone-100 dark:text-stone-900' : 'text-stone-600 dark:text-stone-300')}>
          {label}
        </button>
      ))}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title="Draft related work" wide>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Claude groups the papers into themes and writes a related-work section from their abstracts and your highlights and notes. It only cites papers in the set, with your citation keys.
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="mg-label">Papers</span>
            <select className="mg-input" value={which} onChange={(e) => setWhich(e.target.value as Which)}>
              <option value="project">
                {project ? `All papers in ${project.name}` : 'All papers in this view'} ({projectRows.length})
              </option>
              <option value="cite">Only papers marked Will cite ({pick('cite').length})</option>
              {!!selectedIds?.length && <option value="selected">Selected papers ({selectedIds.length})</option>}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="mg-label">What your paper is about (optional)</span>
            <input className="mg-input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={project?.description || 'e.g. Detecting safety decay in long-horizon tool-use agents'} />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            {seg(style, setStyle, [
              ['paragraphs', 'Paragraphs'],
              ['bullets', 'Bullets'],
            ])}
            {seg(length, setLength, [
              ['short', 'Short'],
              ['medium', 'Medium'],
              ['long', 'Long'],
            ])}
            {seg(format, setFormat, [
              ['latex', 'LaTeX'],
              ['markdown', 'Markdown'],
            ])}
            <button className="mg-btn-primary ml-auto" disabled={busy || chosen.length < 2} onClick={run}>
              {busy ? <Spinner /> : <Icon name="sparkle" size={14} />} {text ? 'Redo' : 'Draft'}
            </button>
          </div>
          {chosen.length < 2 && <p className="text-xs text-stone-500">Pick at least two papers.</p>}
        </div>
        {err && <p className="text-sm text-rose-700">{err}</p>}
        {(text || busy) && (
          <div className="flex flex-col gap-2">
            <textarea className="mg-input min-h-[260px] font-mono text-xs leading-relaxed" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
            {warn.map((w) => (
              <p key={w} className="text-xs text-amber-800 dark:text-amber-200">
                {w}
              </p>
            ))}
            <div className="flex flex-wrap gap-2">
              <CopyButton text={text} label="Copy text" />
              <button className="mg-btn" onClick={() => download(`${slug(project?.name ?? 'related-work')}.bib`, bibFile(chosen.map((r) => r.paper)), 'application/x-bibtex')}>
                <Icon name="download" size={14} /> .bib for these papers
              </button>
            </div>
            <p className="text-xs text-stone-500">Check it against the papers before using it. Claude can still get details wrong.</p>
          </div>
        )}
      </div>
    </Modal>
  );
}
