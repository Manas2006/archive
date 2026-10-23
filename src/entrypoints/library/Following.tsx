import { useMemo, useState } from 'react';
import { EmptyState, Spinner } from '@/components/common';
import { Icon } from '@/components/Icon';
import * as repo from '@/lib/repo';
import { updatePriorities } from '@/lib/enrich';
import type { Follow } from '@/lib/types';
import { authorMatches, go, type LibraryData } from './shared';

interface Hit {
  authorId: string;
  name: string;
  affiliations?: string[];
  paperCount?: number;
  hIndex?: number;
  followed?: boolean;
  libraryPapers?: number;
}

async function followAndRescore(input: Parameters<typeof repo.follow>[0]) {
  await repo.follow(input);
  void updatePriorities();
}

export function FollowingView({ data }: { data: LibraryData | undefined }) {
  const follows = data?.follows ?? [];
  const rows = data?.rows ?? [];
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const libCount = (f: Follow) => rows.filter((r) => r.paper.authors.some((a) => authorMatches(a, f))).length;

  // authors who appear on several of your saved papers and aren't followed yet
  const suggested = useMemo(() => {
    const counts = new Map<string, { name: string; s2Id?: string; n: number }>();
    for (const r of rows) {
      const seen = new Set<string>();
      for (const a of r.paper.authors) {
        const key = a.s2Id ? `id:${a.s2Id}` : `n:${repo.normAuthorName(a.name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const c = counts.get(key) ?? { name: a.name, s2Id: a.s2Id, n: 0 };
        c.n++;
        counts.set(key, c);
      }
    }
    return [...counts.values()]
      .filter((c) => c.n >= 2 && !follows.some((f) => authorMatches({ name: c.name, s2Id: c.s2Id }, f)))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
  }, [rows, follows]);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { searchAuthors } = await import('@/lib/follows');
      setHits((await searchAuthors(q.trim())) as Hit[]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-4 md:px-6">
        <section className="mg-card flex flex-col gap-3 p-4">
          <div>
            <h2 className="text-sm font-semibold">Follow an author</h2>
            <p className="text-xs text-stone-500">Their new papers show up in For you, and their papers rise in your inbox. You can also follow from any author name on a paper.</p>
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input className="mg-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Semantic Scholar by name" />
            <button className="mg-btn-primary" type="submit" disabled={busy || !q.trim()}>
              {busy ? <Spinner /> : <Icon name="search" size={14} />} Search
            </button>
          </form>
          {err && <p className="text-xs text-rose-700">{err}</p>}
          {hits && (
            <ul className="flex flex-col divide-y divide-stone-100 dark:divide-stone-800">
              {!hits.length && <li className="py-2 text-sm text-stone-500">No authors found.</li>}
              {hits.map((h) => (
                <li key={h.authorId} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{h.name}</div>
                    <div className="truncate text-xs text-stone-500">
                      {[h.affiliations?.[0], h.paperCount != null ? `${h.paperCount} papers` : null, h.hIndex != null ? `h-index ${h.hIndex}` : null, h.libraryPapers ? `${h.libraryPapers} in your library` : null].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  {h.followed ? (
                    <span className="text-xs text-stone-500">Following</span>
                  ) : (
                    <button
                      className="mg-btn"
                      onClick={async () => {
                        await followAndRescore({ name: h.name, s2AuthorId: h.authorId, affiliation: h.affiliations?.[0], paperCount: h.paperCount });
                        setHits(hits.map((x) => (x.authorId === h.authorId ? { ...x, followed: true } : x)));
                      }}
                    >
                      <Icon name="plus" size={14} /> Follow
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2">
          <span className="mg-label">Following</span>
          {!follows.length ? (
            <EmptyState icon="star" title="You're not following anyone yet" />
          ) : (
            <ul className="mg-card divide-y divide-stone-100 dark:divide-stone-800">
              {follows.map((f) => {
                const n = libCount(f);
                return (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-2.5">
                    <button className="min-w-0 flex-1 text-left" onClick={() => go({ kind: 'author', id: f.id })}>
                      <div className="text-sm font-medium hover:underline">{f.name}</div>
                      <div className="truncate text-xs text-stone-500">
                        {[f.affiliation, n ? `${n} in your library` : 'None in your library yet', f.lastCheckedAt ? `checked ${new Date(f.lastCheckedAt).toLocaleDateString()}` : null, !f.s2AuthorId ? 'matching by name' : null].filter(Boolean).join(' · ')}
                      </div>
                    </button>
                    <button
                      className="mg-btn-ghost text-xs text-stone-500"
                      onClick={async () => {
                        await repo.unfollow(f.id);
                        void updatePriorities();
                      }}
                    >
                      Unfollow
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {suggested.length > 0 && (
          <section className="flex flex-col gap-2">
            <span className="mg-label">Often in your library</span>
            <ul className="mg-card divide-y divide-stone-100 dark:divide-stone-800">
              {suggested.map((s) => (
                <li key={s.s2Id ?? s.name} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{s.name}</div>
                    <div className="text-xs text-stone-500">{s.n} papers in your library</div>
                  </div>
                  <button className="mg-btn" onClick={() => followAndRescore({ name: s.name, s2AuthorId: s.s2Id ?? null })}>
                    <Icon name="plus" size={14} /> Follow
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
