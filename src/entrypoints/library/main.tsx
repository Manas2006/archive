import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/tailwind.css';
import { useLive } from '@/hooks/useLive';
import { useSettings } from '@/hooks/useSettings';
import { useIsNarrow } from '@/hooks/useMediaQuery';
import { PaperDetail } from '@/components/PaperDetail';
import { Spinner, cx } from '@/components/common';
import { Icon, Logo } from '@/components/Icon';
import { reclusterTopics } from '@/lib/topics';
import { updatePriorities } from '@/lib/enrich';
import { readerUrl } from '@/lib/ids';
import { openSettings } from '@/lib/nav';
import { isWebApp } from '@/lib/platform';
import * as repo from '@/lib/repo';
import type { Project, Topic } from '@/lib/types';
import { AddPaper, ProjectDialog, TopicMenu } from './dialogs';
import { ListView } from './ListView';
import { ForYouView } from './ForYou';
import { FollowingView } from './Following';
import { AskView } from './Ask';
import { RelatedWorkDialog } from './RelatedWork';
import { ImportExportDialog } from './ImportExport';
import { OverleafDialog } from './Overleaf';
import { NavItem, NavSection, go, isListView, loadLibrary, parseHash, sameView, viewTitle, type View } from './shared';

function Sidebar({ view, data, ai, onNewProject, onTopic, onImport }: { view: View; data: Awaited<ReturnType<typeof loadLibrary>> | undefined; ai: boolean; onNewProject: () => void; onTopic: (t: Topic) => void; onImport: () => void }) {
  const [sorting, setSorting] = useState(false);
  const rows = data?.rows ?? [];
  const count = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
  return (
    <>
      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        <div className="flex flex-col gap-0.5">
          <NavItem active={view.kind === 'foryou'} onClick={() => go({ kind: 'foryou' })} icon="sparkle" label="For you" count={data?.feedCount} badge />
          {ai && <NavItem active={view.kind === 'ask'} onClick={() => go({ kind: 'ask' })} icon="send" label="Ask your library" />}
        </div>
        <div className="mt-3 flex flex-col gap-0.5">
          <NavItem active={sameView(view, { kind: 'status', status: 'inbox' })} onClick={() => go({ kind: 'status', status: 'inbox' })} icon="inbox" label="Inbox" count={count((r) => r.entry.status === 'inbox')} />
          <NavItem active={sameView(view, { kind: 'status', status: 'toread' })} onClick={() => go({ kind: 'status', status: 'toread' })} icon="bookmark" label="To read" count={count((r) => r.entry.status === 'toread')} />
          <NavItem active={sameView(view, { kind: 'status', status: 'reading' })} onClick={() => go({ kind: 'status', status: 'reading' })} icon="book" label="Reading" count={count((r) => r.entry.status === 'reading')} />
          <NavItem active={sameView(view, { kind: 'status', status: 'read' })} onClick={() => go({ kind: 'status', status: 'read' })} icon="check" label="Read" count={count((r) => r.entry.status === 'read')} />
          <NavItem active={view.kind === 'cite'} onClick={() => go({ kind: 'cite' })} icon="star" label="Will cite" count={count((r) => r.entry.willCite)} />
          <NavItem active={view.kind === 'all'} onClick={() => go({ kind: 'all' })} icon="library" label="All papers" count={rows.length} />
        </div>
        <NavSection
          title="Projects"
          action={
            <button className="text-stone-400 hover:text-stone-800 dark:hover:text-white" title="New project" onClick={onNewProject}>
              <Icon name="plus" size={15} />
            </button>
          }
        >
          {(data?.projects ?? []).map((p) => (
            <NavItem key={p.id} active={view.kind === 'project' && view.id === p.id} onClick={() => go({ kind: 'project', id: p.id })} color={p.color} label={p.name} count={count((r) => r.entry.projectIds.includes(p.id))} />
          ))}
          {!data?.projects.length && (
            <button className="px-2 py-1 text-left text-xs text-stone-500 hover:text-stone-800" onClick={onNewProject}>
              Create a project to auto-file related papers.
            </button>
          )}
        </NavSection>
        <NavSection
          title="Following"
          action={
            <button className="text-stone-400 hover:text-stone-800 dark:hover:text-white" title="Follow an author" onClick={() => go({ kind: 'following' })}>
              <Icon name="plus" size={15} />
            </button>
          }
        >
          {(data?.follows ?? []).slice(0, 8).map((f) => (
            <NavItem key={f.id} active={view.kind === 'author' && view.id === f.id} onClick={() => go({ kind: 'author', id: f.id })} icon="star" label={f.name} />
          ))}
          <NavItem active={view.kind === 'following'} onClick={() => go({ kind: 'following' })} icon="settings" label={data?.follows.length ? (data.follows.length > 8 ? `All ${data.follows.length} authors` : 'Manage') : 'Follow authors'} />
        </NavSection>
        <NavSection
          title="Topics"
          action={
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
          }
        >
          {(data?.topics ?? []).map((t) => (
            <NavItem
              key={t.id}
              active={view.kind === 'topic' && view.id === t.id}
              onClick={() => go({ kind: 'topic', id: t.id })}
              icon={t.pinned ? 'pin' : 'tag'}
              label={t.name}
              count={count((r) => r.entry.topicId === t.id)}
              extra={
                <button className="mr-1 text-stone-400 hover:text-stone-800 dark:hover:text-white md:hidden md:group-hover:block" title="Rename, pin or merge" onClick={() => onTopic(t)}>
                  <Icon name="settings" size={13} />
                </button>
              }
            />
          ))}
          {data && data.topics.length > 0 && count((r) => !r.entry.topicId) > 0 && (
            <NavItem active={view.kind === 'untopiced'} onClick={() => go({ kind: 'untopiced' })} icon="tag" label={<span className="italic">No topic yet</span>} count={count((r) => !r.entry.topicId)} />
          )}
          {!data?.topics.length && <p className="px-2 text-xs text-stone-500">Topics appear once you've saved about six papers. {ai ? 'Claude names them.' : 'Named by their keywords.'}</p>}
        </NavSection>
      </nav>
      <div className="flex flex-col gap-0.5 border-t border-stone-200 p-2 dark:border-stone-800">
        <button className="mg-btn-ghost w-full justify-start max-md:py-2.5" onClick={onImport}>
          <Icon name="file" size={15} /> Import and export
        </button>
        <button className="mg-btn-ghost w-full justify-start max-md:py-2.5" onClick={() => openSettings()}>
          <Icon name="settings" size={15} /> Settings
        </button>
      </div>
    </>
  );
}

function App() {
  const settings = useSettings();
  const narrow = useIsNarrow();
  const { data, loading } = useLive(loadLibrary, []);
  const [{ view, paper: openPaper }, setRoute] = useState(parseHash);
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [projectDialog, setProjectDialog] = useState<{ open: boolean; project: Project | null }>({ open: false, project: null });
  const [topicMenu, setTopicMenu] = useState<Topic | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [overleafOpen, setOverleafOpen] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(location.hash.slice(1)).get('import')) setImportOpen(true);
    const h = () => {
      setRoute(parseHash());
      setNavOpen(false);
    };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const topics = useMemo(() => new Map((data?.topics ?? []).map((t) => [t.id, t] as const)), [data?.topics]);
  const projects = data?.projects ?? [];
  const currentProject = view.kind === 'project' ? projects.find((p) => p.id === view.id) ?? null : null;
  const currentTopic = view.kind === 'topic' ? topics.get(view.id) ?? null : null;
  const currentFollow = view.kind === 'author' ? data?.follows.find((f) => f.id === view.id) ?? null : null;
  const title = viewTitle(view, data, topics);

  useEffect(() => {
    document.title = `${title} · Archive`;
  }, [title]);

  const sidebar = (
    <Sidebar view={view} data={data} ai={settings.ai} onNewProject={() => setProjectDialog({ open: true, project: null })} onTopic={setTopicMenu} onImport={() => setImportOpen(true)} />
  );

  return (
    <div className="flex h-[100dvh] bg-stone-50 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      {/* sidebar: fixed column on wide screens, slide-over drawer on phones */}
      {!narrow ? (
        <aside className="flex w-60 shrink-0 flex-col border-r border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950">
          <div className="flex items-center gap-2 px-4 py-3">
            <Logo size={20} />
            <span className="font-semibold tracking-tight">Archive</span>
          </div>
          {sidebar}
        </aside>
      ) : (
        navOpen && (
          <div className="fixed inset-0 z-40 flex" onClick={(e) => e.target === e.currentTarget && setNavOpen(false)} style={{ background: 'rgba(28,25,23,.4)' }}>
            <aside
              className="flex w-[82vw] max-w-[320px] flex-col bg-stone-50 pt-[env(safe-area-inset-top)] shadow-xl dark:bg-stone-950"
              // picking any view closes the menu, including the one already showing (no hash change then)
              onClickCapture={(e) => (e.target as Element).closest('nav button, button.mg-btn-ghost') && setTimeout(() => setNavOpen(false), 0)}
            >
              <div className="flex items-center gap-2 px-4 py-3">
                <Logo size={20} />
                <span className="font-semibold tracking-tight">Archive</span>
                <button className="mg-btn-ghost ml-auto" onClick={() => setNavOpen(false)} aria-label="Close menu">
                  <Icon name="x" />
                </button>
              </div>
              {sidebar}
            </aside>
          </div>
        )
      )}

      <main className="flex min-w-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">
        <header className="flex flex-wrap items-center gap-2 border-b border-stone-200 bg-white px-3 py-2.5 dark:border-stone-800 dark:bg-stone-900 md:gap-3 md:px-5 md:py-3">
          {narrow && (
            <button className="mg-btn-ghost px-1.5" onClick={() => setNavOpen(true)} aria-label="Menu">
              <Icon name="menu" size={20} />
            </button>
          )}
          <div className="min-w-0 flex-1 md:flex-none">
            <h1 className="flex items-center gap-2 truncate text-base font-semibold md:text-lg">
              <span className="truncate">{title}</span>
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
            {currentProject?.description && <p className="max-w-2xl truncate text-sm text-stone-500 max-md:hidden">{currentProject.description}</p>}
            {currentFollow?.affiliation && <p className="max-w-2xl truncate text-sm text-stone-500 max-md:hidden">{currentFollow.affiliation}</p>}
          </div>
          {currentProject && (
            <div className="flex items-center gap-1.5">
              {settings.ai && (
                <button className="mg-btn py-1 text-xs" onClick={() => setRelatedOpen(true)}>
                  <Icon name="sparkle" size={13} /> Related work
                </button>
              )}
              <button className="mg-btn py-1 text-xs" onClick={() => setOverleafOpen(true)} title="Keep this project's .bib in Google Drive for Overleaf">
                <Icon name="link" size={13} /> Overleaf
              </button>
            </div>
          )}
          {currentFollow && (
            <button
              className="mg-btn py-1 text-xs"
              onClick={async () => {
                await repo.unfollow(currentFollow.id);
                go({ kind: 'following' });
              }}
            >
              Unfollow
            </button>
          )}
          {isListView(view) &&
            (narrow ? (
              <button className="mg-btn-ghost px-1.5" onClick={() => setSearchOpen((o) => !o)} aria-label="Search and add">
                <Icon name="search" size={19} />
              </button>
            ) : (
              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 xl:gap-3">
                <div className="relative">
                  <Icon name="search" size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400" />
                  <input className="mg-input w-56 py-1.5 pl-8 xl:w-72" placeholder="Search titles, abstracts, highlights, notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
                <AddPaper onAdded={(id) => go({ kind: 'all' }, id)} />
              </div>
            ))}
          {narrow && isListView(view) && (searchOpen || query) && (
            <div className="flex w-full flex-col gap-2 pt-1">
              <input className="mg-input py-2" placeholder="Search your library" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus={searchOpen} type="search" />
              <AddPaper className="w-full [&_input]:flex-1 [&_input]:py-2" onAdded={(id) => go({ kind: 'all' }, id)} />
            </div>
          )}
        </header>

        {view.kind === 'foryou' ? (
          <ForYouView data={data} />
        ) : view.kind === 'following' ? (
          <FollowingView data={data} />
        ) : view.kind === 'ask' ? (
          settings.ai ? <AskView data={data} /> : <ForYouView data={data} />
        ) : (
          <ListView view={view} data={data} loading={loading} query={query} openPaper={openPaper} onOpen={(id) => go(view, id)} citeCommand={settings.citeCommand} />
        )}
      </main>

      {/* paper detail: side column on wide screens, full-screen sheet on phones */}
      {openPaper && (
        <aside
          className={cx(
            'flex flex-col overflow-y-auto bg-white dark:bg-stone-900',
            narrow ? 'fixed inset-0 z-30 pt-[env(safe-area-inset-top)]' : 'w-[440px] shrink-0 border-l border-stone-200 dark:border-stone-800',
          )}
        >
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-stone-200 bg-white px-3 py-2 dark:border-stone-800 dark:bg-stone-900">
            {narrow ? (
              <button className="mg-btn-ghost px-1.5" onClick={() => go(view, null)} aria-label="Back">
                <Icon name="chevronRight" size={18} className="rotate-180" /> Back
              </button>
            ) : (
              <OpenPaperButtons paperId={openPaper} />
            )}
            {narrow ? (
              <OpenPaperButtons paperId={openPaper} />
            ) : (
              <button className="mg-btn-ghost" onClick={() => go(view, null)} aria-label="Close">
                <Icon name="x" />
              </button>
            )}
          </div>
          <PaperDetail key={openPaper} paperId={openPaper} compact />
        </aside>
      )}

      <ProjectDialog open={projectDialog.open} project={projectDialog.project} onClose={() => setProjectDialog({ open: false, project: null })} rows={data?.rows ?? []} />
      {topicMenu && <TopicMenu topic={topicMenu} topics={data?.topics ?? []} onClose={() => setTopicMenu(null)} />}
      <ImportExportDialog open={importOpen} onClose={() => setImportOpen(false)} projects={projects} />
      {currentProject && <RelatedWorkDialog open={relatedOpen} onClose={() => setRelatedOpen(false)} project={currentProject} rows={data?.rows ?? []} />}
      {currentProject && <OverleafDialog open={overleafOpen} onClose={() => setOverleafOpen(false)} project={currentProject} />}
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
          <Icon name="external" size={13} /> HTML
        </a>
      )}
      {pdf && (
        <a className="mg-btn py-1 text-xs" href={readerUrl(pdf, p.id)} target={isWebApp() ? undefined : '_blank'} rel="noreferrer">
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
