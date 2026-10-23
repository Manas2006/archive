import { useEffect, useState } from 'react';
import { Modal, Spinner } from '@/components/common';
import { Icon } from '@/components/Icon';
import * as repo from '@/lib/repo';
import { revokeProjectBibLink } from '@/lib/projectBib';
import { rpc } from '@/lib/rpc';
import { parseArxivId, parsePaperUrl } from '@/lib/ids';
import { mergeTopics } from '@/lib/topics';
import { rescoreLibrary, updatePriorities } from '@/lib/enrich';
import type { Project, Topic } from '@/lib/types';
import { go, type Row } from './shared';

export function ProjectDialog({ open, onClose, project, rows }: { open: boolean; onClose: () => void; project: Project | null; rows: Row[] }) {
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [seeds, setSeeds] = useState<string[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (open) {
      setName(project?.name ?? '');
      setDesc(project?.description ?? '');
      setSeeds(project?.seedPaperIds ?? []);
      setQ('');
    }
  }, [open, project]);
  const matches = q.trim() ? rows.filter((r) => r.paper.title.toLowerCase().includes(q.toLowerCase()) && !seeds.includes(r.paper.id)).slice(0, 6) : [];
  const byId = new Map(rows.map((r) => [r.paper.id, r.paper] as const));
  return (
    <Modal open={open} onClose={onClose} title={project ? 'Edit project' : 'New project'}>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          let id = project?.id;
          if (project) await repo.updateProject(project.id, { name: name.trim(), description: desc.trim(), seedPaperIds: seeds });
          else id = (await repo.createProject({ name, description: desc, seedPaperIds: seeds })).id;
          // seed papers belong to the project
          for (const s of seeds) {
            const r = rows.find((x) => x.paper.id === s);
            if (r && !r.entry.projectIds.includes(id!)) await repo.updateEntry(s, { projectIds: [...r.entry.projectIds, id!] });
          }
          onClose();
          go({ kind: 'project', id: id! });
          // suggest existing papers that fit the new or edited project
          void rescoreLibrary().then(updatePriorities);
        }}
      >
        <label className="block">
          <span className="text-sm font-medium">Name</span>
          <input className="mg-input mt-1" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Safety decay in long-horizon agents" />
        </label>
        <label className="block">
          <span className="text-sm font-medium">One-sentence description</span>
          <span className="block text-xs text-stone-500">Used to judge how relevant new papers are.</span>
          <textarea className="mg-input mt-1" rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Whether tool-use agents get less careful about safety over long episodes, and planning-based fixes." />
        </label>
        <div>
          <span className="text-sm font-medium">Seed papers</span>
          <span className="block text-xs text-stone-500">A few papers that define the project. New saves are compared against them.</span>
          <div className="mt-2 flex flex-col gap-1">
            {seeds.map((id) => (
              <div key={id} className="flex items-center gap-2 rounded bg-stone-50 px-2 py-1 text-sm dark:bg-stone-800">
                <span className="flex-1 truncate">{byId.get(id)?.title ?? id}</span>
                <button type="button" onClick={() => setSeeds(seeds.filter((s) => s !== id))} className="text-stone-400 hover:text-stone-700">
                  <Icon name="x" size={13} />
                </button>
              </div>
            ))}
            <input className="mg-input mt-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your library to add a seed paper…" />
            {matches.map((r) => (
              <button key={r.paper.id} type="button" className="truncate rounded px-2 py-1 text-left text-sm hover:bg-stone-100 dark:hover:bg-stone-800" onClick={() => setSeeds([...seeds, r.paper.id])}>
                + {r.paper.title}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-between">
          {project ? (
            <button
              type="button"
              className="mg-btn-ghost text-rose-700"
              onClick={async () => {
                if (confirm(`Delete the project "${project.name}"? Papers stay in your library.`)) {
                  if (project.driveBib?.publicLink) {
                    try {
                      await revokeProjectBibLink(project);
                    } catch (e) {
                      const ok = confirm(
                        `Archive couldn't turn off the public link to this project's .bib file (${(e as Error).message}). Delete the project anyway? The file stays shared until you change its sharing in Google Drive.`,
                      );
                      if (!ok) return;
                    }
                  }
                  await repo.deleteProject(project.id);
                  onClose();
                  go({ kind: 'status', status: 'inbox' });
                }
              }}
            >
              Delete project
            </button>
          ) : (
            <span />
          )}
          <button type="submit" className="mg-btn-primary" disabled={!name.trim()}>
            {project ? 'Save' : 'Create project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function TopicMenu({ topic, topics, onClose }: { topic: Topic; topics: Topic[]; onClose: () => void }) {
  const [name, setName] = useState(topic.name);
  const [mergeInto, setMergeInto] = useState('');
  return (
    <Modal open onClose={onClose} title="Topic">
      <div className="flex flex-col gap-4">
        <label className="block">
          <span className="text-sm font-medium">Name</span>
          <div className="mt-1 flex gap-2">
            <input className="mg-input" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="mg-btn" disabled={!name.trim() || name === topic.name} onClick={() => repo.putTopic({ ...topic, name: name.trim(), nameSource: 'user' }).then(onClose)}>
              Rename
            </button>
          </div>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={topic.pinned} onChange={(e) => repo.putTopic({ ...topic, pinned: e.target.checked })} />
          Pin this topic (keep its papers together when topics are re-sorted)
        </label>
        <label className="block">
          <span className="text-sm font-medium">Merge into another topic</span>
          <div className="mt-1 flex gap-2">
            <select className="mg-input" value={mergeInto} onChange={(e) => setMergeInto(e.target.value)}>
              <option value="">Choose…</option>
              {topics
                .filter((t) => t.id !== topic.id)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
            <button
              className="mg-btn"
              disabled={!mergeInto}
              onClick={async () => {
                await mergeTopics(mergeInto, topic.id);
                onClose();
                go({ kind: 'topic', id: mergeInto });
              }}
            >
              <Icon name="merge" size={14} /> Merge
            </button>
          </div>
        </label>
      </div>
    </Modal>
  );
}

/** Turn what someone typed or pasted into a save request. */
export function parseAddInput(s: string) {
  const parsed = parsePaperUrl(s);
  const ax = !parsed ? parseArxivId(s) : null;
  const orMatch = !parsed && !ax ? s.match(/^[A-Za-z0-9_-]{8,}$/) : null;
  return parsed ? { url: s } : ax ? { paperId: `arxiv:${ax.id}` } : orMatch ? { paperId: `openreview:${s}` } : { url: s };
}

export function AddPaper({ onAdded, className = '' }: { onAdded: (id: string) => void; className?: string }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className={`flex flex-wrap items-center gap-1.5 ${className}`}
      onSubmit={async (e) => {
        e.preventDefault();
        const s = v.trim();
        if (!s) return;
        setBusy(true);
        setErr(null);
        try {
          const res = await rpc.savePaper(parseAddInput(s));
          setV('');
          onAdded(res.paperId);
        } catch (e2) {
          setErr((e2 as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input className="mg-input min-w-0 py-1 md:w-48 xl:w-64" value={v} onChange={(e) => setV(e.target.value)} placeholder="Add by arXiv ID or URL" title={err ?? undefined} inputMode="url" />
      <button className="mg-btn shrink-0" type="submit" disabled={busy || !v.trim()} aria-label="Add paper">
        {busy ? <Spinner /> : <Icon name="plus" size={14} />}
      </button>
      {err && <span className="w-full max-w-sm text-xs text-rose-700">{err}</span>}
    </form>
  );
}
