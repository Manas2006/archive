import { useEffect, useRef, useState } from 'react';
import { Modal, Spinner } from '@/components/common';
import { Icon } from '@/components/Icon';
import * as repo from '@/lib/repo';
import { rpc } from '@/lib/rpc';
import { bibFile, download } from '@/lib/exports';
import type { ImportedRef } from '@/lib/zotero';
import type { Project } from '@/lib/types';

export function ImportExportDialog({ open, onClose, projects }: { open: boolean; onClose: () => void; projects: Project[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [refs, setRefs] = useState<ImportedRef[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRefs(null);
      setFileName('');
      setMsg(null);
      setErr(null);
    }
  }, [open]);

  const pickFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    setMsg(null);
    try {
      const { parseImport } = await import('@/lib/zotero');
      const parsed = parseImport(f.name, await f.text());
      if (!parsed.length) throw new Error("Couldn't find any references in that file. Use BibTeX (.bib), RIS (.ris) or CSL JSON (.json).");
      setRefs(parsed);
      setFileName(f.name);
    } catch (e) {
      setErr((e as Error).message);
      setRefs(null);
    }
  };

  const runImport = async () => {
    if (!refs) return;
    setBusy('import');
    setErr(null);
    try {
      const { importRefs } = await import('@/lib/zotero');
      const res = await importRefs(refs, { projectId: projectId || undefined });
      if (res.paperIds.length) await rpc.enqueueEnrich(res.paperIds);
      setMsg(`Imported ${res.added} new paper${res.added === 1 ? '' : 's'}${res.updated ? `, updated ${res.updated}` : ''}${res.skipped ? `, skipped ${res.skipped} without a title` : ''}. Archive is looking them up on Semantic Scholar now.`);
      setRefs(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const allItems = async () => {
    const entries = await repo.listEntries();
    const papers = await repo.getPapers(entries.map((e) => e.paperId));
    const byId = new Map(entries.map((e) => [e.paperId, e] as const));
    return Promise.all(papers.map(async (p) => ({ paper: p, entry: byId.get(p.id) ?? null, annotations: await repo.listAnnotations(p.id) })));
  };

  const exportAs = async (kind: 'ris' | 'csljson' | 'bib') => {
    setBusy(kind);
    try {
      const items = await allItems();
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === 'bib') download(`archive-library-${stamp}.bib`, bibFile(items.map((i) => i.paper)), 'application/x-bibtex');
      else {
        const z = await import('@/lib/zotero');
        if (kind === 'ris') download(`archive-library-${stamp}.ris`, z.toRis(items, { projects: new Map(projects.map((p) => [p.id, p] as const)) }), 'application/x-research-info-systems');
        else download(`archive-library-${stamp}.json`, z.toCslJson(items.map((i) => i.paper)), 'application/json');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Import and export">
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Import from Zotero or another reference manager</h3>
          <p className="text-xs text-stone-500">
            In Zotero, choose File, Export Library, and pick RIS (keeps your notes) or BibTeX. Mendeley, EndNote and Paperpile exports work too. Papers you already have are not duplicated.
          </p>
          <input ref={fileRef} type="file" accept=".bib,.bibtex,.ris,.json,.txt" className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
          <button className="mg-btn self-start" onClick={() => fileRef.current?.click()}>
            <Icon name="file" size={14} /> Choose a file
          </button>
          {refs && (
            <div className="flex flex-col gap-2 rounded-md bg-stone-50 p-3 dark:bg-stone-800">
              <div className="text-sm">
                <span className="font-medium">{fileName}</span>: {refs.length} reference{refs.length === 1 ? '' : 's'}
                {(() => {
                  const ax = refs.filter((r) => r.arxivId).length;
                  return ax ? `, ${ax} on arXiv` : '';
                })()}
              </div>
              <label className="flex items-center gap-2 text-sm">
                Add to project
                <select className="mg-input w-auto py-1 text-sm" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">None</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="mg-btn-primary self-start" disabled={!!busy} onClick={runImport}>
                {busy === 'import' ? <Spinner /> : <Icon name="plus" size={14} />} Import {refs.length}
              </button>
            </div>
          )}
          {msg && <p className="text-sm text-accent-800 dark:text-accent-200">{msg}</p>}
          {err && <p className="text-sm text-rose-700">{err}</p>}
        </section>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Export your library</h3>
          <p className="text-xs text-stone-500">RIS includes your highlights and notes, so Zotero imports them as notes on each item (File, Import).</p>
          <div className="flex flex-wrap gap-2">
            <button className="mg-btn" disabled={!!busy} onClick={() => exportAs('ris')}>
              {busy === 'ris' ? <Spinner /> : <Icon name="download" size={14} />} RIS for Zotero
            </button>
            <button className="mg-btn" disabled={!!busy} onClick={() => exportAs('bib')}>
              {busy === 'bib' ? <Spinner /> : <Icon name="download" size={14} />} BibTeX
            </button>
            <button className="mg-btn" disabled={!!busy} onClick={() => exportAs('csljson')}>
              {busy === 'csljson' ? <Spinner /> : <Icon name="download" size={14} />} CSL JSON
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
