import { useState } from 'react';
import * as repo from '@/lib/repo';
import { useLive } from '@/hooks/useLive';
import type { Author, Follow, Paper } from '@/lib/types';
import { Icon } from './Icon';
import { Spinner, cx } from './common';

function matches(a: Author, f: Follow) {
  if (f.s2AuthorId && a.s2Id) return a.s2Id === f.s2AuthorId;
  return repo.normAuthorName(a.name) === repo.normAuthorName(f.name);
}

/** Author names you can tap to follow or unfollow. */
export function AuthorList({ paper, max = 6 }: { paper: Paper; max?: number }) {
  const { data: follows } = useLive(() => repo.listFollows(), [], (e) => e.table === 'follows');
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const authors = paper.authors;
  const shown = all || authors.length <= max ? authors : [...authors.slice(0, max - 1)];
  const followOf = (a: Author) => (follows ?? []).find((f) => matches(a, f));
  const active = open !== null ? authors[open] : null;
  const activeFollow = active ? followOf(active) : undefined;

  return (
    <div className="text-[13px] text-stone-600 dark:text-stone-300">
      <span className="leading-relaxed">
        {shown.map((a, i) => {
          const f = followOf(a);
          return (
            <span key={`${a.name}-${i}`}>
              {i > 0 && ', '}
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                className={cx('rounded-sm decoration-stone-300 underline-offset-2 hover:underline', f && 'font-medium text-accent-700 dark:text-accent-300', open === i && 'bg-stone-100 dark:bg-stone-800')}
                title={f ? `Following ${a.name}` : `Follow ${a.name}`}
              >
                {a.name}
                {f && <Icon name="star" size={11} className="ml-0.5 inline fill-current align-[-1px]" />}
              </button>
            </span>
          );
        })}
        {!all && authors.length > max && (
          <>
            {', '}
            <button type="button" className="text-stone-500 hover:underline" onClick={() => setAll(true)}>
              {authors.length - shown.length} more
            </button>
          </>
        )}
        {paper.year ? ` · ${paper.year}` : ''}
      </span>
      {active && (
        <div className="mt-1.5 flex items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-2.5 py-1.5 dark:border-stone-700 dark:bg-stone-800">
          <span className="min-w-0 flex-1 truncate text-xs">
            {activeFollow ? <>You follow {active.name}. Their new papers show up in For you.</> : <>Follow {active.name} to see their new papers in For you.</>}
          </span>
          <button
            type="button"
            className={activeFollow ? 'mg-btn py-0.5 text-xs' : 'mg-btn-primary py-0.5 text-xs'}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                if (activeFollow) await repo.unfollow(activeFollow.id);
                else {
                  const { followPaperAuthor } = await import('@/lib/follows');
                  await followPaperAuthor(paper, open!);
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Spinner size={12} /> : activeFollow ? 'Unfollow' : 'Follow'}
          </button>
          <button type="button" className="text-stone-400 hover:text-stone-700" onClick={() => setOpen(null)} aria-label="Close">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
