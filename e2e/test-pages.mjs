// Side panel, popup, options daily check, library management, backups and exports.
import fs from 'node:fs';
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { assert, idb, selectText, shot, sleep, waitFor } from './helpers.mjs';

fs.mkdirSync('/tmp/claude-0/shots', { recursive: true });
const server = await startServer();
const { context, extensionId } = await launch();
const ext = (p) => `chrome-extension://${extensionId}/${p}`;
const errors = [];
context.on('weberror', (e) => errors.push(e.error().message));
const opts = await context.newPage();
opts.on('pageerror', (e) => errors.push(`options: ${e.message}`));
await opts.goto(ext('options.html'));

try {
  console.log('\n# Side panel follows the paper tab');
  const html = await context.newPage();
  await html.goto('https://arxiv.org/html/2401.00001v1');
  await html.waitForSelector('marginalia-ui', { state: 'attached' });
  await sleep(500);
  await selectText(html, 'We propose filtered attention, which scores every key block');
  await html.locator('button[title^="Problem"]').click();
  await waitFor(async () => (await idb(opts, 'annotations')).length === 1, { label: 'annotation' });
  const tabId = await waitFor(async () => {
    const all = await opts.evaluate(() => chrome.storage.session.get(null));
    const hit = Object.entries(all).find(([k, v]) => k.startsWith('tab:') && v.paperId === 'arxiv:2401.00001');
    return hit ? Number(hit[0].slice(4)) : null;
  }, { label: 'tab registered' });
  const panel = await context.newPage();
  panel.on('pageerror', (e) => errors.push(`panel: ${e.message}`));
  await panel.setViewportSize({ width: 400, height: 860 });
  await panel.goto(ext(`sidepanel.html?tabId=${tabId}`));
  await panel.locator('text=Filtered Attention for Long-Context Retrieval').first().waitFor();
  assert((await panel.locator('li').count()) === 1, 'side panel lists the highlight');
  // jump from panel scrolls the page
  await html.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await panel.locator('li button[title="Jump to highlight"]').click();
  await waitFor(async () => (await html.evaluate(() => document.querySelector('mark.mg-hl').getBoundingClientRect().top)) < 700, { label: 'jump scroll' });
  assert(true, 'jump to highlight scrolls the paper');
  // note from panel shows on page as dotted underline
  await panel.locator('li button[title="Add note"]').click();
  await panel.fill('li textarea', 'Core idea');
  await panel.locator('li textarea').blur();
  await waitFor(async () => (await html.locator('mark.mg-hl[data-mg-note="1"]').count()) > 0, { label: 'note mark on page' });
  assert(true, 'a note added in the panel updates the page');
  // paper notes tab
  await panel.locator('button[role="tab"]:has-text("Notes")').click();
  await panel.fill('textarea[placeholder^="Notes on the paper"]', 'Read for **lab meeting**.');
  await panel.locator('textarea[placeholder^="Notes on the paper"]').blur();
  await waitFor(async () => (await idb(opts, 'annotations')).some((a) => !a.target.selector && a.body[0].value.includes('lab meeting')), { label: 'paper note' });
  assert(true, 'paper-level note saved as a commenting annotation');
  await shot(panel, 'sidepanel');
  // delete from panel removes mark on page
  await panel.locator('button[role="tab"]:has-text("Highlights")').click();
  await panel.locator('li button[title="Delete highlight"]').click();
  await waitFor(async () => (await html.locator('mark.mg-hl').count()) === 0, { label: 'mark removed from page' });
  assert(true, 'deleting in the panel removes the highlight on the page');

  console.log('\n# Popup');
  const popup = await context.newPage();
  popup.on('pageerror', (e) => errors.push(`popup: ${e.message}`));
  await popup.goto(ext('popup.html'));
  await popup.locator('text=Library').first().waitFor();
  assert(true, 'popup renders');

  console.log('\n# Daily check from settings');
  await opts.reload();
  await opts.locator('button:has-text("Run now")').click();
  await opts.locator('text=/Last run .* checked \\d+/').waitFor({ timeout: 15000 });
  const report = await opts.evaluate(() => chrome.storage.local.get('lastDailyReport').then((v) => v.lastDailyReport));
  assert(report.checked >= 1 && report.errors.length === 0, `daily check ran (checked ${report.checked}, errors ${report.errors.length})`);

  console.log('\n# Library management');
  const lib = await context.newPage();
  lib.on('pageerror', (e) => errors.push(`library: ${e.message}`));
  await lib.goto(ext('library.html#view=all'));
  for (const id of ['2402.00002', '2404.00004', '2405.00005', '2406.00006', '2407.00007']) {
    await lib.fill('input[placeholder="Add by arXiv ID or URL"]', id);
    await lib.locator('input[placeholder="Add by arXiv ID or URL"] + button').click();
    await waitFor(async () => (await idb(opts, 'library', `arxiv:${id}`)) ?? null, { label: `saved ${id}` });
  }
  await lib.goto(ext('library.html#view=all'));
  await lib.locator('button[title="Re-sort topics"]').click();
  await waitFor(async () => (await idb(opts, 'topics')).filter((t) => !t.deletedAt).length >= 2, { label: 'keyword topics' });
  const topics = (await idb(opts, 'topics')).filter((t) => !t.deletedAt);
  console.log('  keyword topics:', topics.map((t) => t.name).join(' | '));
  assert(topics.every((t) => t.nameSource === 'keywords' && t.name.length > 2), 'topics named by keywords when AI is off');
  // rename + pin, then merge
  await lib.locator(`nav >> text=${topics[0].name}`).click();
  await lib.locator('main h1 button[title="Rename, pin or merge"]').click();
  await lib.fill('.mg-card input.mg-input', 'My topic');
  await lib.locator('button:has-text("Rename")').click();
  await waitFor(async () => (await idb(opts, 'topics', topics[0].id)).name === 'My topic', { label: 'rename' });
  assert(true, 'topic renamed');
  await lib.locator('main h1 button[title="Rename, pin or merge"]').click();
  await lib.locator('.mg-card select').selectOption(topics[1].id);
  await lib.locator('button:has-text("Merge")').click();
  await waitFor(async () => (await idb(opts, 'topics', topics[0].id)).deletedAt, { label: 'merge' });
  assert(true, 'topic merged');
  // bulk status
  await lib.goto(ext('library.html#view=all'));
  await lib.locator('thead input[type="checkbox"]').check();
  await lib.locator('select:has(option:has-text("Set status…"))').selectOption('toread');
  await waitFor(async () => (await idb(opts, 'library')).filter((e) => !e.deletedAt).every((e) => e.status === 'toread'), { label: 'bulk status' });
  assert(true, 'bulk status change');

  console.log('\n# Exports and backup');
  await lib.goto(ext('library.html#view=all&paper=arxiv%3A2401.00001'));
  const [md] = await Promise.all([lib.waitForEvent('download'), lib.locator('aside button:has-text("Notes .md")').click()]);
  const mdText = fs.readFileSync(await md.path(), 'utf8');
  assert(md.suggestedFilename() === 'lovelace2024filtered.md' && mdText.includes('Read for **lab meeting**.'), 'notes Markdown export');
  const [bk] = await Promise.all([opts.waitForEvent('download'), opts.locator('button:has-text("Export backup")').click()]);
  const backup = JSON.parse(fs.readFileSync(await bk.path(), 'utf8'));
  assert(backup.format === 'archive-backup' && backup.papers.length >= 6, 'backup contains papers');
  const [ld] = await Promise.all([opts.waitForEvent('download'), opts.locator('button:has-text("Export annotations")').click()]);
  const jsonld = JSON.parse(fs.readFileSync(await ld.path(), 'utf8'));
  assert(jsonld['@context'] === 'http://www.w3.org/ns/anno.jsonld' && jsonld.first.items.length >= 1, 'W3C JSON-LD export');
  opts.once('dialog', (d) => d.accept());
  await opts.locator('button:has-text("Delete all data")').click();
  await waitFor(async () => (await idb(opts, 'papers')).length === 0, { label: 'cleared' });
  await opts.setInputFiles('input[type="file"]', await bk.path());
  await waitFor(async () => (await idb(opts, 'papers')).length === backup.papers.length, { label: 'restored' });
  assert(true, 'backup restores after deleting everything');

  const real = errors.filter((e) => !/favicon|404/.test(e));
  assert(real.length === 0, `no page errors (${real.join(' | ')})`);
  console.log('\nALL PAGE TESTS PASSED');
} catch (e) {
  console.error(e);
  console.error('errors:', errors);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}
