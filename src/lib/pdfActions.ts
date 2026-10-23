// "Download PDF with highlights" and "Save to Drive", shared by the library,
// the side panel and the reader. Heavy modules (pdf.js, pdf-lib) load on demand.

import * as repo from './repo';
import { getSettings } from './settings';
import { fetchPdfBytes, loadPdfjs } from './pdfBytes';
import { nowIso } from './ids';
import type { Paper } from './types';

/** The paper's PDF, with highlights and notes embedded unless `annotated` is false. */
export async function exportPdf(paper: Paper, opts: { annotated?: boolean; bytes?: Uint8Array } = {}): Promise<{ bytes: Uint8Array; placed: number; missed: number; locked?: boolean }> {
  const original = opts.bytes ?? (await fetchPdfBytes(paper));
  if (opts.annotated === false) return { bytes: original, placed: 0, missed: 0 };
  const annotations = await repo.listAnnotations(paper.id);
  if (!annotations.length) return { bytes: original, placed: 0, missed: 0 };
  const [{ annotatePdf }, pdfjs, s] = await Promise.all([import('./pdfExport'), loadPdfjs(), getSettings()]);
  const res = await annotatePdf(original, annotations, { pdfjs, author: s.displayName || undefined, title: paper.title });
  return { bytes: res.bytes, placed: res.placed, missed: res.missed.length, locked: res.reason === 'encrypted' };
}

export function downloadBytes(name: string, bytes: Uint8Array, mime = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function downloadAnnotatedPdf(paper: Paper): Promise<{ placed: number; missed: number; locked?: boolean }> {
  const { pdfFileName } = await import('./pdfExport');
  const res = await exportPdf(paper);
  downloadBytes(pdfFileName(paper), res.bytes);
  return res;
}

/** Folder in Drive for a paper: its first project, else "Unsorted". */
export async function driveFolderFor(paperId: string): Promise<string> {
  const [entry, projects] = await Promise.all([repo.getEntry(paperId), repo.listProjects()]);
  const first = entry?.projectIds.map((id) => projects.find((p) => p.id === id)).find(Boolean);
  return first?.name ?? 'Unsorted';
}

/** Save (or update) the paper's PDF in Google Drive and remember it on the library entry. */
export async function savePdfToDrive(paper: Paper, opts: { bytes?: Uint8Array; annotated?: boolean } = {}): Promise<{ fileId: string; missed: number; locked?: boolean }> {
  const s = await getSettings();
  const annotated = opts.annotated ?? s.driveAnnotatedPdfs;
  const { savePaperPdf } = await import('./drive/files');
  const res = await exportPdf(paper, { annotated, bytes: opts.bytes });
  const file = await savePaperPdf(paper, res.bytes, { folder: await driveFolderFor(paper.id) });
  await repo.updateEntry(paper.id, { drivePdf: { fileId: file.id, savedAt: nowIso(), annotated: annotated && res.placed > 0 } });
  return { fileId: file.id, missed: res.missed, locked: res.locked };
}

export const driveFileUrl = (fileId: string) => `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`;
