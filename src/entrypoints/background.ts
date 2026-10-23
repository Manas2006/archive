import { defineBackground } from 'wxt/utils/define-background';
import { handlers, bypassReader, type RpcCtx } from '@/lib/bg/handlers';
import type { RpcRequest, RpcResponse } from '@/lib/rpc';
import { onChange, type ChangeEvent } from '@/lib/changes';
import { drainQueue, enqueueEnrich, setVenueNotifier } from '@/lib/enrich';
import { runDaily } from '@/lib/daily';
import { followUp, startThread } from '@/lib/ai/features';
import type { AiPortEvent, AiPortRequest } from '@/lib/ai/port';
import { parsePaperUrl, readerUrl } from '@/lib/ids';
import { getSettings } from '@/lib/settings';
import { savePaper } from '@/lib/capture';
import type { TabContext } from '@/lib/types';
import type { VenueUpgrade } from '@/lib/venue';
import { getApiKey } from '@/lib/secrets';

/** Alarms can be cleared on browser restart; recreate them whenever the worker starts. */
async function ensureAlarms() {
  if (!(await chrome.alarms.get('mg-daily'))) chrome.alarms.create('mg-daily', { periodInMinutes: 24 * 60, delayInMinutes: 2 });
  if (!(await chrome.alarms.get('mg-queue'))) chrome.alarms.create('mg-queue', { periodInMinutes: 5 });
}

const PAPER_PATTERNS = [
  'https://arxiv.org/abs/*',
  'https://arxiv.org/html/*',
  'https://arxiv.org/pdf/*',
  'https://openreview.net/forum*',
  'https://openreview.net/pdf*',
];

function notifyUpgrade(u: VenueUpgrade) {
  chrome.notifications.create(`venue:${u.paperId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('/icon/128.png'),
    title: 'Venue version found',
    message: `"${u.title}" appeared at ${u.venue}. Its BibTeX now cites the venue version.`,
    priority: 0,
  });
}

async function tabContext(tabId: number): Promise<TabContext | null> {
  return ((await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] as TabContext | undefined) ?? null;
}

async function saveTab(tab: chrome.tabs.Tab | undefined) {
  if (!tab?.id) return;
  const ctx = await tabContext(tab.id);
  const url = ctx?.url ?? tab.url;
  const paperId = ctx?.paperId ?? (url ? parsePaperUrl(url)?.paperId : null);
  if (!url && !paperId) return;
  try {
    const res = await savePaper({ url: url && parsePaperUrl(url) ? url : undefined, paperId: paperId ?? undefined });
    void enqueueEnrich(res.paper.id);
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#22766c' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '✓' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id!, text: '' }).catch(() => {}), 2500);
  } catch (e) {
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#be123c' });
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    console.warn('[archive] save failed', e);
  }
}

export default defineBackground({
  type: 'module',
  main() {
    setVenueNotifier(notifyUpgrade);
    void ensureAlarms();
    // moves a key saved by the first build out of chrome.storage.local
    void getApiKey().catch(() => {});

    // ---- install / startup ----
    chrome.runtime.onInstalled.addListener(async (details) => {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: 'mg-save', title: 'Save paper to Archive', contexts: ['page'], documentUrlPatterns: PAPER_PATTERNS });
        chrome.contextMenus.create({
          id: 'mg-figure',
          title: 'Use this image as the factoid figure',
          contexts: ['image'],
          documentUrlPatterns: ['https://arxiv.org/html/*'],
        });
        chrome.contextMenus.create({
          id: 'mg-reader',
          title: 'Open PDF in Archive reader',
          contexts: ['link'],
          targetUrlPatterns: ['https://arxiv.org/pdf/*', 'https://openreview.net/pdf*'],
        });
      });
      await ensureAlarms();
      await getSettings(); // creates the user id
      if (details.reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('/options.html#welcome') });
    });

    chrome.runtime.onStartup.addListener(() => {
      void drainQueue();
    });

    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === 'mg-daily') void runDaily({ onUpgrade: notifyUpgrade });
      if (alarm.name === 'mg-queue') void drainQueue();
    });

    // ---- RPC ----
    chrome.runtime.onMessage.addListener((msg: RpcRequest, sender, sendResponse) => {
      if (!msg || typeof msg !== 'object' || !('__mg_rpc' in msg)) return;
      const method = msg.__mg_rpc;
      const ctx: RpcCtx = { tabId: sender.tab?.id, windowId: sender.tab?.windowId, url: sender.url };
      // sidePanel.open must run synchronously inside the user gesture
      if (method === 'openSidePanel') {
        if (ctx.tabId !== undefined) {
          chrome.sidePanel
            .open({ tabId: ctx.tabId })
            .then(() => sendResponse({ ok: true, result: true } satisfies RpcResponse))
            .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies RpcResponse));
          return true;
        }
        sendResponse({ ok: false, error: 'No tab' });
        return;
      }
      const fn = (handlers as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
      if (!fn) {
        sendResponse({ ok: false, error: `Unknown method ${method}` } satisfies RpcResponse);
        return;
      }
      fn(ctx, ...(msg.args ?? []))
        .then((result) => sendResponse({ ok: true, result } satisfies RpcResponse))
        .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies RpcResponse));
      return true;
    });

    // ---- change relay to content scripts ----
    const tabPorts = new Set<chrome.runtime.Port>();
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name === 'mg-tab') {
        tabPorts.add(port);
        port.onDisconnect.addListener(() => tabPorts.delete(port));
        return;
      }
      if (port.name === 'mg-ai') {
        const ctrl = new AbortController();
        let closed = false;
        port.onDisconnect.addListener(() => {
          closed = true;
          ctrl.abort();
        });
        const send = (e: AiPortEvent) => {
          if (!closed) port.postMessage(e);
        };
        port.onMessage.addListener(async (req: AiPortRequest) => {
          const cb = { onThread: (thread: any) => send({ type: 'thread', thread }), onDelta: (text: string) => send({ type: 'delta', text }), signal: ctrl.signal };
          try {
            const thread = req.op === 'start' ? await startThread(req.input, cb) : await followUp(req.threadId, req.text, cb);
            send({ type: 'done', thread });
          } catch (e) {
            if ((e as Error).name !== 'AbortError') send({ type: 'error', message: (e as Error).message });
          }
        });
      }
    });
    onChange((evt: ChangeEvent) => {
      for (const p of tabPorts) {
        try {
          p.postMessage({ type: 'change', evt });
        } catch {
          tabPorts.delete(p);
        }
      }
    });

    // ---- commands and menus ----
    chrome.commands.onCommand.addListener((command, tab) => {
      if (command === 'open-side-panel' && tab?.id !== undefined) {
        chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
      } else if (command === 'save-paper') {
        void saveTab(tab);
      } else if (command === 'open-library') {
        chrome.tabs.create({ url: chrome.runtime.getURL('/library.html') });
      }
    });

    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      if (info.menuItemId === 'mg-save') void saveTab(tab);
      if (info.menuItemId === 'mg-reader' && info.linkUrl) {
        const parsed = parsePaperUrl(info.linkUrl);
        chrome.tabs.create({ url: readerUrl(info.linkUrl, parsed?.paperId) });
      }
      if (info.menuItemId === 'mg-figure' && info.srcUrl && tab?.id !== undefined) {
        const ctx = await tabContext(tab.id);
        if (!ctx?.paperId) return;
        await savePaper({ url: ctx.url }).catch(() => null);
        await handlers.setFactoidFigure({}, ctx.paperId, info.srcUrl);
      }
    });

    // ---- open arXiv / OpenReview PDFs in the reader ----
    chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
      const url = changeInfo.url;
      if (!url) return;
      const parsed = parsePaperUrl(url);
      if (!parsed || (parsed.kind !== 'arxiv-pdf' && parsed.kind !== 'openreview-pdf')) return;
      if (bypassReader.has(tabId)) {
        bypassReader.delete(tabId);
        return;
      }
      const s = await getSettings();
      if (!s.readerRedirect) return;
      chrome.tabs.update(tabId, { url: readerUrl(url, parsed.paperId) }).catch(() => {});
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      chrome.storage.session.remove(`tab:${tabId}`).catch(() => {});
      bypassReader.delete(tabId);
    });

    chrome.notifications.onClicked.addListener((id) => {
      if (id.startsWith('venue:')) {
        const paperId = id.slice('venue:'.length);
        chrome.tabs.create({ url: chrome.runtime.getURL(`/library.html#paper=${encodeURIComponent(paperId)}`) });
      }
    });
  },
});
