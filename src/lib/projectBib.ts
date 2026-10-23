// Keep each project's .bib file up to date in Google Drive (opt-in per project),
// so Overleaf can pull it from a link.

import * as repo from './repo';
import { bibFile } from './exports';
import { cleanImportedBib, hasPrivateBibFields } from './bibtex';
import { nowIso } from './ids';
import type { Project } from './types';
import { BIB_PROP, propValue, saveProjectBib } from './drive/files';
import { findByAppProperty, removePublicLink } from './drive/api';
import { getDriveAccount } from './drive/auth';

export async function projectBibText(projectId: string): Promise<string> {
  const entries = (await repo.listEntries()).filter((e) => e.projectIds.includes(projectId));
  const papers = await repo.getPapers(entries.map((e) => e.paperId));
  papers.sort((a, b) => a.citeKey.localeCompare(b.citeKey));
  // the file can have a public link, so private notes and file paths never go in it
  return bibFile(papers.map((p) => (hasPrivateBibFields(p.bibtex) ? { ...p, bibtex: cleanImportedBib(p.bibtex, p.citeKey) ?? p.bibtex } : p)));
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
  const account = await getDriveAccount();
  if (!account) throw new Error('Connect Google Drive in Settings first.');
  const text = await projectBibText(project.id);
  const hash = hashText(text);
  const cur = project.driveBib;
  // A different Google account: the old file and link belong to that account, so start
  // over, and don't share the new file until the user turns the link on again.
  const sameAccount = !cur?.account || !account.email || cur.account === account.email;
  const want = opts.publicLink ?? (sameAccount && !!cur?.publicLink);
  if (!opts.force && sameAccount && cur?.hash === hash && !!cur.publicLink === want && !cur.error) return project;
  const res = await saveProjectBib(project, text, { publicLink: want });
  return repo.updateProject(
    project.id,
    (c) => ({
      driveBib: {
        ...(c.driveBib ?? { enabled: true }),
        enabled: true,
        fileId: res.file.id,
        publicLink: want ? res.link : undefined,
        hash,
        updatedAt: nowIso(),
        account: account.email || c.driveBib?.account,
        error: undefined,
      },
    }),
    // a link turned on or off is the user's choice and syncs; a routine re-upload doesn't
    { derived: !opts.force && !!cur?.publicLink === want },
  );
}

/** Take down a project's public .bib link. Throws when Drive can't be reached, so the caller can say so. */
export async function revokeProjectBibLink(project: Project): Promise<void> {
  const b = project.driveBib;
  if (!b?.publicLink) return;
  const ids = b.fileId ? [b.fileId] : (await findByAppProperty(BIB_PROP, propValue(project.id, BIB_PROP))).map((f) => f.id);
  for (const id of ids) await removePublicLink(id);
  await repo.updateProject(project.id, (c) => ({ driveBib: { ...(c.driveBib ?? { enabled: false }), publicLink: undefined } }));
}

/** Take down every public .bib link, before disconnecting Drive or deleting everything. */
export async function revokeAllBibLinks(): Promise<{ revoked: number; failed: { project: Project; error: string }[] }> {
  let revoked = 0;
  const failed: { project: Project; error: string }[] = [];
  for (const p of await repo.listProjects()) {
    if (!p.driveBib?.publicLink) continue;
    try {
      await revokeProjectBibLink(p);
      revoked++;
    } catch (e) {
      failed.push({ project: p, error: (e as Error).message });
    }
  }
  return { revoked, failed };
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
          const error = (e as Error).message || 'Upload failed';
          await repo.updateProject(p.id, (c) => ({ driveBib: { ...(c.driveBib ?? { enabled: true }), error } }), { derived: true }).catch(() => undefined);
        }
      }
    } finally {
      running = false;
    }
  }, delayMs);
}
