// Followed authors: moving the v0.2 typed names into the follows table,
// resolving a name to a Semantic Scholar author, following an author from a
// paper, and the author picker.

import * as repo from './repo';
import { getSettings, updateSettings } from './settings';
import { s2AuthorSearch, s2Get, toS2Id, type S2AuthorHit } from './sources/s2';
import type { Author, Follow, Paper } from './types';

/** Settings v0.2 kept followed authors as typed names. Turn them into follow records once. */
export async function migrateLegacyFollows(): Promise<number> {
  const s = await getSettings();
  const names = (s.followedAuthors ?? []).map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!names.length) {
    if (s.followedAuthors?.length) await updateSettings({ followedAuthors: [] });
    return 0;
  }
  const have = new Set((await repo.listFollows()).map((f) => repo.normAuthorName(f.name)));
  let added = 0;
  // names that failed stay in settings, so the next start tries them again
  const left: string[] = [];
  for (const name of names) {
    const n = repo.normAuthorName(name);
    if (!n || have.has(n)) continue;
    try {
      await repo.follow({ name });
      have.add(n);
      added++;
    } catch (e) {
      console.warn('[archive] could not migrate follow', name, e);
      left.push(name);
    }
  }
  await updateSettings({ followedAuthors: left });
  return added;
}

/** Work to run when the extension (or web app) starts. */
export async function startupTasks(): Promise<{ migrated: number }> {
  let migrated = 0;
  try {
    migrated = await migrateLegacyFollows();
  } catch (e) {
    console.warn('[archive] follow migration failed', e);
  }
  return { migrated };
}

/** S2 author ids of library papers' authors, with how many library papers each has. */
async function libraryAuthorCounts(): Promise<Map<string, number>> {
  const entries = await repo.listEntries();
  const papers = await repo.getPapers(entries.map((e) => e.paperId));
  const counts = new Map<string, number>();
  for (const p of papers) {
    for (const id of new Set(p.authors.map((a) => a.s2Id).filter((x): x is string => !!x))) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Pick the S2 profile a typed name most likely means. Exported for tests. */
export function pickAuthor(name: string, hits: S2AuthorHit[], libraryCounts: Map<string, number>): S2AuthorHit | null {
  const target = repo.normAuthorName(name);
  const exact = hits.filter((h) => repo.normAuthorName(h.name) === target);
  if (!exact.length) return null;
  const inLibrary = exact
    .filter((h) => libraryCounts.has(h.authorId))
    .sort((a, b) => libraryCounts.get(b.authorId)! - libraryCounts.get(a.authorId)! || (b.paperCount ?? 0) - (a.paperCount ?? 0));
  if (inLibrary.length) return inLibrary[0];
  return [...exact].sort((a, b) => (b.paperCount ?? 0) - (a.paperCount ?? 0))[0];
}

/**
 * Give a name-only follow its Semantic Scholar author id. Prefers the profile
 * that wrote a paper in the library, else the exact-name profile with the most
 * papers. Leaves the follow alone when no profile has that name.
 */
export async function resolveFollow(f: Follow): Promise<Follow> {
  if (f.s2AuthorId) return f;
  const [hits, counts] = await Promise.all([s2AuthorSearch(f.name, { limit: 50 }), libraryAuthorCounts()]);
  const pick = pickAuthor(f.name, hits, counts);
  if (!pick) return f;
  // the same normalized name, so repo.follow retires the name-only record
  return repo.follow({ name: pick.name || f.name, s2AuthorId: pick.authorId, affiliation: pick.affiliations?.[0], paperCount: pick.paperCount });
}

type S2AuthorRef = { name: string; authorId?: string | null };

const initialKey = (n: string) => {
  const parts = n.split(' ').filter(Boolean);
  return parts.length > 1 ? `${parts[0][0]} ${parts[parts.length - 1]}` : n;
};

/**
 * Copy S2 author ids onto a paper's authors: by position when both lists have
 * the same length, else by name (exact normalized name, then first initial and
 * family name). Returns null when nothing changes.
 */
export function mergeAuthorIds(authors: Author[], s2Authors: S2AuthorRef[]): Author[] | null {
  if (!authors.length || !s2Authors.length) return null;
  const sameLength = authors.length === s2Authors.length;
  const byName = new Map<string, string | null>();
  const byInitial = new Map<string, string | null>();
  if (!sameLength) {
    const add = (m: Map<string, string | null>, k: string, id: string) => m.set(k, m.has(k) && m.get(k) !== id ? null : id); // null: ambiguous
    for (const a of s2Authors) {
      const n = repo.normAuthorName(a.name);
      if (!a.authorId || !n) continue;
      add(byName, n, a.authorId);
      add(byInitial, initialKey(n), a.authorId);
    }
  }
  let changed = false;
  const next = authors.map((a, i) => {
    let id: string | null | undefined;
    if (sameLength) id = s2Authors[i].authorId;
    else {
      const n = repo.normAuthorName(a.name);
      id = byName.get(n) ?? (byName.has(n) ? null : byInitial.get(initialKey(n)));
    }
    if (!id || id === a.s2Id) return a;
    changed = true;
    return { ...a, s2Id: id };
  });
  return changed ? next : null;
}

/** Ask S2 for the paper's author list so we learn author ids; stores them on the paper. */
async function authorIdFromPaper(paper: Paper, index: number): Promise<string | undefined> {
  const lookup = paper.s2Id ?? paper.s2?.paperId ?? toS2Id(paper.id) ?? paper.aliases.map(toS2Id).find(Boolean) ?? null;
  if (!lookup) return undefined;
  const s2 = await s2Get(lookup, 'paperId,authors');
  const list = s2?.authors ?? [];
  const merged = mergeAuthorIds(paper.authors, list);
  if (!merged) return undefined;
  await repo.updatePaper(paper.id, (cur) => ({ authors: mergeAuthorIds(cur.authors, list) ?? cur.authors }), { derived: true });
  return merged[index]?.s2Id;
}

/** Follow the author at `index` in the paper's author list. */
export async function followPaperAuthor(paper: Paper, index: number): Promise<Follow> {
  const a = paper.authors[index];
  if (!a) throw new Error('That author is not on this paper.');
  const s2Id = a.s2Id ?? (await authorIdFromPaper(paper, index).catch(() => undefined));
  if (s2Id) return repo.follow({ name: a.name, s2AuthorId: s2Id });
  const f = await repo.follow({ name: a.name });
  return resolveFollow(f).catch(() => f);
}

/** The follow matching this author: by S2 id first, then by name (unless both sides have different ids). */
export function isFollowed(author: Author, follows: Follow[]): Follow | undefined {
  if (!follows.length) return undefined;
  if (author.s2Id) {
    const byId = follows.find((f) => f.s2AuthorId === author.s2Id);
    if (byId) return byId;
  }
  const n = repo.normAuthorName(author.name);
  if (!n) return undefined;
  return follows.find((f) => (!f.s2AuthorId || !author.s2Id) && repo.normAuthorName(f.name) === n);
}

export interface AuthorPick extends S2AuthorHit {
  followed: boolean;
  followId?: string;
  libraryPapers: number; // library papers by this author (by S2 id)
}

/** Author picker: S2 profiles for a name, those with papers in the library first. */
export async function searchAuthors(name: string): Promise<AuthorPick[]> {
  if (!name.trim()) return [];
  const [hits, follows, counts] = await Promise.all([s2AuthorSearch(name), repo.listFollows(), libraryAuthorCounts()]);
  return hits
    .map((h) => {
      const f = follows.find((x) => x.s2AuthorId === h.authorId);
      return { ...h, followed: !!f, followId: f?.id, libraryPapers: counts.get(h.authorId) ?? 0 };
    })
    .sort((a, b) => b.libraryPapers - a.libraryPapers);
}
