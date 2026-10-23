// Long-running background work shared by the extension's background and the web
// app (which runs it while a page is open): follow migration, Drive sync, project
// .bib files in Drive, and saving new papers' PDFs to Drive.
//
// Everything here is imported statically: the extension's background is a module
// service worker, which can't use dynamic import().

import * as repo from '../repo';
import { onChange } from '../changes';
import { getSettings } from '../settings';
import { startupTasks } from '../follows';
import { startAutoSync, syncNow } from '../drive/sync';
import { getDriveAccount } from '../drive/auth';
import { savePaperPdf } from '../drive/files';
import { driveConfigured } from '../drive/config';
import { scheduleProjectBibs } from '../projectBib';
import { fetchPdfBytes } from '../pdfBytes';
import { nowIso } from '../ids';

let started = false;

export function startServices() {
  if (started) return;
  started = true;
  startupTasks().catch((e) => console.warn('[archive] startup tasks', e));
  if (!driveConfigured()) return;
  startAutoSync(async () => (await getSettings()).driveSync);
  onChange((e) => {
    if (e.table === 'library' || e.table === 'papers' || e.table === 'projects' || e.table === '*') scheduleProjectBibs();
  });
}

/** Periodic catch-up (alarm in the extension, timer in the web app). */
export async function periodicDriveSync() {
  if (!driveConfigured()) return;
  if (!(await getSettings()).driveSync || !(await getDriveAccount())) return;
  await syncNow();
}

/** Folder in Drive for a paper: its first project, else "Unsorted". */
async function folderFor(paperId: string): Promise<string> {
  const [entry, projects] = await Promise.all([repo.getEntry(paperId), repo.listProjects()]);
  const first = entry?.projectIds.map((id) => projects.find((p) => p.id === id)).find(Boolean);
  return first?.name ?? 'Unsorted';
}

/**
 * "Save every new paper's PDF to Drive": called after a paper is saved. The copy has
 * no highlights yet (there are none); the reader replaces it once you highlight.
 */
export async function autoSavePdf(paperId: string): Promise<void> {
  if (!driveConfigured()) return;
  const s = await getSettings();
  if (!s.driveAutoSave || !(await getDriveAccount())) return;
  const paper = await repo.getPaper(paperId);
  const entry = paper && (await repo.getEntry(paper.id));
  if (!paper?.urls.pdf || !entry || entry.drivePdf) return;
  try {
    // a short wait lets enrichment file the paper into its project first
    await new Promise((r) => setTimeout(r, 20_000));
    const bytes = await fetchPdfBytes(paper);
    const file = await savePaperPdf(paper, bytes, { folder: await folderFor(paper.id) });
    await repo.updateEntry(paper.id, { drivePdf: { fileId: file.id, savedAt: nowIso(), annotated: false } });
  } catch (e) {
    console.warn('[archive] auto-save to Drive failed', paperId, e);
  }
}
