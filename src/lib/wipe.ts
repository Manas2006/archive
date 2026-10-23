// "Delete all data": everything Archive keeps in this browser, and the public links it made.

import * as repo from './repo';
import { resetSettings } from './settings';
import { disconnectDrive, getDriveAccount } from './drive/auth';
import { deleteRemoteLibrary } from './drive/sync';
import { revokeAllBibLinks } from './projectBib';

export interface WipeResult {
  /** Things that could not be undone in Google Drive, in words for the user. */
  warnings: string[];
}

/**
 * Take down public .bib links, optionally trash the synced copy in Drive, sign out of
 * Drive, then empty the database (papers, notes, the Claude key, Ask history) and reset
 * settings. PDFs and .bib files saved in Drive stay there.
 */
export async function deleteAllData(opts: { driveCopy?: boolean } = {}): Promise<WipeResult> {
  const warnings: string[] = [];
  if (await getDriveAccount()) {
    const { failed } = await revokeAllBibLinks();
    for (const f of failed) warnings.push(`The public link to the "${f.project.name}" .bib file could not be removed (${f.error}). Turn off its sharing in Google Drive.`);
    if (opts.driveCopy) {
      try {
        await deleteRemoteLibrary();
      } catch (e) {
        warnings.push(`The synced copy in Google Drive could not be deleted (${(e as Error).message}). Delete the Archive/.sync folder in Drive yourself.`);
      }
    }
    await disconnectDrive().catch(() => undefined);
  }
  await repo.clearAll();
  await resetSettings();
  return { warnings };
}
