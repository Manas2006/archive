// The single storage layer. Every read and write in the extension goes through
// here. It's local (IndexedDB) today; every write is also appended to a change
// log so a future lab backend can upload history without a migration.

import { db } from './db';
import { emitChange } from './changes';
import { getSettings } from './settings';
import { nowIso, uuid } from './ids';
import type {
  Annotation,
  Attachment,
  FeedItem,
  Follow,
  FullText,
  LibraryEntry,
  Medium,
  Paper,
  Project,
  SyncMeta,
  Thread,
  Topic,
} from './types';

let cachedUser: { id: string; name: string } | null = null;

export async function currentUser(): Promise<{ id: string; name: string }> {
  if (cachedUser) return cachedUser;
  const s = await getSettings();
  cachedUser = { id: s.userId, name: s.displayName || 'Me' };
  return cachedUser;
}

export async function newMeta(): Promise<SyncMeta> {
  const u = await currentUser();
  const now = nowIso();
  return { owner: u.id, visibility: 'private', groupId: null, createdAt: now, updatedAt: now, deletedAt: null };
}

async function log(table: string, keys: string[], op: 'put' | 'delete', paperIds: string[]) {
  const at = nowIso();
  await db().changes.bulkAdd(keys.map((key) => ({ table, key, op, at, synced: 0 as const })));
  emitChange({ table, keys, paperIds });
}

const alive = <T extends { deletedAt: string | null }>(x: T | undefined | null): x is T => !!x && !x.deletedAt;

/** A patch, or a function computing one from the current record (read inside the same transaction). */
export type Patch<T> = Partial<T> | ((current: T) => Partial<T>);

const resolvePatch = <T>(cur: T, patch: Patch<T>): Partial<T> => (typeof patch === 'function' ? (patch as (c: T) => Partial<T>)(cur) : patch);

// ---------------------------------------------------------------------------
// Papers
// ---------------------------------------------------------------------------

export async function getPaper(idOrAlias: string): Promise<Paper | undefined> {
  const d = db();
  const direct = await d.papers.get(idOrAlias);
  if (direct) return direct;
  return d.papers.where('aliases').equals(idOrAlias).first();
}

export async function getPapers(ids: string[]): Promise<Paper[]> {
  const rows = await db().papers.bulkGet(ids);
  return rows.filter((p): p is Paper => !!p);
}

export async function listPapers(): Promise<Paper[]> {
  return (await db().papers.toArray()).filter(alive);
}

export async function putPaper(p: Paper): Promise<Paper> {
  const next = { ...p, updatedAt: nowIso() };
  await db().papers.put(next);
  await log('papers', [p.id], 'put', [p.id]);
  return next;
}

/** Read-modify-write in one transaction, so concurrent field updates don't clobber each other. */
export async function updatePaper(id: string, patch: Patch<Paper>): Promise<Paper | undefined> {
  const d = db();
  const next = await d.transaction('rw', d.papers, d.changes, async () => {
    const p = (await d.papers.get(id)) ?? (await d.papers.where('aliases').equals(id).first());
    if (!p) return undefined;
    const n: Paper = { ...p, ...resolvePatch(p, patch), id: p.id, updatedAt: nowIso() };
    await d.papers.put(n);
    await d.changes.add({ table: 'papers', key: p.id, op: 'put', at: n.updatedAt, synced: 0 });
    return n;
  });
  if (next) emitChange({ table: 'papers', keys: [next.id], paperIds: [next.id] });
  return next;
}

export async function takenCiteKeys(exceptPaperId?: string): Promise<Set<string>> {
  const all = await db().papers.toArray();
  return new Set(all.filter((p) => p.id !== exceptPaperId && !p.deletedAt).map((p) => p.citeKey));
}

// ---------------------------------------------------------------------------
// Library (personal)
// ---------------------------------------------------------------------------

export async function getEntry(paperId: string): Promise<LibraryEntry | undefined> {
  const e = await db().library.get(paperId);
  return alive(e) ? e : undefined;
}

export async function listEntries(): Promise<LibraryEntry[]> {
  return (await db().library.toArray()).filter(alive);
}

export async function newEntry(paperId: string): Promise<LibraryEntry> {
  return {
    ...(await newMeta()),
    paperId,
    status: 'inbox',
    statusSetBy: 'auto',
    willCite: false,
    projectIds: [],
    dismissedProjectIds: [],
    suggestions: [],
    topicId: null,
    tags: [],
    progress: 0,
    lastOpenedAt: null,
    priority: 0,
    priorityReasons: [],
  };
}

export async function putEntry(e: LibraryEntry): Promise<LibraryEntry> {
  const next = { ...e, updatedAt: nowIso() };
  await db().library.put(next);
  await log('library', [e.paperId], 'put', [e.paperId]);
  return next;
}

export async function updateEntry(paperId: string, patch: Patch<LibraryEntry>): Promise<LibraryEntry | undefined> {
  const d = db();
  const next = await d.transaction('rw', d.library, d.changes, async () => {
    const e = await d.library.get(paperId);
    if (!alive(e)) return undefined;
    const p = { ...resolvePatch(e, patch) };
    if (p.status && !p.statusSetBy) p.statusSetBy = 'user';
    const n: LibraryEntry = { ...e, ...p, paperId, updatedAt: nowIso() };
    await d.library.put(n);
    await d.changes.add({ table: 'library', key: paperId, op: 'put', at: n.updatedAt, synced: 0 });
    return n;
  });
  if (next) emitChange({ table: 'library', keys: [paperId], paperIds: [paperId] });
  return next;
}

export async function removeFromLibrary(paperId: string): Promise<void> {
  const e = await db().library.get(paperId);
  if (!e) return;
  await db().library.put({ ...e, deletedAt: nowIso(), updatedAt: nowIso() });
  await log('library', [paperId], 'delete', [paperId]);
}

/** Restore a soft-deleted entry, or create a fresh one. */
export async function ensureEntry(paperId: string): Promise<{ entry: LibraryEntry; created: boolean }> {
  const existing = await db().library.get(paperId);
  if (existing && !existing.deletedAt) return { entry: existing, created: false };
  const base: LibraryEntry = existing ? { ...existing, deletedAt: null, status: 'inbox' } : await newEntry(paperId);
  const entry = await putEntry({ ...base, createdAt: nowIso() });
  return { entry, created: true };
}

// ---------------------------------------------------------------------------
// Annotations (shareable)
// ---------------------------------------------------------------------------

export async function listAnnotations(paperId: string): Promise<Annotation[]> {
  return (await db().annotations.where('paperId').equals(paperId).toArray())
    .filter(alive)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listAllAnnotations(): Promise<Annotation[]> {
  return (await db().annotations.toArray()).filter(alive);
}

export async function getAnnotation(id: string): Promise<Annotation | undefined> {
  const a = await db().annotations.get(id);
  return alive(a) ? a : undefined;
}

export type NewAnnotation = Pick<Annotation, 'paperId' | 'motivation' | 'body' | 'target'>;

export async function createAnnotation(input: NewAnnotation): Promise<Annotation> {
  const a: Annotation = {
    ...(await newMeta()),
    ...input,
    id: `urn:uuid:${uuid()}`,
    type: 'Annotation',
    creator: await currentUser(),
  };
  await db().annotations.put(a);
  await log('annotations', [a.id], 'put', [a.paperId]);
  return a;
}

export async function updateAnnotation(id: string, patch: Patch<Annotation>): Promise<Annotation | undefined> {
  const d = db();
  const next = await d.transaction('rw', d.annotations, d.changes, async () => {
    const a = await d.annotations.get(id);
    if (!alive(a)) return undefined;
    const n: Annotation = { ...a, ...resolvePatch(a, patch), id, updatedAt: nowIso() };
    await d.annotations.put(n);
    await d.changes.add({ table: 'annotations', key: id, op: 'put', at: n.updatedAt, synced: 0 });
    return n;
  });
  if (next) emitChange({ table: 'annotations', keys: [id], paperIds: [next.paperId] });
  return next;
}

/** Field-level edits: each touches only its own body part, so a quick label click can't erase a note being saved. */
export function setAnnotationLabel(id: string, label: string) {
  return updateAnnotation(id, (a) => ({
    body: [...a.body.filter((b) => b.purpose !== 'tagging'), { type: 'TextualBody', purpose: 'tagging', value: label }],
  }));
}

export function setAnnotationNote(id: string, note: string) {
  return updateAnnotation(id, (a) => {
    const rest = a.body.filter((b) => b.purpose !== 'commenting');
    return { body: note.trim() ? [...rest, { type: 'TextualBody', purpose: 'commenting', value: note, format: 'text/markdown' }] : rest };
  });
}

export async function deleteAnnotation(id: string): Promise<void> {
  const a = await db().annotations.get(id);
  if (!a) return;
  await db().annotations.put({ ...a, deletedAt: nowIso(), updatedAt: nowIso() });
  await log('annotations', [id], 'delete', [a.paperId]);
}

// ---------------------------------------------------------------------------
// Projects and topics (personal)
// ---------------------------------------------------------------------------

const PROJECT_COLORS = ['#22766c', '#b45309', '#7c3aed', '#be123c', '#0369a1', '#4d7c0f', '#a21caf', '#334155'];

export async function listProjects(): Promise<Project[]> {
  return (await db().projects.toArray()).filter(alive).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProject(id: string): Promise<Project | undefined> {
  const p = await db().projects.get(id);
  return alive(p) ? p : undefined;
}

export async function createProject(input: { name: string; description?: string; seedPaperIds?: string[] }): Promise<Project> {
  const count = await db().projects.count();
  const p: Project = {
    ...(await newMeta()),
    id: uuid(),
    name: input.name.trim() || 'Untitled project',
    description: input.description?.trim() ?? '',
    seedPaperIds: input.seedPaperIds ?? [],
    color: PROJECT_COLORS[count % PROJECT_COLORS.length],
  };
  await db().projects.put(p);
  await log('projects', [p.id], 'put', []);
  return p;
}

export async function updateProject(id: string, patch: Patch<Project>): Promise<Project | undefined> {
  const d = db();
  const next = await d.transaction('rw', d.projects, d.changes, async () => {
    const p = await d.projects.get(id);
    if (!alive(p)) return undefined;
    const n: Project = { ...p, ...resolvePatch(p, patch), id, updatedAt: nowIso() };
    await d.projects.put(n);
    await d.changes.add({ table: 'projects', key: id, op: 'put', at: n.updatedAt, synced: 0 });
    return n;
  });
  if (next) emitChange({ table: 'projects', keys: [id], paperIds: [] });
  return next;
}

export async function deleteProject(id: string): Promise<void> {
  const p = await db().projects.get(id);
  if (!p) return;
  await db().projects.put({ ...p, deletedAt: nowIso(), updatedAt: nowIso() });
  const entries = await db().library.where('projectIds').equals(id).toArray();
  for (const e of entries) {
    await updateEntry(e.paperId, (cur) => ({ projectIds: cur.projectIds.filter((x) => x !== id) }));
  }
  await log('projects', [id], 'delete', []);
}

export async function listTopics(): Promise<Topic[]> {
  return (await db().topics.toArray()).filter(alive).sort((a, b) => a.name.localeCompare(b.name));
}

export async function putTopic(t: Topic): Promise<Topic> {
  const next = { ...t, updatedAt: nowIso() };
  await db().topics.put(next);
  await log('topics', [t.id], 'put', []);
  return next;
}

export async function deleteTopic(id: string): Promise<void> {
  const t = await db().topics.get(id);
  if (!t) return;
  await db().topics.put({ ...t, deletedAt: nowIso(), updatedAt: nowIso() });
  await log('topics', [id], 'delete', []);
}

// ---------------------------------------------------------------------------
// Followed authors and the "For you" feed (personal)
// ---------------------------------------------------------------------------

export const normAuthorName = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function followIdFor(name: string, s2AuthorId?: string | null): string {
  return s2AuthorId ? `s2a:${s2AuthorId}` : `name:${normAuthorName(name)}`;
}

export async function listFollows(): Promise<Follow[]> {
  return (await db().follows.toArray()).filter(alive).sort((a, b) => a.name.localeCompare(b.name));
}

/** Follow an author. Re-following a soft-deleted one restores it. A name-only follow is upgraded when an id is known. */
export async function follow(input: { name: string; s2AuthorId?: string | null; affiliation?: string; paperCount?: number }): Promise<Follow> {
  const d = db();
  const id = followIdFor(input.name, input.s2AuthorId);
  const existing = await d.follows.get(id);
  const meta = existing ?? (await newMeta());
  const f: Follow = {
    ...meta,
    id,
    name: input.name.trim(),
    s2AuthorId: input.s2AuthorId ?? null,
    affiliation: input.affiliation ?? existing?.affiliation,
    paperCount: input.paperCount ?? existing?.paperCount,
    lastCheckedAt: existing?.lastCheckedAt ?? null,
    deletedAt: null,
    updatedAt: nowIso(),
  };
  await d.follows.put(f);
  const keys = [id];
  // drop a name-only duplicate once we know the real author
  if (input.s2AuthorId) {
    const byName = await d.follows.get(followIdFor(input.name));
    if (byName && !byName.deletedAt) {
      await d.follows.put({ ...byName, deletedAt: nowIso(), updatedAt: nowIso() });
      keys.push(byName.id);
    }
  }
  await log('follows', keys, 'put', []);
  return f;
}

export async function updateFollow(id: string, patch: Patch<Follow>): Promise<Follow | undefined> {
  const d = db();
  const next = await d.transaction('rw', d.follows, d.changes, async () => {
    const f = await d.follows.get(id);
    if (!alive(f)) return undefined;
    const n: Follow = { ...f, ...resolvePatch(f, patch), id, updatedAt: nowIso() };
    await d.follows.put(n);
    await d.changes.add({ table: 'follows', key: id, op: 'put', at: n.updatedAt, synced: 0 });
    return n;
  });
  if (next) emitChange({ table: 'follows', keys: [id], paperIds: [] });
  return next;
}

export async function unfollow(id: string): Promise<void> {
  const f = await db().follows.get(id);
  if (!f) return;
  await db().follows.put({ ...f, deletedAt: nowIso(), updatedAt: nowIso() });
  await log('follows', [id], 'delete', []);
}

export async function listFeed(status?: FeedItem['status']): Promise<FeedItem[]> {
  const rows = (await db().feed.toArray()).filter(alive);
  return (status ? rows.filter((r) => r.status === status) : rows).sort((a, b) => b.score - a.score || b.foundAt.localeCompare(a.foundAt));
}

export async function getFeedItem(id: string): Promise<FeedItem | undefined> {
  const f = await db().feed.get(id);
  return alive(f) ? f : undefined;
}

/** Add candidates. An existing item keeps its status and gains any new reasons; its score becomes the max. */
export async function addFeedItems(items: FeedItem[]): Promise<number> {
  const d = db();
  let added = 0;
  const keys: string[] = [];
  await d.transaction('rw', d.feed, d.changes, async () => {
    for (const it of items) {
      const cur = await d.feed.get(it.id);
      let next: FeedItem;
      if (cur && !cur.deletedAt) {
        const sig = (r: FeedItem['reasons'][number]) => JSON.stringify({ ...r, score: undefined, count: undefined });
        const have = new Set(cur.reasons.map(sig));
        const reasons = [...cur.reasons, ...it.reasons.filter((r) => !have.has(sig(r)))];
        next = { ...cur, ...it, status: cur.status, foundAt: cur.foundAt, createdAt: cur.createdAt, reasons, score: Math.max(cur.score, it.score), updatedAt: nowIso() };
      } else {
        next = { ...it, updatedAt: nowIso() };
        added++;
      }
      await d.feed.put(next);
      await d.changes.add({ table: 'feed', key: it.id, op: 'put', at: next.updatedAt, synced: 0 });
      keys.push(it.id);
    }
  });
  if (keys.length) emitChange({ table: 'feed', keys, paperIds: [] });
  return added;
}

export async function setFeedStatus(id: string, status: FeedItem['status']): Promise<void> {
  const d = db();
  const f = await d.feed.get(id);
  if (!f) return;
  await d.feed.put({ ...f, status, updatedAt: nowIso() });
  await log('feed', [id], 'put', []);
}

// ---------------------------------------------------------------------------
// AI threads (personal)
// ---------------------------------------------------------------------------

export async function listThreads(paperId: string): Promise<Thread[]> {
  return (await db().threads.where('paperId').equals(paperId).toArray())
    .filter(alive)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getThread(id: string): Promise<Thread | undefined> {
  const t = await db().threads.get(id);
  return alive(t) ? t : undefined;
}

export async function putThread(t: Thread): Promise<Thread> {
  const next = { ...t, updatedAt: nowIso() };
  await db().threads.put(next);
  await log('threads', [t.id], 'put', [t.paperId]);
  return next;
}

export async function deleteThread(id: string): Promise<void> {
  const t = await db().threads.get(id);
  if (!t) return;
  await db().threads.put({ ...t, deletedAt: nowIso() });
  await log('threads', [id], 'delete', [t.paperId]);
}

// ---------------------------------------------------------------------------
// Full text cache and attachments
// ---------------------------------------------------------------------------

export async function getFullText(paperId: string, medium?: Medium): Promise<FullText | undefined> {
  if (medium) return db().fulltext.get([paperId, medium]);
  const rows = await db().fulltext.where('paperId').equals(paperId).toArray();
  // prefer HTML (math as TeX, cleaner), then PDF
  return rows.find((r) => r.medium === 'html') ?? rows[0];
}

export async function putFullText(ft: FullText): Promise<void> {
  await db().fulltext.put(ft);
}

export async function listAttachments(paperId: string): Promise<Attachment[]> {
  return db().attachments.where('paperId').equals(paperId).toArray();
}

export async function getAttachment(id: string): Promise<Attachment | undefined> {
  return db().attachments.get(id);
}

export async function putAttachment(a: Omit<Attachment, 'id' | 'createdAt'>): Promise<Attachment> {
  const full: Attachment = { ...a, id: uuid(), createdAt: nowIso() };
  await db().attachments.put(full);
  await log('attachments', [full.id], 'put', [a.paperId]);
  return full;
}

export async function deleteAttachment(id: string): Promise<void> {
  const a = await db().attachments.get(id);
  await db().attachments.delete(id);
  if (a) await log('attachments', [id], 'delete', [a.paperId]);
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

export async function exportAll() {
  const d = db();
  return {
    format: 'archive-backup',
    version: 1,
    exportedAt: nowIso(),
    papers: await d.papers.toArray(),
    library: await d.library.toArray(),
    annotations: await d.annotations.toArray(),
    projects: await d.projects.toArray(),
    topics: await d.topics.toArray(),
    threads: await d.threads.toArray(),
    attachments: await d.attachments.toArray(),
    follows: await d.follows.toArray(),
    feed: await d.feed.toArray(),
  };
}

export async function importAll(data: Awaited<ReturnType<typeof exportAll>>): Promise<number> {
  if (!['archive-backup', 'scribe-backup', 'marginalia-backup'].includes(data?.format)) throw new Error('Not an Archive backup file');
  const d = db();
  let n = 0;
  await d.transaction('rw', [d.papers, d.library, d.annotations, d.projects, d.topics, d.threads, d.attachments, d.follows, d.feed], async () => {
    // newer record wins
    const merge = async <T extends { updatedAt?: string }>(table: any, rows: T[] | undefined, key: (r: T) => any) => {
      for (const r of rows ?? []) {
        const cur = await table.get(key(r));
        if (!cur || !cur.updatedAt || (r.updatedAt ?? '') >= cur.updatedAt) {
          await table.put(r);
          n++;
        }
      }
    };
    await merge(d.papers, data.papers, (r) => r.id);
    await merge(d.library, data.library, (r) => r.paperId);
    await merge(d.annotations, data.annotations, (r) => r.id);
    await merge(d.projects, data.projects, (r) => r.id);
    await merge(d.topics, data.topics, (r) => r.id);
    await merge(d.threads, data.threads, (r) => r.id);
    await merge(d.attachments as any, data.attachments as any, (r: any) => r.id);
    await merge(d.follows, (data as any).follows, (r: Follow) => r.id);
    await merge(d.feed, (data as any).feed, (r: FeedItem) => r.id);
  });
  emitChange({ table: '*', keys: [], paperIds: [] });
  return n;
}

export async function clearAll(): Promise<void> {
  const d = db();
  await Promise.all(d.tables.filter((t) => t.name !== 'kv').map((t) => t.clear()));
  emitChange({ table: '*', keys: [], paperIds: [] });
}
