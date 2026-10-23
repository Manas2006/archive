// Fetch a paper's PDF as bytes (for Save to Drive and "Download with highlights").

import type { Paper } from './types';

export async function fetchPdfBytes(paper: Paper, src?: string): Promise<Uint8Array> {
  const url = src ?? paper.urls.pdf;
  if (!url) throw new Error('This paper has no PDF link.');
  const res = await fetch(url, { credentials: /^https:\/\/openreview\.net\//.test(url) ? 'include' : 'same-origin' });
  if (res.status === 401 || res.status === 403) throw new Error('This PDF needs you to be signed in to the site.');
  if (!res.ok) throw new Error(`Couldn't download the PDF (${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!new TextDecoder().decode(bytes.slice(0, 1024)).includes('%PDF')) throw new Error("That link didn't return a PDF.");
  return bytes;
}

let pdfjsReady: Promise<typeof import('pdfjs-dist')> | null = null;

/** pdf.js with its worker configured, loaded on demand. */
export function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  pdfjsReady ??= (async () => {
    const [lib, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  })();
  return pdfjsReady;
}
