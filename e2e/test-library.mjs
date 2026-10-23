// Library features added in 0.3: following authors, For you, Zotero import/export,
// Cite, PDFs with highlights, Google Drive (PDFs, project .bib for Overleaf, sync),
// Ask your library, related work, and the phone layout.
// The extension must be built with WXT_GOOGLE_CLIENT_ID set (npm run e2e does this).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, state } from './server.mjs';
import { drive, driveFiles } from './driveMock.mjs';
import { launch } from './launch.mjs';
import { assert, idb, selectText, shot, sleep, waitFor } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
fs.mkdirSync('/tmp/claude-0/shots', { recursive: true });
const server = await startServer();
const { context, extensionId } = await launch();
const ext = (p) => `chrome-extension://${extensionId}/${p}`;
const errors = [];
context.on('weberror', (e) => errors.push(e.error().message));

const opts = await context.newPage();
opts.on('pageerror', (e) => errors.push(`options: ${e.message}`));
await opts.goto(ext('options.html'));

const lib = await context.newPage();
lib.on('pageerror', (e) => errors.push(`library: ${e.message}`));
lib.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`library console: ${m.text()}`));

async function addPaper(id) {
  await lib.fill('input[placeholder="Add by arXiv ID or URL"]', id);
  await lib.locator('input[placeholder="Add by arXiv ID or URL"] + button').click();
  await waitFor(async () => (await idb(opts, 'library', `arxiv:${id}`)) ?? null, { label: `saved ${id}` });
}

/** Highlight annotations in a PDF, read back with pdf.js (pdf-lib compresses objects, so grep won't do). */
async function pdfHighlights(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    for (const a of await (await doc.getPage(i)).getAnnotations()) if (a.subtype === 'Highlight') out.push({ page: i, contents: a.contentsObj?.str ?? '' });
  }
  return out;
}

async function stubClipboard(page) {
  await page.evaluate(() => {
    window.__clip = null;
    navigator.clipboard.writeText = async (t) => {
      window.__clip = t;
    };
  });
}

try {
  console.log('\n# Library with three papers');
  await lib.goto(ext('library.html#view=all'));
  await addPaper('2401.00001');
  await addPaper('2402.00002');
  await addPaper('2403.00003');
  await waitFor(async () => (await idb(opts, 'papers', 'arxiv:2401.00001'))?.s2Id ?? null, { label: 'enriched from Semantic Scholar', timeout: 20000 });
  assert((await lib.locator('nav >> text=For you').count()) === 1 && (await lib.locator('nav >> text=Follow authors').count()) === 1, 'For you and Following in the sidebar');

  console.log('\n# Follow an author from a paper');
  await lib.goto(ext('library.html#view=all&paper=arxiv%3A2401.00001'));
  await lib.locator('aside button[title="Follow Ada Lovelace"]').click();
  await lib.locator('aside button.mg-btn-primary:has-text("Follow")').click();
  const follow = await waitFor(async () => (await idb(opts, 'follows')).find((f) => !f.deletedAt && f.s2AuthorId === 'a-ada') ?? null, { label: 'follow resolved to the S2 author', timeout: 15000 });
  assert(follow.name === 'Ada Lovelace', 'following Ada Lovelace by her Semantic Scholar id');
  await lib.locator('aside button[title="Following Ada Lovelace"]').waitFor();
  assert(true, 'the author shows as followed on the paper');
  await lib.locator('nav >> text=Ada Lovelace').click();
  await lib.locator('main >> text=Filtered Attention for Long-Context Retrieval').first().waitFor();
  assert(true, "author view lists the library's papers by her");

  console.log('\n# A project with two seed papers');
  await lib.goto(ext('library.html#view=all'));
  await lib.locator('button[title="New project"]').click();
  await lib.fill('input[placeholder^="e.g. Safety"]', 'Long-context retrieval');
  await lib.fill('textarea[placeholder^="Whether tool-use"]', 'Retrieval from long contexts and sparse attention in transformers.');
  for (const t of ['Filtered Attention', 'Retrieval heads']) {
    await lib.fill('input[placeholder^="Search your library"]', t);
    await lib.locator(`button:has-text("+ ${t}")`).first().click();
  }
  await lib.locator('button:has-text("Create project")').click();
  await lib.locator('h1:has-text("Long-context retrieval")').waitFor();
  const project = (await idb(opts, 'projects')).find((p) => p.name === 'Long-context retrieval');
  assert(project.seedPaperIds.length === 2, 'project created with seeds');

  console.log('\n# For you');
  await lib.locator('nav >> text=For you').click();
  await lib.locator('button:has-text("Check now")').click();
  await lib.locator('text=Filtered Attention Without Training').waitFor({ timeout: 30000 });
  await lib.locator('text=Pruning Key Blocks for Million-Token Retrieval').waitFor({ timeout: 30000 });
  assert(true, 'new paper by a followed author and a recommendation for the project');
  assert((await lib.locator('text=New from Ada Lovelace').count()) >= 1, 'the reason is shown');
  assert((await lib.locator('text=Curriculum Rewards for Robot Arms').count()) === 0, 'an off-topic recommendation is left out');
  assert(state.recommendCalls.some((b) => b.positivePaperIds?.includes('s2-p1')), 'recommendations asked for with the project papers');
  const feed = await idb(opts, 'feed');
  assert(!feed.some((f) => f.id === 'arxiv:2401.00001'), 'papers already saved are not suggested');
  await shot(lib, 'foryou');
  const card = lib.locator('li', { has: lib.locator('text=Filtered Attention Without Training') });
  await card.locator('button:has-text("Save")').click();
  await waitFor(async () => (await idb(opts, 'library', 'arxiv:2410.00011')) ?? null, { label: 'saved from For you' });
  assert((await idb(opts, 'feed', 'arxiv:2410.00011')).status === 'saved', 'suggestion marked saved');
  await lib.goto(ext('library.html#view=foryou'));
  const rec = lib.locator('li', { has: lib.locator('text=Pruning Key Blocks for Million-Token Retrieval') });
  await rec.locator('button:has-text("Dismiss")').click();
  await waitFor(async () => (await idb(opts, 'feed', 'arxiv:2410.00012'))?.status === 'dismissed', { label: 'dismissed' });
  assert(true, 'dismissing a suggestion');

  console.log('\n# Cite and exports');
  await lib.goto(ext(`library.html#project=${project.id}`));
  await lib.locator('main >> text=Retrieval heads in long-context transformers').first().waitFor();
  await stubClipboard(lib);
  await lib.locator('main button:has-text("Cite")').first().click();
  const cite = await waitFor(() => lib.evaluate(() => window.__clip), { label: 'cite copied' });
  assert(/^\\cite\{[\w-]+,[\w-]+\}$/.test(cite), `Cite copies \\cite with both keys (${cite})`);
  const [risDl] = await Promise.all([lib.waitForEvent('download'), lib.locator('button[title^="For Zotero"]').click()]);
  const ris = fs.readFileSync(await risDl.path(), 'utf8');
  assert(ris.includes('TY  - ') && ris.includes('KW  - Long-context retrieval') && ris.split('ER  -').length === 3, 'RIS export of the project, tagged with the project name');

  console.log('\n# Import from Zotero');
  await lib.locator('button:has-text("Import and export")').click();
  await lib.locator('input[type="file"]').setInputFiles(path.join(HERE, '../tests/fixtures/zotero/zotero-library.ris'));
  await lib.locator('button:has-text("Import 3")').click();
  await lib.locator('text=Imported 3 new papers').waitFor({ timeout: 10000 });
  const cot = await idb(opts, 'papers', 'arxiv:2201.11903');
  assert(cot?.title.startsWith('Chain-of-Thought Prompting'), 'Zotero RIS import adds arXiv papers by their arXiv id');
  const cotNotes = (await idb(opts, 'annotations')).filter((a) => a.paperId === 'arxiv:2201.11903' && !a.target.selector);
  assert(cotNotes.length === 1 && cotNotes[0].body[0].value.includes('intermediate steps'), 'Zotero notes become a paper note');
  await lib.keyboard.press('Escape');

  console.log('\n# PDF with highlights');
  const html = await context.newPage();
  await html.goto('https://arxiv.org/html/2401.00001v2');
  await html.waitForSelector('marginalia-ui', { state: 'attached' });
  await sleep(600);
  await selectText(html, 'We propose filtered attention, which scores every key block');
  await html.locator('button[title^="Method"]').click();
  await waitFor(async () => (await idb(opts, 'annotations')).some((a) => a.paperId === 'arxiv:2401.00001' && a.target.selector), { label: 'highlight saved' });
  await html.close();
  await lib.goto(ext('library.html#view=all&paper=arxiv%3A2401.00001'));
  const [pdfDl] = await Promise.all([lib.waitForEvent('download'), lib.locator('aside button[title="Download the PDF with your highlights and notes in it"]').click()]);
  const pdf = fs.readFileSync(await pdfDl.path());
  fs.writeFileSync('/tmp/claude-0/shots/annotated.pdf', pdf);
  const highlights = await pdfHighlights(pdf);
  assert(pdf.subarray(0, 5).toString() === '%PDF-' && highlights.length === 1 && highlights[0].contents.startsWith('Method') && pdfDl.suggestedFilename().endsWith('.pdf'), `downloaded PDF has the highlight embedded (${JSON.stringify(highlights)})`);

  console.log('\n# Google Drive');
  await opts.reload();
  await opts.locator('button:has-text("Connect Google Drive")').waitFor();
  assert(true, 'Drive section offers Connect (built with a client id)');
  // stand in for Google's sign-in: store a token the way connectDrive does
  await opts.evaluate(
    (token) =>
      new Promise((resolve) => {
        const req = indexedDB.open('marginalia');
        req.onsuccess = () => {
          const tx = req.result.transaction('kv', 'readwrite');
          tx.objectStore('kv').put({ key: 'drive.auth', value: { token, expiresAt: Date.now() + 3600e3, email: 'manas@example.com', connectedAt: new Date().toISOString() } });
          tx.oncomplete = resolve;
        };
      }),
    drive.token,
  );
  await opts.reload();
  await opts.locator('text=Connected as manas@example.com').waitFor();
  assert(true, 'Settings shows the connected account');
  await lib.reload();
  await lib.locator('aside button:has-text("Save to Drive")').click();
  const pdfFile = await waitFor(() => driveFiles().find((f) => f.appProperties.archivePaper === 'arxiv:2401.00001') ?? null, { label: 'PDF in Drive', timeout: 20000 });
  const folder = driveFiles().find((f) => f.id === pdfFile.parents[0]);
  assert(pdfFile.name.endsWith('.pdf') && folder.name === 'Long-context retrieval' && (await pdfHighlights(pdfFile.bytes)).length === 1, 'PDF saved into the project folder, with highlights');
  await waitFor(async () => (await idb(opts, 'library', 'arxiv:2401.00001'))?.drivePdf?.fileId === pdfFile.id, { label: 'drive file remembered' });
  await lib.locator('aside button:has-text("Update in Drive")').click();
  await sleep(2500);
  assert(driveFiles().filter((f) => f.appProperties.archivePaper === 'arxiv:2401.00001').length === 1, 'saving again updates the same file');

  await lib.goto(ext(`library.html#project=${project.id}`));
  await lib.locator('button[title^="Keep this project"]').click();
  await lib.locator('[role="dialog"] button[role="switch"]').first().click();
  const bib = await waitFor(() => driveFiles().find((f) => f.name.endsWith('.bib')) ?? null, { label: '.bib in Drive', timeout: 15000 });
  assert(bib.text.includes('@') && bib.appProperties.archiveBib === project.id, 'project .bib saved to Drive');
  await lib.locator('[role="dialog"] button[role="switch"]').nth(1).click();
  await lib.locator('[role="dialog"] input[readonly]').waitFor({ timeout: 15000 });
  const link = await lib.locator('[role="dialog"] input[readonly]').inputValue();
  assert(link.includes(bib.id) && drive.files.get(bib.id).permissions.some((p) => p.type === 'anyone'), 'Overleaf link made readable by anyone with it');
  await lib.keyboard.press('Escape');

  await opts.locator('button:has-text("Sync now")').click();
  await opts.locator('text=/Synced \\d/').waitFor({ timeout: 20000 });
  const syncFile = driveFiles().find((f) => f.appProperties.archive === 'sync');
  const snap = JSON.parse(syncFile.text);
  assert(snap.papers.some((p) => p.id === 'arxiv:2401.00001') && snap.follows.some((f) => f.s2AuthorId === 'a-ada'), 'library and follows synced to Drive');

  console.log('\n# AI: ask the library and draft related work');
  await opts.locator('button[role="switch"]').first().click();
  await opts.fill('input[placeholder="sk-ant-…"]', 'sk-ant-test');
  await opts.locator('button:has-text("Save")').first().click();
  await opts.locator('text=Key works').waitFor({ timeout: 8000 });
  await lib.goto(ext('library.html#view=ask'));
  await lib.fill('textarea[placeholder^="Ask across"]', 'How does filtered attention improve retrieval?');
  await lib.locator('button:has-text("Ask")').last().click();
  await lib.locator('text=which improves retrieval recall').waitFor({ timeout: 15000 });
  await lib.locator('text=Sources').waitFor();
  assert((await lib.locator('sup.mg-cite').count()) >= 1, 'answer cites its sources');
  const askCall = state.claudeCalls.find((c) => JSON.stringify(c.system).includes('You answer a researcher'));
  assert(askCall.model === 'claude-sonnet-5-5' && askCall.messages[0].content.includes('[1]'), 'question sent with numbered sources to the reading model');
  await shot(lib, 'ask-library');

  await lib.goto(ext(`library.html#project=${project.id}`));
  await lib.locator('button:has-text("Related work")').click();
  await lib.locator('[role="dialog"] button:has-text("Draft")').click();
  await waitFor(async () => (await lib.locator('[role="dialog"] textarea').inputValue()).includes('\\citep{'), { label: 'related work', timeout: 15000 });
  const rw = await lib.locator('[role="dialog"] textarea').inputValue();
  assert(!rw.includes('made2099up') && (await lib.locator('text=/Removed citations/').count()) === 1, 'made-up citation keys are removed and reported');
  await lib.keyboard.press('Escape');

  console.log('\n# Phone layout');
  await lib.setViewportSize({ width: 390, height: 844 });
  await lib.goto(ext('library.html#view=all'));
  await lib.locator('button[aria-label="Menu"]').waitFor();
  assert((await lib.locator('table').count()) === 0 && (await lib.locator('main li').count()) >= 4, 'papers show as cards on a phone');
  const overflow = await lib.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, `no sideways scrolling (${overflow}px)`);
  await lib.locator('button[aria-label="Menu"]').click();
  await lib.locator('nav >> text=For you').waitFor();
  await shot(lib, 'phone-menu');
  await lib.locator('nav >> text=All papers').click();
  await lib.locator('main li').first().locator('button').first().click();
  await lib.locator('button[aria-label="Back"]').waitFor();
  assert(true, 'paper opens full screen with a Back button');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  console.log('\nALL LIBRARY TESTS PASSED');
} catch (e) {
  console.error(e);
  console.error('errors:', errors);
  await shot(lib, 'library-failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}
