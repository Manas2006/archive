import { useState } from 'react';
import { rpc } from '@/lib/rpc';
import type { PaperState } from '@/lib/bg/handlers';
import { StatusSelect, Spinner, WillCiteButton, cx } from '@/components/common';
import { Icon } from '@/components/Icon';

export function Pill({
  page,
  state,
  onSave,
  onOpenPanel,
  onOpenReader,
  highlightCount,
}: {
  page: { kind: string; paperId: string };
  state: PaperState | null;
  onSave: () => Promise<string | null>;
  onOpenPanel: () => void;
  onOpenReader?: () => void;
  highlightCount: number;
}) {
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const entry = state?.entry ?? null;
  const paperId = state?.paper?.id ?? page.paperId;

  if (collapsed) {
    return (
      <button
        data-mg-ui
        className="fixed bottom-5 right-5 z-[2147483600] flex h-10 w-10 items-center justify-center rounded-full border border-stone-200 bg-white text-accent-700 shadow-lg hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900"
        title="Marginalia"
        onClick={() => setCollapsed(false)}
      >
        <Icon name={entry ? 'check' : 'bookmark'} size={17} />
      </button>
    );
  }

  return (
    <div data-mg-ui className="fixed bottom-5 right-5 z-[2147483600] flex items-center gap-1 rounded-xl border border-stone-200 bg-white/95 p-1 shadow-lg backdrop-blur dark:border-stone-700 dark:bg-stone-900/95">
      {entry ? (
        <>
          <span className="flex items-center gap-1 pl-1.5 pr-0.5 text-sm font-medium text-accent-700 dark:text-accent-300" title="In your library">
            <Icon name="check" size={15} />
          </span>
          <StatusSelect size="sm" value={entry.status} onChange={(status) => rpc.updateEntry(paperId, { status })} />
          <WillCiteButton compact value={entry.willCite} onChange={(willCite) => rpc.updateEntry(paperId, { willCite })} />
        </>
      ) : (
        <button
          className={cx('mg-btn-primary rounded-lg py-1.5', busy && 'opacity-80')}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onSave();
            setBusy(false);
          }}
          title="Save to Marginalia (Alt+Shift+S)"
        >
          {busy ? <Spinner /> : <Icon name="bookmark" size={14} />} Save paper
        </button>
      )}
      <button className="mg-btn-ghost px-2 py-1.5" onClick={onOpenPanel} title="Notes and highlights (Alt+Shift+M)">
        <Icon name="panel" size={15} />
        {highlightCount > 0 && <span className="text-xs">{highlightCount}</span>}
      </button>
      {onOpenReader && (
        <button className="mg-btn-ghost px-2 py-1.5 text-xs" onClick={onOpenReader} title="Read and annotate the PDF in Marginalia">
          <Icon name="book" size={15} /> PDF
        </button>
      )}
      <button className="mg-btn-ghost px-1 py-1.5 text-stone-400" onClick={() => setCollapsed(true)} title="Minimize">
        <Icon name="chevronDown" size={14} />
      </button>
    </div>
  );
}
