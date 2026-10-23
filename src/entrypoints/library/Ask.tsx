import { useRef, useState, type MouseEvent } from 'react';
import { EmptyState, Spinner, cx, timeAgo } from '@/components/common';
import { Icon } from '@/components/Icon';
import { Markdown } from '@/components/Markdown';
import { useLive } from '@/hooks/useLive';
import { readerUrl } from '@/lib/ids';
import type { AskSource } from '@/lib/ai/library';
import { go, type LibraryData } from './shared';

const KIND_LABEL: Record<AskSource['kind'], string> = { fulltext: 'Full text', abstract: 'Abstract', highlight: 'Your highlight', note: 'Your note' };

/** Make [3] and [2, 5] citation markers clickable (rendered as <sup class="mg-cite">). */
function withCiteMarkers(md: string): string {
  return md.replace(/\[(\d{1,2}(?:\s*[,;]\s*\d{1,2})*)\](?!\()/g, (_, nums) => `<sup class="mg-cite">[${nums}]</sup>`);
}

export function AskView({ data }: { data: LibraryData | undefined }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('all');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [question, setQuestion] = useState('');
  const [sources, setSources] = useState<AskSource[]>([]);
  const [cited, setCited] = useState<number[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const srcRefs = useRef(new Map<number, HTMLLIElement>());
  const { data: history, reload } = useLive(async () => (await import('@/lib/ai/library')).listAskHistory(), []);
  const papers = new Map((data?.rows ?? []).map((r) => [r.paper.id, r.paper] as const));
  const withText = (data?.rows ?? []).length;

  const ask = async (text: string) => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setAnswer('');
    setSources([]);
    setCited([]);
    setQuestion(text.trim());
    try {
      const { askLibrary } = await import('@/lib/ai/library');
      const res = await askLibrary(text.trim(), scope === 'all' ? {} : { projectId: scope }, {
        onText: (d) => setAnswer((a) => a + d),
        onSources: (s) => setSources(s),
      });
      setAnswer(res.answer);
      setSources(res.sources);
      setCited(res.citedNumbers);
      setQ('');
      reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onAnswerClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest('.mg-cite');
    if (!el) return;
    const n = Number(el.textContent?.match(/\d+/)?.[0]);
    const li = srcRefs.current.get(n);
    if (li) {
      li.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlash(n);
      setTimeout(() => setFlash(null), 1400);
    }
  };

  const shown = sources.filter((s) => !cited.length || cited.includes(s.n));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-4 py-4 md:px-6">
        <form
          className="mg-card flex flex-col gap-2 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
        >
          <textarea
            className="mg-input min-h-[64px] resize-y"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void ask(q);
              }
            }}
            placeholder="Ask across your saved papers, e.g. Which papers evaluate reward hacking, and on what benchmarks?"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select className="mg-input w-auto py-1 text-xs" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Search in">
              <option value="all">Whole library ({withText} papers)</option>
              {(data?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-stone-500">Uses full text for papers you've opened, abstracts for the rest, plus your highlights and notes.</span>
            <button className="mg-btn-primary ml-auto" type="submit" disabled={busy || !q.trim()}>
              {busy ? <Spinner /> : <Icon name="send" size={14} />} Ask
            </button>
          </div>
        </form>

        {err && <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-100">{err}</p>}

        {(answer || busy) && (
          <section className="mg-card flex flex-col gap-3 p-4">
            <div className="text-sm font-semibold text-stone-800 dark:text-stone-100">{question}</div>
            {answer ? (
              <div onClick={onAnswerClick} className="text-[14px] [&_.mg-cite]:cursor-pointer [&_.mg-cite]:font-semibold [&_.mg-cite]:text-accent-700 dark:[&_.mg-cite]:text-accent-300">
                <Markdown text={withCiteMarkers(answer)} />
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-stone-500">
                <Spinner /> Searching your library…
              </div>
            )}
          </section>
        )}

        {shown.length > 0 && (
          <section className="flex flex-col gap-2">
            <span className="mg-label">Sources</span>
            <ul className="flex flex-col gap-2">
              {shown.map((s) => {
                const p = papers.get(s.paperId);
                const pdf = p?.urls.pdf;
                return (
                  <li
                    key={s.n}
                    ref={(el) => {
                      if (el) srcRefs.current.set(s.n, el);
                    }}
                    className={cx('mg-card flex flex-col gap-1.5 p-3 transition', flash === s.n && 'ring-2 ring-accent-400')}
                  >
                    <div className="flex items-start gap-2">
                      <span className="font-mono text-xs font-semibold text-accent-700 dark:text-accent-300">[{s.n}]</span>
                      <div className="min-w-0 flex-1">
                        <button className="text-left text-sm font-medium hover:underline" onClick={() => go({ kind: 'ask' }, s.paperId)}>
                          {s.title}
                        </button>
                        <div className="text-xs text-stone-500">
                          <span className="font-mono">{s.citeKey}</span> · {KIND_LABEL[s.kind]}
                        </div>
                      </div>
                    </div>
                    {s.quote && <blockquote className="border-l-2 border-stone-300 pl-2 text-[13px] italic leading-relaxed text-stone-600 dark:border-stone-600 dark:text-stone-300">{s.quote}</blockquote>}
                    {pdf && s.kind !== 'abstract' && (
                      <a className="self-start text-xs text-accent-700 hover:underline dark:text-accent-300" href={`${readerUrl(pdf, s.paperId)}&${s.annotationId ? `annotation=${encodeURIComponent(s.annotationId)}` : `find=${encodeURIComponent((s.target?.quote.exact ?? s.quote).replace(/\s+/g, ' ').slice(0, 300))}`}`} target="_blank" rel="noreferrer">
                        Read in context
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        {!answer && !busy && !err && !(history ?? []).length && (
          <EmptyState icon="sparkle" title="Ask your whole library">
            Answers cite the exact passages they come from, so you can check them.
          </EmptyState>
        )}

        {!busy && (history ?? []).length > 0 && (
          <section className="flex flex-col gap-1">
            <span className="mg-label">Earlier questions</span>
            {(history ?? []).map((h, i) => (
              <button
                key={i}
                className="flex items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-stone-100 dark:hover:bg-stone-900"
                onClick={() => {
                  setQuestion(h.question);
                  setAnswer(h.answer);
                  setSources(h.sources);
                  setCited([]);
                  window.scrollTo({ top: 0 });
                }}
              >
                <span className="flex-1 text-sm text-stone-800 dark:text-stone-100">{h.question}</span>
                <span className="shrink-0 text-xs text-stone-400">{timeAgo(h.at)}</span>
              </button>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}

