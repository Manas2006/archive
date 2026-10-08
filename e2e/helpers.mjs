// Shared helpers for browser tests.

export function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 10000, interval = 200, label = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

/** Select the first occurrence of `text` inside `rootSelector` and fire mouseup. */
export async function selectText(page, text, rootSelector = 'article') {
  const ok = await page.evaluate(
    ({ text, rootSelector }) => {
      const root = document.querySelector(rootSelector) ?? document.body;
      // Build a flat text map of all text nodes (including math) to find spans across nodes.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let all = '';
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const p = n.parentElement;
        if (p && (p.closest('annotation') || p.closest('button') || p.closest('script'))) continue;
        nodes.push([n, all.length]);
        all += n.nodeValue;
      }
      const at = all.indexOf(text);
      if (at < 0) return false;
      const locate = (off) => {
        for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i][1] <= off) return [nodes[i][0], off - nodes[i][1]];
        return null;
      };
      const [sn, so] = locate(at);
      const [en, eo] = locate(at + text.length);
      const r = document.createRange();
      r.setStart(sn, so);
      r.setEnd(en, eo);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      const rect = r.getBoundingClientRect();
      (en.parentElement ?? document).dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true, clientX: rect.right, clientY: rect.bottom }));
      return true;
    },
    { text, rootSelector },
  );
  if (!ok) throw new Error(`text not found for selection: ${text}`);
}

/** Locator inside the content-script shadow root. */
export function ui(page) {
  return page.locator('marginalia-ui');
}

/** Read an IndexedDB store from an extension page. */
export async function idb(extPage, store, key) {
  return extPage.evaluate(
    ({ store, key }) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('marginalia');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(store, 'readonly');
          const os = tx.objectStore(store);
          const r = key === undefined ? os.getAll() : os.get(key);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        };
        req.onerror = () => reject(req.error);
      }),
    { store, key },
  );
}

export async function session(extPage, key) {
  return extPage.evaluate((key) => chrome.storage.session.get(key).then((v) => v[key]), key);
}

export async function shot(page, name) {
  const p = `/tmp/claude-0/shots/${name}.png`;
  await page.screenshot({ path: p });
  return p;
}
