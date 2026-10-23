import { useState } from 'react';
import { CopyButton, Modal, Spinner, Toggle } from '@/components/common';
import { Icon } from '@/components/Icon';
import { useLive } from '@/hooks/useLive';
import * as repo from '@/lib/repo';
import { download } from '@/lib/exports';
import { projectBibText } from '@/lib/projectBib';
import { openSettings } from '@/lib/nav';
import type { Project } from '@/lib/types';
import { slug } from './shared';

export function OverleafDialog({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const { data: account } = useLive(async () => (await import('@/lib/drive/auth')).getDriveAccount(), [open], (e) => e.table === 'drive');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bib = project.driveBib;

  const update = async (enabled: boolean, publicLink: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const { pushProjectBib } = await import('@/lib/projectBib');
      if (!enabled) {
        if (bib?.fileId && bib.publicLink) await (await import('@/lib/drive/api')).removePublicLink(bib.fileId).catch(() => undefined);
        await repo.updateProject(project.id, (cur) => ({ driveBib: { ...(cur.driveBib ?? {}), enabled: false, publicLink: undefined } }));
      } else {
        await repo.updateProject(project.id, (cur) => ({ driveBib: { ...(cur.driveBib ?? {}), enabled: true } }));
        await pushProjectBib({ ...project, driveBib: { ...(bib ?? {}), enabled: true } }, { force: true, publicLink });
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Use this bibliography in Overleaf">
      <div className="flex flex-col gap-4 text-sm">
        {!account ? (
          <>
            <p className="text-stone-600 dark:text-stone-300">
              Archive can keep <span className="font-mono">{slug(project.name)}.bib</span> up to date in your Google Drive, with a link Overleaf can read, so new papers show up in your paper after one click on Refresh.
            </p>
            <div className="flex flex-wrap gap-2">
              <button className="mg-btn-primary" onClick={() => openSettings('drive')}>
                Connect Google Drive in Settings
              </button>
              <button className="mg-btn" onClick={async () => download(`${slug(project.name)}.bib`, await projectBibText(project.id), 'application/x-bibtex')}>
                <Icon name="download" size={14} /> Download .bib instead
              </button>
            </div>
          </>
        ) : (
          <>
            <Toggle
              checked={!!bib?.enabled}
              disabled={busy}
              onChange={(v) => update(v, !!bib?.publicLink)}
              label={`Keep ${slug(project.name)}.bib up to date in Google Drive`}
              description={`Saved in Archive/${project.name}/ in ${account.email}'s Drive. Updated a few seconds after you add or change papers.`}
            />
            {bib?.enabled && (
              <Toggle
                checked={!!bib.publicLink}
                disabled={busy}
                onChange={(v) => update(true, v)}
                label="Make a link Overleaf can read"
                description="Anyone with the link can read this .bib file. It only contains bibliography entries, not your notes or highlights."
              />
            )}
            {busy && (
              <div className="flex items-center gap-2 text-stone-500">
                <Spinner /> Updating Drive…
              </div>
            )}
            {bib?.publicLink && (
              <div className="flex flex-col gap-2 rounded-md bg-stone-50 p-3 dark:bg-stone-800">
                <div className="flex items-center gap-2">
                  <input className="mg-input font-mono text-xs" readOnly value={bib.publicLink} onFocus={(e) => e.target.select()} />
                  <CopyButton text={bib.publicLink} label="Copy" />
                </div>
                <ol className="list-decimal pl-5 text-xs text-stone-600 dark:text-stone-300">
                  <li>In Overleaf, click the upload icon (Upload) and choose From external URL.</li>
                  <li>Paste the link and name the file, for example refs.bib.</li>
                  <li>After you add papers here, click Refresh on that file in Overleaf.</li>
                </ol>
              </div>
            )}
          </>
        )}
        {err && <p className="text-rose-700">{err}</p>}
      </div>
    </Modal>
  );
}
