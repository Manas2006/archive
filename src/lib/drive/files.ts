// What Archive keeps in Drive besides the sync file: paper PDFs and project .bib
// files. Each file is tagged with an app property (only Archive can see it), so it
// is found and updated in place even after the user renames or moves it.

import { ROOT_FOLDER } from './config';
import { ensureFolderPath, findByAppProperty, makeLinkReadable, removePublicLink, uploadFile, type DriveFile } from './api';
import type { Paper, Project } from '../types';

export const PAPER_PROP = 'archivePaper';
export const BIB_PROP = 'archiveBib';

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
const MAX_NAME = 120;

/**
 * A folder or file name that is safe in Drive and in Drive for desktop on every OS:
 * no slashes or other reserved characters, no control characters, no trailing dots
 * or spaces, at most 120 characters.
 */
export function sanitizeName(name: string, fallback = 'Untitled'): string {
  let s = (name ?? '')
    .normalize('NFC')
    .replace(/[\t\n\r]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME);
  s = s.replace(/[. ]+$/, '');
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/** File name for a paper's PDF: its citation key. */
export function drivePdfName(paper: Paper): string {
  return `${sanitizeName(paper.citeKey || paper.id.replace(/[:/]+/g, '-'), 'paper')}.pdf`;
}

/** Drive limits an app property's key plus value to 124 bytes, so very long ids are hashed. */
export function propValue(id: string, key: string): string {
  const bytes = new TextEncoder().encode(key + id).length;
  if (bytes <= 120) return id;
  return `h:${fnv(id, 0x811c9dc5)}${fnv(id, 0x01000193)}`;
}

function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// One save at a time per tagged file, so an auto-save racing a manual save can't create twins.
const locks = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

/**
 * Save a paper's PDF as Archive/<folder>/<citeKey>.pdf (Archive/<citeKey>.pdf when
 * folder is empty). If Archive saved this paper before, that file's content is
 * replaced in place, wherever it is now and whatever it is called.
 */
export function savePaperPdf(paper: Paper, bytes: Uint8Array, opts: { folder: string }): Promise<DriveFile> {
  const tag = propValue(paper.id, PAPER_PROP);
  return serialized(`${PAPER_PROP}:${tag}`, async () => {
    const appProperties = { [PAPER_PROP]: tag };
    const name = drivePdfName(paper);
    const existing = (await findByAppProperty(PAPER_PROP, tag))[0];
    if (existing) return uploadFile({ fileId: existing.id, name, mimeType: 'application/pdf', body: bytes, appProperties });
    const folder = opts.folder?.trim();
    const parentId = await ensureFolderPath(folder ? [ROOT_FOLDER, sanitizeName(folder)] : [ROOT_FOLDER]);
    return uploadFile({ name, parentId, mimeType: 'application/pdf', body: bytes, appProperties });
  });
}

/**
 * Keep a project's bibliography at Archive/<project>/<project>.bib. With publicLink,
 * anyone with the link can read it and the direct download link is returned (paste it
 * into Overleaf's "Add files > From external URL"); without it, any such link is removed.
 */
export function saveProjectBib(project: Project, bibText: string, opts: { publicLink: boolean }): Promise<{ file: DriveFile; link?: string }> {
  const tag = propValue(project.id, BIB_PROP);
  return serialized(`${BIB_PROP}:${tag}`, async () => {
    const appProperties = { [BIB_PROP]: tag };
    const folder = sanitizeName(project.name, 'Untitled project');
    const name = `${folder}.bib`;
    const existing = (await findByAppProperty(BIB_PROP, tag))[0];
    let file: DriveFile;
    if (existing) {
      file = await uploadFile({ fileId: existing.id, name, mimeType: 'text/plain', body: bibText, appProperties });
    } else {
      const parentId = await ensureFolderPath([ROOT_FOLDER, folder]);
      file = await uploadFile({ name, parentId, mimeType: 'text/plain', body: bibText, appProperties });
    }
    if (opts.publicLink) return { file, link: await makeLinkReadable(file.id) };
    if (existing) await removePublicLink(file.id);
    return { file };
  });
}
