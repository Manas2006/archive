// Keep each project's .bib file up to date in Google Drive (opt-in per project),
// so Overleaf can pull it from a link.

import * as repo from './repo';
import { bibFile } from './exports';
import { nowIso } from './ids';
import type { Project } from './types';
import { saveProjectBib } from './drive/files';
import { getDriveAccount } from './drive/auth';

export async function projectBibText(projectId: string): Promise<string> {
  const entries = (await repo.listEntries()).filter((e) => e.projectIds.includes(projectId));
  const papers = await repo.getPapers(entries.map((e) => e.paperId));
  papers.sort((a, b) => a.citeKey.localeCompare(b.citeKey));
  return bibFile(papers);
}

/** Cheap stable hash (FNV-1a) to tell whether the file changed. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Upload one project's .bib if it changed (or when forced). Returns the project as updated. */
export async function pushProjectBib(project: Project, opts: { force?: boolean; publicLink?: boolean } = {}): Promise<Project | undefined> {
  const text = await projectBibText(project.id);
  const hash = hashText(text);
  const want = opts.publicLink ?? !!project.driveBib?.publicLink;
  if (!opts.force && project.driveBib?.hash === hash && !!project.driveBib.publicLink === want) return project;
  const res = await saveProjectBib(project, text, { publicLink: want });
  return repo.updateProject(project.id, (cur) => ({
    driveBib: { ...(cur.driveBib ?? { enabled: true }), enabled: true, fileId: res.file.id, publicLink: want ? res.link : undefined, hash, updatedAt: nowIso() },
  }));
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

/** Debounced: re-upload the .bib of every project that has Drive sync on. Safe to call on every change. */
export function scheduleProjectBibs(delayMs = 15000) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    if (running) return scheduleProjectBibs(delayMs);
    running = true;
    try {
      if (!(await getDriveAccount())) return;
      for (const p of await repo.listProjects()) {
        if (!p.driveBib?.enabled) continue;
        try {
          await pushProjectBib(p);
        } catch (e) {
          console.warn('[archive] project .bib upload failed', p.name, e);
        }
      }
    } finally {
      running = false;
    }
  }, delayMs);
}
