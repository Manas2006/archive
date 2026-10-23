import { useEffect, useState } from 'react';
import * as repo from '@/lib/repo';
import { rpc } from '@/lib/rpc';
import { useLive } from '@/hooks/useLive';
import { useSettings } from '@/hooks/useSettings';
import { arxivBibtex, genericBibtex, rekey } from '@/lib/bibtex';
import { download, notesMarkdown, noteOf } from '@/lib/exports';
import { extractFields, summarizeReviews } from '@/lib/ai/features';
import { quoteOf } from '@/lib/anchoring/text';
import { nowIso } from '@/lib/ids';
import type { Annotation, ExtractedFields, Paper, Thread } from '@/lib/types';
import { AutoSaveTextarea, CopyButton, EmptyState, Spinner, StatusSelect, Tabs, VenueBadge, WillCiteButton, cx, timeAgo } from './common';
import { HighlightList } from './HighlightList';
import { EntryProjects } from './ProjectPicker';
import { FactoidDialog } from './FactoidDialog';
import { Markdown } from './Markdown';
import { ThreadView, useThread } from './ThreadView';
import { Icon } from './Icon';
import { AuthorList } from './AuthorList';
import { citeText } from '@/lib/cite';
import { driveFileUrl, downloadAnnotatedPdf, savePdfToDrive } from '@/lib/pdfActions';
import type { LibraryEntry } from '@/lib/types';

type Tab = 'highlights' | 'notes' | 'ask' | 'info' | 'bibtex';

async function loadDetail(paperId: string) {
  const paper = await repo.getPaper(paperId);
  if (!paper) return null;
  const [entry, annotations, projects, topics, threads, attachments, fulltext] = await Promise.all([
    repo.getEntry(paper.id),
    repo.listAnnotations(paper.id),
    repo.listProjects(),
    repo.listTopics(),
    repo.listThreads(paper.id),
    repo.listAttachments(paper.id),
    repo.getFullText(paper.id),
  ]);
  return { paper, entry: entry ?? null, annotations, projects, topics, threads, attachments, hasFullText: !!fulltext };
}

export function PaperDetail({
  paperId,
  orphanIds,
  onJump,
  onOpen,
  compact,
}: {
  paperId: string;
  orphanIds?: string[];
  onJump?: (annotationId: string) => void;
  onOpen?: (p: Paper) => void;
  compact?: boolean;
}) {
  const settings = useSettings();
  const ai = settings.ai;
  const { data, loading } = useLive(() => loadDetail(paperId), [paperId]);
  const [tab, setTab] = useState<Tab>('highlights');
  const [factoidOpen, setFactoidOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openThread, setOpenThread] = useState<Thread | null>(null);
  const t = useThread();

  useEffect(() => {
    if (!ai && tab === 'ask') setTab('highlights');
  }, [ai, tab]);

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center p-8 text-stone-400">
        <Spinner size={18} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="p-4">
        <EmptyState icon="bookmark" title="Not saved yet">
          <button
            className="mg-btn-primary mt-2"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              setError(null);
              try {
                await rpc.savePaper({ paperId });
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? <Spinner /> : <Icon name="bookmark" size={14} />} Save to library
          </button>
          {error && <p className="mt-2 text-rose-700">{error}</p>}
        </EmptyState>
      </div>
    );
  }

  const { paper, entry, annotations, projects, topics, threads, attachments } = data;
  const topic = entry?.topicId ? topics.find((x) => x.id === entry.topicId) : null;
  const highlightCount = annotations.filter((a) => a.target.selector).length;

  const explain = (a: Annotation) => {
    setTab('ask');
    setOpenThread(null);
    t.setThread(null);
    t.start({ kind: 'explain', paperId: paper.id, quote: quoteOf(a.target.selector)?.exact ?? '', annotationId: a.id });
  };

  return (
    <div className="flex min-h-0 flex-col">
      {/* header */}
      <div className="flex flex-col gap-2 px-4 pb-3 pt-3">
        <h1 className={cx('font-serif font-semibold leading-snug text-stone-900 dark:text-stone-50', compact ? 'text-base' : 'text-lg')}>
          {onOpen ? (
            <button className="text-left hover:underline" onClick={() => onOpen(paper)}>
              {paper.title}
            </button>
          ) : (
            paper.title
          )}
        </h1>
        <AuthorList paper={paper} />
        <div className="flex flex-wrap items-center gap-1.5">
          <VenueBadge paper={paper} />
          {paper.review?.avgRating != null && (
            <span className="rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-800 dark:bg-violet-950 dark:text-violet-200" title="Average OpenReview rating">
              Avg rating {paper.review.avgRating}
            </span>
          )}
          {topic && <span className="mg-chip">{topic.name}</span>}
          <PaperLinks paper={paper} />
        </div>
        {entry ? (
          <>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <StatusSelect value={entry.status} onChange={(status) => repo.updateEntry(paper.id, { status })} />
              <WillCiteButton value={entry.willCite} onChange={(willCite) => repo.updateEntry(paper.id, { willCite })} />
              {entry.progress > 0.02 && <span className="text-xs text-stone-400">{Math.round(entry.progress * 100)}% read</span>}
            </div>
            <EntryProjects entry={entry} projects={projects} />
            {entry.priorityReasons.length > 0 && entry.status === 'inbox' && (
              <div className="text-xs text-stone-500 dark:text-stone-400">Why it's near the top: {entry.priorityReasons.join(' · ')}</div>
            )}
          </>
        ) : (
          <button className="mg-btn-primary mt-1 self-start" onClick={() => rpc.savePaper({ paperId: paper.id })}>
            <Icon name="bookmark" size={14} /> Save to library
          </button>
        )}
      </div>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'highlights', label: `Highlights${highlightCount ? ` ${highlightCount}` : ''}` },
          { id: 'notes', label: 'Notes' },
          { id: 'ask', label: <span className="inline-flex items-center gap-1"><Icon name="sparkle" size={13} />Ask</span>, hidden: !ai },
          { id: 'info', label: 'Info' },
          { id: 'bibtex', label: 'BibTeX' },
        ]}
      />

      <div className="min-h-0 flex-1 px-4 py-3">
        {tab === 'highlights' && <HighlightList annotations={annotations} orphanIds={orphanIds} onJump={onJump} onExplain={ai ? explain : undefined} />}
        {tab === 'notes' && <NotesTab paper={paper} annotations={annotations} />}
        {tab === 'ask' && ai && (
          <AskTab paper={paper} threads={threads} t={t} openThread={openThread} setOpenThread={setOpenThread} hasFullText={data.hasFullText} />
        )}
        {tab === 'info' && <InfoTab paper={paper} ai={ai} />}
        {tab === 'bibtex' && <BibtexTab paper={paper} />}
      </div>

      <div className="sticky bottom-0 mt-auto flex flex-wrap gap-2 border-t border-stone-200 bg-white/95 px-4 py-2.5 backdrop-blur dark:border-stone-700 dark:bg-stone-900/95">
        <button className="mg-btn" onClick={() => setFactoidOpen(true)}>
          <Icon name="quote" size={14} /> Factoid
        </button>
        <button className="mg-btn" onClick={() => download(`${paper.citeKey}.md`, notesMarkdown(paper, annotations, entry), 'text/markdown')}>
          <Icon name="download" size={14} /> Notes .md
        </button>
        <CopyButton text={paper.bibtex} label="BibTeX" />
        <CopyButton text={citeText([paper.citeKey], settings.citeCommand)} label="Cite" />
        {paper.urls.pdf && <PdfButtons paper={paper} entry={entry} />}
      </div>

      <FactoidDialog open={factoidOpen} onClose={() => setFactoidOpen(false)} paper={paper} entry={entry} annotations={annotations} attachments={attachments} ai={ai} />
    </div>
  );
}

/** Download the PDF with highlights embedded, and save it to Google Drive when connected. */
function PdfButtons({ paper, entry }: { paper: Paper; entry: LibraryEntry | null }) {
  const { data: account } = useLive(async () => (await import('@/lib/drive/auth')).getDriveAccount(), [], (e) => e.table === '*');
  const [busy, setBusy] = useState<'download' | 'drive' | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (kind: 'download' | 'drive') => {
    setBusy(kind);
    setMsg(null);
    try {
      const res = kind === 'download' ? await downloadAnnotatedPdf(paper) : await savePdfToDrive(paper);
      if (res.locked) setMsg("This PDF is locked against changes, so it was saved without your highlights.");
      else if (res.missed) setMsg(`${res.missed} highlight${res.missed === 1 ? '' : 's'} couldn't be placed in this PDF version.`);
      else if (kind === 'drive') setMsg('Saved to Google Drive.');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <button className="mg-btn" disabled={!!busy} onClick={() => run('download')} title="Download the PDF with your highlights and notes in it">
        {busy === 'download' ? <Spinner /> : <Icon name="download" size={14} />} PDF
      </button>
      {account && entry && (
        <button className="mg-btn" disabled={!!busy} onClick={() => run('drive')} title={entry.drivePdf ? `Saved ${timeAgo(entry.drivePdf.savedAt)}. Click to update it.` : 'Save the PDF to Google Drive'}>
          {busy === 'drive' ? <Spinner /> : <Icon name="folder" size={14} />} {entry.drivePdf ? 'Update in Drive' : 'Save to Drive'}
        </button>
      )}
      {entry?.drivePdf && (
        <a className="self-center text-xs text-accent-700 hover:underline dark:text-accent-300" href={driveFileUrl(entry.drivePdf.fileId)} target="_blank" rel="noreferrer">
          Open in Drive
        </a>
      )}
      {msg && <span className="w-full text-xs text-stone-500">{msg}</span>}
    </>
  );
}

function PaperLinks({ paper }: { paper: Paper }) {
  const links: [string, string | undefined][] = [
    ['arXiv', paper.urls.abs],
    ['HTML', paper.urls.html],
    ['PDF', paper.urls.pdf],
    ['OpenReview', paper.urls.openreview],
    ['Code', paper.codeLinks[0]],
  ];
  return (
    <span className="flex flex-wrap items-center gap-x-2 text-xs">
      {links
        .filter(([, u]) => u)
        .map(([label, u]) => (
          <a key={label} href={u} target="_blank" rel="noreferrer" className="text-accent-700 hover:underline dark:text-accent-300">
            {label}
          </a>
        ))}
    </span>
  );
}

function NotesTab({ paper, annotations }: { paper: Paper; annotations: Annotation[] }) {
  const note = annotations.find((a) => !a.target.selector && a.motivation === 'commenting');
  const [preview, setPreview] = useState(false);
  const value = note ? noteOf(note) : '';
  const save = async (v: string) => {
    const body = [{ type: 'TextualBody' as const, purpose: 'commenting' as const, value: v, format: 'text/markdown' as const }];
    if (note) await repo.updateAnnotation(note.id, { body });
    else if (v.trim()) await repo.createAnnotation({ paperId: paper.id, motivation: 'commenting', body, target: { source: paper.id } });
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="mg-label">Paper notes</span>
        <button className="mg-btn-ghost px-1.5 py-0.5 text-xs" onClick={() => setPreview((p) => !p)}>
          <Icon name={preview ? 'note' : 'eye'} size={13} /> {preview ? 'Edit' : 'Preview'}
        </button>
      </div>
      {preview ? (
        <div className="min-h-[120px] rounded-md border border-stone-200 p-3 text-sm dark:border-stone-700">
          {value ? <Markdown text={value} /> : <span className="text-stone-400">Nothing yet.</span>}
        </div>
      ) : (
        <AutoSaveTextarea value={value} rows={12} onSave={save} placeholder="Notes on the paper as a whole. Markdown and $math$ work." />
      )}
    </div>
  );
}

function AskTab({
  paper,
  threads,
  t,
  openThread,
  setOpenThread,
  hasFullText,
}: {
  paper: Paper;
  threads: Thread[];
  t: ReturnType<typeof useThread>;
  openThread: Thread | null;
  setOpenThread: (t: Thread | null) => void;
  hasFullText: boolean;
}) {
  const [q, setQ] = useState('');
  const [compareId, setCompareId] = useState('');
  const { data: library } = useLive(async () => {
    const entries = await repo.listEntries();
    return (await repo.getPapers(entries.map((e) => e.paperId))).filter((p) => p.id !== paper.id).sort((a, b) => a.title.localeCompare(b.title));
  }, [paper.id]);

  const active = t.thread ?? openThread;
  if (active || t.busy) {
    return (
      <div className="flex flex-col gap-3">
        <button
          className="mg-btn-ghost self-start px-1.5 text-xs"
          onClick={() => {
            t.stop();
            t.setThread(null);
            setOpenThread(null);
          }}
        >
          <Icon name="chevronRight" size={13} className="rotate-180" /> All questions
        </button>
        <ThreadView t={t} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {!hasFullText && (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Only the abstract is available. Open the paper's HTML page or PDF once so answers can use the full text.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!q.trim()) return;
          t.start({ kind: 'chat', paperId: paper.id, question: q.trim() });
          setQ('');
        }}
        className="flex flex-col gap-2"
      >
        <label className="mg-label" htmlFor="mg-ask">
          Ask about this paper
        </label>
        <div className="flex gap-2">
          <input id="mg-ask" className="mg-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. How is the reward model trained?" />
          <button className="mg-btn-primary" type="submit" disabled={!q.trim()}>
            <Icon name="send" size={14} />
          </button>
        </div>
      </form>
      <div className="flex flex-col gap-2">
        <span className="mg-label">Compare with a paper in your library</span>
        <div className="flex gap-2">
          <select className="mg-input" value={compareId} onChange={(e) => setCompareId(e.target.value)}>
            <option value="">Choose a paper…</option>
            {(library ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.title.length > 80 ? `${p.title.slice(0, 80)}…` : p.title}
              </option>
            ))}
          </select>
          <button className="mg-btn" disabled={!compareId} onClick={() => compareId && t.start({ kind: 'compare', paperId: paper.id, comparePaperId: compareId })}>
            Compare
          </button>
        </div>
      </div>
      {threads.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="mg-label">Earlier</span>
          {threads.map((th) => (
            <div key={th.id} className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800">
              <button
                className="flex-1 text-left"
                onClick={() => {
                  t.setThread(th);
                  setOpenThread(th);
                }}
              >
                <div className="text-sm font-medium text-stone-800 dark:text-stone-100">{th.title}</div>
                <div className="line-clamp-2 text-xs text-stone-500">{th.quote ?? th.messages[0]?.content}</div>
              </button>
              <span className="text-xs text-stone-400">{timeAgo(th.updatedAt)}</span>
              <button className="text-stone-400 opacity-0 hover:text-rose-600 group-hover:opacity-100" title="Delete" onClick={() => repo.deleteThread(th.id)}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ListField({ label, values, onSave }: { label: string; values: string[]; onSave: (v: string[]) => void }) {
  const [v, setV] = useState(values.join(', '));
  useEffect(() => setV(values.join(', ')), [values.join('|')]);
  return (
    <label className="block">
      <span className="mg-label">{label}</span>
      <input
        className="mg-input mt-1"
        value={v}
        placeholder="comma-separated"
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const next = v.split(',').map((x) => x.trim()).filter(Boolean);
          if (next.join('|') !== values.join('|')) onSave(next);
        }}
      />
    </label>
  );
}

function InfoTab({ paper, ai }: { paper: Paper; ai: boolean }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const x: ExtractedFields = paper.extracted ?? { task: '', benchmarks: [], models: [], metrics: [], headlineResult: '', source: 'manual', updatedAt: nowIso() };
  const save = (patch: Partial<ExtractedFields>) => repo.updatePaper(paper.id, { extracted: { ...x, ...patch, source: 'manual', updatedAt: nowIso() } });
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">At a glance</span>
          {ai && (
            <button className="mg-btn-ghost px-1.5 py-0.5 text-xs" disabled={!!busy} onClick={() => run('extract', async () => repo.updatePaper(paper.id, { extracted: await extractFields(paper) }))}>
              {busy === 'extract' ? <Spinner size={12} /> : <Icon name="sparkle" size={13} />} {paper.extracted ? 'Re-extract' : 'Extract with AI'}
            </button>
          )}
        </div>
        <label className="block">
          <span className="mg-label">Task</span>
          <input className="mg-input mt-1" defaultValue={x.task} key={`task-${x.updatedAt}`} onBlur={(e) => e.target.value !== x.task && save({ task: e.target.value.trim() })} />
        </label>
        <ListField label="Benchmarks" values={x.benchmarks} onSave={(benchmarks) => save({ benchmarks })} />
        <ListField label="Models" values={x.models} onSave={(models) => save({ models })} />
        <ListField label="Metrics" values={x.metrics} onSave={(metrics) => save({ metrics })} />
        <label className="block">
          <span className="mg-label">Headline result</span>
          <textarea className="mg-input mt-1" rows={2} defaultValue={x.headlineResult} key={`hr-${x.updatedAt}`} onBlur={(e) => e.target.value !== x.headlineResult && save({ headlineResult: e.target.value.trim() })} />
        </label>
        {paper.extracted?.source === 'ai' && <span className="text-xs text-stone-400">Extracted by Claude. Edit any field to correct it.</span>}
      </section>

      {paper.review && (
        <section className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">Reviews</span>
          <div className="text-sm text-stone-700 dark:text-stone-200">
            {paper.review.decision && (
              <div>
                Decision: <span className="font-medium">{paper.review.decision}</span>
              </div>
            )}
            {paper.review.avgRating != null && <div>Average rating: {paper.review.avgRating}</div>}
          </div>
          {paper.review.scores.length > 0 && (
            <table className="w-full text-left text-xs">
              <thead className="text-stone-500">
                <tr>
                  <th className="py-1 font-medium">Reviewer</th>
                  <th className="py-1 font-medium">Rating</th>
                  <th className="py-1 font-medium">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {paper.review.scores.map((s, i) => (
                  <tr key={i} className="border-t border-stone-100 dark:border-stone-800">
                    <td className="py-1">{s.reviewer}</td>
                    <td className="py-1" title={s.ratingText}>{s.rating ?? '–'}</td>
                    <td className="py-1">{s.confidence ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {paper.review.summary ? (
            <div className="rounded-md bg-stone-50 p-3 text-sm dark:bg-stone-800">
              <Markdown text={paper.review.summary} />
            </div>
          ) : (
            ai &&
            paper.review.digest && (
              <button
                className="mg-btn self-start"
                disabled={!!busy}
                onClick={() => run('reviews', async () => repo.updatePaper(paper.id, { review: { ...paper.review!, summary: await summarizeReviews(paper) } }))}
              >
                {busy === 'reviews' ? <Spinner /> : <Icon name="sparkle" size={14} />} Summarize reviews and rebuttal
              </button>
            )
          )}
        </section>
      )}

      {paper.codeLinks.length > 0 && (
        <section className="flex flex-col gap-1">
          <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">Code</span>
          {paper.codeLinks.map((u) => (
            <a key={u} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 truncate text-sm text-accent-700 hover:underline dark:text-accent-300">
              <Icon name="code" size={13} /> {u.replace(/^https?:\/\//, '')}
            </a>
          ))}
        </section>
      )}

      <section className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">Abstract</span>
        <p className="text-[13px] leading-relaxed text-stone-700 dark:text-stone-300">{paper.abstract || 'No abstract.'}</p>
        <div className="mt-1 text-xs text-stone-400">
          {paper.s2?.citationCount != null && <span>{paper.s2.citationCount} citations (Semantic Scholar) · </span>}
          Added {timeAgo(paper.createdAt)}
        </div>
      </section>
      {error && <p className="text-sm text-rose-700">{error}</p>}
    </div>
  );
}

function BibtexTab({ paper }: { paper: Paper }) {
  const [text, setText] = useState(paper.bibtex);
  const [key, setKey] = useState(paper.citeKey);
  useEffect(() => {
    setText(paper.bibtex);
    setKey(paper.citeKey);
  }, [paper.bibtex, paper.citeKey]);
  const sourceNote: Record<Paper['bibtexSource'], string> = {
    arxiv: 'arXiv entry. Archive checks daily and switches to the venue version once the paper is published.',
    openreview: 'From OpenReview.',
    dblp: `Venue version from DBLP${paper.venue ? ` (${paper.venue})` : ''}.`,
    s2: `Venue version built from Semantic Scholar${paper.venue ? ` (${paper.venue})` : ''}.`,
    manual: 'Edited by you. Automatic updates are off for this entry.',
    import: 'Imported from your reference manager.',
  };
  const regenerate = () => {
    const bib = paper.arxivId
      ? arxivBibtex({ citeKey: paper.citeKey, title: paper.title, authors: paper.authors, year: paper.year, arxivId: paper.arxivId, primaryCategory: paper.primaryCategory })
      : genericBibtex({ citeKey: paper.citeKey, type: paper.venue ? 'inproceedings' : 'misc', title: paper.title, authors: paper.authors, year: paper.year, venue: paper.venue, url: paper.urls.abs ?? paper.urls.openreview });
    return repo.updatePaper(paper.id, { bibtex: bib, bibtexSource: paper.arxivId ? 'arxiv' : 's2', venueStatus: paper.arxivId ? 'preprint' : paper.venueStatus });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-stone-500 dark:text-stone-400">{sourceNote[paper.bibtexSource]}</p>
      <label className="block">
        <span className="mg-label">Citation key</span>
        <div className="mt-1 flex gap-2">
          <input className="mg-input font-mono" value={key} onChange={(e) => setKey(e.target.value.replace(/[^\w:.-]/g, ''))} />
          {key !== paper.citeKey && key && (
            <button className="mg-btn" onClick={() => repo.updatePaper(paper.id, { citeKey: key, bibtex: rekey(paper.bibtex, key) })}>
              Save
            </button>
          )}
        </div>
      </label>
      <textarea className="mg-input font-mono text-xs leading-relaxed" rows={12} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <CopyButton text={text} />
        {text !== paper.bibtex && (
          <button className="mg-btn" onClick={() => repo.updatePaper(paper.id, { bibtex: text, bibtexSource: 'manual' })}>
            Save edits
          </button>
        )}
        {paper.bibtexSource === 'manual' && (
          <button className="mg-btn-ghost" onClick={regenerate}>
            <Icon name="refresh" size={14} /> Reset to automatic
          </button>
        )}
      </div>
    </div>
  );
}
