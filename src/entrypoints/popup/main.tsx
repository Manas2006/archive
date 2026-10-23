import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/tailwind.css';
import { useActiveTab } from '@/hooks/useActiveTab';
import { useLive } from '@/hooks/useLive';
import { useSettings } from '@/hooks/useSettings';
import { StatusSelect, Spinner, VenueBadge, WillCiteButton, authorLine } from '@/components/common';
import { Icon, Logo } from '@/components/Icon';
import * as repo from '@/lib/repo';
import { rpc } from '@/lib/rpc';
import { parsePaperUrl, readerUrl } from '@/lib/ids';

function App() {
  const tab = useActiveTab();
  const settings = useSettings();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctxUrl = tab.ctx?.url ?? tab.url ?? '';
  const parsed = ctxUrl ? parsePaperUrl(ctxUrl) : null;
  const paperId = tab.ctx?.paperId ?? parsed?.paperId ?? null;
  const { data } = useLive(async () => {
    if (!paperId) return null;
    const paper = await repo.getPaper(paperId);
    const entry = paper ? await repo.getEntry(paper.id) : undefined;
    return { paper: paper ?? null, entry: entry ?? null };
  }, [paperId]);

  const openPanel = async () => {
    if (tab.windowId !== null) await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  };

  const pdfUrl = data?.paper?.urls.pdf ?? (parsed?.arxiv ? `https://arxiv.org/pdf/${parsed.arxiv.id}` : parsed?.openreviewId ? `https://openreview.net/pdf?id=${parsed.openreviewId}` : null);

  return (
    <div className="w-[340px] bg-white dark:bg-stone-950">
      <header className="flex items-center gap-2 border-b border-stone-200 px-3 py-2 dark:border-stone-800">
        <Logo />
        <span className="text-sm font-semibold">Archive</span>
        <span className="ml-auto text-xs text-stone-400">{settings.ai ? 'AI on' : 'AI off'}</span>
      </header>
      {paperId ? (
        <div className="flex flex-col gap-3 p-3">
          {data?.paper ? (
            <div>
              <div className="font-serif text-[15px] font-semibold leading-snug">{data.paper.title}</div>
              <div className="mt-0.5 text-xs text-stone-500">{authorLine(data.paper, 3)}</div>
              <div className="mt-1.5">
                <VenueBadge paper={data.paper} />
              </div>
            </div>
          ) : (
            <div className="text-sm text-stone-600 dark:text-stone-300">{tab.ctx?.title ?? 'Paper detected on this page.'}</div>
          )}
          {data?.entry ? (
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-sm font-medium text-accent-700 dark:text-accent-300">
                <Icon name="check" size={15} /> Saved
              </span>
              <StatusSelect size="sm" value={data.entry.status} onChange={(status) => repo.updateEntry(data.paper!.id, { status })} />
              <WillCiteButton compact value={data.entry.willCite} onChange={(willCite) => repo.updateEntry(data.paper!.id, { willCite })} />
            </div>
          ) : (
            <button
              className="mg-btn-primary w-full py-2"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await rpc.savePaper({ url: ctxUrl && parsed ? ctxUrl : undefined, paperId });
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner /> : <Icon name="bookmark" size={15} />} Save paper
            </button>
          )}
          {error && <p className="text-xs text-rose-700">{error}</p>}
          <div className="grid grid-cols-2 gap-2">
            <button className="mg-btn" onClick={openPanel}>
              <Icon name="panel" size={14} /> Notes panel
            </button>
            {pdfUrl && tab.ctx?.kind !== 'reader' ? (
              <button
                className="mg-btn"
                onClick={() => {
                  if (tab.tabId !== null) chrome.tabs.update(tab.tabId, { url: readerUrl(pdfUrl, paperId) });
                  window.close();
                }}
              >
                <Icon name="book" size={14} /> Read PDF
              </button>
            ) : (
              <button className="mg-btn" onClick={() => rpc.openLibrary(data?.paper?.id).then(() => window.close())}>
                <Icon name="library" size={14} /> Library
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="p-4 text-sm text-stone-600 dark:text-stone-300">
          This page isn't an arXiv or OpenReview paper. Open one to save it and take notes.
        </div>
      )}
      <footer className="flex items-center gap-1 border-t border-stone-200 px-2 py-1.5 dark:border-stone-800">
        <button className="mg-btn-ghost text-xs" onClick={() => rpc.openLibrary().then(() => window.close())}>
          <Icon name="library" size={14} /> Library
        </button>
        <button className="mg-btn-ghost text-xs" onClick={() => rpc.openOptions().then(() => window.close())}>
          <Icon name="settings" size={14} /> Settings
        </button>
        <span className="ml-auto pr-1 text-[11px] text-stone-400">Alt+Shift+S saves</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
