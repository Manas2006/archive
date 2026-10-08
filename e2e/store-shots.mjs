// Generates Chrome Web Store screenshots (1280x800) from the extension running
// against the mock services. Usage: node e2e/store-shots.mjs <outdir>
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { idb, selectText, sleep, waitFor } from './helpers.mjs';

const OUT = process.argv[2] ?? '/tmp/store-shots';
fs.mkdirSync(OUT, { recursive: true });
const server = await startServer();
const { context, extensionId } = await launch();
const ext = (p) => `chrome-extension://${extensionId}/${p}`;
const W = 1280;
const H = 800;

const opts = await context.newPage();
await opts.goto(ext('options.html'));
await opts.fill('input[placeholder="Your name"]', 'Manas');
await opts.locator('button[role="switch"]').first().click();
await opts.fill('input[placeholder="sk-ant-…"]', 'sk-ant-test');
await opts.locator('button:has-text("Save")').first().click();
await opts.locator('text=Key works').waitFor();

async function highlight(page, text, label, root) {
  await selectText(page, text, root);
  await sleep(250);
  await page.locator(`button[title^="${label}"]`).first().click();
  await sleep(600);
}

// ---- annotate the HTML paper ----
const html = await context.newPage();
await html.setViewportSize({ width: W, height: H });
await html.goto('https://arxiv.org/html/2401.00001v2');
await html.waitForSelector('marginalia-ui', { state: 'attached' });
await sleep(600);
await highlight(html, 'Long-context language models often struggle to use information placed in the middle of their input', 'Problem');
await highlight(html, 'We propose filtered attention, which scores every key block and keeps only the top', 'Method');
await selectText(html, 'Filtered attention improves retrieval recall by 11.4 points at 128k tokens on NeedleBench');
await sleep(250);
await html.locator('button[title="Highlight and add a note"]').click();
await html.fill('textarea[placeholder="Note (Markdown)…"]', 'Key result: big gain at 128k with 38% fewer FLOPs.');
await html.locator('textarea[placeholder="Note (Markdown)…"]').blur();
await sleep(900);
await html.keyboard.press('Escape');
await sleep(300);
await highlight(html, 'Our approach keeps the base model frozen.', 'Interesting');
await highlight(html, 'The scoring layer is trained with a contrastive objective on synthetic retrieval tasks', 'Weakness');
await waitFor(async () => (await idb(opts, 'annotations')).filter((a) => !a.deletedAt).length >= 5, { label: '5 annotations' });
await html.mouse.click(5, 5);

// ---- library contents ----
const lib = await context.newPage();
await lib.setViewportSize({ width: W, height: H });
await lib.goto(ext('library.html#view=all'));
for (const id of ['2402.00002', '2404.00004', '2405.00005', '2406.00006', '2407.00007']) {
  await lib.fill('input[placeholder="Add by arXiv ID or URL"]', id);
  await lib.locator('input[placeholder="Add by arXiv ID or URL"] + button').click();
  await waitFor(async () => (await idb(opts, 'library', `arxiv:${id}`)) ?? null, { label: id });
}
const or = await context.newPage();
await or.goto('https://openreview.net/forum?id=ORabc123');
await or.locator('button:has-text("Save paper")').click();
await sleep(1500);
await or.close();
await waitFor(async () => (await idb(opts, 'papers')).filter((p) => p.extracted).length >= 7, { label: 'extraction', timeout: 30000 });

async function project(name, desc, seed) {
  await lib.locator('button[title="New project"]').click();
  await lib.fill('input[placeholder^="e.g. Safety"]', name);
  await lib.fill('textarea[placeholder^="Whether tool-use"]', desc);
  await lib.fill('input[placeholder^="Search your library"]', seed);
  await lib.locator(`button:has-text("+ ${seed}")`).first().click();
  await lib.locator('button:has-text("Create project")').click();
  await sleep(800);
}
await project('Long-context retrieval', 'Retrieval from long contexts and sparse attention in transformers.', 'Filtered Attention');
await project('Agent rewards', 'Reward shaping and credit assignment for tool-use agents.', 'Planning Traces');
await lib.goto(ext('library.html#view=all'));
await lib.locator('button[title="Re-sort topics"]').click();
await waitFor(async () => (await idb(opts, 'topics')).filter((t) => !t.deletedAt).length >= 2, { label: 'topics' });
// file the suggestions so the Projects column is populated
for (const e of await idb(opts, 'library')) {
  if (e.suggestions?.length) {
    await opts.evaluate(async ({ id, pids }) => {
      // reuse the page's own IndexedDB via a tiny transaction
      const db = await new Promise((r) => {
        const q = indexedDB.open('marginalia');
        q.onsuccess = () => r(q.result);
      });
      const tx = db.transaction('library', 'readwrite');
      const store = tx.objectStore('library');
      const row = await new Promise((r) => {
        const g = store.get(id);
        g.onsuccess = () => r(g.result);
      });
      row.projectIds = [...new Set([...row.projectIds, ...pids])];
      row.suggestions = [];
      store.put(row);
      await new Promise((r) => (tx.oncomplete = r));
    }, { id: e.paperId, pids: e.suggestions.map((s) => s.projectId) });
  }
}
await opts.evaluate(async () => {
  const db = await new Promise((r) => {
    const q = indexedDB.open('marginalia');
    q.onsuccess = () => r(q.result);
  });
  const tx = db.transaction('library', 'readwrite');
  const store = tx.objectStore('library');
  const set = (id, patch) =>
    new Promise((r) => {
      const g = store.get(id);
      g.onsuccess = () => {
        if (g.result) store.put({ ...g.result, ...patch });
        r();
      };
    });
  await set('arxiv:2402.00002', { status: 'read', willCite: true });
  await set('arxiv:2406.00006', { status: 'toread' });
  await set('arxiv:2404.00004', { status: 'reading' });
  await new Promise((r) => (tx.oncomplete = r));
});

// ---- 1. paper page + side panel ----
await html.setViewportSize({ width: 880, height: H });
await html.reload();
await html.waitForSelector('marginalia-ui', { state: 'attached' });
await sleep(1200);
await html.evaluate(() => document.querySelector('#S1').scrollIntoView());
await html.evaluate(() => window.scrollBy(0, -20));
await sleep(500);
await html.screenshot({ path: path.join(OUT, '_page.png') });
const tabId = await waitFor(async () => {
  const all = await opts.evaluate(() => chrome.storage.session.get(null));
  const hit = Object.entries(all).find(([k, v]) => k.startsWith('tab:') && v.paperId === 'arxiv:2401.00001' && v.kind === 'arxiv-html');
  return hit ? Number(hit[0].slice(4)) : null;
}, { label: 'tab id' });
const panel = await context.newPage();
await panel.setViewportSize({ width: 400, height: H });
await panel.goto(ext(`sidepanel.html?tabId=${tabId}`));
await panel.locator('li').first().waitFor();
await sleep(600);
await panel.screenshot({ path: path.join(OUT, '_panel.png') });

// ---- 2. explain popover ----
await html.setViewportSize({ width: W, height: H });
await sleep(400);
await html.evaluate(() => document.querySelector('#S2').scrollIntoView());
await sleep(300);
await selectText(html, 'keep the blocks whose score exceeds');
await sleep(300);
await html.locator('button[title="Explain this passage"]').click();
await html.locator('text=matters because pruning happens').waitFor();
await sleep(500);
await html.screenshot({ path: path.join(OUT, '2-explain.png') });
await html.keyboard.press('Escape');

// ---- 3. PDF reader ----
const pdf = await context.newPage();
await pdf.setViewportSize({ width: W, height: H });
await pdf.goto('https://arxiv.org/pdf/2401.00001v1').catch(() => {});
await waitFor(async () => pdf.url().includes('/reader.html'), { label: 'reader' });
await pdf.waitForSelector('.textLayer mark.mg-hl', { timeout: 20000 });
await pdf.locator('button:has-text("Fit")').click();
await sleep(800);
await pdf.evaluate(() => (document.getElementById('viewerContainer').scrollTop = 330));
await sleep(800);
await selectText(pdf, 'Retrieval failures are not uniform across the context window.', '#viewer');
await sleep(500);
await pdf.screenshot({ path: path.join(OUT, '3-reader.png') });

// ---- 4. library ----
await lib.evaluate(() => localStorage.setItem('mg-cols', JSON.stringify(['title', 'venue', 'status', 'projects', 'topic', 'task', 'benchmarks'])));
await lib.goto(ext('library.html#view=all'));
await lib.reload();
await lib.locator('tbody tr').nth(6).waitFor();
await sleep(800);
await lib.screenshot({ path: path.join(OUT, '4-library.png') });

// ---- 5. factoid ----
await lib.goto(ext('library.html#view=all&paper=arxiv%3A2401.00001'));
await lib.locator('aside button:has-text("Factoid")').click();
await lib.locator('button:has-text("Draft with AI")').click();
await waitFor(async () => (await lib.locator('textarea').nth(0).inputValue()).includes('Long-context models miss facts'), { label: 'factoid' });
await lib.evaluate(() => document.querySelector('[role="dialog"]')?.parentElement?.scrollTo(0, 0));
await sleep(500);
await lib.screenshot({ path: path.join(OUT, '5-factoid.png') });

await context.close();
server.close();
console.log('screenshots written to', OUT);
