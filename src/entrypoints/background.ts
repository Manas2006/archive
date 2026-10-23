import { defineBackground } from 'wxt/utils/define-background';
import { handlers, bypassReader } from '@/lib/bg/handlers';
import { registerBackground } from '@/lib/bg/setup';
import { drainQueue, enqueueEnrich, setVenueNotifier } from '@/lib/enrich';
import { parsePaperUrl, readerUrl } from '@/lib/ids';
import { getSettings } from '@/lib/settings';
import { savePaper } from '@/lib/capture';
import type { TabContext } from '@/lib/types';
import type { VenueUpgrade } from '@/lib/venue';
import { getApiKey } from '@/lib/secrets';
import { openNotesPanel } from '@/platform/panel';
import { hasHostPermissions, onHostPermissionsChanged, watchAiDataConsent } from '@/platform/permissions';
import { isFirefox } from '@/lib/platform';
import { dailyAfterSync, periodicDriveSync, startServices } from '@/lib/bg/services';
import { FEED_NOTIFICATION_ID } from '@/lib/daily';

// Firefox for Android has no context menus, commands or notifications, and only
// Chrome has chrome.sidePanel, so every one of those is optional here.

/** Alarms can be cleared on browser restart; recreate them whenever the worker starts. */
async function ensureAlarms() {
  if (!(await chrome.alarms.get('mg-daily'))) chrome.alarms.create('mg-daily', { periodInMinutes: 24 * 60, delayInMinutes: 2 });
  if (!(await chrome.alarms.get('mg-queue'))) chrome.alarms.create('mg-queue', { periodInMinutes: 5 });
  if (!(await chrome.alarms.get('mg-sync'))) chrome.alarms.create('mg-sync', { periodInMinutes: 15 });
}

const PAPER_PATTERNS = [
  'https://arxiv.org/abs/*',
  'https://arxiv.org/html/*',
  'https://arxiv.org/pdf/*',
  'https://openreview.net/forum*',
  'https://openreview.net/pdf*',
];

function notifyUpgrade(u: VenueUpgrade) {
  chrome.notifications
    ?.create(`venue:${u.paperId}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('/icon/128.png'),
      title: 'Venue version found',
      message: `"${u.title}" appeared at ${u.venue}. Its BibTeX now cites the venue version.`,
      priority: 0,
    })
    ?.catch?.(() => {});
}

async function tabContext(tabId: number): Promise<TabContext | null> {
  return ((await chrome.storage.session.get(`tab:${tabId}`))[`tab:${tabId}`] as TabContext | undefined) ?? null;
}

/** Badge on the toolbar button (not every browser has one, e.g. Firefox for Android). */
async function badge(tabId: number, text: string, color?: string) {
  try {
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    /* no badge support */
  }
}

/** Firefox lets people decline or revoke host access: mark the toolbar button so they find the popup's "Grant access". */
async function flagHostAccess() {
  const ok = await hasHostPermissions();
  try {
    await chrome.action.setBadgeText({ text: ok ? '' : '!' });
    if (!ok) await chrome.action.setBadgeBackgroundColor({ color: '#b45309' });
    await chrome.action.setTitle({ title: ok ? 'Archive' : 'Archive needs access to arXiv and OpenReview' });
  } catch {
    /* no toolbar button (Firefox for Android) */
  }
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
    await badge(tab.id, '✓', '#22766c');
    setTimeout(() => void badge(tab.id!, ''), 2500);
  } catch (e) {
    await badge(tab.id, '!', '#be123c');
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

    // ---- RPC and the AI port (shared with the web app) ----
    registerBackground({ platform: 'extension' });
    // follow migration, Drive sync, project .bib files in Drive
    startServices();
    watchAiDataConsent();

    if (isFirefox()) {
      void flagHostAccess();
      onHostPermissionsChanged(() => void flagHostAccess());
    }

    // ---- install / startup ----
    chrome.runtime.onInstalled.addListener(async (details) => {
      chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })?.catch(() => {});
      chrome.contextMenus?.removeAll(() => {
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
      if (alarm.name === 'mg-daily') void dailyAfterSync({ onUpgrade: notifyUpgrade }).catch(() => {});
      if (alarm.name === 'mg-queue') void drainQueue();
      if (alarm.name === 'mg-sync') void periodicDriveSync().catch(() => {});
    });

    // ---- commands and menus ----
    // (Firefox opens its sidebar with the built-in _execute_sidebar_action command instead)
    chrome.commands?.onCommand.addListener((command, tab) => {
      if (command === 'open-side-panel' && tab?.id !== undefined) {
        openNotesPanel({ tabId: tab.id }).catch(() => {});
      } else if (command === 'save-paper') {
        void saveTab(tab);
      } else if (command === 'open-library') {
        chrome.tabs.create({ url: chrome.runtime.getURL('/library.html') });
      }
    });

    chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
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

    chrome.notifications?.onClicked.addListener((id) => {
      if (id.startsWith('venue:')) {
        const paperId = id.slice('venue:'.length);
        chrome.tabs.create({ url: chrome.runtime.getURL(`/library.html#paper=${encodeURIComponent(paperId)}`) });
      }
      if (id === FEED_NOTIFICATION_ID) {
        chrome.tabs.create({ url: chrome.runtime.getURL('/library.html#view=foryou') });
        chrome.notifications.clear(id).catch?.(() => {});
      }
    });
  },
});
