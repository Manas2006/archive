import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import 'pdfjs-dist/web/pdf_viewer.css';
import '@/assets/tailwind.css';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { createViewer, loadPdf, pageTexts, readableText, PdfAnnotator, type Viewer } from './pdf';
import { useSettings } from '@/hooks/useSettings';
import { useThread } from '@/components/ThreadView';
import { AiPopover, HighlightPopover, SelectionToolbar, type Rect } from '@/components/annot/Floating';
import { Spinner, StatusSelect, WillCiteButton } from '@/components/common';
import { Icon, Logo } from '@/components/Icon';
import { HIGHLIGHT_CSS, highlightIdsAt } from '@/lib/anchoring/highlighter';
import { onChange } from '@/lib/changes';
import { parsePaperUrl, uuid } from '@/lib/ids';
import * as repo from '@/lib/repo';
import { rpc, onTabCommand } from '@/lib/rpc';
import { HIGHLIGHT_LABELS, type Annotation, type HighlightLabel, type LibraryEntry, type Paper } from '@/lib/types';

const style = document.createElement('style');
style.textContent = `${HIGHLIGHT_CSS}
.textLayer mark.mg-hl { mix-blend-mode: multiply; border-radius: 1px; }
.textLayer ::selection { background: rgba(31, 95, 88, 0.28); }
#viewerContainer { position: absolute; inset: 48px 0 0 0; overflow: auto; background: #e7e5e4; }
@media (prefers-color-scheme: dark) { #viewerContainer { background: #1c1917; } }
.pdfViewer .page { box-shadow: 0 1px 3px rgba(0,0,0,.15); border: none; margin: 12px auto; }
.mg-snip { position: absolute; border: 2px dashed #22766c; background: rgba(34,118,108,.12); pointer-events: none; z-index: 20; }
`;
document.head.append(style);

const params = new URLSearchParams(location.search);
const SRC = params.get('src') ?? '';
const parsed = parsePaperUrl(SRC);
const PAPER_ID = params.get('paper') ?? parsed?.paperId ?? null;
const VERSION = parsed?.arxiv?.version;

const toRect = (r: DOMRect): Rect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

function App() {
  const settings = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [annotator, setAnnotator] = useState<PdfAnnotator | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [tabId, setTabId] = useState<number | null>(null);
  const [paper, setPaper] = useState<Paper | null>(null);
  const [entry, setEntry] = useState<LibraryEntry | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const pending = useRef(0);

  const showToast = (t: string) => {
    setToast(t);
    setTimeout(() => setToast((x) => (x === t ? null : x)), 3000);
  };

  useEffect(() => {
    chrome.tabs.getCurrent().then((t) => setTabId(t?.id ?? null));
  }, []);

  // ---- load the PDF ----
  useEffect(() => {
    if (!SRC) {
      setError('No PDF to open.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const d = await loadPdf(SRC, (l, t) => setProgress(l / t));
        if (cancelled) return;
        const texts = await pageTexts(d);
        const { viewer: v, eventBus, linkService } = await createViewer(containerRef.current!, viewerRef.current!);
        const ann = new PdfAnnotator(v, texts, VERSION);
        eventBus.on('pagesinit', () => {
          v.currentScaleValue = 'page-width';
        });
        eventBus.on('textlayerrendered', (e: { pageNumber: number }) => ann.renderPage(e.pageNumber - 1));
        eventBus.on('pagechanging', (e: { pageNumber: number }) => setPage(e.pageNumber));
        eventBus.on('scalechanging', (e: { scale: number }) => setScale(e.scale));
        v.setDocument(d);
        linkService.setDocument(d, null);
        setDoc(d);
        setViewer(v);
        setAnnotator(ann);
        const meta = await d.getMetadata().catch(() => null);
        const title = (meta?.info as any)?.Title;
        if (title && !document.title.includes(title)) document.title = `${title} · Archive`;
      } catch (e) {
        // restricted PDFs (e.g. OpenReview submissions under review): fall back to Chrome's viewer
        if ((e as { status?: number }).status === 401 || (e as { status?: number }).status === 403) {
          void rpc.openOriginal(SRC);
          return;
        }
        setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- paper state ----
  const refresh = useCallback(async () => {
    if (!PAPER_ID || pending.current > 0) return;
    const p = (await repo.getPaper(PAPER_ID)) ?? null;
    setPaper(p);
    setEntry(p ? (await repo.getEntry(p.id)) ?? null : null);
    setAnnotations(p ? await repo.listAnnotations(p.id) : []);
    if (p) document.title = `${p.title} · Archive`;
  }, []);

  useEffect(() => {
    void refresh();
    return onChange((e) => {
      if (e.table === '*' || !e.paperIds.length || e.paperIds.some((id) => id === PAPER_ID || id === paper?.id)) void refresh();
    });
  }, [refresh, paper?.id]);

  useEffect(() => {
    if (tabId === null) return;
    rpc.registerTab({ kind: 'reader', url: SRC, paperId: PAPER_ID, version: VERSION, title: paper?.title, medium: 'pdf' }).catch(() => {});
  }, [tabId, paper?.title]);

  useEffect(() => {
    if (!annotator || pending.current > 0) return;
    annotator.setAnnotations(annotations);
    if (paper) rpc.reportAnchors(paper.id, annotator.orphanIds).catch(() => {});
  }, [annotator, annotations, paper?.id]);

  // full text for AI, once the paper is saved
  const pushed = useRef(false);
  const pushText = useCallback(async (paperId: string) => {
    if (!doc || pushed.current) return;
    pushed.current = true;
    const text = await readableText(doc);
    await rpc.putFullText({ paperId, medium: 'pdf', version: VERSION ?? null, text, savedAt: new Date().toISOString() });
  }, [doc]);
  useEffect(() => {
    if (entry && paper && doc) void pushText(paper.id);
  }, [entry, paper, doc, pushText]);

  const save = useCallback(async (): Promise<string | null> => {
    if (!PAPER_ID) return null;
    try {
      const r = await rpc.savePaper({ url: parsed ? SRC : undefined, paperId: PAPER_ID });
      if (r.created) showToast('Saved to your library');
      await refresh();
      return r.paperId;
    } catch (e) {
      showToast(`Couldn't save: ${(e as Error).message}`);
      return null;
    }
  }, [refresh]);

  // ---- reading progress ----
  const lastProgress = useRef(0);
  useEffect(() => {
    const c = containerRef.current;
    if (!c || !annotator || !entry || !paper) return;
    lastProgress.current = entry.progress;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const refPage = viewer?.getPageView(annotator.referencesPage())?.div as HTMLElement | undefined;
        const end = refPage ? refPage.offsetTop + refPage.offsetHeight * 0.3 : c.scrollHeight;
        const p = Math.min(1, (c.scrollTop + c.clientHeight) / Math.max(end, 1));
        if (p > lastProgress.current + 0.05 || (p >= 0.9 && lastProgress.current < 0.9)) {
          lastProgress.current = p;
          rpc.reportProgress(paper.id, p).catch(() => {});
        }
      }, 1500);
    };
    c.addEventListener('scroll', onScroll, { passive: true });
    return () => c.removeEventListener('scroll', onScroll);
  }, [annotator, entry?.paperId, paper?.id, viewer]);

  // ---- selection ----
  const [sel, setSel] = useState<{ range: Range; rect: Rect } | null>(null);
  const [popover, setPopover] = useState<{ id: string; rect: Rect; edit?: boolean } | null>(null);
  const [aiPop, setAiPop] = useState<{ rect: Rect; title: string } | null>(null);
  const t = useThread();
  const [snip, setSnip] = useState(false);

  useEffect(() => {
    const c = containerRef.current;
    if (!c || !annotator) return;
    const check = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount || s.toString().trim().length < 2) return setSel(null);
      const range = s.getRangeAt(0);
      if (!c.contains(range.commonAncestorContainer)) return setSel(null);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      setSel({ range: range.cloneRange(), rect: toRect(rects[0] ?? range.getBoundingClientRect()) });
    };
    const onUp = () => setTimeout(check, 10);
    const onSelChange = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setSel(null);
    };
    const onScroll = () => setSel(null);
    c.addEventListener('mouseup', onUp);
    document.addEventListener('keyup', onUp);
    document.addEventListener('selectionchange', onSelChange);
    c.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      c.removeEventListener('mouseup', onUp);
      document.removeEventListener('keyup', onUp);
      document.removeEventListener('selectionchange', onSelChange);
      c.removeEventListener('scroll', onScroll);
    };
  }, [annotator]);

  const createHighlight = useCallback(
    async (label: HighlightLabel, withNote = false) => {
      if (!annotator || !sel || !PAPER_ID) return;
      const d = annotator.describe(sel.range);
      if (!d) return;
      const body: Annotation['body'] = [{ type: 'TextualBody', purpose: 'tagging', value: label }];
      const target: Annotation['target'] = { source: paper?.id ?? PAPER_ID, selector: d.selectors, state: { medium: 'pdf', version: VERSION, page: d.page } };
      const tempId = `tmp-${uuid()}`;
      const rect = sel.rect;
      annotator.addAt(tempId, d.start, d.end, { id: tempId, body, target } as Annotation);
      window.getSelection()?.removeAllRanges();
      setSel(null);
      pending.current++;
      try {
        const real = await rpc.createAnnotation({ paperId: target.source, motivation: 'highlighting', body, target }, { url: parsed ? SRC : undefined, paperId: PAPER_ID });
        annotator.rename(tempId, real.id);
        if (!entry) showToast('Saved to your library');
        if (withNote) setPopover({ id: real.id, rect, edit: true });
      } catch (e) {
        annotator.removeOne(tempId);
        showToast(`Couldn't save the highlight: ${(e as Error).message}`);
      } finally {
        pending.current--;
        await refresh();
      }
    },
    [annotator, sel, paper?.id, entry, refresh],
  );

  useEffect(() => {
    if (!sel) return;
    const h = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
      const l = HIGHLIGHT_LABELS.find((x) => x.key === e.key);
      if (l) {
        e.preventDefault();
        void createHighlight(l.id);
      }
    };
    document.addEventListener('keydown', h, true);
    return () => document.removeEventListener('keydown', h, true);
  }, [sel, createHighlight]);

  // click on a highlight
  useEffect(() => {
    const c = containerRef.current;
    if (!c || !annotator) return;
    const h = (e: MouseEvent) => {
      const s = window.getSelection();
      if (s && !s.isCollapsed) return;
      const ids = highlightIdsAt(e.target as Element);
      if (!ids.length) return;
      const el = (e.target as Element).closest('mark.mg-hl') ?? (e.target as Element);
      setPopover({ id: ids[0], rect: toRect(el.getBoundingClientRect()) });
      annotator.focus(ids[0]);
    };
    c.addEventListener('click', h);
    return () => c.removeEventListener('click', h);
  }, [annotator]);

  useEffect(() => {
    if (!popover) annotator?.focus(null);
  }, [popover, annotator]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPopover(null);
        setAiPop(null);
        setSnip(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!popover) return;
    const c = containerRef.current;
    const start = c?.scrollTop ?? 0;
    const close = () => {
      if (Math.abs((c?.scrollTop ?? 0) - start) > 80) setPopover(null);
    };
    c?.addEventListener('scroll', close, { passive: true });
    return () => c?.removeEventListener('scroll', close);
  }, [popover]);

  // side panel commands
  useEffect(() => {
    if (tabId === null) return;
    onTabCommand(
      () => tabId,
      (cmd) => {
        if (cmd.type === 'scroll-to-annotation') return annotator?.scrollTo(cmd.id) ?? false;
        if (cmd.type === 'refresh') void refresh();
        return undefined;
      },
    );
  }, [tabId, annotator, refresh]);

  // ---- AI ----
  const runAi = useCallback(
    async (kind: 'explain' | 'evidence', quote: string, rect: Rect, annotationId?: string) => {
      setAiPop({ rect, title: kind === 'explain' ? 'Explain' : "Where's the evidence?" });
      t.setThread(null);
      const id = paper && entry ? paper.id : await save();
      if (!id) return setAiPop(null);
      pushed.current = false;
      await pushText(id);
      t.start({ kind, paperId: id, quote, annotationId });
    },
    [paper, entry, save, pushText, t],
  );

  // ---- figure snipping ----
  const [snipBox, setSnipBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const finishSnip = async (box: { x0: number; y0: number; x1: number; y1: number }) => {
    if (!viewer || !doc) return;
    const left = Math.min(box.x0, box.x1);
    const top = Math.min(box.y0, box.y1);
    const w = Math.abs(box.x1 - box.x0);
    const h = Math.abs(box.y1 - box.y0);
    if (w < 12 || h < 12) return;
    for (let i = 0; i < doc.numPages; i++) {
      const pv = viewer.getPageView(i);
      const canvas: HTMLCanvasElement | undefined = pv?.canvas;
      if (!canvas) continue;
      const r = canvas.getBoundingClientRect();
      if (left < r.left || top < r.top || left > r.right || top > r.bottom) continue;
      const sx = canvas.width / r.width;
      const sy = canvas.height / r.height;
      const out = document.createElement('canvas');
      out.width = Math.round(Math.min(w, r.right - left) * sx);
      out.height = Math.round(Math.min(h, r.bottom - top) * sy);
      out.getContext('2d')!.drawImage(canvas, (left - r.left) * sx, (top - r.top) * sy, out.width, out.height, 0, 0, out.width, out.height);
      const dataUrl = out.toDataURL('image/png');
      const id = paper && entry ? paper.id : await save();
      if (!id) return;
      const att = await repo.putAttachment({ paperId: id, kind: 'figure', mime: 'image/png', dataUrl, caption: `Snipped from page ${i + 1}` });
      await repo.updateEntry(id, { factoidFigure: { kind: 'attachment', id: att.id } });
      showToast('Figure saved for your factoid');
      return;
    }
  };

  const zoom = (factor: number) => {
    if (!viewer) return;
    viewer.currentScale = Math.max(0.4, Math.min(4, viewer.currentScale * factor));
  };

  const popAnnotation = popover ? annotations.find((a) => a.id === popover.id) : null;
  const ai = settings.ai;

  return (
    <div className="h-screen bg-stone-100 dark:bg-stone-900">
      <header className="fixed inset-x-0 top-0 z-30 flex h-12 items-center gap-2 border-b border-stone-200 bg-white px-3 dark:border-stone-800 dark:bg-stone-950">
        <Logo />
        <div className="min-w-0 flex-1">
          <div className="truncate font-serif text-[15px] font-semibold text-stone-900 dark:text-stone-50">{paper?.title ?? (doc ? document.title.replace(/ · Archive$/, '') : 'Loading…')}</div>
        </div>
        {doc && (
          <div className="flex items-center gap-1 text-sm text-stone-600 dark:text-stone-300">
            <span className="tabular-nums">
              {page} / {doc.numPages}
            </span>
            <button className="mg-btn-ghost px-1.5" onClick={() => zoom(1 / 1.15)} title="Zoom out">
              <Icon name="zoomOut" size={16} />
            </button>
            <span className="w-11 text-center tabular-nums">{Math.round(scale * 100)}%</span>
            <button className="mg-btn-ghost px-1.5" onClick={() => zoom(1.15)} title="Zoom in">
              <Icon name="zoomIn" size={16} />
            </button>
            <button className="mg-btn-ghost px-1.5 text-xs" onClick={() => viewer && (viewer.currentScaleValue = 'page-width')} title="Fit width">
              Fit
            </button>
          </div>
        )}
        <span className="mx-1 h-6 w-px bg-stone-200 dark:bg-stone-700" />
        <button className={`mg-btn-ghost px-2 ${snip ? 'bg-accent-50 text-accent-800 dark:bg-accent-900/40 dark:text-accent-100' : ''}`} onClick={() => setSnip((s) => !s)} title="Snip a figure for your factoid (drag a box)">
          <Icon name="scissors" size={16} /> <span className="text-xs">Snip</span>
        </button>
        {PAPER_ID &&
          (entry && paper ? (
            <>
              <StatusSelect size="sm" value={entry.status} onChange={(status) => repo.updateEntry(paper.id, { status })} />
              <WillCiteButton compact value={entry.willCite} onChange={(willCite) => repo.updateEntry(paper.id, { willCite })} />
            </>
          ) : (
            <button className="mg-btn-primary py-1" onClick={save}>
              <Icon name="bookmark" size={14} /> Save
            </button>
          ))}
        <button className="mg-btn-ghost px-2" title="Notes and highlights (side panel)" onClick={() => tabId !== null && chrome.sidePanel.open({ tabId })}>
          <Icon name="panel" size={16} />
          {annotations.filter((a) => a.target.selector).length > 0 && <span className="text-xs">{annotations.filter((a) => a.target.selector).length}</span>}
        </button>
        <button className="mg-btn-ghost px-2" title="Open the original PDF" onClick={() => rpc.openOriginal(SRC)}>
          <Icon name="external" size={16} />
        </button>
      </header>

      <div id="viewerContainer" ref={containerRef} className={snip ? 'cursor-crosshair' : ''}>
        <div id="viewer" ref={viewerRef} className="pdfViewer" />
        {snip && (
          <div
            className="fixed inset-0 top-12 z-20"
            onMouseDown={(e) => setSnipBox({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY })}
            onMouseMove={(e) => snipBox && setSnipBox({ ...snipBox, x1: e.clientX, y1: e.clientY })}
            onMouseUp={async () => {
              if (snipBox) await finishSnip(snipBox);
              setSnipBox(null);
              setSnip(false);
            }}
          >
            {snipBox && (
              <div
                className="mg-snip"
                style={{
                  position: 'fixed',
                  left: Math.min(snipBox.x0, snipBox.x1),
                  top: Math.min(snipBox.y0, snipBox.y1),
                  width: Math.abs(snipBox.x1 - snipBox.x0),
                  height: Math.abs(snipBox.y1 - snipBox.y0),
                }}
              />
            )}
          </div>
        )}
      </div>

      {!doc && !error && (
        <div className="fixed inset-0 top-12 flex flex-col items-center justify-center gap-3 text-stone-500">
          <Spinner size={22} />
          <span className="text-sm">{progress > 0 ? `Downloading ${Math.round(progress * 100)}%` : 'Opening PDF…'}</span>
        </div>
      )}
      {error && (
        <div className="fixed inset-0 top-12 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <Icon name="alert" size={26} className="text-rose-600" />
          <p className="max-w-md text-sm text-stone-700 dark:text-stone-200">{error}</p>
          {SRC && (
            <button className="mg-btn" onClick={() => rpc.openOriginal(SRC)}>
              Open the original PDF
            </button>
          )}
        </div>
      )}

      {sel && !popover && !snip && (
        <SelectionToolbar
          rect={sel.rect}
          ai={ai}
          onLabel={(l) => createHighlight(l)}
          onNote={() => createHighlight('plain', true)}
          onExplain={() => {
            const q = sel.range.toString().replace(/\s+/g, ' ').trim();
            const r = sel.rect;
            setSel(null);
            void runAi('explain', q, r);
          }}
          onEvidence={() => {
            const q = sel.range.toString().replace(/\s+/g, ' ').trim();
            const r = sel.rect;
            setSel(null);
            void runAi('evidence', q, r);
          }}
        />
      )}
      {popover && popAnnotation && (
        <HighlightPopover
          key={popover.id}
          rect={popover.rect}
          annotation={popAnnotation}
          ai={ai}
          startEditing={popover.edit}
          onLabel={(l) => repo.setAnnotationLabel(popover.id, l)}
          onNote={(n) => repo.setAnnotationNote(popover.id, n)}
          onDelete={() => {
            annotator?.removeOne(popover.id);
            void repo.deleteAnnotation(popover.id);
            setPopover(null);
          }}
          onExplain={() => {
            const q = (popAnnotation.target.selector?.find((s) => s.type === 'TextQuoteSelector') as { exact: string } | undefined)?.exact ?? '';
            const r = popover.rect;
            setPopover(null);
            void runAi('explain', q, r, popAnnotation.id);
          }}
          onClose={() => setPopover(null)}
        />
      )}
      {aiPop && (
        <AiPopover
          rect={aiPop.rect}
          t={t}
          title={aiPop.title}
          onClose={() => {
            t.stop();
            setAiPop(null);
          }}
          onOpenPanel={() => tabId !== null && chrome.sidePanel.open({ tabId })}
        />
      )}
      {toast && <div className="fixed bottom-5 right-5 z-40 rounded-lg bg-stone-900 px-3 py-2 text-sm text-white shadow-lg dark:bg-white dark:text-stone-900">{toast}</div>}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
