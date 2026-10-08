import { useEffect, useRef, useState } from 'react';
import * as repo from '@/lib/repo';
import type { LibraryEntry, Project } from '@/lib/types';
import { Icon } from './Icon';
import { cx } from './common';

export function ProjectChip({ project, onRemove, onClick }: { project: Project; onRemove?: () => void; onClick?: () => void }) {
  return (
    <span className="mg-chip">
      <span className="h-2 w-2 rounded-full" style={{ background: project.color }} />
      <button type="button" className="max-w-[160px] truncate" onClick={onClick} disabled={!onClick}>
        {project.name}
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-stone-400 hover:text-stone-700 dark:hover:text-white" aria-label={`Remove from ${project.name}`}>
          <Icon name="x" size={12} />
        </button>
      )}
    </span>
  );
}

/** Project chips, suggestions, and an add menu for one library entry. */
export function EntryProjects({ entry, projects }: { entry: LibraryEntry; projects: Project[] }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const byId = new Map(projects.map((p) => [p.id, p] as const));
  const assigned = entry.projectIds.map((id) => byId.get(id)).filter((p): p is Project => !!p);
  const suggestions = entry.suggestions.filter((s) => byId.has(s.projectId) && !entry.projectIds.includes(s.projectId));
  const available = projects.filter((p) => !entry.projectIds.includes(p.id));

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !e.composedPath().includes(ref.current)) setOpen(false);
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);

  const add = (id: string) =>
    repo.updateEntry(entry.paperId, {
      projectIds: [...new Set([...entry.projectIds, id])],
      suggestions: entry.suggestions.filter((s) => s.projectId !== id),
      dismissedProjectIds: entry.dismissedProjectIds.filter((x) => x !== id),
    });
  const remove = (id: string) =>
    repo.updateEntry(entry.paperId, { projectIds: entry.projectIds.filter((x) => x !== id), dismissedProjectIds: [...new Set([...entry.dismissedProjectIds, id])] });
  const dismiss = (id: string) =>
    repo.updateEntry(entry.paperId, { suggestions: entry.suggestions.filter((s) => s.projectId !== id), dismissedProjectIds: [...new Set([...entry.dismissedProjectIds, id])] });

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {assigned.map((p) => (
          <ProjectChip key={p.id} project={p} onRemove={() => remove(p.id)} />
        ))}
        <div className="relative" ref={ref}>
          <button type="button" className="mg-btn-ghost px-1.5 py-0.5 text-xs" onClick={() => setOpen((o) => !o)}>
            <Icon name="plus" size={13} /> Project
          </button>
          {open && (
            <div className="mg-card absolute left-0 top-full z-30 mt-1 w-60 p-1 shadow-lg">
              {available.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800"
                  onClick={() => {
                    add(p.id);
                    setOpen(false);
                  }}
                >
                  <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
              <form
                className="flex gap-1 border-t border-stone-200 p-1 pt-2 dark:border-stone-700"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!name.trim()) return;
                  const p = await repo.createProject({ name, seedPaperIds: [entry.paperId] });
                  await add(p.id);
                  setName('');
                  setOpen(false);
                }}
              >
                <input className="mg-input py-1 text-xs" placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} />
                <button className="mg-btn px-2 py-1 text-xs" type="submit">
                  Add
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
          <span>Suggested:</span>
          {suggestions.map((s) => {
            const p = byId.get(s.projectId)!;
            return (
              <span key={s.projectId} className={cx('mg-chip border-dashed')}>
                <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
                <span className="max-w-[140px] truncate">{p.name}</span>
                <span className="text-stone-400">{Math.round(s.score * 100)}%</span>
                <button type="button" onClick={() => add(s.projectId)} className="text-accent-700 hover:text-accent-900 dark:text-accent-300" title="Add">
                  <Icon name="check" size={12} />
                </button>
                <button type="button" onClick={() => dismiss(s.projectId)} className="text-stone-400 hover:text-stone-700" title="Not relevant">
                  <Icon name="x" size={12} />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
