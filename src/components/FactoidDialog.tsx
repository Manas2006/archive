import { useEffect, useMemo, useState } from 'react';
import { copyRich, factoidFromHighlights, factoidHtml, factoidText, FACTOID_SECTIONS, type FactoidDraft } from '@/lib/exports';
import { draftFactoid } from '@/lib/ai/features';
import * as repo from '@/lib/repo';
import type { Annotation, Attachment, LibraryEntry, Paper } from '@/lib/types';
import { Modal, Spinner } from './common';
import { Icon } from './Icon';

function figureSrc(entry: LibraryEntry | null, paper: Paper, attachments: Attachment[]): string | null {
  const f = entry?.factoidFigure;
  if (f?.kind === 'url') return f.url;
  if (f?.kind === 'attachment') return attachments.find((a) => a.id === f.id)?.dataUrl ?? null;
  return attachments[0]?.dataUrl ?? paper.firstFigureUrl ?? null;
}

export function FactoidDialog({
  open,
  onClose,
  paper,
  entry,
  annotations,
  attachments,
  ai,
}: {
  open: boolean;
  onClose: () => void;
  paper: Paper;
  entry: LibraryEntry | null;
  annotations: Annotation[];
  attachments: Attachment[];
  ai: boolean;
}) {
  const base = useMemo(() => factoidFromHighlights(annotations), [annotations]);
  const [draft, setDraft] = useState<FactoidDraft>(base);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [figureOn, setFigureOn] = useState(true);

  useEffect(() => {
    if (open) {
      setDraft(base);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const fig = figureSrc(entry, paper, attachments);
  const options = [
    ...(paper.firstFigureUrl ? [{ key: 'first', src: paper.firstFigureUrl, set: () => entry && repo.updateEntry(paper.id, { factoidFigure: { kind: 'url', url: paper.firstFigureUrl! } }) }] : []),
    ...attachments.map((a) => ({ key: a.id, src: a.dataUrl, set: () => entry && repo.updateEntry(paper.id, { factoidFigure: { kind: 'attachment', id: a.id } }) })),
  ];

  const copy = async (rich: boolean) => {
    const clean = Object.fromEntries(
      Object.entries(draft).map(([k, v]) => [k, (v as string[]).map((x) => x.trim()).filter(Boolean)]),
    ) as unknown as FactoidDraft;
    const html = factoidHtml(paper, clean, figureOn && fig ? { src: fig } : null);
    if (rich) await copyRich(html, factoidText(paper, clean));
    else await navigator.clipboard.writeText(factoidText(paper, clean));
    setCopied(rich ? 'rich' : 'text');
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <Modal open={open} onClose={onClose} title="Factoid for lab meeting" wide>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-stone-600 dark:text-stone-300">
          Built from your labeled highlights. Edit freely (one bullet per line), then copy it into the shared lab doc.
        </p>
        {ai && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="mg-btn"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  setDraft(await draftFactoid(paper, annotations));
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner /> : <Icon name="sparkle" size={14} />} Draft with AI
            </button>
            <button type="button" className="mg-btn-ghost" onClick={() => setDraft(base)}>
              <Icon name="undo" size={14} /> Use highlights as-is
            </button>
            {error && <span className="text-sm text-rose-700">{error}</span>}
          </div>
        )}
        <div className="grid gap-3">
          <div className="text-sm">
            <span className="font-semibold">Paper:</span> {paper.title}
          </div>
          {FACTOID_SECTIONS.map((s) => (
            <label key={s.key} className="block">
              <span className="mg-label">{s.title}</span>
              <textarea
                className="mg-input mt-1"
                rows={Math.max(2, draft[s.key].length + 1)}
                value={draft[s.key].join('\n')}
                placeholder={draft[s.key].length ? '' : `No ${s.title.toLowerCase()} highlights yet`}
                onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value.split('\n') })}
              />
            </label>
          ))}
        </div>
        <div>
          <div className="mg-label mb-1.5">Figure</div>
          {fig ? (
            <div className="flex items-start gap-3">
              <img src={fig} alt="" className={`max-h-40 max-w-[280px] rounded border border-stone-200 bg-white object-contain dark:border-stone-700 ${figureOn ? '' : 'opacity-30'}`} />
              <div className="flex flex-col gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={figureOn} onChange={(e) => setFigureOn(e.target.checked)} /> Include figure
                </label>
                {options.length > 1 && (
                  <div className="flex flex-wrap gap-1">
                    {options.map((o) => (
                      <button key={o.key} type="button" onClick={() => o.set()} className="h-12 w-16 overflow-hidden rounded border border-stone-200 bg-white dark:border-stone-700">
                        <img src={o.src} alt="" className="h-full w-full object-contain" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-stone-500">
              No figure yet. On an arXiv HTML page, right-click a figure and choose "Use this image as the factoid figure", or use Snip in the PDF reader.
            </p>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-stone-200 pt-3 dark:border-stone-700">
          <button type="button" className="mg-btn" onClick={() => copy(false)}>
            <Icon name={copied === 'text' ? 'check' : 'copy'} size={14} /> {copied === 'text' ? 'Copied' : 'Copy as text'}
          </button>
          <button type="button" className="mg-btn-primary" onClick={() => copy(true)}>
            <Icon name={copied === 'rich' ? 'check' : 'copy'} size={14} /> {copied === 'rich' ? 'Copied' : 'Copy for lab doc'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
