// Steps 1-2: capture, BibTeX, enrichment + venue upgrade, library, projects,
// highlights/notes on arXiv HTML, re-anchoring across versions, progress.
import fs from 'node:fs';
import { startServer, state } from './server.mjs';
import { launch } from './launch.mjs';
import { assert, idb, selectText, session, shot, sleep, waitFor } from './helpers.mjs';

fs.mkdirSync('/tmp/claude-0/shots', { recursive: true });
const server = await startServer();
const { context, extensionId } = await launch();
const ext = (p) => `chrome-extension://${extensionId}/${p}`;
const errors = [];
context.on('weberror', (e) => errors.push(e.error().message));

const extPage = await context.newPage();
await extPage.goto(ext('options.html'));

try {
  console.log('\n# Capture from the abs page');
  const abs = await context.newPage();
  abs.on('pageerror', (e) => errors.push(`abs: ${e.message}`));
  await abs.goto('https://arxiv.org/abs/2401.00001');
  await abs.locator('button:has-text("Save paper")').click();
  await waitFor(async () => (await abs.locator('select[aria-label="Reading status"]').count()) > 0, { label: 'saved state in pill' });
  assert(true, 'pill switches to saved state');
  const paper = await waitFor(() => idb(extPage, 'papers', 'arxiv:2401.00001'), { label: 'paper record' });
  assert(paper.title === 'Filtered Attention for Long-Context Retrieval', 'title from arXiv API');
  assert(paper.citeKey === 'lovelace2024filtered', `cite key ${paper.citeKey}`);
  assert(paper.codeLinks.includes('https://github.com/ada/filtered-attention'), 'code link extracted');
  const entry = await idb(extPage, 'library', 'arxiv:2401.00001');
  assert(entry.status === 'inbox', 'new paper lands in the inbox');

  console.log('\n# Enrichment and venue upgrade');
  const upgraded = await waitFor(async () => {
    const p = await idb(extPage, 'papers', 'arxiv:2401.00001');
    return p.bibtexSource === 'dblp' ? p : null;
  }, { timeout: 20000, label: 'venue upgrade' });
  assert(upgraded.bibtex.startsWith('@inproceedings{lovelace2024filtered,'), 'DBLP bibtex re-keyed to our cite key');
  assert(!upgraded.bibtex.includes('timestamp'), 'DBLP noise fields dropped');
  assert(upgraded.venueStatus === 'accepted' && upgraded.venue === 'NeurIPS 2024', `venue set: ${upgraded.venue}`);
  assert(upgraded.s2?.embedding?.length === 768, 'SPECTER embedding stored');
  assert(upgraded.s2?.referenceIds?.includes('arxiv:2402.00002'), 'references stored as canonical ids');
  console.log(upgraded.bibtex);

  console.log('\n# Highlights on arXiv HTML (v1)');
  const html = await context.newPage();
  html.on('pageerror', (e) => errors.push(`html: ${e.message}`));
  html.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(`html console: ${m.text()}`));
  await html.goto('https://arxiv.org/html/2401.00001v1');
  await html.waitForSelector('marginalia-ui', { state: 'attached' });
  await sleep(500);
  await selectText(html, 'We propose filtered attention, which scores every key block');
  await html.locator('button[title^="Method"]').click();
  await waitFor(async () => (await html.locator('mark.mg-hl[data-mg-label="method"]').count()) > 0, { label: 'method mark' });
  assert(true, 'method highlight rendered');
  await selectText(html, 'This sentence only exists in the first version and will be removed later.');
  await html.locator('button[title^="Weakness"]').click();
  await selectText(html, 'Long-context language models struggle to use information placed in the middle of their input');
  await html.locator('button[title^="Problem"]').click();
  // highlight spanning math: "Let θ denote the parameters"
  await selectText(html, 'denote the parameters of a pretrained transformer, and let k be the number');
  await sleep(250);
  await html.keyboard.press('5'); // Interesting via keyboard
  await waitFor(async () => (await html.locator('mark.mg-hl[data-mg-label="interesting"]').count()) > 0, { label: 'keyboard highlight' });
  assert(true, 'keyboard shortcut 5 creates an Interesting highlight');
  // note via toolbar
  await selectText(html, 'improves retrieval recall by 11.4 points at 128k tokens on NeedleBench');
  await html.locator('button[title="Highlight and add a note"]').click();
  const ta = html.locator('textarea[placeholder="Note (Markdown)…"]');
  await ta.waitFor();
  await ta.fill('Key result: +11.4 recall.');
  await ta.blur();
  await sleep(900);
  const anns = await waitFor(async () => {
    const all = (await idb(extPage, 'annotations')).filter((a) => !a.deletedAt);
    return all.length >= 5 && all.some((a) => a.body.some((b) => b.purpose === 'commenting' && b.value.includes('+11.4'))) ? all : null;
  }, { label: '5 annotations incl. note' });
  assert(anns.every((a) => a.id.startsWith('urn:uuid:')), 'annotations have urn:uuid ids');
  assert(anns.every((a) => a.target.selector.some((s) => s.type === 'TextQuoteSelector')), 'W3C TextQuoteSelector stored');
  assert(anns.every((a) => a.target.state.medium === 'html' && a.target.state.version === 1), 'medium/version recorded');
  assert(anns.every((a) => a.visibility === 'private' && a.groupId === null && a.owner), 'sharing fields present');
  await shot(html, 'html-highlights');

  console.log('\n# Click a highlight to edit');
  await html.locator('mark.mg-hl[data-mg-label="method"]').first().click();
  await html.locator('button[title="Result"]').first().click();
  await waitFor(async () => (await html.locator('mark.mg-hl[data-mg-label="method"]').count()) === 0 && (await html.locator('mark.mg-hl[data-mg-label="result"]').count()) >= 1, { label: 'label change' });
  assert(true, 'changing the label recolors the highlight');
  await html.keyboard.press('Escape');

  console.log('\n# Reload re-anchors');
  await html.reload();
  await html.waitForSelector('marginalia-ui', { state: 'attached' });
  const marksAfterReload = await waitFor(async () => {
    const n = await html.evaluate(() => new Set([...document.querySelectorAll('mark.mg-hl')].map((m) => m.dataset.mgId)).size);
    return n >= 4 ? n : null;
  }, { label: 'highlights after reload' });
  const mathHl = await html.locator('math.mg-hl-math').count();
  assert(marksAfterReload >= 4, `${marksAfterReload} highlights restored after reload`);
  assert(mathHl >= 1, 'math inside a highlight is marked without breaking MathML');

  console.log('\n# Version 2: fuzzy re-anchoring and orphans');
  await html.goto('https://arxiv.org/html/2401.00001v2');
  await html.waitForSelector('marginalia-ui', { state: 'attached' });
  const hls = await waitFor(async () => {
    const ids = await html.evaluate(() => [...new Set([...document.querySelectorAll('mark.mg-hl')].map((m) => m.dataset.mgId))]);
    return ids.length >= 4 ? ids : null;
  }, { label: 'v2 highlights' });
  const tabId = await html.evaluate(() => 0);
  const anchors = await waitFor(async () => {
    const all = await extPage.evaluate(() => chrome.storage.session.get(null));
    return Object.entries(all).find(([k, v]) => k.startsWith('anchors:') && v.orphanIds?.length) ?? null;
  }, { label: 'orphan report' });
  const removed = anns.find((a) => a.target.selector[0].exact.includes('only exists in the first version'));
  assert(anchors[1].orphanIds.includes(removed.id), 'removed sentence reported as orphan');
  assert(hls.length === anns.length - 1, `${hls.length} of ${anns.length} highlights placed on v2 (changed sentence re-anchored fuzzily)`);
  const problemText = await html.locator('mark.mg-hl[data-mg-label="problem"]').allTextContents();
  assert(problemText.join('').includes('often struggle'), 'edited sentence highlight now covers the v2 wording');

  console.log('\n# Reading progress');
  await html.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(2200);
  await html.evaluate(() => window.scrollBy(0, -5));
  const e2 = await waitFor(async () => {
    const e = await idb(extPage, 'library', 'arxiv:2401.00001');
    return e.status === 'read' ? e : null;
  }, { label: 'status read after scrolling', timeout: 8000 });
  assert(e2.progress >= 0.9, `progress ${e2.progress.toFixed(2)} and status read`);

  console.log('\n# Full text stored for AI');
  const ft = await idb(extPage, 'fulltext', ['arxiv:2401.00001', 'html']);
  assert(ft?.text?.includes('$\\theta$') && !ft.text.includes('Report issue'), 'full text has TeX math and no a11y noise');

  console.log('\n# Citation hovercard');
  await html.evaluate(() => window.scrollTo(0, 0));
  const citeLink = html.locator('a[href="#bib.bib1"]').first();
  await citeLink.hover();
  await html.locator('text=Retrieval heads in long-context transformers').first().waitFor({ timeout: 8000 });
  await html.locator('[data-mg-ui] button:has-text("Save")').first().click();
  await waitFor(async () => (await idb(extPage, 'library', 'arxiv:2402.00002')) ?? null, { label: 'cited paper saved' });
  assert(true, 'hovercard shows S2 abstract and saves the cited paper');
  await html.mouse.move(5, 5);
  await sleep(400);

  console.log('\n# Symbol lookup');
  await html.locator('math[alttext="\\\\tau"]').first().hover();
  await html.locator('text=Jump there').waitFor({ timeout: 5000 });
  const symText = await html.locator('div[data-mg-ui]:has-text("Jump there")').last().innerText();
  assert(/threshold/.test(symText), 'symbol card shows the defining sentence for τ');
  await shot(html, 'symbol-card');
  await html.mouse.move(5, 5);

  console.log('\n# OpenReview capture with reviews');
  const or = await context.newPage();
  await or.goto('https://openreview.net/forum?id=ORabc123');
  await or.locator('button:has-text("Save paper")').click();
  const orPaper = await waitFor(async () => {
    const p = await idb(extPage, 'papers', 'openreview:ORabc123');
    return p?.review ? p : null;
  }, { label: 'openreview paper with reviews', timeout: 15000 });
  assert(orPaper.venue === 'ICLR 2025' && orPaper.venueStatus === 'accepted', `OpenReview venue ${orPaper.venue}`);
  assert(orPaper.review.avgRating === 6.33 && orPaper.review.decision === 'Accept (poster)', 'scores averaged and decision parsed');
  assert(orPaper.bibtex.startsWith('@inproceedings{hopper2025sparse,') && orPaper.bibtex.includes('Thirteenth International Conference'), 'OpenReview bibtex normalized');
  // Semantic Scholar calls are spaced out, so the alias can land a moment after the reviews
  const linked = await waitFor(async () => ((await idb(extPage, 'papers', 'openreview:ORabc123'))?.aliases.includes('arxiv:2403.00003') ? true : null), { label: 'alias', timeout: 15000 });
  assert(linked, 'arXiv alias linked through Semantic Scholar');

  console.log('\n# Library');
  const lib = await context.newPage();
  lib.on('pageerror', (e) => errors.push(`library: ${e.message}`));
  await lib.goto(ext('library.html#view=all'));
  await lib.locator('text=Filtered Attention for Long-Context Retrieval').first().waitFor();
  const rowCount = await lib.locator('tbody tr').count();
  assert(rowCount === 3, `${rowCount} papers in All papers`);
  await lib.fill('input[placeholder^="Search titles"]', 'Key result');
  await sleep(300);
  assert((await lib.locator('tbody tr').count()) === 1, 'search finds a paper by its highlight note');
  await lib.fill('input[placeholder^="Search titles"]', '');
  // project with seed paper
  await lib.locator('button[title="New project"]').click();
  await lib.fill('input[placeholder^="e.g. Safety"]', 'Long-context retrieval');
  await lib.fill('textarea[placeholder^="Whether tool-use"]', 'Retrieval of facts from long contexts and attention sparsity in transformers.');
  await lib.fill('input[placeholder^="Search your library"]', 'Filtered');
  await lib.locator('button:has-text("+ Filtered Attention")').click();
  await lib.locator('button:has-text("Create project")').click();
  await lib.waitForURL(/project=/);
  await waitFor(async () => (await lib.locator('tbody tr').count()) === 1, { label: 'project rows' });
  assert(true, 'project view lists its seed paper');
  // export .bib
  const [download] = await Promise.all([lib.waitForEvent('download'), lib.locator('button:has-text(".bib")').click()]);
  const bibPath = await download.path();
  const bib = fs.readFileSync(bibPath, 'utf8');
  assert(download.suggestedFilename() === 'long-context-retrieval.bib' && bib.includes('@inproceedings{lovelace2024filtered'), 'project .bib export');
  // detail drawer
  await lib.locator('tbody tr').first().click();
  await lib.locator('aside >> text=Highlights').first().waitFor();
  const cards = await lib.locator('aside li').count();
  assert(cards >= 4, `${cards} highlight cards in the detail drawer`);
  await lib.locator('aside button[role="tab"]:has-text("BibTeX")').click();
  assert(await lib.locator('aside >> text=Venue version from DBLP').count(), 'BibTeX tab explains the source');
  await shot(lib, 'library');

  console.log('\n# Relevance: new related paper gets filed into the project');
  const e3 = await waitFor(async () => {
    const e = await idb(extPage, 'library', 'arxiv:2402.00002');
    return e.suggestions.length ? e : null;
  }, { label: 'suggestion for related paper', timeout: 8000 });
  const projects = await idb(extPage, 'projects');
  console.log('  relevance for 2402.00002:', JSON.stringify(e3.suggestions), e3.projectIds);
  assert(e3.suggestions.some((x) => x.projectId === projects[0].id), 'existing related paper is suggested for the new project');
  const orEntry = await idb(extPage, 'library', 'openreview:ORabc123');
  assert(!orEntry.suggestions.length, 'unrelated paper is not suggested');

  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  console.log('\nALL CORE TESTS PASSED');
} catch (e) {
  console.error(e);
  console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}
