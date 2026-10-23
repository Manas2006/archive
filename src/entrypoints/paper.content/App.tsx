import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { rpc, onTabCommand } from '@/lib/rpc';
import { dispatchRemoteChange, onChange } from '@/lib/changes';
import { parsePaperUrl, uuid } from '@/lib/ids';
import { HtmlAnnotator } from '@/lib/anchoring/annotator';
import { highlightIdsAt } from '@/lib/anchoring/highlighter';
import { rangeToReadableText } from '@/lib/anchoring/dom';
import { articleFullText, articleRoot, bibRefFor, extractPageMeta, findSymbol, readingEnd, type BibRef, type SymbolInfo } from '@/lib/page/arxivHtml';
import { useSettings } from '@/hooks/useSettings';
import { useThread } from '@/components/ThreadView';
import { AiPopover, HighlightPopover, SelectionToolbar, type Rect } from '@/components/annot/Floating';
import { CitationCard, SymbolCard } from './Cards';
import { Pill } from './Pill';
import type { PaperState } from '@/lib/bg/handlers';
import type { Annotation, HighlightLabel, PageKind } from '@/lib/types';
import { useTextSelection } from '@/platform/selection';
import { HIGHLIGHT_LABELS } from '@/lib/types';

interface Page {
  kind: PageKind;
  url: string;
  paperId: string;
  version?: number;
  pdfUrl?: string;
}

function detectPage(): Page | null {
  const p = parsePaperUrl(location.href);
  if (!p) return null;
  const pdfUrl = p.arxiv ? `https://arxiv.org/pdf/${p.arxiv.id}${p.arxiv.version ? `v${p.arxiv.version}` : ''}` : p.openreviewId ? `https://openreview.net/pdf?id=${p.openreviewId}` : undefined;
  return { kind: p.kind, url: location.href.split('#')[0], paperId: p.paperId, version: p.arxiv?.version, pdfUrl };
}

const toRect = (r: DOMRect): Rect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** Keep the background's change feed flowing into this page (reconnects if the service worker restarts). */
function useChangeRelay() {
  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    let stopped = false;
    let delay = 500;
    const connect = () => {
      if (stopped) return;
      try {
        port = chrome.runtime.connect({ name: 'mg-tab' });
      } catch {
        return; // extension reloaded; this content script is orphaned
      }
      port.onMessage.addListener((m) => {
        if (m?.type === 'change') dispatchRemoteChange(m.evt);
      });
      port.onDisconnect.addListener(() => {
        port = null;
        if (stopped || !chrome.runtime?.id) return;
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 15000);
      });
      delay = 500;
    };
    connect();
    return () => {
      stopped = true;
      port?.disconnect();
    };
  }, []);
}

export function App({ ctx }: { ctx: ContentScriptContext }) {
  useChangeRelay();
  const settings = useSettings();
  const ai = settings.ai;
  const [page, setPage] = useState<Page | null>(detectPage);
  const [state, setState] = useState<PaperState | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const isHtml = page?.kind === 'arxiv-html';

  // OpenReview is a single-page app: follow URL changes
  useEffect(() => {
    const h = () => setPage(detectPage());
    ctx.addEventListener(window, 'wxt:locationchange', h);
  }, [ctx]);

  const showToast = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ text, tone });
    setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 3500);
  }, []);

  // ---- paper state ----
  const pending = useRef(0);
  const refresh = useCallback(async () => {
    if (!page) return;
    if (pending.current > 0) return; // a create is in flight; it refreshes when done
    try {
      setState(await rpc.getPaperState(page.paperId));
    } catch (e) {
      console.warn('[archive]', e);
    }
  }, [page?.paperId]);

  useEffect(() => {
    if (!page) return;
    void refresh();
    const meta = extractPageMeta(page.kind);
    rpc.registerTab({ kind: page.kind, url: page.url, paperId: page.paperId, version: page.version, title: meta.title, medium: isHtml ? 'html' : undefined }).catch(() => {});
    const off = onChange((e) => {
      if (e.table === '*' || e.table === 'projects' || !e.paperIds.length || e.paperIds.some((id) => id === page.paperId || id === state?.paper?.id)) void refresh();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page?.paperId, refresh]);

  const paperId = state?.paper?.id ?? page?.paperId ?? null;
  const saved = !!state?.entry;

  const save = useCallback(async () => {
    if (!page) return null;
    try {
      const res = await rpc.savePaper({ url: page.url, pageMeta: extractPageMeta(page.kind) });
      if (res.created) showToast('Saved to your library');
      await refresh();
      return res.paperId;
    } catch (e) {
      showToast(`Couldn't save: ${(e as Error).message}`, 'err');
      return null;
    }
  }, [page, refresh, showToast]);

  // full text for AI (stored locally once the paper is saved)
  const pushedText = useRef<string | null>(null);
  useEffect(() => {
    if (!isHtml || !saved || !paperId || pushedText.current === paperId) return;
    pushedText.current = paperId;
    const text = articleFullText();
    if (text.length > 500) rpc.putFullText({ paperId, medium: 'html', version: page?.version ?? null, text, savedAt: new Date().toISOString() }).catch(() => {});
  }, [isHtml, saved, paperId, page?.version]);

  // ---- annotator (arXiv HTML) ----
  const annotator = useMemo(() => (isHtml ? new HtmlAnnotator(articleRoot(), 'html', page?.version) : null), [isHtml, page?.paperId]);
  useEffect(() => () => annotator?.destroy(), [annotator]);
  useEffect(() => {
    if (!annotator || !state || pending.current > 0) return;
    const report = annotator.sync(state.annotations);
    rpc.reportAnchors(state.paper?.id ?? page!.paperId, report.orphans).catch(() => {});
  }, [annotator, state]);

  // ---- reading progress ----
  const lastProgress = useRef(0);
  useEffect(() => {
    if (!saved || !paperId || page?.kind === 'openreview-forum') return;
    lastProgress.current = state?.entry?.progress ?? 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!isHtml) return;
        const p = Math.min(1, (window.scrollY + window.innerHeight) / readingEnd());
        if (p > lastProgress.current + 0.05 || (p >= 0.9 && lastProgress.current < 0.9)) {
          lastProgress.current = p;
          rpc.reportProgress(paperId, p).catch(() => {});
        }
      }, 1500);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [saved, paperId, isHtml]);

  // ---- selection (mouse, keyboard, touch and Apple Pencil) ----
  const [sel, setSel] = useTextSelection({
    enabled: !!annotator,
    accept: (range) => {
      const root = annotator?.root;
      if (!root || !root.contains(range.commonAncestorContainer)) return false;
      return !(range.commonAncestorContainer as Element).closest?.('[data-mg-ui]');
    },
    onScroll: 'follow',
  });
  const [popover, setPopover] = useState<{ id: string; rect: Rect; edit?: boolean } | null>(null);
  const [aiPop, setAiPop] = useState<{ rect: Rect; title: string } | null>(null);
  const t = useThread();

  const createHighlight = useCallback(
    async (label: HighlightLabel, withNote = false) => {
      if (!annotator || !sel || !page) return;
      const selectors = annotator.describe(sel.range);
      if (!selectors) return;
      const body: Annotation['body'] = [{ type: 'TextualBody', purpose: 'tagging', value: label }];
      const target: Annotation['target'] = { source: paperId ?? page.paperId, selector: selectors, state: { medium: 'html', version: page.version } };
      const tempId = `tmp-${uuid()}`;
      const temp = { id: tempId, body, target, paperId: target.source } as Annotation;
      const rect = sel.rect;
      annotator.add(temp, sel.range.cloneRange());
      window.getSelection()?.removeAllRanges();
      setSel(null);
      pending.current++;
      try {
        const real = await rpc.createAnnotation({ paperId: target.source, motivation: 'highlighting', body, target }, { url: page.url, pageMeta: extractPageMeta(page.kind) });
        annotator.rename(tempId, real.id);
        if (!saved) showToast('Saved to your library');
        if (withNote) setPopover({ id: real.id, rect, edit: true });
      } catch (e) {
        annotator.removeOne(tempId);
        showToast(`Couldn't save the highlight: ${(e as Error).message}`, 'err');
      } finally {
        pending.current--;
        await refresh();
      }
    },
    [annotator, sel, page, paperId, saved, refresh, showToast],
  );

  // keys 1-6 highlight while a selection toolbar is showing
  useEffect(() => {
    if (!sel) return;
    const h = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.metaKey || e.ctrlKey || e.altKey) return;
      const l = HIGHLIGHT_LABELS.find((x) => x.key === e.key);
      if (l) {
        e.preventDefault();
        e.stopPropagation();
        void createHighlight(l.id);
      }
    };
    document.addEventListener('keydown', h, true);
    return () => document.removeEventListener('keydown', h, true);
  }, [sel, createHighlight]);

  // clicking an existing highlight
  useEffect(() => {
    if (!annotator) return;
    const h = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target.closest?.('[data-mg-ui]')) return;
      const s = window.getSelection();
      if (s && !s.isCollapsed) return;
      const ids = highlightIdsAt(target);
      if (!ids.length) return;
      const el = target.closest('mark.mg-hl, math.mg-hl-math') ?? target;
      setPopover({ id: ids[0], rect: toRect(el.getBoundingClientRect()) });
      annotator.focus(ids[0]);
    };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [annotator]);

  useEffect(() => {
    if (!popover) annotator?.focus(null);
  }, [popover, annotator]);

  // close popovers on Escape / outside click
  useEffect(() => {
    if (!popover && !aiPop) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPopover(null);
        setAiPop(null);
      }
    };
    const onDown = (e: MouseEvent) => {
      const path = e.composedPath() as Element[];
      if (path.some((el) => el?.hasAttribute?.('data-mg-ui'))) return;
      if (highlightIdsAt(e.target as Element).length) return;
      setPopover(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [popover, aiPop]);

  // side panel commands
  useEffect(() => {
    onTabCommand(
      () => null,
      (cmd) => {
        if (cmd.type === 'scroll-to-annotation') return annotator?.scrollTo(cmd.id) ?? false;
        if (cmd.type === 'refresh') void refresh();
        return undefined;
      },
    );
  }, [annotator, refresh]);

  // ---- AI ----
  const ensureReady = useCallback(async (): Promise<string | null> => {
    let id = paperId;
    if (!saved) id = await save();
    if (!id) return null;
    if (isHtml) {
      const text = articleFullText();
      await rpc.putFullText({ paperId: id, medium: 'html', version: page?.version ?? null, text, savedAt: new Date().toISOString() }).catch(() => {});
      pushedText.current = id;
    }
    return id;
  }, [paperId, saved, save, isHtml, page?.version]);

  const runAi = useCallback(
    async (kind: 'explain' | 'evidence', quote: string, rect: Rect, annotationId?: string) => {
      setAiPop({ rect, title: kind === 'explain' ? 'Explain' : "Where's the evidence?" });
      t.setThread(null);
      const id = await ensureReady();
      if (!id) {
        setAiPop(null);
        return;
      }
      t.start({ kind, paperId: id, quote, annotationId });
    },
    [ensureReady, t],
  );

  const openPanel = useCallback(async () => {
    try {
      await rpc.openSidePanel();
    } catch {
      showToast('Press Alt+Shift+M to open the side panel', 'ok');
    }
  }, [showToast]);

  // ---- symbols and citations (arXiv HTML) ----
  const [symbol, setSymbol] = useState<{ info: SymbolInfo; rect: Rect } | null>(null);
  const [cite, setCite] = useState<{ ref: BibRef; rect: Rect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>();
  const hideTimer = useRef<ReturnType<typeof setTimeout>>();
  const keepCard = () => clearTimeout(hideTimer.current);
  const hideCards = () => {
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      setSymbol(null);
      setCite(null);
    }, 250);
  };

  useEffect(() => {
    if (!annotator) return;
    const root = annotator.root;
    const over = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target?.closest || target.closest('[data-mg-ui]')) return;
      const link = target.closest('a[href*="#bib."]') as HTMLAnchorElement | null;
      const math = target.closest('math');
      if (!link && !math) return;
      clearTimeout(hoverTimer.current);
      keepCard();
      hoverTimer.current = setTimeout(
        () => {
          if (link) {
            const ref = bibRefFor(link);
            if (ref) {
              setSymbol(null);
              setCite({ ref, rect: toRect(link.getBoundingClientRect()) });
            }
          } else if (math) {
            const info = findSymbol(target, root);
            if (info) {
              setCite(null);
              setSymbol({ info, rect: toRect((target.closest('mi, msub, msup, msubsup') ?? math).getBoundingClientRect()) });
            }
          }
        },
        link ? 300 : 450,
      );
    };
    const out = (e: MouseEvent) => {
      const target = e.target as Element;
      if (target?.closest?.('a[href*="#bib."], math')) {
        clearTimeout(hoverTimer.current);
        hideCards();
      }
    };
    root.addEventListener('mouseover', over as EventListener);
    root.addEventListener('mouseout', out as EventListener);
    return () => {
      root.removeEventListener('mouseover', over as EventListener);
      root.removeEventListener('mouseout', out as EventListener);
    };
  }, [annotator]);

  if (!page) return null;
  const popAnnotation = popover ? state?.annotations.find((a) => a.id === popover.id) : null;

  return (
    <div className="font-sans text-stone-900 dark:text-stone-100" style={{ fontSize: 14, lineHeight: 1.4 }}>
      {settings.loaded && (settings.showFloatingButton || isHtml) && (
        <Pill
          page={page}
          state={state}
          onSave={save}
          onOpenPanel={openPanel}
          onOpenReader={page.pdfUrl && page.kind !== 'arxiv-html' ? () => rpc.openReader(page.pdfUrl!, paperId) : undefined}
          highlightCount={state?.annotations.filter((a) => a.target.selector).length ?? 0}
        />
      )}
      {sel && !popover && (
        <SelectionToolbar
          rect={sel.rect}
          ai={ai}
          touch={sel.pointer !== 'mouse'}
          onLabel={(l) => createHighlight(l)}
          onNote={() => createHighlight('plain', true)}
          onExplain={() => {
            const q = rangeToReadableText(sel.range);
            const r = sel.rect;
            setSel(null);
            void runAi('explain', q, r);
          }}
          onEvidence={() => {
            const q = rangeToReadableText(sel.range);
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
          onLabel={(l) => rpc.setAnnotationLabel(popover.id, l)}
          onNote={(n) => rpc.setAnnotationNote(popover.id, n)}
          onDelete={() => {
            annotator?.removeOne(popover.id);
            void rpc.deleteAnnotation(popover.id);
            setPopover(null);
          }}
          onExplain={() => {
            const els = annotator?.elementsFor(popover.id) ?? [];
            const quote = popAnnotation.target.selector?.find((s) => s.type === 'TextQuoteSelector') as { exact: string } | undefined;
            const r = popover.rect;
            setPopover(null);
            void runAi('explain', quote?.exact ?? els.map((e) => e.textContent).join(' '), r, popAnnotation.id);
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
          onOpenPanel={openPanel}
        />
      )}
      {symbol && (
        <SymbolCard
          info={symbol.info}
          rect={symbol.rect}
          ai={ai}
          onEnter={keepCard}
          onLeave={hideCards}
          onJump={() => {
            symbol.info.defElement.scrollIntoView({ block: 'center', behavior: 'smooth' });
            symbol.info.defElement.classList.add('mg-hl-math', 'mg-pulse');
            setTimeout(() => symbol.info.defElement.classList.remove('mg-hl-math', 'mg-pulse'), 2000);
            setSymbol(null);
          }}
          onAsk={async () => {
            const r = symbol.rect;
            const info = symbol.info;
            setSymbol(null);
            setAiPop({ rect: r, title: 'Symbol' });
            t.setThread(null);
            const id = await ensureReady();
            if (id) t.start({ kind: 'symbol', paperId: id, symbol: info.tex, context: info.context });
          }}
        />
      )}
      {cite && <CitationCard bib={cite.ref} rect={cite.rect} onEnter={keepCard} onLeave={hideCards} />}
      {toast && (
        <div data-mg-ui className={`fixed bottom-20 right-5 z-[2147483600] max-w-sm rounded-lg px-3 py-2 text-sm shadow-lg ${toast.tone === 'err' ? 'bg-rose-700 text-white' : 'bg-stone-900 text-white dark:bg-white dark:text-stone-900'}`}>
          {toast.text}
        </div>
      )}
    </div>
  );
}
