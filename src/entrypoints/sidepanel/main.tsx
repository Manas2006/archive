import { createRoot } from 'react-dom/client';
import '@/assets/tailwind.css';
import { useActiveTab } from '@/hooks/useActiveTab';
import { useLive } from '@/hooks/useLive';
import { useSettings } from '@/hooks/useSettings';
import { PaperDetail } from '@/components/PaperDetail';
import { EmptyState, Spinner, timeAgo } from '@/components/common';
import { Icon, Logo } from '@/components/Icon';
import * as repo from '@/lib/repo';
import { rpc, sendToTab } from '@/lib/rpc';

function openLibrary(paperId?: string) {
  chrome.tabs.create({ url: chrome.runtime.getURL('/library.html') + (paperId ? `#paper=${encodeURIComponent(paperId)}` : '') });
}

function Recent() {
  const { data } = useLive(async () => {
    const entries = (await repo.listEntries()).sort((a, b) => (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt)).slice(0, 8);
    const papers = new Map((await repo.getPapers(entries.map((e) => e.paperId))).map((p) => [p.id, p] as const));
    return entries.map((e) => ({ e, p: papers.get(e.paperId) })).filter((x) => x.p);
  }, []);
  if (!data?.length) return null;
  return (
    <div className="px-4 pb-4">
      <div className="mg-label mb-2">Recent papers</div>
      <ul className="flex flex-col gap-1">
        {data.map(({ e, p }) => (
          <li key={e.paperId}>
            <button
              className="w-full rounded-md px-2 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-800"
              onClick={() => {
                const url = p!.urls.html ?? p!.urls.abs ?? p!.urls.openreview;
                if (url) chrome.tabs.update({ url });
                else openLibrary(p!.id);
              }}
            >
              <div className="line-clamp-2 font-serif text-sm text-stone-800 dark:text-stone-100">{p!.title}</div>
              <div className="text-xs text-stone-400">{timeAgo(e.lastOpenedAt ?? e.createdAt)}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function App() {
  const tab = useActiveTab();
  const settings = useSettings();
  const paperId = tab.ctx?.paperId ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-white dark:bg-stone-950">
      <header className="flex items-center gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
        <Logo />
        <span className="text-sm font-semibold tracking-tight">Archive</span>
        {settings.ai && <span className="rounded bg-accent-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-700 dark:bg-accent-900/40 dark:text-accent-200">AI</span>}
        <div className="ml-auto flex items-center">
          <button className="mg-btn-ghost px-1.5" title="Open library" onClick={() => openLibrary(paperId ?? undefined)}>
            <Icon name="library" size={16} />
          </button>
          <button className="mg-btn-ghost px-1.5" title="Settings" onClick={() => rpc.openOptions()}>
            <Icon name="settings" size={16} />
          </button>
        </div>
      </header>
      {tab.tabId === null ? (
        <div className="flex justify-center p-8 text-stone-400">
          <Spinner />
        </div>
      ) : paperId ? (
        <PaperDetail
          key={paperId}
          paperId={paperId}
          orphanIds={tab.orphanIds}
          onJump={(id) => tab.tabId !== null && sendToTab(tab.tabId, { type: 'scroll-to-annotation', id })}
        />
      ) : (
        <>
          <EmptyState icon="book" title="Open a paper">
            Go to a paper on arXiv (abstract, HTML or PDF) or OpenReview. Its highlights, notes and BibTeX show up here.
          </EmptyState>
          <Recent />
        </>
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
