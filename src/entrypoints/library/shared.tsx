import type { ReactNode } from 'react';
import { cx } from '@/components/common';
import { Icon } from '@/components/Icon';
import * as repo from '@/lib/repo';
import { noteOf } from '@/lib/exports';
import { quoteOf } from '@/lib/anchoring/text';
import { READING_STATUSES, type Author, type Follow, type LibraryEntry, type Paper, type ReadingStatus, type Topic } from '@/lib/types';

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export interface Row {
  paper: Paper;
  entry: LibraryEntry;
  highlights: number;
  searchText: string;
}

export async function loadLibrary() {
  const [entries, projects, topics, annotations, follows, feed] = await Promise.all([
    repo.listEntries(),
    repo.listProjects(),
    repo.listTopics(),
    repo.listAllAnnotations(),
    repo.listFollows(),
    repo.listFeed('new'),
  ]);
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
  return { rows, projects, topics, follows, feedCount: feed.length };
}

export type LibraryData = Awaited<ReturnType<typeof loadLibrary>>;

/** Does this author (on a paper) match a followed author? */
export function authorMatches(a: Author, f: Follow): boolean {
  if (f.s2AuthorId && a.s2Id) return a.s2Id === f.s2AuthorId;
  return repo.normAuthorName(a.name) === repo.normAuthorName(f.name);
}

// ---------------------------------------------------------------------------
// Views (kept in the URL hash so links and the back button work)
// ---------------------------------------------------------------------------

export type View =
  | { kind: 'status'; status: ReadingStatus }
  | { kind: 'all' }
  | { kind: 'cite' }
  | { kind: 'project'; id: string }
  | { kind: 'topic'; id: string }
  | { kind: 'untopiced' }
  | { kind: 'author'; id: string }
  | { kind: 'foryou' }
  | { kind: 'following' }
  | { kind: 'ask' };

export const isListView = (v: View) => !['foryou', 'following', 'ask'].includes(v.kind);

export function parseHash(): { view: View; paper: string | null } {
  const h = new URLSearchParams(location.hash.slice(1));
  const paper = h.get('paper');
  if (h.get('project')) return { view: { kind: 'project', id: h.get('project')! }, paper };
  if (h.get('topic')) return { view: { kind: 'topic', id: h.get('topic')! }, paper };
  if (h.get('author')) return { view: { kind: 'author', id: h.get('author')! }, paper };
  const v = h.get('view');
  if (v === 'all' || v === 'cite' || v === 'untopiced' || v === 'foryou' || v === 'following' || v === 'ask') return { view: { kind: v }, paper };
  if (v && READING_STATUSES.some((s) => s.id === v)) return { view: { kind: 'status', status: v as ReadingStatus }, paper };
  return { view: paper ? { kind: 'all' } : { kind: 'status', status: 'inbox' }, paper };
}

export function viewHash(v: View, paper?: string | null): string {
  const q = new URLSearchParams();
  if (v.kind === 'status') q.set('view', v.status);
  else if (v.kind === 'project') q.set('project', v.id);
  else if (v.kind === 'topic') q.set('topic', v.id);
  else if (v.kind === 'author') q.set('author', v.id);
  else q.set('view', v.kind);
  if (paper) q.set('paper', paper);
  return `#${q.toString()}`;
}

export const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

export function go(v: View, paper: string | null = null) {
  location.hash = viewHash(v, paper);
}

export function viewTitle(view: View, data: LibraryData | undefined, topics: Map<string, Topic>): string {
  switch (view.kind) {
    case 'status':
      return READING_STATUSES.find((s) => s.id === view.status)!.label;
    case 'cite':
      return 'Will cite';
    case 'project':
      return data?.projects.find((p) => p.id === view.id)?.name ?? 'Project';
    case 'topic':
      return topics.get(view.id)?.name ?? 'Topic';
    case 'untopiced':
      return 'No topic yet';
    case 'author':
      return data?.follows.find((f) => f.id === view.id)?.name ?? 'Author';
    case 'foryou':
      return 'For you';
    case 'following':
      return 'Following';
    case 'ask':
      return 'Ask your library';
    default:
      return 'All papers';
  }
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'library';

// ---------------------------------------------------------------------------
// Small shared components
// ---------------------------------------------------------------------------

export function NavItem({ active, onClick, icon, label, count, color, extra, badge }: { active: boolean; onClick: () => void; icon?: string; label: ReactNode; count?: number; color?: string; extra?: ReactNode; badge?: boolean }) {
  return (
    <div className={cx('group flex items-center rounded-md', active ? 'bg-stone-200/70 dark:bg-stone-800' : 'hover:bg-stone-100 dark:hover:bg-stone-900')}>
      <button onClick={onClick} className={cx('flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm max-md:py-2.5', active ? 'font-semibold text-stone-900 dark:text-white' : 'text-stone-700 dark:text-stone-300')}>
        {color ? <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} /> : icon ? <Icon name={icon} size={15} className="text-stone-400" /> : null}
        <span className="truncate">{label}</span>
        {count !== undefined && count > 0 && (
          <span className={cx('ml-auto pl-2 text-xs', badge ? 'rounded-full bg-accent-600 px-1.5 py-px font-semibold text-white' : 'font-normal text-stone-400')}>{count}</span>
        )}
      </button>
      {extra}
    </div>
  );
}

/** A labelled section heading in the sidebar with an optional action button. */
export function NavSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="mb-1 mt-5 flex items-center justify-between px-2">
        <span className="mg-label">{title}</span>
        {action}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </>
  );
}
