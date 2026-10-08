import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/tailwind.css';
import { useLive } from '@/hooks/useLive';
import { useSettings } from '@/hooks/useSettings';
import { PaperDetail } from '@/components/PaperDetail';
import { EmptyState, Modal, Spinner, StatusSelect, VenueBadge, WillCiteButton, authorLine, cx, timeAgo, STATUS_STYLE } from '@/components/common';
import { Icon, Logo } from '@/components/Icon';
import { ProjectChip } from '@/components/ProjectPicker';
import * as repo from '@/lib/repo';
import { rpc } from '@/lib/rpc';
import { bibFile, download, noteOf } from '@/lib/exports';
import { quoteOf } from '@/lib/anchoring/text';
import { parseArxivId, parsePaperUrl } from '@/lib/ids';
import { mergeTopics, reclusterTopics } from '@/lib/topics';
import { rescoreLibrary, updatePriorities } from '@/lib/enrich';
import { READING_STATUSES, type LibraryEntry, type Paper, type Project, type ReadingStatus, type Topic } from '@/lib/types';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Row {
  paper: Paper;
  entry: LibraryEntry;
  highlights: number;
  searchText: string;
}

async function loadLibrary() {
  const [entries, projects, topics, annotations] = await Promise.all([repo.listEntries(), repo.listProjects(), repo.listTopics(), repo.listAllAnnotations()]);
  const papers = new Map((await repo.getPapers(entries.map((e) => e.paperId))).map((p) => [p.id, p] as const));
  const annByPaper = new Map<string, string[]>();
  const hlCount = new Map<string, number>();
  for (const a of annotations) {
    const list = annByPaper.get(a.paperId) ?? [];
    list.push(quoteOf(a.target.selector)?.exact ?? '', noteOf(a));
    annByPaper.set(a.paperId, list);
    if (a.target.selector) hlCount.set(a.paperId, (hlCount.get(a.paperId) ?? 0) + 1);
  }
  const rows: Row[] = [];
  for (const e of entries) {
    const p = papers.get(e.paperId);
    if (!p) continue;
    const x = p.extracted;
    rows.push({
      paper: p,
      entry: e,
      highlights: hlCount.get(p.id) ?? 0,
      searchText: [
        p.title,
        p.abstract,
        p.authors.map((a) => a.name).join(' '),
        p.venue ?? '',
        p.citeKey,
        p.arxivId ?? '',
        x ? [x.task, ...x.benchmarks, ...x.models, ...x.metrics, x.headlineResult].join(' ') : '',
        ...(annByPaper.get(p.id) ?? []),
        e.tags.join(' '),
      ]
        .join(' \n ')
        .toLowerCase(),
    });
  }
  return { rows, projects, topics };
}

// ---------------------------------------------------------------------------
// Views and columns
// ---------------------------------------------------------------------------

type View = { kind: 'status'; status: ReadingStatus } | { kind: 'all' } | { kind: 'cite' } | { kind: 'project'; id: string } | { kind: 'topic'; id: string } | { kind: 'untopiced' };

function parseHash(): { view: View; paper: string | null } {
  const h = new URLSearchParams(location.hash.slice(1));
  const paper = h.get('paper');
  if (h.get('project')) return { view: { kind: 'project', id: h.get('project')! }, paper };
  if (h.get('topic')) return { view: { kind: 'topic', id: h.get('topic')! }, paper };
  const v = h.get('view');
  if (v === 'all') return { view: { kind: 'all' }, paper };
  if (v === 'cite') return { view: { kind: 'cite' }, paper };
  if (v === 'untopiced') return { view: { kind: 'untopiced' }, paper };
  if (v && READING_STATUSES.some((s) => s.id === v)) return { view: { kind: 'status', status: v as ReadingStatus }, paper };
  return { view: paper ? { kind: 'all' } : { kind: 'status', status: 'inbox' }, paper };
}

function viewHash(v: View, paper?: string | null): string {
  const q = new URLSearchParams();
  if (v.kind === 'status') q.set('view', v.status);
  else if (v.kind === 'project') q.set('project', v.id);
  else if (v.kind === 'topic') q.set('topic', v.id);
  else q.set('view', v.kind);
  if (paper) q.set('paper', paper);
  return `#${q.toString()}`;
}

const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

type ColId = 'title' | 'year' | 'venue' | 'status' | 'projects' | 'topic' | 'task' | 'benchmarks' | 'models' | 'metrics' | 'result' | 'highlights' | 'progress' | 'priority' | 'added' | 'citekey';

const COLUMNS: { id: ColId; label: string; sortable: boolean; width?: string }[] = [
  { id: 'title', label: 'Paper', sortable: true },
  { id: 'year', label: 'Year', sortable: true, width: 'w-14' },
  { id: 'venue', label: 'Venue', sortable: true, width: 'w-36' },
  { id: 'status', label: 'Status', sortable: true, width: 'w-28' },
  { id: 'projects', label: 'Projects', sortable: false, width: 'w-44' },
  { id: 'topic', label: 'Topic', sortable: true, width: 'w-36' },
  { id: 'task', label: 'Task', sortable: true, width: 'w-44' },
  { id: 'benchmarks', label: 'Benchmarks', sortable: true, width: 'w-44' },
  { id: 'models', label: 'Models', sortable: true, width: 'w-40' },
  { id: 'metrics', label: 'Metrics', sortable: true, width: 'w-36' },
  { id: 'result', label: 'Headline result', sortable: false, width: 'w-64' },
  { id: 'highlights', label: 'Highlights', sortable: true, width: 'w-20' },
  { id: 'progress', label: 'Read', sortable: true, width: 'w-16' },
  { id: 'priority', label: 'Priority', sortable: true, width: 'w-20' },
  { id: 'added', label: 'Added', sortable: true, width: 'w-24' },
  { id: 'citekey', label: 'Cite key', sortable: true, width: 'w-40' },
];

const DEFAULT_COLS: ColId[] = ['title', 'year', 'venue', 'status', 'projects', 'topic', 'task', 'benchmarks', 'added'];

function loadCols(): ColId[] {
  try {
    const v = JSON.parse(localStorage.getItem('mg-cols') ?? 'null');
    if (Array.isArray(v) && v.includes('title')) return v;
  } catch {
    /* ignore */
  }
  return DEFAULT_COLS;
}

const STATUS_ORDER: Record<ReadingStatus, number> = { inbox: 0, toread: 1, reading: 2, read: 3 };

function sortValue(r: Row, col: ColId, topics: Map<string, Topic>): string | number {
  const x = r.paper.extracted;
  switch (col) {
    case 'title':
      return r.paper.title.toLowerCase();
    case 'year':
      return r.paper.year ?? 0;
    case 'venue':
      return (r.paper.venue ?? (r.paper.arxivId ? 'zz arxiv' : 'zzz')).toLowerCase();
    case 'status':
      return STATUS_ORDER[r.entry.status];
    case 'topic':
      return (r.entry.topicId ? topics.get(r.entry.topicId)?.name ?? '' : 'zzz').toLowerCase();
    case 'task':
      return (x?.task || 'zzz').toLowerCase();
    case 'benchmarks':
      return (x?.benchmarks.join(', ') || 'zzz').toLowerCase();
    case 'models':
      return (x?.models.join(', ') || 'zzz').toLowerCase();
    case 'metrics':
      return (x?.metrics.join(', ') || 'zzz').toLowerCase();
    case 'highlights':
      return r.highlights;
    case 'progress':
      return r.entry.progress;
    case 'priority':
      return r.entry.priority;
    case 'added':
      return r.entry.createdAt;
    case 'citekey':
      return r.paper.citeKey;
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function NavItem({ active, onClick, icon, label, count, color, extra }: { active: boolean; onClick: () => void; icon?: string; label: ReactNode; count?: number; color?: string; extra?: ReactNode }) {
  return (
    <div className={cx('group flex items-center rounded-md', active ? 'bg-stone-200/70 dark:bg-stone-800' : 'hover:bg-stone-100 dark:hover:bg-stone-900')}>
      <button onClick={onClick} className={cx('flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm', active ? 'font-semibold text-stone-900 dark:text-white' : 'text-stone-700 dark:text-stone-300')}>
        {color ? <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} /> : icon ? <Icon name={icon} size={15} className="text-stone-400" /> : null}
        <span className="truncate">{label}</span>
        {count !== undefined && <span className="ml-auto pl-2 text-xs font-normal text-stone-400">{count}</span>}
      </button>
      {extra}
    </div>
  );
}

function ProjectDialog({ open, onClose, project, rows }: { open: boolean; onClose: () => void; project: Project | null; rows: Row[] }) {
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
          location.hash = viewHash({ kind: 'project', id: id! });
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
                  await repo.deleteProject(project.id);
                  onClose();
                  location.hash = viewHash({ kind: 'status', status: 'inbox' });
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

function TopicMenu({ topic, topics, onClose }: { topic: Topic; topics: Topic[]; onClose: () => void }) {
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
                location.hash = viewHash({ kind: 'topic', id: mergeInto });
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

function AddPaper({ onAdded }: { onAdded: (id: string) => void }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        const s = v.trim();
        if (!s) return;
        setBusy(true);
        setErr(null);
        try {
          const parsed = parsePaperUrl(s);
          const ax = !parsed ? parseArxivId(s) : null;
          const orMatch = !parsed && !ax ? s.match(/^[A-Za-z0-9_-]{8,}$/) : null;
          const res = await rpc.savePaper(parsed ? { url: s } : ax ? { paperId: `arxiv:${ax.id}` } : orMatch ? { paperId: `openreview:${s}` } : { url: s });
          setV('');
          onAdded(res.paperId);
        } catch (e2) {
          setErr((e2 as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input className="mg-input w-64 py-1" value={v} onChange={(e) => setV(e.target.value)} placeholder="Add by arXiv ID or URL" title={err ?? undefined} />
      <button className="mg-btn" type="submit" disabled={busy || !v.trim()}>
        {busy ? <Spinner /> : <Icon name="plus" size={14} />}
      </button>
      {err && <span className="max-w-[200px] truncate text-xs text-rose-700" title={err}>{err}</span>}
    </form>
  );
}

function Cell({ col, r, projects, topics }: { col: ColId; r: Row; projects: Map<string, Project>; topics: Map<string, Topic> }) {
  const x = r.paper.extracted;
  const list = (v?: string[]) => <span className="line-clamp-2 text-stone-600 dark:text-stone-300">{v?.length ? v.join(', ') : <span className="text-stone-300 dark:text-stone-600">–</span>}</span>;
  switch (col) {
    case 'title':
      return (
        <div className="min-w-[280px]">
          <div className="font-serif text-[14.5px] font-semibold leading-snug text-stone-900 dark:text-stone-50">{r.paper.title}</div>
          <div className="mt-0.5 truncate text-xs text-stone-500">{authorLine(r.paper, 3)}</div>
          {r.entry.status === 'inbox' && r.entry.priorityReasons.length > 0 && <div className="mt-0.5 text-xs text-accent-700 dark:text-accent-300">{r.entry.priorityReasons.join(' · ')}</div>}
        </div>
      );
    case 'year':
      return <span className="text-stone-600 dark:text-stone-300">{r.paper.year ?? '–'}</span>;
    case 'venue':
      return <VenueBadge paper={r.paper} />;
    case 'status':
      return (
        <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
          <StatusSelect size="sm" value={r.entry.status} onChange={(status) => repo.updateEntry(r.paper.id, { status })} />
          {r.entry.willCite && <Icon name="star" size={13} className="fill-amber-400 text-amber-500" title="Will cite" />}
        </div>
      );
    case 'projects':
      return (
        <div className="flex flex-wrap gap-1">
          {r.entry.projectIds.map((id) => projects.get(id)).filter(Boolean).map((p) => <ProjectChip key={p!.id} project={p!} />)}
          {r.entry.suggestions.length > 0 && <span className="text-xs text-stone-400" title="Suggested projects">+{r.entry.suggestions.length} suggested</span>}
        </div>
      );
    case 'topic':
      return <span className="text-stone-600 dark:text-stone-300">{r.entry.topicId ? topics.get(r.entry.topicId)?.name ?? '–' : '–'}</span>;
    case 'task':
      return <span className="line-clamp-2 text-stone-600 dark:text-stone-300">{x?.task || <span className="text-stone-300 dark:text-stone-600">–</span>}</span>;
    case 'benchmarks':
      return list(x?.benchmarks);
    case 'models':
      return list(x?.models);
    case 'metrics':
      return list(x?.metrics);
    case 'result':
      return <span className="line-clamp-3 text-stone-600 dark:text-stone-300">{x?.headlineResult || '–'}</span>;
    case 'highlights':
      return <span className="text-stone-600 dark:text-stone-300">{r.highlights || '–'}</span>;
    case 'progress':
      return <span className="text-stone-600 dark:text-stone-300">{r.entry.progress ? `${Math.round(r.entry.progress * 100)}%` : '–'}</span>;
    case 'priority':
      return <span className="font-mono text-xs text-stone-600 dark:text-stone-300">{Math.round(r.entry.priority * 100)}</span>;
    case 'added':
      return <span className="text-xs text-stone-500">{timeAgo(r.entry.createdAt)}</span>;
    case 'citekey':
      return <span className="font-mono text-xs text-stone-600 dark:text-stone-300">{r.paper.citeKey}</span>;
  }
}

function App() {
  const settings = useSettings();
  const { data, loading } = useLive(loadLibrary, []);
  const [{ view, paper: openPaper }, setRoute] = useState(parseHash);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ col: ColId; dir: 1 | -1 } | null>(null);
  const [cols, setCols] = useState<ColId[]>(loadCols);
  const [colsOpen, setColsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [projectDialog, setProjectDialog] = useState<{ open: boolean; project: Project | null }>({ open: false, project: null });
  const [topicMenu, setTopicMenu] = useState<Topic | null>(null);
  const [sorting, setSorting] = useState(false);

  useEffect(() => {
    const h = () => setRoute(parseHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  useEffect(() => {
    localStorage.setItem('mg-cols', JSON.stringify(cols));
  }, [cols]);
  useEffect(() => setSelected(new Set()), [JSON.stringify(view)]);

  const go = (v: View, paper: string | null = null) => {
    location.hash = viewHash(v, paper);
  };

  const rows = data?.rows ?? [];
  const projects = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.id, p] as const)), [data?.projects]);
  const topics = useMemo(() => new Map((data?.topics ?? []).map((t) => [t.id, t] as const)), [data?.topics]);

  const inView = (r: Row) => {
    switch (view.kind) {
      case 'status':
        return r.entry.status === view.status;
      case 'cite':
        return r.entry.willCite;
      case 'project':
        return r.entry.projectIds.includes(view.id);
      case 'topic':
        return r.entry.topicId === view.id;
      case 'untopiced':
        return !r.entry.topicId;
      default:
        return true;
    }
  };

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    let list = rows.filter((r) => inView(r) && terms.every((t) => r.searchText.includes(t)));
    const s = sort ?? (view.kind === 'status' && view.status === 'inbox' ? { col: 'priority' as ColId, dir: -1 as const } : { col: 'added' as ColId, dir: -1 as const });
    list = list.slice().sort((a, b) => {
      const va = sortValue(a, s.col, topics);
      const vb = sortValue(b, s.col, topics);
      return (va < vb ? -1 : va > vb ? 1 : 0) * s.dir || b.entry.createdAt.localeCompare(a.entry.createdAt);
    });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, sort, JSON.stringify(view), topics]);

  const count = (pred: (r: Row) => boolean) => rows.filter(pred).length;
  const viewTitle =
    view.kind === 'status'
      ? READING_STATUSES.find((s) => s.id === view.status)!.label
      : view.kind === 'cite'
        ? 'Will cite'
        : view.kind === 'project'
          ? projects.get(view.id)?.name ?? 'Project'
          : view.kind === 'topic'
            ? topics.get(view.id)?.name ?? 'Topic'
            : view.kind === 'untopiced'
              ? 'No topic yet'
              : 'All papers';
  const currentProject = view.kind === 'project' ? projects.get(view.id) ?? null : null;
  const currentTopic = view.kind === 'topic' ? topics.get(view.id) ?? null : null;
  const targetForBib = selected.size ? filtered.filter((r) => selected.has(r.paper.id)) : filtered;
  const bibName = (currentProject?.name ?? viewTitle).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'library';

  return (
    <div className="flex h-screen bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      {/* sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950">
        <div className="flex items-center gap-2 px-4 py-3">
          <Logo size={20} />
          <span className="font-semibold tracking-tight">Marginalia</span>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-4">
          <div className="flex flex-col gap-0.5">
            <NavItem active={sameView(view, { kind: 'status', status: 'inbox' })} onClick={() => go({ kind: 'status', status: 'inbox' })} icon="inbox" label="Inbox" count={count((r) => r.entry.status === 'inbox')} />
            <NavItem active={sameView(view, { kind: 'status', status: 'toread' })} onClick={() => go({ kind: 'status', status: 'toread' })} icon="bookmark" label="To read" count={count((r) => r.entry.status === 'toread')} />
            <NavItem active={sameView(view, { kind: 'status', status: 'reading' })} onClick={() => go({ kind: 'status', status: 'reading' })} icon="book" label="Reading" count={count((r) => r.entry.status === 'reading')} />
            <NavItem active={sameView(view, { kind: 'status', status: 'read' })} onClick={() => go({ kind: 'status', status: 'read' })} icon="check" label="Read" count={count((r) => r.entry.status === 'read')} />
            <NavItem active={view.kind === 'cite'} onClick={() => go({ kind: 'cite' })} icon="star" label="Will cite" count={count((r) => r.entry.willCite)} />
            <NavItem active={view.kind === 'all'} onClick={() => go({ kind: 'all' })} icon="library" label="All papers" count={rows.length} />
          </div>
          <div className="mb-1 mt-5 flex items-center justify-between px-2">
            <span className="mg-label">Projects</span>
            <button className="text-stone-400 hover:text-stone-800 dark:hover:text-white" title="New project" onClick={() => setProjectDialog({ open: true, project: null })}>
              <Icon name="plus" size={15} />
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {(data?.projects ?? []).map((p) => (
              <NavItem key={p.id} active={view.kind === 'project' && view.id === p.id} onClick={() => go({ kind: 'project', id: p.id })} color={p.color} label={p.name} count={count((r) => r.entry.projectIds.includes(p.id))} />
            ))}
            {!data?.projects.length && (
              <button className="px-2 py-1 text-left text-xs text-stone-500 hover:text-stone-800" onClick={() => setProjectDialog({ open: true, project: null })}>
                Create a project to auto-file related papers.
              </button>
            )}
          </div>
          <div className="mb-1 mt-5 flex items-center justify-between px-2">
            <span className="mg-label">Topics</span>
            <button
              className="text-stone-400 hover:text-stone-800 disabled:opacity-50 dark:hover:text-white"
              title="Re-sort topics"
              disabled={sorting}
              onClick={async () => {
                setSorting(true);
                try {
                  await reclusterTopics();
                  await updatePriorities();
                } finally {
                  setSorting(false);
                }
              }}
            >
              {sorting ? <Spinner size={13} /> : <Icon name="refresh" size={14} />}
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {(data?.topics ?? []).map((t) => (
              <NavItem
                key={t.id}
                active={view.kind === 'topic' && view.id === t.id}
                onClick={() => go({ kind: 'topic', id: t.id })}
                icon={t.pinned ? 'pin' : 'tag'}
                label={t.name}
                count={count((r) => r.entry.topicId === t.id)}
                extra={
                  <button className="mr-1 hidden text-stone-400 hover:text-stone-800 group-hover:block dark:hover:text-white" title="Rename, pin or merge" onClick={() => setTopicMenu(t)}>
                    <Icon name="settings" size={13} />
                  </button>
                }
              />
            ))}
            {data && data.topics.length > 0 && count((r) => !r.entry.topicId) > 0 && (
              <NavItem active={view.kind === 'untopiced'} onClick={() => go({ kind: 'untopiced' })} icon="tag" label={<span className="italic">No topic yet</span>} count={count((r) => !r.entry.topicId)} />
            )}
            {!data?.topics.length && <p className="px-2 text-xs text-stone-500">Topics appear once you've saved about six papers. {settings.ai ? 'Claude names them.' : 'Named by their keywords.'}</p>}
          </div>
        </nav>
        <div className="border-t border-stone-200 p-2 dark:border-stone-800">
          <button className="mg-btn-ghost w-full justify-start" onClick={() => chrome.runtime.openOptionsPage()}>
            <Icon name="settings" size={15} /> Settings
          </button>
        </div>
      </aside>

      {/* main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-5 py-3 dark:border-stone-800 dark:bg-stone-900">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              {viewTitle}
              {currentProject && (
                <button className="text-stone-400 hover:text-stone-700" title="Edit project" onClick={() => setProjectDialog({ open: true, project: currentProject })}>
                  <Icon name="settings" size={15} />
                </button>
              )}
              {currentTopic && (
                <button className="text-stone-400 hover:text-stone-700" title="Rename, pin or merge" onClick={() => setTopicMenu(currentTopic)}>
                  <Icon name="settings" size={15} />
                </button>
              )}
            </h1>
            {currentProject?.description && <p className="max-w-2xl truncate text-sm text-stone-500">{currentProject.description}</p>}
          </div>
          <div className="relative ml-auto">
            <Icon name="search" size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
            <input className="mg-input w-72 py-1.5 pl-8" placeholder="Search titles, abstracts, highlights, notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <AddPaper onAdded={(id) => go({ kind: 'all' }, id)} />
        </div>

        <div className="flex items-center gap-2 border-b border-stone-200 bg-white px-5 py-2 text-sm dark:border-stone-800 dark:bg-stone-900">
          <span className="text-stone-500">
            {selected.size ? `${selected.size} selected` : `${filtered.length} paper${filtered.length === 1 ? '' : 's'}`}
          </span>
          {selected.size > 0 && (
            <>
              <select
                className="mg-input w-auto py-1 text-xs"
                value=""
                onChange={async (e) => {
                  const status = e.target.value as ReadingStatus;
                  for (const id of selected) await repo.updateEntry(id, { status });
                }}
              >
                <option value="">Set status…</option>
                {READING_STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
              <select
                className="mg-input w-auto py-1 text-xs"
                value=""
                onChange={async (e) => {
                  const pid = e.target.value;
                  for (const id of selected) {
                    const r = rows.find((x) => x.paper.id === id);
                    if (r && !r.entry.projectIds.includes(pid)) await repo.updateEntry(id, { projectIds: [...r.entry.projectIds, pid] });
                  }
                }}
              >
                <option value="">Add to project…</option>
                {(data?.projects ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                className="mg-btn-ghost text-xs"
                onClick={async () => {
                  for (const id of selected) await repo.updateEntry(id, { willCite: true });
                }}
              >
                <Icon name="star" size={13} /> Will cite
              </button>
              <button
                className="mg-btn-ghost text-xs text-rose-700"
                onClick={async () => {
                  if (!confirm(`Remove ${selected.size} paper${selected.size > 1 ? 's' : ''} from your library? Highlights and notes are kept.`)) return;
                  for (const id of selected) await repo.removeFromLibrary(id);
                  setSelected(new Set());
                }}
              >
                <Icon name="trash" size={13} /> Remove
              </button>
              <button className="mg-btn-ghost text-xs" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button className="mg-btn py-1 text-xs" disabled={!targetForBib.length} onClick={() => download(`${bibName}.bib`, bibFile(targetForBib.map((r) => r.paper)), 'application/x-bibtex')}>
              <Icon name="download" size={13} /> .bib{selected.size ? ` (${selected.size})` : ''}
            </button>
            <div className="relative">
              <button className="mg-btn py-1 text-xs" onClick={() => setColsOpen((o) => !o)}>
                Columns <Icon name="chevronDown" size={13} />
              </button>
              {colsOpen && (
                <div className="mg-card absolute right-0 top-full z-20 mt-1 w-48 p-2 shadow-lg" onMouseLeave={() => setColsOpen(false)}>
                  {COLUMNS.filter((c) => c.id !== 'title').map((c) => (
                    <label key={c.id} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-stone-50 dark:hover:bg-stone-800">
                      <input
                        type="checkbox"
                        checked={cols.includes(c.id)}
                        onChange={(e) => setCols(e.target.checked ? COLUMNS.map((x) => x.id).filter((id) => id === c.id || cols.includes(id)) : cols.filter((x) => x !== c.id))}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {loading && !data ? (
            <div className="flex justify-center p-10 text-stone-400">
              <Spinner size={20} />
            </div>
          ) : !rows.length ? (
            <EmptyState icon="library" title="Your library is empty">
              Open a paper on arXiv or OpenReview and press Alt+Shift+S, or add one by arXiv ID above.
            </EmptyState>
          ) : !filtered.length ? (
            <EmptyState icon="search" title={query ? 'No matches' : 'Nothing here yet'} />
          ) : (
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-10 bg-stone-50 dark:bg-stone-950">
                <tr>
                  <th className="w-9 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={selected.size > 0 && selected.size === filtered.length}
                      onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((r) => r.paper.id)) : new Set())}
                    />
                  </th>
                  {COLUMNS.filter((c) => cols.includes(c.id)).map((c) => (
                    <th key={c.id} className={cx('border-b border-stone-200 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-stone-500 dark:border-stone-800', c.width)}>
                      {c.sortable ? (
                        <button className="inline-flex items-center gap-1 uppercase hover:text-stone-900 dark:hover:text-white" onClick={() => setSort((s) => (s?.col === c.id ? { col: c.id, dir: (s.dir * -1) as 1 | -1 } : { col: c.id, dir: c.id === 'added' || c.id === 'priority' || c.id === 'year' ? -1 : 1 }))}>
                          {c.label}
                          {sort?.col === c.id && <Icon name="chevronDown" size={12} className={sort.dir === 1 ? 'rotate-180' : ''} />}
                        </button>
                      ) : (
                        c.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr
                    key={r.paper.id}
                    onClick={() => go(view, r.paper.id)}
                    className={cx('cursor-pointer align-top transition', openPaper === r.paper.id ? 'bg-accent-50/70 dark:bg-accent-900/20' : 'bg-white hover:bg-stone-50 dark:bg-stone-900 dark:hover:bg-stone-800/60')}
                  >
                    <td className="border-b border-stone-100 px-3 py-2.5 dark:border-stone-800" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label="Select"
                        checked={selected.has(r.paper.id)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(r.paper.id);
                          else next.delete(r.paper.id);
                          setSelected(next);
                        }}
                      />
                    </td>
                    {COLUMNS.filter((c) => cols.includes(c.id)).map((c) => (
                      <td key={c.id} className="border-b border-stone-100 px-3 py-2.5 dark:border-stone-800">
                        <Cell col={c.id} r={r} projects={projects} topics={topics} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {/* detail drawer */}
      {openPaper && (
        <aside className="flex w-[440px] shrink-0 flex-col overflow-y-auto border-l border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
          <div className="flex items-center justify-between border-b border-stone-200 px-3 py-2 dark:border-stone-800">
            <OpenPaperButtons paperId={openPaper} />
            <button className="mg-btn-ghost" onClick={() => go(view, null)} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
          <PaperDetail key={openPaper} paperId={openPaper} compact />
        </aside>
      )}

      <ProjectDialog open={projectDialog.open} project={projectDialog.project} onClose={() => setProjectDialog({ open: false, project: null })} rows={rows} />
      {topicMenu && <TopicMenu topic={topicMenu} topics={data?.topics ?? []} onClose={() => setTopicMenu(null)} />}
    </div>
  );
}

function OpenPaperButtons({ paperId }: { paperId: string }) {
  const { data: p } = useLive(() => repo.getPaper(paperId), [paperId]);
  if (!p) return <span />;
  const html = p.urls.html;
  const pdf = p.urls.pdf;
  return (
    <div className="flex items-center gap-1">
      {html && (
        <a className="mg-btn py-1 text-xs" href={html} target="_blank" rel="noreferrer">
          <Icon name="external" size={13} /> Open HTML
        </a>
      )}
      {pdf && (
        <a className="mg-btn py-1 text-xs" href={chrome.runtime.getURL(`/reader.html?src=${encodeURIComponent(pdf)}&paper=${encodeURIComponent(p.id)}`)} target="_blank" rel="noreferrer">
          <Icon name="book" size={13} /> Read PDF
        </a>
      )}
      {!html && !pdf && p.urls.abs && (
        <a className="mg-btn py-1 text-xs" href={p.urls.abs} target="_blank" rel="noreferrer">
          <Icon name="external" size={13} /> Open
        </a>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
