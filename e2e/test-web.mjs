// The web app (PWA) build: the extension's pages on a plain web origin, through the
// chrome shim, in Chromium without the extension. Build it first:
//   npx vite build -c vite.web.config.ts
// Served at https://archive.test/archive/ by the mock server (like GitHub Pages).
import fs from 'node:fs';
import { chromium, devices } from 'playwright';
import { HOSTS, WEB_BASE, WEB_HOST, requests, startServer, state } from './server.mjs';
import { assert, horizontalOverflow, idb, selectText, shot, sleep, touchSelectText, waitFor } from './helpers.mjs';

const APP = `https://${WEB_HOST}${WEB_BASE}`;
const PDF = 'https://arxiv.org/pdf/2401.00001';
const READER = `${APP}reader.html?src=${encodeURIComponent(PDF)}&paper=${encodeURIComponent('arxiv:2401.00001')}`;
const TITLE = 'Filtered Attention for Long-Context Retrieval';

if (!fs.existsSync(new URL('../dist-web/index.html', import.meta.url))) {
  console.error('dist-web/ is missing. Build the web app first: npx vite build -c vite.web.config.ts');
  process.exit(1);
}
fs.mkdirSync('/tmp/claude-0/shots', { recursive: true });

const server = await startServer();
const env = { ...process.env };
for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY', 'all_proxy']) delete env[k];
const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  env,
  args: [`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1`).join(',')}`, '--ignore-certificate-errors', '--no-proxy-server'],
});

// Requests the web app can't make (no CORS) until enrich.ts skips them there. Reported, not failed.
const CORS_BLOCKED = /dblp\.org|openreview\.net|export\.arxiv\.org/;
const errors = [];
const expected = [];
function watch(page, label) {
  page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = `${m.text()} ${m.location()?.url ?? ''}`;
    if (CORS_BLOCKED.test(text)) expected.push(`${label}: ${m.text().slice(0, 160)}`);
    // S2 answers "not found" with a 404, and its 429s (the outage test) have no CORS headers
    else if (/api\.semanticscholar\.org/.test(text) && /404|429|CORS|ERR_FAILED/.test(text)) expected.push(`${label}: ${m.text().slice(0, 120)}`);
    else errors.push(`${label} console: ${text}`);
  });
  return page;
}

async function addPaper(page, value) {
  const input = page.locator('input[placeholder*="arXiv" i]').first();
  // phones: the add field sits behind the "Search and add" button
  if (!(await input.isVisible().catch(() => false))) {
    const toggle = page.locator('button[aria-label="Search and add"]');
    if (await toggle.count()) await toggle.first().click();
  }
  await input.fill(value);
  await input.press('Enter');
}

const paperNotSaved = (page, id) => idb(page, 'papers', id).then((p) => !p);

try {
  // ---------------------------------------------------------------------------
  console.log('\n# Library loads on a plain web origin');
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 }, ignoreHTTPSErrors: true });
  const lib = watch(await desk.newPage(), 'library');
  await lib.goto(APP);
  await waitFor(() => lib.evaluate(() => document.getElementById('root')?.childElementCount > 0), { label: 'library rendered' });
  assert(true, 'library page renders at the app root');
  const shim = await lib.evaluate(() => ({ id: chrome.runtime.id, reader: chrome.runtime.getURL('/reader.html'), version: chrome.runtime.getManifest().version }));
  assert(shim.id === 'archive-web' && shim.reader === `${APP}reader.html`, `chrome shim installed (getURL -> ${shim.reader})`);
  const settings = await waitFor(() => lib.evaluate(() => JSON.parse(localStorage.getItem('archive.local:settings') ?? 'null')), { label: 'settings in localStorage' });
  assert(!!settings.userId, 'chrome.storage.local is backed by localStorage');
  const rpcRes = await lib.evaluate(() => chrome.runtime.sendMessage({ __mg_rpc: 'aiAvailable', args: [] }));
  assert(rpcRes?.ok === true && rpcRes.result === false, 'RPC answered by the in-page background');

  console.log('\n# Storage change events, in this tab and across tabs');
  const sameTab = await lib.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.storage.onChanged.addListener(function l(changes, area) {
          if (!changes.webTest) return;
          chrome.storage.onChanged.removeListener(l);
          resolve({ area, value: changes.webTest.newValue });
        });
        chrome.storage.local.set({ webTest: { n: 1 } });
      }),
  );
  assert(sameTab.area === 'local' && sameTab.value.n === 1, 'onChanged fires in the writing tab');
  const other = watch(await desk.newPage(), 'second tab');
  await other.goto(`${APP}library.html`);
  const crossTab = lib.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.storage.onChanged.addListener(function l(changes) {
          if (!changes.webTest || changes.webTest.newValue?.n !== 2) return;
          chrome.storage.onChanged.removeListener(l);
          resolve(changes.webTest);
        });
      }),
  );
  await other.evaluate(() => chrome.storage.local.set({ webTest: { n: 2 } }));
  const ct = await crossTab;
  assert(ct.oldValue.n === 1 && ct.newValue.n === 2, 'onChanged fires in other tabs (storage event)');
  const got = await lib.evaluate(() => Promise.all([chrome.storage.local.get('webTest'), chrome.storage.local.get(['webTest', 'nope']), chrome.storage.local.get({ nope: 7 })]));
  assert(got[0].webTest.n === 2 && !('nope' in got[1]) && got[2].nope === 7, 'get() takes a key, a list and defaults');
  await other.close();

  console.log('\n# Add a paper by arXiv ID (metadata from Semantic Scholar)');
  const arxivApiBefore = requests.filter((r) => r.host === 'export.arxiv.org').length;
  await addPaper(lib, '2401.00001');
  const paper = await waitFor(() => idb(lib, 'papers', 'arxiv:2401.00001'), { label: 'paper saved', timeout: 20000 });
  assert(paper.title === TITLE && paper.authors.some((a) => /Lovelace/.test(a.family ?? a.name ?? JSON.stringify(a))), `title and authors from S2 (${paper.title})`);
  assert(paper.abstract.startsWith('Long-context language models'), 'abstract from S2');
  assert(requests.filter((r) => r.host === 'export.arxiv.org').length === arxivApiBefore, 'no request to the arXiv API (it has no CORS)');
  const entry = await waitFor(() => idb(lib, 'library', 'arxiv:2401.00001'), { label: 'library entry' });
  assert(entry.status === 'inbox', 'paper is in the library');

  console.log('\n# Share to Archive asks first');
  const shareUrl = `${APP}library.html?url=${encodeURIComponent('https://arxiv.org/abs/2402.00002')}`;
  const sharePage = watch(await desk.newPage(), 'share');
  let asked = '';
  sharePage.once('dialog', (d) => {
    asked = d.message();
    void d.dismiss();
  });
  await sharePage.goto(shareUrl);
  await waitFor(() => asked, { label: 'share confirmation' });
  await sleep(1500);
  assert(asked.includes('arxiv.org/abs/2402.00002') && (await paperNotSaved(sharePage, 'arxiv:2402.00002')), 'a shared link is not saved when the person says no');
  assert(!(await sharePage.evaluate(() => location.search)), 'the shared link is removed from the address bar');
  await sharePage.close();

  console.log('\n# OpenReview links explain where to add them');
  await addPaper(lib, 'https://openreview.net/forum?id=ORabc123');
  await waitFor(
    () => lib.evaluate(() => document.body.innerText.includes('Open OpenReview papers in the Archive extension') || !!document.querySelector('[title*="Open OpenReview papers in the Archive extension"]')),
    { label: 'OpenReview message' },
  );
  assert(await paperNotSaved(lib, 'openreview:ORabc123'), 'OpenReview link shows the extension message and saves nothing');
  await shot(lib, 'web-library');

  console.log('\n# Reader: open, highlight, reload');
  const reader = watch(await desk.newPage(), 'reader');
  await reader.goto(READER);
  await reader.waitForSelector('.textLayer span', { timeout: 20000 });
  assert(true, 'PDF renders in the web reader (pdf.js worker, cmaps, CORS fetch)');
  await sleep(500);
  await selectText(reader, 'improves retrieval recall by 11.4 points', '#viewer');
  await reader.locator('button[title^="Result"]').click();
  await waitFor(async () => (await reader.locator('.textLayer mark.mg-hl[data-mg-label="result"]').count()) > 0, { label: 'highlight mark' });
  const anns = await waitFor(async () => {
    const a = (await idb(reader, 'annotations')).filter((x) => !x.deletedAt);
    return a.length === 1 ? a : null;
  }, { label: 'annotation saved' });
  assert(anns[0].target.state.medium === 'pdf' && anns[0].paperId === 'arxiv:2401.00001', 'highlight stored in IndexedDB');
  await reader.reload();
  await reader.waitForSelector('.textLayer span', { timeout: 20000 });
  await waitFor(async () => (await reader.locator('.textLayer mark.mg-hl[data-mg-label="result"]').count()) > 0, { label: 'highlight after reload', timeout: 10000 });
  assert(true, 'highlight persists after reload');
  const finder = watch(await desk.newPage(), 'reader find');
  await finder.goto(`${READER}&find=${encodeURIComponent('The scoring layer is trained with a contrastive objective')}`);
  await finder.locator('.textLayer mark[data-mg-id="mg-find"]').first().waitFor({ state: 'attached', timeout: 20000 });
  assert(true, 'reader links with &find= flash the quoted passage');
  await finder.close();
  await reader.locator('button[title="Notes and highlights"]').click();
  await reader.locator('[role="dialog"]').getByText('improves retrieval recall', { exact: false }).first().waitFor({ timeout: 10000 });
  assert(true, 'notes button opens the drawer with the highlight list (no side panel in the web app)');
  await shot(reader, 'web-reader-drawer');
  await reader.keyboard.press('Escape');

  console.log('\n# Installable: manifest and offline service worker');
  const manifest = await lib.evaluate(async () => {
    const href = document.querySelector('link[rel="manifest"]')?.href;
    return href ? (await fetch(href)).json() : null;
  });
  assert(manifest?.name === 'Archive' && manifest.display === 'standalone' && manifest.icons.some((i) => i.purpose === 'maskable'), 'web manifest is linked (standalone, maskable icon)');
  const sw = await waitFor(
    () => lib.evaluate(async () => {
      const r = await navigator.serviceWorker.getRegistration();
      return r?.active?.state === 'activated' ? r.scope : null;
    }),
    { label: 'service worker', timeout: 15000 },
  );
  assert(sw === APP, `service worker active for ${sw}`);
  const cached = await lib.evaluate(async () => {
    const keys = await caches.keys();
    const shell = keys.find((k) => k.startsWith('archive-shell-'));
    return shell ? (await (await caches.open(shell)).keys()).map((r) => new URL(r.url).pathname) : [];
  });
  assert(cached.includes(`${WEB_BASE}reader.html`) && cached.some((p) => p.endsWith('.js')), `app shell cached (${cached.length} files)`);
  await desk.close();

  // ---------------------------------------------------------------------------
  console.log('\n# iPhone: metadata from the arXiv HTML page when Semantic Scholar is down');
  const phone = await browser.newContext({ ...devices['iPhone 13'], ignoreHTTPSErrors: true });
  const plib = watch(await phone.newPage(), 'phone library');
  await plib.goto(`${APP}library.html#view=all`);
  await waitFor(() => plib.evaluate(() => document.getElementById('root')?.childElementCount > 0), { label: 'phone library rendered' });
  state.s2Down = true;
  await addPaper(plib, '2401.00001');
  const p2 = await waitFor(() => idb(plib, 'papers', 'arxiv:2401.00001'), { label: 'paper from HTML', timeout: 40000 });
  state.s2Down = false;
  assert(p2.title === TITLE, `title from the arXiv HTML page (${p2.title})`);
  assert(p2.authors.length === 2 && p2.abstract.startsWith('Long-context language models'), 'authors and abstract from the HTML page');
  assert(p2.firstFigureUrl === 'https://arxiv.org/html/2401.00001/x1.png', `first figure from the HTML page (${p2.firstFigureUrl})`);
  await sleep(500);
  const libOverflow = await horizontalOverflow(plib);
  await shot(plib, 'web-phone-library');
  assert(libOverflow <= 0, `library has no horizontal scrollbar at 390px (overflow ${libOverflow}px)`);

  console.log('\n# iPhone reader: layout and touch selection');
  const pr = watch(await phone.newPage(), 'phone reader');
  await pr.goto(READER);
  await pr.waitForSelector('.textLayer span', { timeout: 20000 });
  await sleep(800);
  assert((await horizontalOverflow(pr)) <= 0, 'reader has no horizontal scrollbar at 390px');
  const header = await pr.evaluate(() => {
    const h = document.querySelector('header');
    const overflowing = [...h.querySelectorAll('button, select, a')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5);
    });
    return { fits: h.scrollWidth <= h.clientWidth, overflowing: overflowing.length };
  });
  assert(header.fits && header.overflowing === 0, 'reader toolbar fits a phone screen');
  const pageWidth = await pr.evaluate(() => document.querySelector('.pdfViewer .page').getBoundingClientRect().width);
  assert(pageWidth <= 390 && pageWidth > 300, `PDF opens at fit width (${Math.round(pageWidth)}px page)`);
  const coarse = await pr.evaluate(() => matchMedia('(pointer: coarse)').matches);

  await touchSelectText(pr, 'improves retrieval recall by 11.4 points', '#viewer');
  const early = await pr.locator('[data-mg-toolbar]').count();
  await pr.locator('[data-mg-toolbar]').waitFor({ timeout: 3000 });
  assert(early === 0, 'toolbar waits for the touch selection to settle');
  const geo = await pr.evaluate(() => {
    const sel = window.getSelection();
    const rects = sel.rangeCount ? [...sel.getRangeAt(0).getClientRects()] : [];
    const bottom = Math.max(...rects.map((r) => r.bottom));
    const tb = document.querySelector('[data-mg-toolbar]').getBoundingClientRect();
    const heights = [...document.querySelectorAll('[data-mg-toolbar] button')].map((b) => b.getBoundingClientRect().height);
    return { bottom, top: tb.top, right: tb.right, left: tb.left, vw: window.innerWidth, minHeight: Math.min(...heights) };
  });
  assert(geo.top >= geo.bottom, `toolbar sits below the selection (toolbar top ${Math.round(geo.top)}, selection bottom ${Math.round(geo.bottom)})`);
  assert(geo.left >= 0 && geo.right <= geo.vw, 'toolbar stays inside the viewport');
  assert(geo.minHeight >= 40, `toolbar buttons are at least 40px tall (${geo.minHeight}px)`);
  await shot(pr, 'web-phone-toolbar');
  await pr.locator('[data-mg-toolbar] button[aria-label="Method"]').tap();
  await waitFor(async () => (await pr.locator('.textLayer mark.mg-hl[data-mg-label="method"]').count()) > 0, { label: 'tap creates the highlight' });
  const phoneAnns = await waitFor(async () => {
    const a = (await idb(pr, 'annotations')).filter((x) => !x.deletedAt);
    return a.length === 1 ? a : null;
  }, { label: 'phone annotation saved' });
  assert(phoneAnns[0].body.some((b) => b.value === 'method'), 'tapping a toolbar button highlights the touch selection');

  console.log('\n# Apple Pencil (pen) selections work the same way');
  await touchSelectText(pr, 'The scoring layer is trained with a contrastive objective', '#viewer', 'pen');
  await pr.locator('[data-mg-toolbar]').waitFor({ timeout: 3000 });
  await pr.locator('[data-mg-toolbar] button[aria-label="Interesting"]').tap();
  await waitFor(async () => (await pr.locator('.textLayer mark.mg-hl[data-mg-label="interesting"]').count()) > 0, { label: 'pen highlight' });
  assert(true, 'pen selection highlights too');

  console.log('\n# iPhone reader: menu and drawer');
  await pr.locator('button[aria-label="More"]').tap();
  await pr.locator('[data-mg-menu]').getByText('Fit width').waitFor();
  assert((await horizontalOverflow(pr)) <= 0, 'menu opens without horizontal scrolling');
  await shot(pr, 'web-phone-menu');
  await pr.locator('[data-mg-menu] button[title="Zoom in"]').tap();
  await waitFor(async () => (await pr.evaluate(() => document.querySelector('.pdfViewer .page').getBoundingClientRect().width)) > pageWidth + 20, { label: 'zoom in from the menu' });
  assert(true, 'zoom works from the menu');
  await pr.locator('[data-mg-menu]').getByText('Fit width').tap();
  await pr.locator('button[title="Notes and highlights"]').tap();
  await pr.locator('[role="dialog"]').getByText('contrastive objective', { exact: false }).first().waitFor({ timeout: 10000 });
  await sleep(400); // slide-in transition
  const drawerBox = await pr.evaluate(() => {
    const r = document.querySelector('[role="dialog"]').getBoundingClientRect();
    return { left: r.left, right: r.right, vw: window.innerWidth };
  });
  assert((await horizontalOverflow(pr)) <= 0 && Math.abs(drawerBox.left) < 1 && Math.abs(drawerBox.right - drawerBox.vw) < 1, `drawer fills the phone screen (${Math.round(drawerBox.left)} to ${Math.round(drawerBox.right)} of ${drawerBox.vw})`);
  await shot(pr, 'web-phone-drawer');
  console.log(`  (touch media query coarse: ${coarse})`);
  await phone.close();

  const unexpectedCors = expected.filter((e) => /export\.arxiv\.org/.test(e));
  assert(unexpectedCors.length === 0, 'no blocked calls to the arXiv API');
  if (expected.length) console.log(`\n  note: ${expected.length} expected console errors (DBLP/OpenReview have no CORS; S2 outage test):\n    ${[...new Set(expected.map((e) => e.replace(/^[^:]+: /, '').slice(0, 110)))].slice(0, 6).join('\n    ')}`);
  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  console.log('\nALL WEB TESTS PASSED');
} catch (e) {
  console.error(e);
  console.error('errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
