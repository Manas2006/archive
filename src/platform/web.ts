// Entry point shared by every page of the web app (phones, iPads, any browser).
// Each web page imports this module first: it installs the chrome shim, runs the
// background's message handlers inside the page, and catches up on background
// work (enrichment queue, daily check) whenever the app is open.

import './chromeShim';
import { registerBackground } from '@/lib/bg/setup';
import { drainQueue, setVenueNotifier } from '@/lib/enrich';
import { lastDailyReport, runDaily } from '@/lib/daily';
import { parseArxivId, parsePaperUrl } from '@/lib/ids';
import { rpc } from '@/lib/rpc';
import type { VenueUpgrade } from '@/lib/venue';
import { FEED_NOTIFICATION_ID } from '@/lib/daily';
import { startServices } from '@/lib/bg/services';

const DAILY_EVERY_MS = 20 * 60 * 60 * 1000;
const BASE = import.meta.env.BASE_URL || '/';

registerBackground({ platform: 'web' });
startServices();

function notifyUpgrade(u: VenueUpgrade) {
  void chrome.notifications.create(`venue:${u.paperId}`, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('/icons/icon-192.png'),
    title: 'Venue version found',
    message: `"${u.title}" appeared at ${u.venue}. Its BibTeX now cites the venue version.`,
  });
}
setVenueNotifier(notifyUpgrade);
chrome.notifications.onClicked.addListener((id: string) => {
  if (id.startsWith('venue:')) location.assign(chrome.runtime.getURL(`/library.html#paper=${encodeURIComponent(id.slice('venue:'.length))}`));
  if (id === FEED_NOTIFICATION_ID) location.assign(chrome.runtime.getURL('/library.html#view=foryou'));
});

// ---- background jobs while the app is open ----

/** Run `fn` in one tab at a time; skip it when another tab of the app is already on it. */
async function exclusive(name: string, fn: () => Promise<unknown>): Promise<void> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks?.request) {
    await fn();
    return;
  }
  await locks.request(`archive:${name}`, { ifAvailable: true }, async (lock) => {
    if (lock) await fn();
  });
}

async function dailyIfDue() {
  const last = await lastDailyReport().catch(() => null);
  if (last && Date.now() - Date.parse(last.ranAt) < DAILY_EVERY_MS) return;
  await runDaily({ onUpgrade: notifyUpgrade });
}

function catchUp() {
  exclusive('queue', () => drainQueue()).catch((e) => console.warn('[archive] enrichment queue', e));
  exclusive('daily', () => dailyIfDue()).catch((e) => console.warn('[archive] daily check', e));
}

chrome.alarms.onAlarm.addListener((alarm: { name: string }) => {
  if (alarm.name === 'mg-queue') exclusive('queue', () => drainQueue()).catch(() => {});
  if (alarm.name === 'mg-daily') exclusive('daily', () => dailyIfDue()).catch(() => {});
});
void chrome.alarms.create('mg-queue', { periodInMinutes: 5 });
void chrome.alarms.create('mg-daily', { periodInMinutes: 60 });

// let the page render first; an installed app resumed from the background doesn't reload, so check again then
setTimeout(catchUp, 1500);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') catchUp();
});

// ---- offline app shell and storage ----

const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE }).catch((e) => console.warn('[archive] offline cache unavailable', e));
  });
}
// ask the browser not to evict the library (Safari clears site data after weeks of not visiting a site in a tab)
if (standalone()) navigator.storage?.persist?.().catch(() => {});

// ---- "Share to Archive" (Android installs the app as a share target) ----

function sharedPaper(): { url?: string; paperId?: string } | null {
  const q = new URLSearchParams(location.search);
  const text = [q.get('url'), q.get('text'), q.get('title')].filter(Boolean).join(' ');
  if (!text) return null;
  for (const m of text.matchAll(/https?:\/\/\S+/g)) if (parsePaperUrl(m[0])) return { url: m[0] };
  const ax = parseArxivId(text);
  return ax ? { paperId: `arxiv:${ax.id}` } : null;
}

const shared = /\/(index|library)\.html$|\/$/.test(location.pathname) ? sharedPaper() : null;
if (shared) {
  history.replaceState(null, '', location.pathname + location.hash);
  rpc
    .savePaper(shared)
    .then((r) => {
      location.hash = `paper=${encodeURIComponent(r.paperId)}`;
    })
    .catch((e: Error) => alert(`Couldn't add that paper: ${e.message}`));
}
