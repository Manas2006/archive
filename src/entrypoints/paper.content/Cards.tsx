import { useEffect, useState } from 'react';
import { rpc } from '@/lib/rpc';
import type { BibRef, SymbolInfo } from '@/lib/page/arxivHtml';
import type { CitationInfo } from '@/lib/citations';
import { Floating, type Rect } from '@/components/annot/Floating';
import { Markdown } from '@/components/Markdown';
import { Spinner } from '@/components/common';
import { Icon } from '@/components/Icon';

export function SymbolCard({
  info,
  rect,
  ai,
  onEnter,
  onLeave,
  onJump,
  onAsk,
}: {
  info: SymbolInfo;
  rect: Rect;
  ai: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onJump: () => void;
  onAsk: () => void;
}) {
  return (
    <Floating rect={rect} prefer="below" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="w-80 rounded-lg border border-stone-200 bg-white p-3 text-[13px] shadow-xl dark:border-stone-700 dark:bg-stone-900">
        <div className="mb-1 flex items-center gap-2 text-xs text-stone-500">
          <span className="font-medium text-stone-700 dark:text-stone-200">{info.isDefinition ? 'Defined' : 'First appears'}</span>
          {info.section && <span className="truncate">in {info.section}</span>}
        </div>
        <div className="leading-relaxed text-stone-800 dark:text-stone-100">
          <Markdown text={info.context} />
        </div>
        <div className="mt-2 flex items-center gap-1">
          <button className="mg-btn-ghost px-1.5 py-0.5 text-xs" onClick={onJump}>
            <Icon name="chevronRight" size={13} /> Jump there
          </button>
          {ai && (
            <button className="mg-btn-ghost px-1.5 py-0.5 text-xs text-accent-800 dark:text-accent-200" onClick={onAsk}>
              <Icon name="sparkle" size={13} /> Ask Claude
            </button>
          )}
          <span className="ml-auto text-xs text-stone-400">{info.occurrences} use{info.occurrences === 1 ? '' : 's'}</span>
        </div>
      </div>
    </Floating>
  );
}

export function CitationCard({ bib, rect, onEnter, onLeave }: { bib: BibRef; rect: Rect; onEnter: () => void; onLeave: () => void }) {
  const [info, setInfo] = useState<CitationInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setInfo(null);
    rpc
      .lookupCitation({ title: bib.title, arxivId: bib.arxivId, doi: bib.doi })
      .then((i) => alive && setInfo(i))
      .catch(() => alive && setInfo(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [bib.id]);
  const abstract = info?.abstract ?? '';
  return (
    <Floating rect={rect} prefer="below" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="w-[400px] max-w-[calc(100vw-16px)] rounded-lg border border-stone-200 bg-white p-3 text-[13px] shadow-xl dark:border-stone-700 dark:bg-stone-900">
        {info?.found ? (
          <>
            <div className="font-serif text-[14px] font-semibold leading-snug text-stone-900 dark:text-stone-50">{info.title}</div>
            <div className="mt-0.5 text-xs text-stone-500">
              {info.authors}
              {info.year ? ` · ${info.year}` : ''}
              {info.venue ? ` · ${info.venue}` : ''}
            </div>
            {abstract && (
              <p className="mt-2 leading-relaxed text-stone-700 dark:text-stone-300">
                {expanded || abstract.length < 420 ? abstract : `${abstract.slice(0, 420)}…`}
                {abstract.length >= 420 && (
                  <button className="ml-1 text-xs text-accent-700" onClick={() => setExpanded((x) => !x)}>
                    {expanded ? 'less' : 'more'}
                  </button>
                )}
              </p>
            )}
          </>
        ) : (
          <div className="leading-relaxed text-stone-700 dark:text-stone-300">{bib.text.length > 400 ? `${bib.text.slice(0, 400)}…` : bib.text}</div>
        )}
        <div className="mt-2.5 flex items-center gap-2">
          {loading ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-stone-500">
              <Spinner size={12} /> Looking it up…
            </span>
          ) : info?.inLibrary ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-accent-700 dark:text-accent-300">
              <Icon name="check" size={13} /> In your library
            </span>
          ) : info?.found && (info.s2Id || info.paperId) ? (
            <button
              className="mg-btn-primary py-0.5 text-xs"
              disabled={saving}
              onClick={async () => {
                setSaving(true);
                try {
                  await rpc.saveFromS2(info.paperId?.startsWith('arxiv:') ? info.paperId : info.s2Id ?? info.paperId!);
                  setInfo({ ...info, inLibrary: true });
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? <Spinner size={12} /> : <Icon name="bookmark" size={13} />} Save
            </button>
          ) : (
            !info?.found && <span className="text-xs text-stone-400">Not found on Semantic Scholar</span>
          )}
          {info?.url && (
            <a className="ml-auto inline-flex items-center gap-1 text-xs text-accent-700 hover:underline dark:text-accent-300" href={info.url} target="_blank" rel="noreferrer">
              Open <Icon name="external" size={12} />
            </a>
          )}
        </div>
      </div>
    </Floating>
  );
}
