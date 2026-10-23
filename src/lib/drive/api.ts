// A small Google Drive v3 client: authorized fetch with retries, folders, uploads,
// downloads and anyone-with-the-link sharing. With the drive.file scope every call
// here only ever sees files Archive created.

import { db } from '../db';
import { uuid } from '../ids';
import { HttpError, fetchWithRetry, sleep, type FetchOpts } from '../net';
import { DriveAuthError, getAccessToken, getDriveAccount } from './auth';
import { DRIVE_API, DRIVE_UPLOAD_API, KV } from './config';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  md5Checksum?: string;
  appProperties?: Record<string, string>;
  trashed?: boolean;
  headRevisionId?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
}

export class DriveApiError extends HttpError {
  constructor(status: number, message: string, public reason?: string) {
    super(status, message);
    this.name = 'DriveApiError';
  }
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,createdTime,md5Checksum,appProperties,trashed,headRevisionId,size,webViewLink,parents';
const FIELDS_Q = `fields=${encodeURIComponent(FILE_FIELDS)}`;
/** Bodies above this go through a resumable upload. */
export const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KiB
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=UTF-8' };
const enc = encodeURIComponent;

let rateLimitBackoffMs = 1000;

// ---------------------------------------------------------------------------
// Authorized fetch
// ---------------------------------------------------------------------------

export interface DriveFetchOpts extends Omit<FetchOpts, 'headers'> {
  headers?: Record<string, string>;
  /** Statuses that are not errors for this call (308 during a resumable upload, 404 for idempotent deletes). */
  accept?: number[];
}

/**
 * fetch with the Drive token. Retries 429/5xx with backoff (fetchWithRetry), retries
 * once after a silent token refresh on 401, and backs off on Drive's 403 rate limits.
 */
export async function driveFetch(url: string, opts: DriveFetchOpts = {}): Promise<Response> {
  const { accept = [], headers = {}, ...init } = opts;
  let token = await requireToken(false);
  let refreshed = false;
  let rateRetries = 0;
  for (;;) {
    const res = await fetchWithRetry(url, { retries: 3, ...init, headers: { ...headers, Authorization: `Bearer ${token}` } });
    if (res.ok || accept.includes(res.status)) return res;
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      token = await requireToken(true);
      continue;
    }
    if (res.status === 403 && rateRetries < 4) {
      const reason = (await readError(res.clone())).reason;
      if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
        await sleep(rateLimitBackoffMs * 2 ** rateRetries++);
        continue;
      }
    }
    throw await toApiError(res);
  }
}

async function requireToken(forceRefresh: boolean): Promise<string> {
  const t = await getAccessToken({ interactive: false, forceRefresh });
  if (t) return t;
  if (!(await getDriveAccount())) throw new DriveAuthError('not_connected', 'Connect Google Drive in Settings first.');
  throw new DriveAuthError('needs_reconnect', 'Reconnect Google Drive to continue.');
}

async function readError(res: Response): Promise<{ message?: string; reason?: string }> {
  try {
    const j = (await res.json()) as { error?: { message?: string; status?: string; errors?: { reason?: string }[] } };
    return { message: j.error?.message, reason: j.error?.errors?.[0]?.reason ?? j.error?.status };
  } catch {
    return {};
  }
}

async function toApiError(res: Response): Promise<DriveApiError> {
  const { message, reason } = await readError(res);
  const text =
    reason === 'storageQuotaExceeded'
      ? 'Your Google Drive storage is full.'
      : `Google Drive: ${message ?? `${res.status} ${res.statusText}`.trim()}`;
  return new DriveApiError(res.status, text, reason);
}

async function driveJson<T>(url: string, opts: DriveFetchOpts = {}): Promise<T> {
  const res = await driveFetch(url, opts);
  return (await res.json()) as T;
}

const notFound = (e: unknown) => e instanceof HttpError && e.status === 404;

// ---------------------------------------------------------------------------
// Finding files
// ---------------------------------------------------------------------------

/** A string literal for a Drive query. */
export function quoteQ(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export async function findFiles(q: string, opts: { orderBy?: string; limit?: number } = {}): Promise<DriveFile[]> {
  const limit = opts.limit ?? 1000;
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({ q, fields: `nextPageToken,files(${FILE_FIELDS})`, spaces: 'drive', pageSize: String(Math.min(limit, 1000)) });
    if (opts.orderBy) p.set('orderBy', opts.orderBy);
    if (pageToken) p.set('pageToken', pageToken);
    const j = await driveJson<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE_API}/files?${p.toString()}`);
    out.push(...(j.files ?? []));
    pageToken = j.nextPageToken;
  } while (pageToken && out.length < limit);
  return out.slice(0, limit);
}

/** Live (not trashed) files tagged with an app property, oldest first. */
export function findByAppProperty(key: string, value: string, parentId?: string): Promise<DriveFile[]> {
  let q = `appProperties has { key=${quoteQ(key)} and value=${quoteQ(value)} } and trashed = false`;
  if (parentId) q += ` and ${quoteQ(parentId)} in parents`;
  return findFiles(q, { orderBy: 'createdTime' });
}

/** File metadata, or null when it was deleted for good (or Archive can no longer see it). */
export async function getFile(id: string): Promise<DriveFile | null> {
  try {
    return await driveJson<DriveFile>(`${DRIVE_API}/files/${enc(id)}?${FIELDS_Q}`);
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

let folderChain: Promise<unknown> = Promise.resolve();

/**
 * Id of the folder at this path under My Drive (e.g. ['Archive', 'Thesis']), creating
 * what is missing. Ids are cached in kv; a cached folder that was trashed or deleted
 * is recreated. Calls are serialized so parallel saves don't create twin folders.
 */
export function ensureFolderPath(names: string[]): Promise<string> {
  const run = folderChain.then(() => ensureFolderPathNow(names));
  folderChain = run.catch(() => undefined);
  return run;
}

async function ensureFolderPathNow(names: string[]): Promise<string> {
  if (!names.length) return 'root';
  const d = db();
  const cache: Record<string, string> = { ...((await d.kv.get(KV.folders))?.value as Record<string, string> | undefined) };
  const keyAt = (i: number) => names.slice(0, i + 1).join('/');
  const last = names.length - 1;
  const cachedLeaf = cache[keyAt(last)];
  if (cachedLeaf && (await folderAlive(cachedLeaf))) return cachedLeaf;

  let parent = 'root';
  for (let i = 0; i <= last; i++) {
    const k = keyAt(i);
    let id: string | undefined = cache[k];
    if (id && (i === last || !(await folderAlive(id)))) id = undefined;
    if (!id) {
      const found = await findFolder(names[i], parent);
      id = found?.id ?? (await createFolder(names[i], parent)).id;
      if (!found) for (const key of Object.keys(cache)) if (key.startsWith(`${k}/`)) delete cache[key];
      cache[k] = id;
    }
    parent = id;
  }
  await d.kv.put({ key: KV.folders, value: cache });
  return parent;
}

async function folderAlive(id: string): Promise<boolean> {
  const f = await getFile(id);
  return !!f && !f.trashed && f.mimeType === FOLDER_MIME;
}

async function findFolder(name: string, parentId: string): Promise<DriveFile | undefined> {
  const q = `name = ${quoteQ(name)} and mimeType = '${FOLDER_MIME}' and ${quoteQ(parentId)} in parents and trashed = false`;
  return (await findFiles(q, { orderBy: 'createdTime', limit: 10 }))[0];
}

export function createFolder(name: string, parentId = 'root'): Promise<DriveFile> {
  return driveJson<DriveFile>(`${DRIVE_API}/files?${FIELDS_Q}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
}

// ---------------------------------------------------------------------------
// Uploads and downloads
// ---------------------------------------------------------------------------

export interface UploadOptions {
  name: string;
  parentId?: string;
  mimeType: string;
  body: Blob | Uint8Array | ArrayBuffer | string;
  appProperties?: Record<string, string>;
  /** Replace this file's content in place instead of creating a new file. */
  fileId?: string;
  /** On update, also set the name. By default a name the user changed in Drive is kept. */
  rename?: boolean;
}

/** Create or update a file. Multipart up to 5 MB, resumable (in 8 MB chunks) above that. */
export async function uploadFile(o: UploadOptions): Promise<DriveFile> {
  const blob = toBlob(o.body, o.mimeType);
  const meta: Record<string, unknown> = { mimeType: o.mimeType };
  if (o.appProperties) meta.appProperties = o.appProperties;
  if (!o.fileId) {
    meta.name = o.name;
    if (o.parentId) meta.parents = [o.parentId];
  } else if (o.rename) {
    meta.name = o.name;
  }
  return blob.size > RESUMABLE_THRESHOLD ? resumableUpload(o.fileId, meta, blob, o.mimeType) : multipartUpload(o.fileId, meta, blob, o.mimeType);
}

function toBlob(body: UploadOptions['body'], type: string): Blob {
  if (body instanceof Blob) return body;
  if (typeof body === 'string') return new Blob([body], { type });
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  return new Blob([bytes as unknown as BlobPart], { type });
}

function uploadUrl(fileId: string | undefined, uploadType: 'multipart' | 'resumable'): string {
  return `${DRIVE_UPLOAD_API}/files${fileId ? `/${enc(fileId)}` : ''}?uploadType=${uploadType}&${FIELDS_Q}`;
}

async function multipartUpload(fileId: string | undefined, meta: Record<string, unknown>, blob: Blob, mime: string): Promise<DriveFile> {
  const boundary = `archive-${uuid()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  return driveJson<DriveFile>(uploadUrl(fileId, 'multipart'), {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    timeoutMs: 120000,
  });
}

async function resumableUpload(fileId: string | undefined, meta: Record<string, unknown>, blob: Blob, mime: string): Promise<DriveFile> {
  const total = blob.size;
  const start = await driveFetch(uploadUrl(fileId, 'resumable'), {
    method: fileId ? 'PATCH' : 'POST',
    headers: { ...JSON_HEADERS, 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(total) },
    body: JSON.stringify(meta),
  });
  const session = start.headers.get('Location');
  if (!session) throw new DriveApiError(start.status, 'Google Drive did not start the upload.');
  let offset = 0;
  let resumes = 0;
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    let res: Response;
    try {
      res = await driveFetch(session, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
        body: blob.slice(offset, end),
        accept: [308],
        retries: 0,
        timeoutMs: 300000,
      });
    } catch (e) {
      const retryable = !(e instanceof DriveAuthError) && (!(e instanceof HttpError) || e.status >= 500 || e.status === 429);
      if (!retryable || resumes >= 3) throw e;
      resumes++;
      await sleep(1000 * resumes);
      const st = await uploadStatus(session, total);
      if (st.file) return st.file;
      offset = st.offset;
      continue;
    }
    if (res.status === 308) {
      offset = rangeEnd(res.headers.get('Range')) ?? end;
      continue;
    }
    return (await res.json()) as DriveFile;
  }
  const st = await uploadStatus(session, total);
  if (st.file) return st.file;
  throw new DriveApiError(500, 'Google Drive did not finish the upload.');
}

/** "bytes=0-1234" means bytes up to 1234 arrived, so the next offset is 1235. */
function rangeEnd(range: string | null): number | undefined {
  const m = range?.match(/bytes=0-(\d+)/);
  return m ? Number(m[1]) + 1 : undefined;
}

async function uploadStatus(session: string, total: number): Promise<{ offset: number; file?: DriveFile }> {
  const res = await driveFetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` }, accept: [308] });
  if (res.status === 308) return { offset: rangeEnd(res.headers.get('Range')) ?? 0 };
  return { offset: total, file: (await res.json()) as DriveFile };
}

export async function downloadFile(id: string): Promise<ArrayBuffer> {
  const res = await driveFetch(`${DRIVE_API}/files/${enc(id)}?alt=media`, { timeoutMs: 120000 });
  return res.arrayBuffer();
}

export async function trashFile(id: string): Promise<void> {
  await driveFetch(`${DRIVE_API}/files/${enc(id)}?fields=id,trashed`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ trashed: true }),
    accept: [404],
  });
}

// ---------------------------------------------------------------------------
// Public links (for Overleaf's "Add files > From external URL")
// ---------------------------------------------------------------------------

/** Direct download link for a file shared with "anyone with the link". */
export function directDownloadLink(id: string): string {
  return `https://drive.google.com/uc?export=download&id=${enc(id)}`;
}

/** Let anyone with the link read the file and return a direct download link. Safe to repeat. */
export async function makeLinkReadable(id: string): Promise<string> {
  await driveJson(`${DRIVE_API}/files/${enc(id)}/permissions?fields=id`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ type: 'anyone', role: 'reader', allowFileDiscovery: false }),
  });
  return directDownloadLink(id);
}

/** Remove every "anyone with the link" permission. No-op when there is none or the file is gone. */
export async function removePublicLink(id: string): Promise<void> {
  let perms: { id: string; type: string }[];
  try {
    perms = (await driveJson<{ permissions?: { id: string; type: string }[] }>(`${DRIVE_API}/files/${enc(id)}/permissions?fields=${enc('permissions(id,type,role)')}`)).permissions ?? [];
  } catch (e) {
    if (notFound(e)) return;
    throw e;
  }
  for (const p of perms.filter((x) => x.type === 'anyone')) {
    await driveFetch(`${DRIVE_API}/files/${enc(id)}/permissions/${enc(p.id)}`, { method: 'DELETE', accept: [404] });
  }
}

/** For tests: base delay for Drive's 403 rate-limit backoff. */
export function __setBackoffForTests(ms: number) {
  rateLimitBackoffMs = ms;
}
