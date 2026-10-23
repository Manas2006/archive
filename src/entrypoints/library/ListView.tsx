import { useEffect, useMemo, useState } from 'react';
import { CopyButton, EmptyState, Spinner, StatusSelect, VenueBadge, authorLine, cx, timeAgo } from '@/components/common';
import { Icon } from '@/components/Icon';
import { ProjectChip } from '@/components/ProjectPicker';
import * as repo from '@/lib/repo';
import { bibFile, download } from '@/lib/exports';
import { citeText } from '@/lib/cite';
import { READING_STATUSES, type Project, type ReadingStatus, type Topic } from '@/lib/types';
import { useIsNarrow } from '@/hooks/useMediaQuery';
import { isWebApp } from '@/lib/platform';
import { authorMatches, slug, type LibraryData, type Row, type View } from './shared';

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

function Dash() {
  return <span className="text-stone-300 dark:text-stone-600">–</span>;
}

function Cell({ col, r, projects, topics }: { col: ColId; r: Row; projects: Map<string, Project>; topics: Map<string, Topic> }) {
  const x = r.paper.extracted;
  const list = (v?: string[]) => <span className="line-clamp-2 text-stone-600 dark:text-stone-300">{v?.length ? v.join(', ') : <Dash />}</span>;
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
      return <span className="line-clamp-2 text-stone-600 dark:text-stone-300">{x?.task || <Dash />}</span>;
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

/** Phone layout: one card per paper. */
function PaperCard({ r, projects, active, selected, onSelect, onOpen }: { r: Row; projects: Map<string, Project>; active: boolean; selected: boolean; onSelect: (v: boolean) => void; onOpen: () => void }) {
  return (
    <li className={cx('flex gap-3 border-b border-stone-100 px-4 py-3 dark:border-stone-800', active ? 'bg-accent-50/70 dark:bg-accent-900/20' : 'bg-white dark:bg-stone-900')}>
      <input type="checkbox" className="mt-1.5 h-4 w-4 shrink-0" aria-label="Select" checked={selected} onChange={(e) => onSelect(e.target.checked)} />
      <div className="min-w-0 flex-1">
        <button className="block w-full text-left" onClick={onOpen}>
          <div className="font-serif text-[15px] font-semibold leading-snug text-stone-900 dark:text-stone-50">{r.paper.title}</div>
          <div className="mt-0.5 line-clamp-1 text-xs text-stone-500">
            {authorLine(r.paper, 3)}
            {r.paper.year ? ` · ${r.paper.year}` : ''}
          </div>
          {r.entry.status === 'inbox' && r.entry.priorityReasons.length > 0 && <div className="mt-0.5 text-xs text-accent-700 dark:text-accent-300">{r.entry.priorityReasons.join(' · ')}</div>}
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <StatusSelect size="sm" value={r.entry.status} onChange={(status) => repo.updateEntry(r.paper.id, { status })} />
          <VenueBadge paper={r.paper} />
          {r.entry.willCite && <Icon name="star" size={13} className="fill-amber-400 text-amber-500" title="Will cite" />}
          {r.highlights > 0 && (
            <span className="inline-flex items-center gap-0.5 text-xs text-stone-500">
              <Icon name="note" size={12} /> {r.highlights}
            </span>
          )}
          {r.entry.projectIds.map((id) => projects.get(id)).filter(Boolean).map((p) => <ProjectChip key={p!.id} project={p!} />)}
        </div>
      </div>
    </li>
  );
}

export function ListView({
  view,
  data,
  loading,
  query,
  openPaper,
  onOpen,
  citeCommand,
}: {
  view: View;
  data: LibraryData | undefined;
  loading: boolean;
  query: string;
  openPaper: string | null;
  onOpen: (paperId: string) => void;
  citeCommand: string;
}) {
  const narrow = useIsNarrow();
  const [sort, setSort] = useState<{ col: ColId; dir: 1 | -1 } | null>(null);
  const [cols, setCols] = useState<ColId[]>(loadCols);
  const [colsOpen, setColsOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    localStorage.setItem('mg-cols', JSON.stringify(cols));
  }, [cols]);
  useEffect(() => setSelected(new Set()), [JSON.stringify(view)]);

  const rows = data?.rows ?? [];
  const projects = useMemo(() => new Map((data?.projects ?? []).map((p) => [p.id, p] as const)), [data?.projects]);
  const topics = useMemo(() => new Map((data?.topics ?? []).map((t) => [t.id, t] as const)), [data?.topics]);
  const follow = view.kind === 'author' ? data?.follows.find((f) => f.id === view.id) : undefined;

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
      case 'author':
        return !!follow && r.paper.authors.some((a) => authorMatches(a, follow));
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
  }, [rows, query, sort, JSON.stringify(view), topics, follow]);

  const target = selected.size ? filtered.filter((r) => selected.has(r.paper.id)) : filtered;
  const currentProject = view.kind === 'project' ? projects.get(view.id) : undefined;
  const fileBase = slug(currentProject?.name ?? follow?.name ?? (view.kind === 'status' ? view.status : view.kind));

  const exportRis = async () => {
    setExporting(true);
    try {
      const { toRis } = await import('@/lib/zotero');
      const items = await Promise.all(target.map(async (r) => ({ paper: r.paper, entry: r.entry, annotations: await repo.listAnnotations(r.paper.id) })));
      download(`${fileBase}.ris`, toRis(items, { projects }), 'application/x-research-info-systems');
    } finally {
      setExporting(false);
    }
  };

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-stone-200 bg-white px-4 py-2 text-sm dark:border-stone-800 dark:bg-stone-900 md:px-5">
        <span className="text-stone-500">{selected.size ? `${selected.size} selected` : `${filtered.length} paper${filtered.length === 1 ? '' : 's'}`}</span>
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
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <CopyButton className="mg-btn py-1 text-xs" label={`Cite${selected.size ? ` (${selected.size})` : ''}`} text={citeText(target.map((r) => r.paper.citeKey), citeCommand)} />
          <button className="mg-btn py-1 text-xs" disabled={!target.length} onClick={() => download(`${fileBase}.bib`, bibFile(target.map((r) => r.paper)), 'application/x-bibtex')} title="Download BibTeX">
            <Icon name="download" size={13} /> .bib
          </button>
          <button className="mg-btn py-1 text-xs" disabled={!target.length || exporting} onClick={exportRis} title="For Zotero, Mendeley or EndNote, with your highlights and notes">
            {exporting ? <Spinner size={12} /> : <Icon name="download" size={13} />} .ris
          </button>
          {!narrow && (
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
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !data ? (
          <div className="flex justify-center p-10 text-stone-400">
            <Spinner size={20} />
          </div>
        ) : !rows.length ? (
          <EmptyState icon="library" title="Your library is empty">
            {isWebApp()
              ? 'Add a paper by pasting its arXiv link or ID above, import from Zotero, or connect Google Drive in Settings to bring in the library from your computer.'
              : 'Open a paper on arXiv or OpenReview and press Alt+Shift+S, add one by arXiv ID above, or import from Zotero.'}
          </EmptyState>
        ) : !filtered.length ? (
          <EmptyState icon="search" title={query ? 'No matches' : 'Nothing here yet'}>
            {view.kind === 'author' && !query ? 'None of your saved papers are by this author yet. New ones show up in For you.' : undefined}
          </EmptyState>
        ) : narrow ? (
          <ul>
            {filtered.map((r) => (
              <PaperCard key={r.paper.id} r={r} projects={projects} active={openPaper === r.paper.id} selected={selected.has(r.paper.id)} onSelect={(v) => toggle(r.paper.id, v)} onOpen={() => onOpen(r.paper.id)} />
            ))}
          </ul>
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
                      <button
                        className="inline-flex items-center gap-1 uppercase hover:text-stone-900 dark:hover:text-white"
                        onClick={() => setSort((s) => (s?.col === c.id ? { col: c.id, dir: (s.dir * -1) as 1 | -1 } : { col: c.id, dir: c.id === 'added' || c.id === 'priority' || c.id === 'year' ? -1 : 1 }))}
                      >
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
                  onClick={() => onOpen(r.paper.id)}
                  className={cx('cursor-pointer align-top transition', openPaper === r.paper.id ? 'bg-accent-50/70 dark:bg-accent-900/20' : 'bg-white hover:bg-stone-50 dark:bg-stone-900 dark:hover:bg-stone-800/60')}
                >
                  <td className="border-b border-stone-100 px-3 py-2.5 dark:border-stone-800" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" aria-label="Select" checked={selected.has(r.paper.id)} onChange={(e) => toggle(r.paper.id, e.target.checked)} />
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
    </>
  );
}
