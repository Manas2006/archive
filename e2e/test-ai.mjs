// Step 4-6: AI toggle and key, hidden-when-off, explain/evidence streaming,
// extraction, review summary, ask/compare, factoid, topics, exports.
import fs from 'node:fs';
import { startServer, state } from './server.mjs';
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

async function addPaper(lib, id) {
  await lib.fill('input[placeholder="Add by arXiv ID or URL"]', id);
  await lib.locator('input[placeholder="Add by arXiv ID or URL"] + button').click();
  await waitFor(async () => (await idb(opts, 'library', `arxiv:${id}`)) ?? null, { label: `saved ${id}` });
}

try {
  console.log('\n# AI off: no AI surfaces');
  const html = await context.newPage();
  html.on('pageerror', (e) => errors.push(`html: ${e.message}`));
  await html.goto('https://arxiv.org/html/2401.00001v1');
  await html.waitForSelector('marginalia-ui', { state: 'attached' });
  await sleep(400);
  await selectText(html, 'We propose filtered attention, which scores every key block');
  await html.locator('button[title^="Method"]').waitFor();
  assert((await html.locator('button[title="Explain this passage"]').count()) === 0, 'no Explain button when AI is off');
  await html.locator('button[title^="Method"]').click();
  await waitFor(async () => (await idb(opts, 'library', 'arxiv:2401.00001')) ?? null, { label: 'saved via highlight' });
  await sleep(1500);
  let paper = await idb(opts, 'papers', 'arxiv:2401.00001');
  assert(!paper.extracted, 'no AI extraction when AI is off');
  assert(state.claudeCalls.length === 0, 'no Claude API calls while AI is off');

  console.log('\n# Turn AI on with a key');
  await opts.reload();
  await opts.locator('button[role="switch"]').first().click();
  await opts.fill('input[placeholder="sk-ant-…"]', 'sk-ant-wrong');
  await opts.locator('button:has-text("Save")').first().click();
  await opts.locator('text=Your Claude API key was rejected').waitFor({ timeout: 8000 });
  assert(true, 'a bad key is rejected with a clear message');
  await opts.fill('input[placeholder="sk-ant-…"]', 'sk-ant-test');
  await opts.locator('button:has-text("Save")').first().click();
  await opts.locator('text=Key works').waitFor({ timeout: 8000 });
  assert(true, 'a good key is accepted');
  const local = JSON.stringify(await opts.evaluate(() => chrome.storage.local.get(null)));
  assert(!local.includes('sk-ant-test'), 'API key is not in chrome.storage.local (content scripts cannot see it)');
  const models = await opts.locator('select').first().locator('option').allTextContents();
  assert(models.includes('claude-haiku-5-5') && models.includes('claude-opus-5-5'), 'model list comes from the API');
  await shot(opts, 'options-ai');

  console.log('\n# Explain streams into an in-page popover');
  await html.reload();
  await html.waitForSelector('marginalia-ui', { state: 'attached' });
  await sleep(500);
  await selectText(html, 'The threshold');
  await html.locator('button[title="Explain this passage"]').click();
  await html.locator('text=matters because pruning happens').waitFor({ timeout: 10000 });
  assert(true, 'explanation streamed');
  const call = state.claudeCalls.find((c) => c.stream && c.messages[0].content.includes('Explain this passage'));
  assert(call.model === 'claude-sonnet-5-5', 'explain uses the reading model');
  assert(call.system[1].cache_control?.type === 'ephemeral' && call.system[1].text.includes('Full text:'), 'paper full text sent once with prompt caching');
  assert(await html.locator('math').count() > 0, 'math in the answer renders as MathML');
  // follow-up (once the first answer has finished streaming)
  await html.locator('button[title="Send"]').waitFor({ timeout: 10000 });
  await html.fill('textarea[placeholder="Ask a follow-up…"]', 'And what is k?');
  await html.keyboard.press('Enter');
  await waitFor(() => state.claudeCalls.filter((c) => c.stream).length >= 2, { label: 'follow-up call' });
  const fu = state.claudeCalls.filter((c) => c.stream).at(-1);
  assert(fu.messages.length === 3 && fu.messages[2].content === 'And what is k?', 'follow-up keeps the thread history');
  await shot(html, 'explain-popover');
  await html.keyboard.press('Escape');

  console.log('\n# Evidence');
  await selectText(html, 'improves retrieval recall by 11.4 points at 128k tokens on NeedleBench');
  await html.locator('button[title^="Where"]').click();
  await html.locator('text=Table 1 reports recall').waitFor({ timeout: 10000 });
  assert(true, 'evidence answer shown');
  await html.keyboard.press('Escape');

  console.log('\n# Symbol: ask Claude');
  await html.locator('math[alttext="\\\\tau"]').first().hover();
  await html.locator('button:has-text("Ask Claude")').click();
  await waitFor(() => state.claudeCalls.some((c) => c.messages[0].content.includes('What does the symbol')), { label: 'symbol call' });
  assert(true, 'symbol question sent with its context');
  await html.keyboard.press('Escape');

  console.log('\n# Extraction and review summary on save');
  const lib = await context.newPage();
  lib.on('pageerror', (e) => errors.push(`library: ${e.message}`));
  await lib.goto(ext('library.html#view=all'));
  await addPaper(lib, '2402.00002');
  const p2 = await waitFor(async () => (await idb(opts, 'papers', 'arxiv:2402.00002'))?.extracted ?? null, { label: 'extraction', timeout: 15000 });
  assert(p2.task === 'mechanistic interpretability' && p2.benchmarks.includes('Needle-in-a-Haystack') && p2.source === 'ai', 'fields extracted with the fast model');
  assert(state.claudeCalls.some((c) => c.model === 'claude-haiku-5-5' && c.messages[0].content.includes('Return JSON')), 'extraction used Haiku');
  const or = await context.newPage();
  await or.goto('https://openreview.net/forum?id=ORabc123');
  await or.locator('button:has-text("Save paper")').click();
  const orp = await waitFor(async () => (await idb(opts, 'papers', 'openreview:ORabc123'))?.review?.summary ?? null, { label: 'review summary', timeout: 15000 });
  assert(orp.includes('What reviewers criticized'), 'review summary generated');

  console.log('\n# Library: Ask tab, compare, extraction columns');
  await lib.goto(ext('library.html#view=all&paper=arxiv%3A2401.00001'));
  await lib.locator('aside button[role="tab"]:has-text("Ask")').click();
  await lib.fill('#mg-ask', 'How is the filter trained?');
  await lib.locator('aside form button[type="submit"]').first().click();
  await lib.locator('aside >> text=matters because pruning happens').waitFor({ timeout: 10000 });
  assert(true, 'question answered in the detail view');
  await lib.locator('aside button:has-text("All questions")').click();
  await lib.locator('aside select:has(option:has-text("Choose a paper"))').selectOption({ label: 'Retrieval heads in long-context transformers' });
  await lib.locator('aside button:has-text("Compare")').click();
  await waitFor(() => state.claudeCalls.some((c) => c.messages[0].content.includes('<other_paper>')), { label: 'compare call' });
  const cmp = state.claudeCalls.find((c) => c.messages[0].content.includes('<other_paper>'));
  assert(cmp.messages[0].content.includes('Retrieval heads in long-context transformers'), 'compare sends the other paper');
  await lib.locator('aside button:has-text("All questions")').click();
  assert((await lib.locator('aside >> text=Earlier').count()) === 1, 'threads are listed for later');

  console.log('\n# Factoid with AI draft');
  await lib.locator('aside button:has-text("Factoid")').click();
  await lib.locator('button:has-text("Draft with AI")').click();
  await waitFor(async () => (await lib.locator('textarea').nth(0).inputValue()).includes('Long-context models miss facts'), { label: 'factoid draft' });
  await lib.evaluate(() => {
    window.__clip = null;
    navigator.clipboard.write = async (items) => {
      window.__clip = await (await items[0].getType('text/html')).text();
    };
  });
  await lib.locator('button:has-text("Copy for lab doc")').click();
  const clip = await waitFor(() => lib.evaluate(() => window.__clip), { label: 'clipboard html' });
  assert(clip.includes('<b>Problem</b>') && clip.includes('href="https://arxiv.org/abs/2401.00001"'), 'factoid copied as rich HTML with the paper link');
  await shot(lib, 'factoid');
  await lib.keyboard.press('Escape');

  console.log('\n# Topics named by Claude');
  for (const id of ['2404.00004', '2405.00005', '2406.00006', '2407.00007']) await addPaper(lib, id);
  await lib.goto(ext('library.html#view=all'));
  await lib.locator('button[title="Re-sort topics"]').click();
  await waitFor(async () => (await idb(opts, 'topics')).filter((t) => !t.deletedAt).length >= 2, { label: 'topics', timeout: 15000 });
  const topics = (await idb(opts, 'topics')).filter((t) => !t.deletedAt);
  console.log('  topics:', topics.map((t) => `${t.name} (${t.nameSource})`).join(', '));
  assert(topics.every((t) => t.nameSource === 'ai'), 'topic names come from Claude');
  const entries = await idb(opts, 'library');
  const topicOf = (id) => entries.find((e) => e.paperId === id)?.topicId;
  assert(topicOf('arxiv:2404.00004') === topicOf('arxiv:2407.00007') && topicOf('arxiv:2404.00004') !== topicOf('arxiv:2401.00001'), 'agent papers cluster apart from attention papers');
  await shot(lib, 'library-topics');

  console.log('\n# AI off hides everything again');
  await opts.locator('button[role="switch"]').first().click();
  await sleep(400);
  await html.reload();
  await html.waitForSelector('marginalia-ui', { state: 'attached' });
  await sleep(400);
  await selectText(html, 'The threshold');
  await html.locator('button[title^="Method"]').waitFor();
  assert((await html.locator('button[title="Explain this passage"]').count()) === 0, 'Explain hidden after turning AI off');
  await lib.goto(ext('library.html#view=all&paper=arxiv%3A2401.00001'));
  await lib.locator('aside button[role="tab"]:has-text("Notes")').waitFor();
  assert((await lib.locator('aside button[role="tab"]:has-text("Ask")').count()) === 0, 'Ask tab hidden after turning AI off');
  const callsBefore = state.claudeCalls.length;
  await addPaper(lib, '2401.00001').catch(() => {});
  await sleep(1500);
  assert(state.claudeCalls.length === callsBefore, 'no Claude calls after turning AI off');

  const real = errors.filter((e) => !/favicon|404/.test(e));
  assert(real.length === 0, `no page errors (${real.join(' | ')})`);
  console.log('\nALL AI TESTS PASSED');
} catch (e) {
  console.error(e);
  console.error('errors:', errors);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}
