// Library sync across devices (laptop extension, phone and iPad web app) through one
// JSON file in Drive: Archive/.sync/library.json, tagged { archive: 'sync' }.
//
// The file is a full snapshot in the backup format (repo.exportAll). A sync:
//  1. pulls: if the file's revision differs from the one we last merged, download it
//     and merge it into the local DB (newest updatedAt wins per record; deletions are
//     records with deletedAt, so they travel too);
//  2. pushes: if anything changed locally since our last push (change log seq, or a
//     table fingerprint for writes that bypass the log, such as a backup import), or
//     the file lacks something we have, upload a fresh snapshot and remember its
//     revision so we never download our own upload.
// Attachments are hard-deleted locally, so their deletions travel as tombstones.

import { db } from '../db';
import { emitChange, onChange, type ChangeEvent } from '../changes';
import { nowIso, uuid } from '../ids';
import { sleep } from '../net';
import * as repo from '../repo';
import type { Attachment, Paper } from '../types';
import { getDriveAccount } from './auth';
import { downloadFile, ensureFolderPath, findByAppProperty, getFile, trashFile, uploadFile, type DriveFile } from './api';
import { KV, ROOT_FOLDER, SYNC_FILE, SYNC_FOLDER } from './config';

export interface SyncReport {
  pulled: number; // records changed locally by the merge
  pushed: boolean; // uploaded a new snapshot
  at: string;
  error?: string;
}

const SYNC_PROP = { key: 'archive', value: 'sync' };
const SNAPSHOT_VERSION = 1;
/** Attachments (figure crops) bigger than this stay on their device. */
const MAX_ATTACHMENT_CHARS = 1.5 * 1024 * 1024;
const LEASE_MS = 2 * 60 * 1000;
const LEASE_WAIT_MS = 15000;
const MAX_TOMBSTONES = 5000;

type TableName = 'papers' | 'library' | 'annotations' | 'projects' | 'topics' | 'threads' | 'attachments' | 'follows' | 'feed';

const TABLES: { name: TableName; key: (r: any) => string; indexed: boolean }[] = [
  { name: 'papers', key: (r) => r.id, indexed: true },
  { name: 'library', key: (r) => r.paperId, indexed: true },
  { name: 'annotations', key: (r) => r.id, indexed: true },
  { name: 'projects', key: (r) => r.id, indexed: true },
  { name: 'topics', key: (r) => r.id, indexed: true },
  { name: 'threads', key: (r) => r.id, indexed: true },
  { name: 'attachments', key: (r) => r.id, indexed: false },
  { name: 'follows', key: (r) => r.id, indexed: true },
  { name: 'feed', key: (r) => r.id, indexed: true },
];
const SYNCED_TABLES = new Set<string>(TABLES.map((t) => t.name));

/** Per table: "count|max updatedAt". */
type Fingerprint = Record<string, string>;

interface SyncState {
  fileId?: string;
  revision?: string; // revision of the sync file the local DB already includes
  pushedSeq: number; // highest change-log seq included in what Drive has
  fingerprint?: Fingerprint;
  tombstones: string[]; // attachment ids deleted on some device
  device?: string;
  lastSyncAt?: string;
}

type Snapshot = Partial<Record<TableName, any[]>> & {
  format: string;
  version: number;
  exportedAt?: string;
  sync?: { device?: string; tombstones?: { attachments?: string[] } };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let running: Promise<SyncReport> | null = null;
let queued: Promise<SyncReport> | null = null;
/** > 0 while this context writes merged records, so its own change events are ignored. */
let merging = 0;

/** Pull and push once. Never throws: failures are in `error`. Concurrent calls share one follow-up run. */
export function syncNow(): Promise<SyncReport> {
  if (!running) return start();
  if (!queued) {
    const next = () => {
      queued = null;
      return start();
    };
    queued = running.then(next, next);
  }
  return queued;
}

/** When this device last finished a sync, if ever. */
export async function lastSyncedAt(): Promise<string | null> {
  return (await readState()).lastSyncAt ?? null;
}

/**
 * Keep syncing while this context runs: once now, 20 s after the last local change,
 * and every 10 minutes. Each run checks `getEnabled()` and that Drive is connected.
 * Returns a stop function. In an MV3 service worker timers die with the worker, so
 * also call syncNow() from an alarm.
 */
export function startAutoSync(getEnabled: () => Promise<boolean>, opts: { debounceMs?: number; intervalMs?: number } = {}): () => void {
  const debounceMs = opts.debounceMs ?? 20000;
  const intervalMs = opts.intervalMs ?? 10 * 60 * 1000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped) return;
    try {
      if (!(await getEnabled()) || !(await getDriveAccount())) return;
      const r = await syncNow();
      if (r.error) console.warn('[archive] Drive sync:', r.error);
    } catch (e) {
      console.warn('[archive] Drive sync failed', e);
    }
  };
  const off = onChange((evt) => {
    if (stopped || merging > 0 || !triggersSync(evt)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), debounceMs);
  });
  void run();
  const interval = setInterval(() => void run(), intervalMs);
  return () => {
    stopped = true;
    off();
    if (timer) clearTimeout(timer);
    clearInterval(interval);
  };
}

function triggersSync(evt: ChangeEvent): boolean {
  if (evt.table === 'drive') return evt.keys.includes('connected');
  return evt.table === '*' || SYNCED_TABLES.has(evt.table);
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

function start(): Promise<SyncReport> {
  const p: Promise<SyncReport> = runSync().finally(() => {
    if (running === p) running = null;
  });
  running = p;
  return p;
}

async function runSync(): Promise<SyncReport> {
  const report: SyncReport = { pulled: 0, pushed: false, at: nowIso() };
  try {
    if (!(await getDriveAccount())) return { ...report, error: 'Connect Google Drive to sync.' };
    if (!(await acquireLease())) return { ...report, error: 'Another sync is still running. Try again in a moment.' };
    try {
      await doSync(report);
    } finally {
      await releaseLease();
    }
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
  }
  report.at = nowIso();
  return report;
}

async function doSync(report: SyncReport): Promise<void> {
  const state = await readState();
  state.device ??= uuid();
  const seqStart = await maxSeq();
  const fpStart = await fingerprint();
  const localDead = await locallyDeletedAttachments();
  // Before the first sync there is no fingerprint: comparing with the file decides instead.
  let needPush = seqStart > state.pushedSeq || (!!state.fingerprint && !sameFingerprint(fpStart, state.fingerprint));
  // Rows vanished locally (Clear all data, a deleted attachment): read Drive again before overwriting it.
  let forceDownload = countsDropped(fpStart, state.fingerprint);
  let tombstones = union(state.tombstones, localDead);

  const found = await locateSyncFiles(state);
  let file: DriveFile | null = found[0] ?? null;
  const duplicates = found.slice(1);
  let pending: DriveFile[] = found;

  for (let round = 0; ; round++) {
    for (const f of pending) {
      const canonical: boolean = f.id === file?.id;
      const target: DriveFile | null = canonical && !forceDownload ? await changedSince(f, state) : f;
      if (!target) continue;
      const snap = parseSnapshot(await downloadFile(target.id));
      if (snap) {
        const remoteDead = snap.sync?.tombstones?.attachments ?? [];
        tombstones = union(tombstones, remoteDead);
        const m = await mergeRemote(snap, new Set(tombstones), remoteDead);
        report.pulled += m.pulled;
        if (m.localAhead) needPush = true;
        const known = new Set(remoteDead);
        if (localDead.some((id) => !known.has(id))) needPush = true;
      } else if (canonical) {
        needPush = true; // unreadable: replace it with a good snapshot
      }
      if (canonical) {
        file = target;
        state.fileId = target.id;
        state.revision = revisionOf(target);
      } else {
        needPush = true; // fold the duplicate into the canonical file
      }
    }
    forceDownload = false;
    if (!file) needPush = !isEmpty(fpStart); // no file yet: create it, unless there is nothing to put in it
    if (!needPush) break;

    // Someone may have pushed while we merged: merge that first (twice at most).
    if (file && round < 2) {
      const fresh = await getFile(file.id);
      if (!fresh || fresh.trashed) {
        file = null;
      } else if (revisionOf(fresh) !== state.revision) {
        pending = [fresh];
        continue;
      }
    }

    // renew before a possibly long upload; if another context took over meanwhile, let it finish
    if (!(await tryLease())) throw new Error('Another sync took over. Try again in a moment.');
    const seqPush = await maxSeq();
    const fpPush = await fingerprint();
    const body = await buildSnapshot(tombstones, state.device);
    const appProperties = { [SYNC_PROP.key]: SYNC_PROP.value };
    const up = file
      ? await uploadFile({ fileId: file.id, name: SYNC_FILE, mimeType: 'application/json', body, appProperties })
      : await uploadFile({ name: SYNC_FILE, parentId: await ensureFolderPath([ROOT_FOLDER, SYNC_FOLDER]), mimeType: 'application/json', body, appProperties });
    report.pushed = true;
    state.fileId = up.id;
    state.revision = revisionOf(up);
    state.pushedSeq = seqPush;
    state.fingerprint = fpPush;
    for (const dup of duplicates) if (dup.id !== up.id) await trashFile(dup.id).catch(() => undefined);
    await finish(state, tombstones);
    return;
  }
  state.pushedSeq = Math.max(state.pushedSeq, seqStart);
  state.fingerprint = await fingerprint();
  await finish(state, tombstones);
}

async function finish(state: SyncState, tombstones: string[]) {
  state.tombstones = tombstones.slice(-MAX_TOMBSTONES);
  state.lastSyncAt = nowIso();
  await writeState(state);
}

// ---------------------------------------------------------------------------
// Locating the file
// ---------------------------------------------------------------------------

const revisionOf = (f: DriveFile) => f.headRevisionId || f.md5Checksum || f.modifiedTime || '';

/** Every live sync file, oldest first. The oldest is canonical; others came from a race and get folded in. */
async function locateSyncFiles(state: SyncState): Promise<DriveFile[]> {
  const all = new Map((await findByAppProperty(SYNC_PROP.key, SYNC_PROP.value)).map((f) => [f.id, f] as const));
  // Drive's search can lag behind a file created moments ago; the id we know is authoritative.
  if (state.fileId && !all.has(state.fileId)) {
    const known = await getFile(state.fileId);
    if (known && !known.trashed) all.set(known.id, known);
  }
  return [...all.values()].sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? '') || a.id.localeCompare(b.id));
}

/** The file's current metadata if its content changed since our last merge, else null. */
async function changedSince(f: DriveFile, state: SyncState): Promise<DriveFile | null> {
  if (f.id === state.fileId && revisionOf(f) === state.revision) return null;
  // Listings can be stale; confirm with a direct read before downloading.
  const fresh = await getFile(f.id);
  if (!fresh || fresh.trashed) return null;
  if (fresh.id === state.fileId && revisionOf(fresh) === state.revision) return null;
  return fresh;
}

function parseSnapshot(buf: ArrayBuffer): Snapshot | null {
  let data: Snapshot;
  try {
    data = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (data.format !== 'archive-backup') throw new Error('The sync file in Drive is not an Archive library. Delete Archive/.sync/library.json in Drive to start over.');
  if (Number(data.version) > SNAPSHOT_VERSION) throw new Error('The sync file was written by a newer version of Archive. Update Archive on this device.');
  return data;
}

// ---------------------------------------------------------------------------
// Merge and snapshot
// ---------------------------------------------------------------------------

/** a is strictly newer than b. On a tie, a deletion wins. */
function newer(a: any, b: any): boolean {
  if (!a) return false;
  if (!b) return true;
  const au = a.updatedAt ?? '';
  const bu = b.updatedAt ?? '';
  if (au !== bu) return au > bu;
  return !!a.deletedAt && !b.deletedAt;
}

const syncableAttachment = (a: Attachment) => (a.dataUrl?.length ?? 0) <= MAX_ATTACHMENT_CHARS;

async function mergeRemote(remote: Snapshot, dead: Set<string>, remoteDead: string[]): Promise<{ pulled: number; localAhead: boolean }> {
  const d = db() as any;
  const incoming: Partial<Record<TableName, any[]>> = {};
  let localAhead = false;
  for (const t of TABLES) {
    const rows: any[] = Array.isArray(remote[t.name]) ? remote[t.name]! : [];
    const local: any[] = await d[t.name].toArray();
    const byKey = new Map(local.map((r) => [t.key(r), r] as const));
    const seen = new Set<string>();
    const take: any[] = [];
    for (const r of rows) {
      const k = r ? t.key(r) : undefined;
      if (k == null) continue;
      seen.add(k);
      if (t.name === 'attachments' && dead.has(k)) continue;
      const l = byKey.get(k);
      if (newer(r, l)) {
        // feed embeddings are not uploaded; keep the one this device has
        take.push(t.name === 'feed' && l?.embedding && !r.embedding ? { ...r, embedding: l.embedding } : r);
      } else if (newer(l, r)) {
        localAhead = true;
      }
    }
    if (!localAhead) {
      for (const [k, l] of byKey) {
        if (seen.has(k)) continue;
        if (t.name === 'attachments' && (dead.has(k) || !syncableAttachment(l))) continue;
        localAhead = true;
        break;
      }
    }
    if (take.length) incoming[t.name] = take;
  }

  let pulled = 0;
  const gone = (await d.attachments.bulkGet(remoteDead)).filter(Boolean) as Attachment[];
  merging++;
  try {
    if (Object.keys(incoming).length) {
      const data = {
        format: 'archive-backup',
        version: 1,
        exportedAt: nowIso(),
        papers: incoming.papers ?? [],
        library: incoming.library ?? [],
        annotations: incoming.annotations ?? [],
        projects: incoming.projects ?? [],
        topics: incoming.topics ?? [],
        threads: incoming.threads ?? [],
        attachments: incoming.attachments ?? [],
        follows: incoming.follows ?? [],
        feed: incoming.feed ?? [],
      } as Parameters<typeof repo.importAll>[0];
      pulled += await repo.importAll(data);
    }
    if (gone.length) {
      await d.attachments.bulkDelete(gone.map((a) => a.id));
      pulled += gone.length;
      emitChange({ table: 'attachments', keys: gone.map((a) => a.id), paperIds: [...new Set(gone.map((a) => a.paperId))] });
    }
  } finally {
    merging--;
  }
  return { pulled, localAhead };
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

function slimPaper(p: Paper): Paper {
  return p.s2?.embedding?.length ? { ...p, s2: { ...p.s2, embedding: p.s2.embedding.map(round4) } } : p;
}

/** The whole library as JSON, minus large figures and feed embeddings, with rounded paper embeddings. */
async function buildSnapshot(tombstones: string[], device?: string): Promise<string> {
  const data = await repo.exportAll();
  const dead = new Set(tombstones);
  return JSON.stringify({
    ...data,
    papers: data.papers.map(slimPaper),
    attachments: data.attachments.filter((a) => syncableAttachment(a) && !dead.has(a.id)),
    feed: data.feed.map(({ embedding: _drop, ...rest }) => rest),
    sync: { device, tombstones: { attachments: tombstones.slice(-MAX_TOMBSTONES) } },
  });
}

// ---------------------------------------------------------------------------
// Local change detection
// ---------------------------------------------------------------------------

async function maxSeq(): Promise<number> {
  return (await db().changes.toCollection().last())?.seq ?? 0;
}

async function fingerprint(): Promise<Fingerprint> {
  const d = db() as any;
  const fp: Fingerprint = {};
  for (const t of TABLES) {
    const table = d[t.name];
    const count: number = await table.count();
    const max: string = t.indexed ? ((await table.orderBy('updatedAt').last())?.updatedAt ?? '') : '';
    fp[t.name] = `${count}|${max}`;
  }
  return fp;
}

const countOf = (fp: Fingerprint | undefined, t: string) => Number((fp?.[t] ?? '0|').split('|')[0]) || 0;

function sameFingerprint(a: Fingerprint, b: Fingerprint | undefined): boolean {
  return !!b && TABLES.every((t) => a[t.name] === b[t.name]);
}

function countsDropped(now: Fingerprint, before: Fingerprint | undefined): boolean {
  return !!before && TABLES.some((t) => countOf(now, t.name) < countOf(before, t.name));
}

const isEmpty = (fp: Fingerprint) => TABLES.every((t) => countOf(fp, t.name) === 0);

async function locallyDeletedAttachments(): Promise<string[]> {
  const rows = await db().changes.where('table').equals('attachments').toArray();
  return rows.filter((c) => c.op === 'delete').map((c) => c.key);
}

function union(a: string[], b: string[]): string[] {
  const seen = new Set(a);
  const out = [...a];
  for (const x of b) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// State and the cross-context lease
// ---------------------------------------------------------------------------

async function readState(): Promise<SyncState> {
  const v = (await db().kv.get(KV.sync))?.value as Partial<SyncState> | undefined;
  return { pushedSeq: 0, tombstones: [], ...v };
}

async function writeState(s: SyncState): Promise<void> {
  await db().kv.put({ key: KV.sync, value: s });
}

// Extension pages, the background and web app tabs share one IndexedDB, so a lease row
// written in a kv transaction keeps two of them from syncing at once. It expires on its
// own if its holder dies mid-sync (an MV3 service worker being stopped, a closed tab).
const leaseOwner = uuid();

async function tryLease(): Promise<boolean> {
  const d = db();
  return d.transaction('rw', d.kv, async () => {
    const cur = (await d.kv.get(KV.lease))?.value as { owner: string; until: number } | undefined;
    if (cur && cur.owner !== leaseOwner && cur.until > Date.now()) return false;
    await d.kv.put({ key: KV.lease, value: { owner: leaseOwner, until: Date.now() + LEASE_MS } });
    return true;
  });
}

async function acquireLease(): Promise<boolean> {
  const deadline = Date.now() + LEASE_WAIT_MS;
  for (;;) {
    if (await tryLease()) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
}

async function releaseLease(): Promise<void> {
  const d = db();
  await d.transaction('rw', d.kv, async () => {
    const cur = (await d.kv.get(KV.lease))?.value as { owner: string } | undefined;
    if (cur?.owner === leaseOwner) await d.kv.delete(KV.lease);
  });
}
