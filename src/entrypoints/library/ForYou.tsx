import { useState } from 'react';
import { EmptyState, Spinner, cx, timeAgo } from '@/components/common';
import { Icon } from '@/components/Icon';
import { useLive } from '@/hooks/useLive';
import * as repo from '@/lib/repo';
import { rpc } from '@/lib/rpc';
import { readerUrl } from '@/lib/ids';
import { lastDailyReport } from '@/lib/daily';
import type { FeedItem, FeedReason, Project } from '@/lib/types';
import { go, type LibraryData } from './shared';

function reasonText(r: FeedReason, projects: Map<string, Project>): string {
  if (r.kind === 'author') return `New from ${r.name}`;
  if (r.kind === 'project') return `Fits ${projects.get(r.projectId)?.name ?? 'a project'} (${Math.round(r.score * 100)}%)`;
  return `Cites ${r.count} of your papers`;
}

function authorsShort(it: FeedItem): string {
  const n = it.authors.map((a) => a.name);
  return n.length > 4 ? `${n.slice(0, 3).join(', ')}, … ${n[n.length - 1]}` : n.join(', ');
}

function FeedCard({ it, projects, onSaved }: { it: FeedItem; projects: Map<string, Project>; onSaved: (paperId: string) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pdf = it.urls.pdf;
  return (
    <li className="mg-card flex flex-col gap-2 p-4">
      <div className="flex flex-wrap gap-1.5">
        {it.reasons.map((r, i) => (
          <span key={i} className={cx('rounded-full px-2 py-0.5 text-xs font-medium', r.kind === 'author' ? 'bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-100' : 'bg-accent-50 text-accent-800 dark:bg-accent-900/40 dark:text-accent-100')}>
            {reasonText(r, projects)}
          </span>
        ))}
      </div>
      <button className="text-left" onClick={() => setOpen((o) => !o)}>
        <div className="font-serif text-[15.5px] font-semibold leading-snug text-stone-900 dark:text-stone-50">{it.title}</div>
        <div className="mt-0.5 text-xs text-stone-500">
          {authorsShort(it)}
          {it.venue ? ` · ${it.venue}` : ''}
          {it.published ? ` · ${new Date(it.published).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : it.year ? ` · ${it.year}` : ''}
        </div>
      </button>
      {it.abstract && <p className={cx('text-[13px] leading-relaxed text-stone-700 dark:text-stone-300', !open && 'line-clamp-3')}>{it.abstract}</p>}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          className="mg-btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              onSaved(await rpc.saveFeedItem(it.id));
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : <Icon name="bookmark" size={14} />} Save
        </button>
        {pdf && (
          <a className="mg-btn" href={readerUrl(pdf, it.id)} target="_blank" rel="noreferrer">
            <Icon name="book" size={14} /> Read
          </a>
        )}
        {(it.urls.abs ?? it.urls.s2) && (
          <a className="mg-btn-ghost" href={it.urls.abs ?? it.urls.s2} target="_blank" rel="noreferrer">
            <Icon name="external" size={14} /> {it.urls.abs ? 'arXiv' : 'Semantic Scholar'}
          </a>
        )}
        <button className="mg-btn-ghost ml-auto text-stone-500" onClick={() => repo.setFeedStatus(it.id, 'dismissed')} title="Not interested. Similar papers are shown less often.">
          <Icon name="x" size={14} /> Dismiss
        </button>
      </div>
      {err && <p className="text-xs text-rose-700">{err}</p>}
    </li>
  );
}

export function ForYouView({ data }: { data: LibraryData | undefined }) {
  const { data: items, loading } = useLive(() => repo.listFeed('new'), [], (e) => e.table === 'feed');
  const { data: report } = useLive(() => lastDailyReport(), []);
  const [filter, setFilter] = useState<string>('all');
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const projects = new Map((data?.projects ?? []).map((p) => [p.id, p] as const));
  const list = (items ?? []).filter((it) => filter === 'all' || (filter === 'authors' ? it.reasons.some((r) => r.kind === 'author') : it.reasons.some((r) => r.kind === 'project' && r.projectId === filter)));
  const projectIds = [...new Set((items ?? []).flatMap((it) => it.reasons.flatMap((r) => (r.kind === 'project' ? [r.projectId] : []))))].filter((id) => projects.has(id));
  const hasAuthors = (items ?? []).some((it) => it.reasons.some((r) => r.kind === 'author'));
  const noSources = !data?.follows.length && !data?.projects.length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5">
            <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
              All
            </Chip>
            {hasAuthors && (
              <Chip active={filter === 'authors'} onClick={() => setFilter('authors')}>
                From authors you follow
              </Chip>
            )}
            {projectIds.map((id) => (
              <Chip key={id} active={filter === id} onClick={() => setFilter(id)}>
                <span className="h-2 w-2 rounded-full" style={{ background: projects.get(id)!.color }} /> {projects.get(id)!.name}
              </Chip>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 text-xs text-stone-500">
            {report?.ranAt && <span>Checked {timeAgo(report.ranAt)}</span>}
            <button
              className="mg-btn py-1 text-xs"
              disabled={refreshing || noSources}
              onClick={async () => {
                setRefreshing(true);
                setMsg(null);
                try {
                  const r = await rpc.refreshFeed();
                  setMsg(r.added ? `${r.added} new paper${r.added === 1 ? '' : 's'}` : 'Nothing new right now');
                } catch (e) {
                  setMsg((e as Error).message);
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              {refreshing ? <Spinner size={12} /> : <Icon name="refresh" size={13} />} Check now
            </button>
          </div>
        </div>
        {msg && <p className="text-xs text-stone-500">{msg}</p>}
        {loading && !items ? (
          <div className="flex justify-center p-10 text-stone-400">
            <Spinner size={20} />
          </div>
        ) : !list.length ? (
          <EmptyState icon="sparkle" title={noSources ? 'Nothing to suggest yet' : 'All caught up'}>
            {noSources ? (
              <>
                <button className="text-accent-700 underline dark:text-accent-300" onClick={() => go({ kind: 'following' })}>
                  Follow authors
                </button>{' '}
                or create a project, and Archive will look for new papers for you once a day.
              </>
            ) : (
              'New papers by authors you follow and papers that fit your projects show up here once a day.'
            )}
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-3">
            {list.map((it) => (
              <FeedCard key={it.id} it={it} projects={projects} onSaved={(paperId) => go({ kind: 'foryou' }, paperId)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition',
        active ? 'border-accent-600 bg-accent-600 text-white' : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200',
      )}
    >
      {children}
    </button>
  );
}
