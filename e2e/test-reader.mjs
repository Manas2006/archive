// Step 3: PDF reader: redirect, cross-medium anchoring, highlights, zoom, snipping, progress.
import fs from 'node:fs';
import { startServer } from './server.mjs';
import { launch } from './launch.mjs';
import { assert, idb, selectText, shot, sleep, waitFor } from './helpers.mjs';

fs.mkdirSync('/tmp/claude-0/shots', { recursive: true });
const server = await startServer();
const { context, extensionId } = await launch();
const ext = (p) => `chrome-extension://${extensionId}/${p}`;
const errors = [];
const extPage = await context.newPage();
await extPage.goto(ext('options.html'));

try {
  console.log('\n# Seed a highlight on the HTML page');
  const html = await context.newPage();
  await html.goto('https://arxiv.org/html/2401.00001v1');
  await html.waitForSelector('marginalia-ui', { state: 'attached' });
  await sleep(400);
  await selectText(html, 'We propose filtered attention, which scores every key block');
  await html.locator('button[title^="Method"]').click();
  await waitFor(async () => (await idb(extPage, 'annotations')).length === 1, { label: 'html annotation' });
  await html.close();

  console.log('\n# PDF opens in the reader');
  const pdf = await context.newPage();
  pdf.on('pageerror', (e) => errors.push(`reader: ${e.message}`));
  pdf.on('console', (m) => m.type() === 'error' && errors.push(`reader console: ${m.text()}`));
  await pdf.goto('https://arxiv.org/pdf/2401.00001v1').catch(() => {});
  await waitFor(async () => pdf.url().includes('/reader.html'), { label: 'redirect to reader' });
  assert(pdf.url().includes(encodeURIComponent('https://arxiv.org/pdf/2401.00001v1')), 'reader got the PDF url');
  await pdf.waitForSelector('.textLayer span', { timeout: 20000 });
  assert(true, 'text layer rendered');
  const layerText = await pdf.evaluate(() => document.querySelector('.textLayer').textContent.slice(0, 300));
  console.log('  text layer starts:', JSON.stringify(layerText.slice(0, 120)));

  console.log('\n# Cross-medium anchoring (HTML highlight shows in the PDF)');
  await waitFor(async () => (await pdf.locator('.textLayer mark.mg-hl[data-mg-label="method"]').count()) > 0, { label: 'html highlight in pdf', timeout: 10000 });
  const methodText = (await pdf.locator('.textLayer mark.mg-hl[data-mg-label="method"]').allTextContents()).join('');
  assert(methodText.replace(/\s/g, '').includes('Weproposefilteredattention'), `HTML highlight placed in the PDF: "${methodText.slice(0, 60)}"`);

  console.log('\n# New highlight in the PDF');
  await selectText(pdf, 'improves retrieval recall by 11.4 points', '#viewer');
  await pdf.locator('button[title^="Result"]').click();
  await waitFor(async () => (await pdf.locator('.textLayer mark.mg-hl[data-mg-label="result"]').count()) > 0, { label: 'pdf result mark' });
  const anns = await waitFor(async () => {
    const a = (await idb(extPage, 'annotations')).filter((x) => !x.deletedAt);
    return a.length === 2 ? a : null;
  }, { label: '2 annotations' });
  const pdfAnn = anns.find((a) => a.target.state.medium === 'pdf');
  assert(pdfAnn && pdfAnn.target.state.page === 1 && pdfAnn.target.state.version === 1, 'pdf annotation records medium, page and version');
  const entry = await idb(extPage, 'library', 'arxiv:2401.00001');
  assert(entry && entry.status === 'reading', 'highlighting an unsaved paper saves it as Reading');

  console.log('\n# Zoom keeps highlights (no duplicates)');
  const before = await pdf.locator('.textLayer mark.mg-hl').count();
  await pdf.locator('button[title="Zoom in"]').click();
  await sleep(1200);
  const after = await pdf.locator('.textLayer mark.mg-hl').count();
  assert(after === before, `marks after zoom: ${after} (was ${before})`);
  await shot(pdf, 'reader');

  console.log('\n# Click highlight → popover → delete');
  await pdf.locator('.textLayer mark.mg-hl[data-mg-label="result"]').first().click();
  await pdf.locator('button:has-text("Delete")').click();
  await waitFor(async () => (await pdf.locator('.textLayer mark.mg-hl[data-mg-label="result"]').count()) === 0, { label: 'mark removed' });
  const remaining = (await idb(extPage, 'annotations')).filter((x) => !x.deletedAt);
  assert(remaining.length === 1, 'deleted highlight is soft-deleted');

  console.log('\n# Snip a figure');
  await pdf.evaluate(() => (document.getElementById('viewerContainer').scrollTop = 0));
  await sleep(500);
  await pdf.locator('button[title^="Snip a figure"]').click();
  const box = await pdf.locator('.page canvas').first().boundingBox();
  console.log('  canvas box', JSON.stringify(box));
  await pdf.mouse.move(box.x + 40, box.y + 60);
  await pdf.mouse.down();
  await pdf.mouse.move(box.x + 300, box.y + 200, { steps: 5 });
  await pdf.mouse.up();
  const att = await waitFor(async () => (await idb(extPage, 'attachments'))[0], { label: 'attachment' });
  assert(att.dataUrl.startsWith('data:image/png;base64,') && att.dataUrl.length > 1000, 'snipped figure stored as PNG');
  const e2 = await idb(extPage, 'library', 'arxiv:2401.00001');
  assert(e2.factoidFigure?.kind === 'attachment' && e2.factoidFigure.id === att.id, 'snip becomes the factoid figure');

  console.log('\n# Full text from the PDF');
  const ft = await waitFor(() => idb(extPage, 'fulltext', ['arxiv:2401.00001', 'pdf']), { label: 'pdf full text' });
  assert(ft.text.includes('Filtered attention improves retrieval recall'), 'readable PDF text stored');

  console.log('\n# Reading progress in the reader');
  await pdf.evaluate(() => {
    const c = document.getElementById('viewerContainer');
    c.scrollTop = c.scrollHeight;
  });
  await sleep(2000);
  await pdf.evaluate(() => document.getElementById('viewerContainer').scrollBy(0, -3));
  await waitFor(async () => (await idb(extPage, 'library', 'arxiv:2401.00001')).status === 'read', { label: 'read status', timeout: 6000 });
  assert(true, 'scrolling to the end marks the paper read');

  console.log('\n# Open original bypasses the reader');
  await pdf.locator('button[title="Open the original PDF"]').click();
  await waitFor(async () => pdf.url().startsWith('https://arxiv.org/pdf/'), { label: 'original pdf' });
  await sleep(1500);
  assert(pdf.url().startsWith('https://arxiv.org/pdf/'), 'stays on the original PDF');

  console.log('\n# OpenReview PDF in the reader');
  const orp = await context.newPage();
  await orp.goto('https://openreview.net/pdf?id=ORabc123').catch(() => {});
  await waitFor(async () => orp.url().includes('/reader.html'), { label: 'openreview redirect' });
  await orp.waitForSelector('.textLayer span', { timeout: 20000 });
  assert(true, 'OpenReview PDF renders in the reader');

  const real = errors.filter((e) => !/favicon|404/.test(e));
  assert(real.length === 0, `no reader errors (${real.join(' | ')})`);
  console.log('\nALL READER TESTS PASSED');
} catch (e) {
  console.error(e);
  console.error('errors:', errors);
  process.exitCode = 1;
} finally {
  await context.close();
  server.close();
}
