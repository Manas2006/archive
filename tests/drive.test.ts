import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveDB, db, setDb } from '@/lib/db';
import * as repo from '@/lib/repo';
import type { FeedItem, Paper, Project } from '@/lib/types';
import { DRIVE_PERMISSIONS, DRIVE_SCOPES, KV, __setClientIdForTests, driveConfigured } from '@/lib/drive/config';
import {
  DriveAuthError,
  __setTokenProviderForTests,
  connectDrive,
  disconnectDrive,
  getAccessToken,
  getDriveAccount,
  parseAuthRedirect,
  reconnectDrive,
  type TokenOptions,
} from '@/lib/drive/auth';
import { DriveApiError, __setBackoffForTests, downloadFile, ensureFolderPath, findByAppProperty, findFiles, uploadFile } from '@/lib/drive/api';
import { propValue, sanitizeName, savePaperPdf, saveProjectBib } from '@/lib/drive/files';
import { startAutoSync, syncNow } from '@/lib/drive/sync';

// ---------------------------------------------------------------------------
// chrome.storage stub (settings live there; repo reads the user id from it)
// ---------------------------------------------------------------------------

const storage: Record<string, unknown> = {};
const chromeStub: any = {
  runtime: { id: 'test' },
  storage: {
    local: {
      get: async (k: string) => ({ [k]: storage[k] }),
      set: async (o: Record<string, unknown>) => void Object.assign(storage, o),
      remove: async (k: string) => void delete storage[k],
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
};
(globalThis as any).chrome = chromeStub;

// ---------------------------------------------------------------------------
// A small in-memory Google Drive v3
// ---------------------------------------------------------------------------

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties: Record<string, string>;
  trashed: boolean;
  content: Uint8Array | null;
  createdTime: string;
  modifiedTime: string;
  headRevisionId?: string;
  perms: { id: string; type: string; role: string }[];
}

interface Failure {
  match: RegExp;
  status: number;
  times: number;
  headers?: Record<string, string>;
  body?: unknown;
}

const FOLDER = 'application/vnd.google-apps.folder';

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}

function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function toBytes(body: unknown): Promise<Uint8Array> {
  if (body == null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (typeof (body as Blob).arrayBuffer === 'function') return new Uint8Array(await (body as Blob).arrayBuffer());
  throw new Error(`fake drive: unsupported body ${typeof body}`);
}

function parseMultipart(bytes: Uint8Array, contentType: string): { meta: any; media: Uint8Array; mediaType: string } {
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (!boundary) throw new Error('fake drive: no boundary');
  const parts = latin1(bytes).split(`--${boundary}`);
  if (parts[parts.length - 1] !== '--') throw new Error('fake drive: missing closing boundary');
  const parsed = parts.slice(1, -1).map((part) => {
    const i = part.indexOf('\r\n\r\n');
    const head = part.slice(2, i);
    let body = part.slice(i + 4);
    if (body.endsWith('\r\n')) body = body.slice(0, -2);
    return { head, body };
  });
  if (parsed.length !== 2) throw new Error(`fake drive: expected 2 parts, got ${parsed.length}`);
  expect(parsed[0].head).toMatch(/Content-Type: application\/json/i);
  return {
    meta: JSON.parse(new TextDecoder().decode(fromLatin1(parsed[0].body))),
    media: fromLatin1(parsed[1].body),
    mediaType: /Content-Type: ([^\r\n]+)/i.exec(parsed[1].head)![1],
  };
}

const unq = (s: string) => s.replace(/\\(.)/g, '$1');
const LIT = "'((?:\\\\.|[^'\\\\])*)'";

class FakeDrive {
  files = new Map<string, FakeFile>();
  tokens = new Set<string>(['tok']);
  revoked: string[] = [];
  log: string[] = [];
  failures: Failure[] = [];
  email = 'ada@example.com';
  private n = 0;
  private rev = 0;
  private clock = Date.parse('2026-01-01T00:00:00Z');
  private sessions = new Map<string, { fileId?: string; meta: any; total: number; mime: string; data: Uint8Array; received: number }>();

  count(kind: string) {
    return this.log.filter((x) => x === kind).length;
  }

  private now() {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  isTrashed(f: FakeFile): boolean {
    return f.trashed || f.parents.some((p) => {
      const parent = this.files.get(p);
      return parent ? this.isTrashed(parent) : false;
    });
  }

  meta(f: FakeFile) {
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      parents: f.parents,
      appProperties: { ...f.appProperties },
      trashed: this.isTrashed(f),
      createdTime: f.createdTime,
      modifiedTime: f.modifiedTime,
      headRevisionId: f.headRevisionId,
      size: f.content ? String(f.content.length) : undefined,
      webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
    };
  }

  /** Test helper: add a file directly. */
  put(init: Partial<FakeFile> & { name: string; mimeType: string }): FakeFile {
    const t = this.now();
    const f: FakeFile = { id: `f${++this.n}`, parents: ['root'], appProperties: {}, trashed: false, content: null, createdTime: t, modifiedTime: t, perms: [], ...init };
    if (f.content) f.headRevisionId = `r${++this.rev}`;
    this.files.set(f.id, f);
    return f;
  }

  /** Test helper: permanently delete a file and everything under it. */
  purge(id: string) {
    for (const f of [...this.files.values()]) if (f.parents.includes(id)) this.purge(f.id);
    this.files.delete(id);
  }

  byPath(path: string[]): FakeFile | undefined {
    let parent = 'root';
    let f: FakeFile | undefined;
    for (const name of path) {
      f = [...this.files.values()].find((x) => x.name === name && x.parents.includes(parent) && !this.isTrashed(x));
      if (!f) return undefined;
      parent = f.id;
    }
    return f;
  }

  private write(f: FakeFile, content: Uint8Array) {
    f.content = content;
    f.headRevisionId = `r${++this.rev}`;
    f.modifiedTime = this.now();
  }

  private create(meta: any, content: Uint8Array | null): FakeFile {
    for (const p of meta.parents ?? []) if (p !== 'root' && !this.files.has(p)) throw Object.assign(new Error('parent'), { status: 404 });
    const f = this.put({ name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? ['root'], appProperties: { ...(meta.appProperties ?? {}) } });
    if (content) this.write(f, content);
    return f;
  }

  private update(f: FakeFile, meta: any, content: Uint8Array) {
    if (meta.name) f.name = meta.name;
    if (meta.mimeType) f.mimeType = meta.mimeType;
    if (meta.appProperties) f.appProperties = { ...f.appProperties, ...meta.appProperties };
    this.write(f, content);
  }

  private matcher(q: string): (f: FakeFile) => boolean {
    const tests: ((f: FakeFile) => boolean)[] = [];
    let rest = q;
    const take = (re: RegExp, fn: (m: string[]) => (f: FakeFile) => boolean) => {
      rest = rest.replace(re, (...m: string[]) => {
        tests.push(fn(m));
        return ' ';
      });
    };
    take(new RegExp(`appProperties has \\{ key=${LIT} and value=${LIT} \\}`, 'g'), (m) => (f) => f.appProperties[unq(m[1])] === unq(m[2]));
    take(new RegExp(`name = ${LIT}`, 'g'), (m) => (f) => f.name === unq(m[1]));
    take(new RegExp(`mimeType = ${LIT}`, 'g'), (m) => (f) => f.mimeType === unq(m[1]));
    take(/trashed = (true|false)/g, (m) => (f) => this.isTrashed(f) === (m[1] === 'true'));
    take(new RegExp(`${LIT} in parents`, 'g'), (m) => (f) => f.parents.includes(unq(m[1])));
    if (rest.replace(/\band\b/g, '').trim()) throw new Error(`fake drive: unsupported query ${q}`);
    return (f) => tests.every((t) => t(f));
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const json = (status: number, body: unknown, h: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...h } });
    const notFound = () => json(404, { error: { code: 404, message: 'File not found.', errors: [{ reason: 'notFound' }] } });

    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/revoke' && method === 'POST') {
      const t = url.searchParams.get('token') ?? '';
      this.revoked.push(t);
      this.tokens.delete(t);
      return json(200, {});
    }
    if (url.host !== 'www.googleapis.com') return json(404, { error: { code: 404, message: `unexpected host ${url.host}` } });

    const sig = `${method} ${url.pathname}${url.search}`;
    for (const f of this.failures) {
      if (f.times > 0 && f.match.test(sig)) {
        f.times--;
        return new Response(JSON.stringify(f.body ?? { error: { code: f.status, message: 'injected' } }), { status: f.status, headers: f.headers });
      }
    }

    // resumable session uploads authenticate with the session id
    if (method === 'PUT' && url.searchParams.has('upload_id')) return this.sessionPut(url, headers, init.body, json);

    const token = headers.get('Authorization')?.replace(/^Bearer /, '');
    if (!token || !this.tokens.has(token)) return json(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } });

    const p = url.pathname;
    let m: RegExpMatchArray | null;
    if (p === '/drive/v3/about') {
      this.log.push('about');
      expect(url.searchParams.get('fields')).toContain('emailAddress');
      return json(200, { user: { emailAddress: this.email, displayName: 'Ada' } });
    }
    if (p === '/drive/v3/files' && method === 'GET') {
      this.log.push('list');
      const match = this.matcher(url.searchParams.get('q') ?? '');
      let rows = [...this.files.values()].filter(match);
      if (url.searchParams.get('orderBy')?.startsWith('createdTime')) rows.sort((a, b) => a.createdTime.localeCompare(b.createdTime));
      const size = Number(url.searchParams.get('pageSize') ?? 100);
      const from = Number(url.searchParams.get('pageToken') ?? 0);
      const page = rows.slice(from, from + size);
      return json(200, { files: page.map((f) => this.meta(f)), ...(from + size < rows.length ? { nextPageToken: String(from + size) } : {}) });
    }
    if (p === '/drive/v3/files' && method === 'POST') {
      this.log.push('create-folder');
      const meta = JSON.parse(String(init.body));
      try {
        return json(200, this.meta(this.create(meta, null)));
      } catch {
        return notFound();
      }
    }
    if ((m = p.match(/^\/drive\/v3\/files\/([^/]+)$/))) {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f) return notFound();
      if (method === 'GET' && url.searchParams.get('alt') === 'media') {
        this.log.push('download');
        return new Response((f.content ?? new Uint8Array()) as unknown as BodyInit, { status: 200 });
      }
      if (method === 'GET') {
        this.log.push('get');
        return json(200, this.meta(f));
      }
      if (method === 'PATCH') {
        this.log.push('trash');
        const body = JSON.parse(String(init.body));
        if ('trashed' in body) f.trashed = !!body.trashed;
        return json(200, this.meta(f));
      }
    }
    if ((m = p.match(/^\/drive\/v3\/files\/([^/]+)\/permissions$/))) {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f) return notFound();
      if (method === 'GET') {
        this.log.push('perm-list');
        return json(200, { permissions: f.perms });
      }
      if (method === 'POST') {
        this.log.push('perm-create');
        const body = JSON.parse(String(init.body));
        let perm = f.perms.find((x) => x.type === body.type && x.role === body.role);
        if (!perm) f.perms.push((perm = { id: body.type === 'anyone' ? 'anyoneWithLink' : `perm${++this.n}`, type: body.type, role: body.role }));
        return json(200, { id: perm.id });
      }
    }
    if ((m = p.match(/^\/drive\/v3\/files\/([^/]+)\/permissions\/([^/]+)$/)) && method === 'DELETE') {
      this.log.push('perm-delete');
      const f = this.files.get(decodeURIComponent(m[1]));
      const before = f?.perms.length ?? 0;
      if (f) f.perms = f.perms.filter((x) => x.id !== decodeURIComponent(m![2]));
      return f && f.perms.length < before ? new Response(null, { status: 204 }) : notFound();
    }
    if ((m = p.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/))) {
      const existing = m[1] ? this.files.get(decodeURIComponent(m[1])) : undefined;
      if (m[1] && !existing) return notFound();
      if (existing && method !== 'PATCH') return json(400, { error: { code: 400, message: 'update must be PATCH' } });
      const type = url.searchParams.get('uploadType');
      if (type === 'multipart') {
        this.log.push(existing ? 'update-multipart' : 'upload-multipart');
        const { meta, media, mediaType } = parseMultipart(await toBytes(init.body), headers.get('Content-Type') ?? '');
        expect(mediaType).toBe(meta.mimeType);
        if (existing) {
          this.update(existing, meta, media);
          return json(200, this.meta(existing));
        }
        try {
          return json(200, this.meta(this.create(meta, media)));
        } catch {
          return notFound();
        }
      }
      if (type === 'resumable') {
        this.log.push('resumable-start');
        const meta = JSON.parse(String(init.body));
        const total = Number(headers.get('X-Upload-Content-Length'));
        const sid = `s${++this.n}`;
        this.sessions.set(sid, { fileId: existing?.id, meta, total, mime: headers.get('X-Upload-Content-Type') ?? '', data: new Uint8Array(total), received: 0 });
        return new Response(null, { status: 200, headers: { Location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${sid}` } });
      }
    }
    return json(400, { error: { code: 400, message: `fake drive: unhandled ${sig}` } });
  };

  private async sessionPut(url: URL, headers: Headers, body: unknown, json: (s: number, b: unknown) => Response): Promise<Response> {
    const s = this.sessions.get(url.searchParams.get('upload_id') ?? '');
    if (!s) return json(404, { error: { code: 404, message: 'no session' } });
    const range = headers.get('Content-Range') ?? '';
    const incomplete = () => new Response(null, { status: 308, headers: s.received ? { Range: `bytes=0-${s.received - 1}` } : {} });
    if (/^bytes \*\//.test(range)) {
      this.log.push('status');
      if (s.received < s.total) return incomplete();
    } else {
      this.log.push('chunk');
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (!m || Number(m[1]) !== s.received) return json(400, { error: { code: 400, message: `bad range ${range} at ${s.received}` } });
      const bytes = await toBytes(body);
      expect(bytes.length).toBe(Number(m[2]) - Number(m[1]) + 1);
      s.data.set(bytes, s.received);
      s.received += bytes.length;
      if (s.received < s.total) return incomplete();
    }
    const existing = s.fileId ? this.files.get(s.fileId) : undefined;
    const meta = { mimeType: s.mime, ...s.meta };
    if (existing) {
      this.update(existing, meta, s.data);
      return json(200, this.meta(existing));
    }
    return json(200, this.meta(this.create(meta, s.data)));
  }
}

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

let drive: FakeDrive;
let dbCount = 0;

async function newDevice(): Promise<ArchiveDB> {
  const d = new ArchiveDB(`drive-test-${++dbCount}-${Math.random().toString(36).slice(2)}`);
  await d.open();
  setDb(d);
  return d;
}

function use(d: ArchiveDB) {
  setDb(d);
}

function paperFixture(id: string, extra: Partial<Paper> = {}): Paper {
  const now = new Date().toISOString();
  return {
    owner: 'u',
    visibility: 'private',
    groupId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    id,
    aliases: [],
    source: 'arxiv',
    title: `Paper ${id}`,
    authors: [{ name: 'Ada Lovelace' }],
    abstract: '',
    year: 2024,
    published: null,
    venue: null,
    venueStatus: 'preprint',
    urls: {},
    codeLinks: [],
    citeKey: `lovelace2024${id.replace(/\W/g, '')}`,
    bibtex: '',
    bibtexSource: 'arxiv',
    ...extra,
  };
}

function projectFixture(name: string): Project {
  const now = new Date().toISOString();
  return { owner: 'u', visibility: 'private', groupId: null, createdAt: now, updatedAt: now, deletedAt: null, id: `proj-${name.length}`, name, description: '', seedPaperIds: [], color: '#000' };
}

function feedFixture(id: string, embedding: number[]): FeedItem {
  const now = new Date().toISOString();
  return {
    owner: 'u',
    visibility: 'private',
    groupId: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    id,
    title: `Feed ${id}`,
    authors: [],
    abstract: '',
    year: 2025,
    published: null,
    venue: null,
    urls: {},
    reasons: [{ kind: 'cites', count: 2 }],
    score: 0.5,
    status: 'new',
    foundAt: now,
    embedding,
  };
}

const bytes = (n: number, seed = 1) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
};

function sameBytes(a: Uint8Array | ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  const x = a instanceof ArrayBuffer ? new Uint8Array(a) : a;
  if (!x || x.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (x[i] !== b[i]) return false;
  return true;
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

async function until(fn: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(10);
  }
}

function syncFileJson(): any {
  const f = [...drive.files.values()].find((x) => x.appProperties.archive === 'sync' && !drive.isTrashed(x));
  return f?.content ? JSON.parse(new TextDecoder().decode(f.content)) : null;
}

beforeEach(async () => {
  drive = new FakeDrive();
  vi.stubGlobal('fetch', drive.fetch);
  __setClientIdForTests('test-client.apps.googleusercontent.com');
  __setTokenProviderForTests(async () => 'tok');
  __setBackoffForTests(1);
  await newDevice();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __setTokenProviderForTests(null);
  __setClientIdForTests(null);
  delete chromeStub.identity;
  delete chromeStub.permissions;
});

// ---------------------------------------------------------------------------
// Config and auth
// ---------------------------------------------------------------------------

describe('drive config', () => {
  it('is off without a client id and only ever asks for drive.file', async () => {
    __setClientIdForTests('');
    expect(driveConfigured()).toBe(false);
    await expect(connectDrive()).rejects.toMatchObject({ code: 'not_configured' });
    __setClientIdForTests('x.apps.googleusercontent.com');
    expect(driveConfigured()).toBe(true);
    expect(DRIVE_SCOPES).toEqual(['https://www.googleapis.com/auth/drive.file']);
  });
});

describe('drive auth', () => {
  it('connects and reads the account email from about.get', async () => {
    const account = await connectDrive();
    expect(account.email).toBe('ada@example.com');
    expect(await getDriveAccount()).toEqual({ email: 'ada@example.com', connectedAt: account.connectedAt });
    const stored = (await db().kv.get(KV.auth))?.value as any;
    expect(stored.token).toBe('tok');
    expect(stored.expiresAt).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
  });

  it('runs the extension OAuth flow: permission in the click, silent refresh, reconnect, disconnect', async () => {
    __setTokenProviderForTests(null);
    const redirect = 'https://abcdefghijklmnop.chromiumapp.org/';
    let n = 0;
    let failSilent = false;
    const calls: { url: URL; interactive: boolean }[] = [];
    chromeStub.permissions = { request: vi.fn(() => Promise.resolve(true)), remove: vi.fn(() => Promise.resolve(true)) };
    chromeStub.identity = {
      getRedirectURL: () => redirect,
      launchWebAuthFlow: vi.fn(async (d: { url: string; interactive: boolean }) => {
        const url = new URL(d.url);
        calls.push({ url, interactive: d.interactive });
        if (!d.interactive && failSilent) throw new Error('User interaction required.');
        const token = `ext-${++n}`;
        drive.tokens.add(token);
        const scope = encodeURIComponent(DRIVE_SCOPES[0]);
        return `${redirect}#access_token=${token}&expires_in=3599&token_type=Bearer&scope=${scope}&state=${url.searchParams.get('state')}`;
      }),
    };

    const pending = connectDrive();
    // requested synchronously, inside the click, before any await
    expect(chromeStub.permissions.request).toHaveBeenCalledWith(DRIVE_PERMISSIONS);
    const account = await pending;
    expect(account.email).toBe('ada@example.com');
    const first = calls[0];
    expect(first.interactive).toBe(true);
    expect(first.url.origin + first.url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(first.url.searchParams)).toMatchObject({
      client_id: 'test-client.apps.googleusercontent.com',
      redirect_uri: redirect,
      response_type: 'token',
      scope: 'https://www.googleapis.com/auth/drive.file',
      include_granted_scopes: 'true',
      prompt: 'consent select_account',
    });
    expect(await getAccessToken()).toBe('ext-1');
    expect(calls).toHaveLength(1);

    // close to expiry: silent refresh with prompt=none and the account as login hint
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 59 * 60 * 1000);
    expect(await getAccessToken()).toBe('ext-2');
    expect(calls[1].interactive).toBe(false);
    expect(calls[1].url.searchParams.get('prompt')).toBe('none');
    expect(calls[1].url.searchParams.get('login_hint')).toBe('ada@example.com');

    // silent refresh fails: no token, and the account asks for a reconnect
    failSilent = true;
    vi.setSystemTime(Date.now() + 59 * 60 * 1000);
    expect(await getAccessToken()).toBeNull();
    expect((await getDriveAccount())?.needsReconnect).toBe(true);

    const again = await reconnectDrive();
    expect(again.connectedAt).toBe(account.connectedAt);
    expect(calls[3].interactive).toBe(true);
    expect(calls[3].url.searchParams.get('prompt')).toBeNull();
    expect(calls[3].url.searchParams.get('login_hint')).toBe('ada@example.com');
    expect((await getDriveAccount())?.needsReconnect).toBeUndefined();
    vi.useRealTimers();

    await disconnectDrive();
    expect(drive.revoked).toEqual(['ext-3']);
    expect(await getDriveAccount()).toBeNull();
    expect(await db().kv.get(KV.auth)).toBeUndefined();
    expect(chromeStub.permissions.remove).toHaveBeenCalledWith(DRIVE_PERMISSIONS);
    expect(await getAccessToken()).toBeNull();
  });

  it('parses the redirect fragment and rejects errors, foreign state and a missing Drive scope', () => {
    const ok = parseAuthRedirect(`https://x.chromiumapp.org/#access_token=a&expires_in=10&scope=${encodeURIComponent(DRIVE_SCOPES[0])}&state=s1`, 's1');
    expect(ok).toEqual({ token: 'a', expiresIn: 10, scope: DRIVE_SCOPES[0] });
    expect(() => parseAuthRedirect('https://x.chromiumapp.org/#error=access_denied&state=s1', 's1')).toThrow(DriveAuthError);
    expect(() => parseAuthRedirect('https://x.chromiumapp.org/?error=access_denied')).toThrow(/not granted/);
    expect(() => parseAuthRedirect('https://x.chromiumapp.org/#access_token=a&state=other', 's1')).toThrow(/unexpected/);
    expect(() => parseAuthRedirect('https://x.chromiumapp.org/#access_token=a&scope=email', undefined)).toThrow(/Drive box/);
  });

  it('refreshes the token once after a 401 and retries the request', async () => {
    await connectDrive();
    const asked: TokenOptions[] = [];
    __setTokenProviderForTests(async (o) => {
      asked.push(o);
      return o.forceRefresh ? 'tok' : 'stale';
    });
    expect(await ensureFolderPath(['Archive'])).toMatch(/^f\d+$/);
    expect(asked[0]).toMatchObject({ interactive: false });
    expect(asked.some((o) => o.forceRefresh)).toBe(true);

    __setTokenProviderForTests(async (o) => (o.forceRefresh ? null : 'stale'));
    await expect(findFiles("name = 'x'")).rejects.toMatchObject({ code: 'needs_reconnect' });
  });

  it('backs off on 429 and on Drive rate limits, and surfaces other errors', async () => {
    await connectDrive();
    drive.failures.push({ match: /^GET \/drive\/v3\/files\?/, status: 429, times: 1, headers: { 'Retry-After': '0.01' } });
    expect(await findFiles("name = 'x'")).toEqual([]);
    drive.failures.push({ match: /^GET \/drive\/v3\/files\?/, status: 403, times: 2, body: { error: { code: 403, message: 'slow down', errors: [{ reason: 'userRateLimitExceeded' }] } } });
    expect(await findFiles("name = 'x'")).toEqual([]);
    drive.failures.push({ match: /^GET \/drive\/v3\/files\?/, status: 403, times: 1, body: { error: { code: 403, message: 'Nope', errors: [{ reason: 'forbidden' }] } } });
    const err = await findFiles("name = 'x'").catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
    expect(err).toMatchObject({ status: 403, reason: 'forbidden', message: 'Google Drive: Nope' });
  });
});

// ---------------------------------------------------------------------------
// Folders, files and uploads
// ---------------------------------------------------------------------------

describe('drive folders', () => {
  it('creates missing folders once, reuses existing ones and caches ids', async () => {
    await connectDrive();
    const existing = drive.put({ name: 'Archive', mimeType: FOLDER });
    const id = await ensureFolderPath(['Archive', "Bob's thesis"]);
    expect(drive.count('create-folder')).toBe(1);
    expect(drive.files.get(id)).toMatchObject({ name: "Bob's thesis", parents: [existing.id] });
    const before = drive.log.length;
    expect(await ensureFolderPath(['Archive', "Bob's thesis"])).toBe(id);
    expect(drive.log.slice(before)).toEqual(['get']);
    expect(((await db().kv.get(KV.folders))?.value as Record<string, string>)['Archive']).toBe(existing.id);
  });

  it('recreates a cached folder that was trashed or deleted', async () => {
    await connectDrive();
    const thesis1 = await ensureFolderPath(['Archive', 'Thesis']);
    const archive1 = drive.files.get(thesis1)!.parents[0];
    drive.files.get(thesis1)!.trashed = true;
    const thesis2 = await ensureFolderPath(['Archive', 'Thesis']);
    expect(thesis2).not.toBe(thesis1);
    expect(drive.files.get(thesis2)!.parents).toEqual([archive1]);
    drive.purge(archive1);
    const thesis3 = await ensureFolderPath(['Archive', 'Thesis']);
    expect(drive.files.has(thesis3)).toBe(true);
    expect(drive.files.get(drive.files.get(thesis3)!.parents[0])).toMatchObject({ name: 'Archive', parents: ['root'] });
    expect(drive.byPath(['Archive', 'Thesis'])?.id).toBe(thesis3);
  });
});

describe('drive files', () => {
  it('saves a PDF to Archive/<folder>/<citeKey>.pdf and updates it in place', async () => {
    await connectDrive();
    const p = paperFixture('arxiv:1706.03762', { citeKey: 'vaswani2017attention' });
    const first = await savePaperPdf(p, bytes(1000, 1), { folder: 'Thesis' });
    const f = drive.files.get(first.id)!;
    expect(f).toMatchObject({ name: 'vaswani2017attention.pdf', mimeType: 'application/pdf', appProperties: { archivePaper: 'arxiv:1706.03762' } });
    expect(f.parents).toEqual([drive.byPath(['Archive', 'Thesis'])!.id]);
    expect(f.content).toEqual(bytes(1000, 1));

    // the user renamed and moved it in Drive; saving again (from another project) replaces the content in place
    f.name = 'Attention (mine).pdf';
    f.parents = ['root'];
    const rev = f.headRevisionId;
    const second = await savePaperPdf(p, bytes(1200, 2), { folder: 'Other project' });
    expect(second.id).toBe(first.id);
    expect(f.name).toBe('Attention (mine).pdf');
    expect(f.content).toEqual(bytes(1200, 2));
    expect(f.headRevisionId).not.toBe(rev);
    expect(drive.byPath(['Archive', 'Other project'])).toBeUndefined();
    expect(await findByAppProperty('archivePaper', p.id)).toHaveLength(1);

    // parallel saves still make one file; a trashed copy is ignored
    f.trashed = true;
    const [a, b] = await Promise.all([savePaperPdf(p, bytes(10, 3), { folder: '' }), savePaperPdf(p, bytes(10, 4), { folder: '' })]);
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(first.id);
    expect(drive.files.get(a.id)!.parents).toEqual([drive.byPath(['Archive'])!.id]);
    expect(drive.files.get(a.id)!.content).toEqual(bytes(10, 4));
  });

  it('sanitizes names and keeps app properties within Drive limits', () => {
    expect(sanitizeName('NLP / Vision')).toBe('NLP - Vision');
    expect(sanitizeName('a:b*c?"d"<e>|f\\g')).toBe('a-b-c-d-e-f-g');
    expect(sanitizeName('tab\there\nnew  line')).toBe('tab here new line');
    expect(sanitizeName('  trailing dots... ')).toBe('trailing dots');
    expect(sanitizeName('...')).toBe('Untitled');
    expect(sanitizeName('', 'Untitled project')).toBe('Untitled project');
    expect(sanitizeName('CON')).toBe('CON_');
    expect(sanitizeName('.sync')).toBe('.sync');
    expect(sanitizeName('x'.repeat(300))).toHaveLength(120);
    expect(propValue('arxiv:2401.12345', 'archivePaper')).toBe('arxiv:2401.12345');
    const long = propValue(`doi:10.1000/${'x'.repeat(200)}`, 'archivePaper');
    expect(long).toMatch(/^h:[0-9a-f]{16}$/);
  });

  it('keeps one .bib per project and toggles its public link', async () => {
    await connectDrive();
    const project = projectFixture('Thesis: Chapter 2');
    const r1 = await saveProjectBib(project, '@article{a,}', { publicLink: true });
    const f = drive.files.get(r1.file.id)!;
    expect(f).toMatchObject({ name: 'Thesis- Chapter 2.bib', appProperties: { archiveBib: project.id } });
    expect(drive.files.get(f.parents[0])!.name).toBe('Thesis- Chapter 2');
    expect(r1.link).toBe(`https://drive.google.com/uc?export=download&id=${f.id}`);
    expect(f.perms).toEqual([{ id: 'anyoneWithLink', type: 'anyone', role: 'reader' }]);

    const r2 = await saveProjectBib(project, '@article{a,}\n@article{b,}', { publicLink: false });
    expect(r2.file.id).toBe(f.id);
    expect(r2.link).toBeUndefined();
    expect(f.perms).toEqual([]);
    expect(new TextDecoder().decode(f.content!)).toContain('@article{b,}');

    const r3 = await saveProjectBib(project, '@article{c,}', { publicLink: true });
    expect(r3.link).toBe(r1.link);
    expect(f.perms).toHaveLength(1);
    expect(await findByAppProperty('archiveBib', project.id)).toHaveLength(1);
  });
});

describe('drive uploads', () => {
  it('uses a resumable upload above 5 MB and resumes after a failed chunk', async () => {
    await connectDrive();
    const parentId = await ensureFolderPath(['Archive']);
    const big = bytes(9 * 1024 * 1024, 7);
    const created = await uploadFile({ name: 'big.pdf', parentId, mimeType: 'application/pdf', body: big, appProperties: { k: 'v' } });
    expect(drive.count('resumable-start')).toBe(1);
    expect(drive.count('chunk')).toBe(2);
    expect(drive.files.get(created.id)).toMatchObject({ name: 'big.pdf', parents: [parentId], appProperties: { k: 'v' } });
    expect(sameBytes(await downloadFile(created.id), big)).toBe(true);

    drive.failures.push({ match: /^PUT .*upload_id/, status: 503, times: 1 });
    const big2 = bytes(6 * 1024 * 1024, 9);
    const updated = await uploadFile({ fileId: created.id, name: 'ignored.pdf', mimeType: 'application/pdf', body: big2 });
    expect(updated.id).toBe(created.id);
    expect(drive.count('status')).toBe(1);
    expect(drive.files.get(created.id)!.name).toBe('big.pdf');
    expect(sameBytes(drive.files.get(created.id)!.content, big2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Library sync
// ---------------------------------------------------------------------------

describe('drive sync', () => {
  it('syncs two devices through one file in Drive', async () => {
    const devA = db() as ArchiveDB;
    await connectDrive();
    await repo.putPaper(paperFixture('arxiv:2401.00001'));
    await repo.putPaper(paperFixture('arxiv:2401.00002'));
    await repo.ensureEntry('arxiv:2401.00001');
    await repo.ensureEntry('arxiv:2401.00002');
    const keep = await repo.createAnnotation({ paperId: 'arxiv:2401.00001', motivation: 'highlighting', body: [], target: { source: 'arxiv:2401.00001' } });
    const drop = await repo.createAnnotation({ paperId: 'arxiv:2401.00001', motivation: 'commenting', body: [], target: { source: 'arxiv:2401.00001' } });
    await repo.createProject({ name: 'Thesis' });

    const a1 = await syncNow();
    expect(a1).toMatchObject({ pulled: 0, pushed: true });
    expect(a1.error).toBeUndefined();
    const syncFile = drive.byPath(['Archive', '.sync', 'library.json'])!;
    expect(syncFile).toMatchObject({ mimeType: 'application/json', appProperties: { archive: 'sync' } });
    expect(syncFileJson()).toMatchObject({ format: 'archive-backup', version: 1 });

    // device B starts empty and pulls everything
    await newDevice();
    await connectDrive();
    const b1 = await syncNow();
    expect(b1).toMatchObject({ pulled: 7, pushed: false });
    expect((await repo.listPapers()).map((p) => p.id).sort()).toEqual(['arxiv:2401.00001', 'arxiv:2401.00002']);
    expect(await repo.listAnnotations('arxiv:2401.00001')).toHaveLength(2);

    // B edits one record, deletes another, changes a library entry
    await tick();
    await repo.setAnnotationNote(keep.id, 'edited on B');
    await repo.deleteAnnotation(drop.id);
    await repo.updateEntry('arxiv:2401.00002', { status: 'read' });
    const b2 = await syncNow();
    expect(b2).toMatchObject({ pulled: 0, pushed: true });
    const downloadsAfterB = drive.count('download');
    expect(await syncNow()).toMatchObject({ pulled: 0, pushed: false });
    expect(drive.count('download')).toBe(downloadsAfterB); // B does not download its own upload

    // A pulls the edit and the deletion
    use(devA);
    const a2 = await syncNow();
    expect(a2).toMatchObject({ pulled: 3, pushed: false });
    const notes = await repo.listAnnotations('arxiv:2401.00001');
    expect(notes.map((a) => a.id)).toEqual([keep.id]);
    expect(notes[0].body.find((b) => b.purpose === 'commenting')?.value).toBe('edited on B');
    expect((await repo.getEntry('arxiv:2401.00002'))?.status).toBe('read');
    expect((await devA.annotations.get(drop.id))?.deletedAt).toBeTruthy();

    const downloadsAfterA = drive.count('download');
    expect(await syncNow()).toMatchObject({ pulled: 0, pushed: false });
    expect(drive.count('download')).toBe(downloadsAfterA);
    expect([...drive.files.values()].filter((f) => f.appProperties.archive === 'sync')).toHaveLength(1);
  });

  it('merges edits made on both devices since the last sync', async () => {
    const devA = db() as ArchiveDB;
    await connectDrive();
    await repo.putPaper(paperFixture('arxiv:2402.00001'));
    await repo.ensureEntry('arxiv:2402.00001');
    await syncNow();
    const devB = await newDevice();
    await connectDrive();
    await syncNow();

    await tick();
    await repo.updateEntry('arxiv:2402.00001', { tags: ['from-b'] });
    use(devA);
    await repo.createProject({ name: 'From A' });
    use(devB);
    expect(await syncNow()).toMatchObject({ pushed: true });
    use(devA);
    expect(await syncNow()).toMatchObject({ pulled: 1, pushed: true });
    use(devB);
    expect(await syncNow()).toMatchObject({ pulled: 1, pushed: false });
    expect((await repo.listProjects()).map((p) => p.name)).toEqual(['From A']);
    expect((await repo.getEntry('arxiv:2402.00001'))?.tags).toEqual(['from-b']);
  });

  it('keeps the snapshot small and keeps what it leaves out on the device', async () => {
    const devA = db() as ArchiveDB;
    await connectDrive();
    await repo.putPaper(paperFixture('arxiv:2403.00001', { s2: { paperId: 's2x', embedding: [0.123456789, -0.987654321], checkedAt: '2026-01-01' } }));
    const small = await repo.putAttachment({ paperId: 'arxiv:2403.00001', kind: 'figure', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', caption: '' });
    const big = await repo.putAttachment({ paperId: 'arxiv:2403.00001', kind: 'figure', mime: 'image/png', dataUrl: `data:image/png;base64,${'A'.repeat(1.6 * 1024 * 1024)}`, caption: '' });
    await repo.addFeedItems([feedFixture('arxiv:2403.09999', [0.5, 0.25])]);
    expect(await syncNow()).toMatchObject({ pushed: true });

    const snap = syncFileJson();
    expect(snap.papers[0].s2.embedding).toEqual([0.1235, -0.9877]);
    expect(snap.attachments.map((a: any) => a.id)).toEqual([small.id]);
    expect(snap.feed[0].embedding).toBeUndefined();
    expect(snap.feed[0].title).toBe('Feed arxiv:2403.09999');

    // the big attachment alone doesn't make every sync upload again
    expect(await syncNow()).toMatchObject({ pushed: false });

    // B changes the feed item; A keeps its own embedding when it pulls the change
    await newDevice();
    await connectDrive();
    await syncNow();
    await tick();
    await repo.setFeedStatus('arxiv:2403.09999', 'dismissed');
    expect(await syncNow()).toMatchObject({ pushed: true });
    use(devA);
    expect(await syncNow()).toMatchObject({ pulled: 1 });
    const item = await devA.feed.get('arxiv:2403.09999');
    expect(item).toMatchObject({ status: 'dismissed', embedding: [0.5, 0.25] });
    expect((await devA.papers.get('arxiv:2403.00001'))?.s2?.embedding).toEqual([0.123456789, -0.987654321]);
    expect(await devA.attachments.get(big.id)).toBeTruthy();
  });

  it('propagates attachment deletions as tombstones', async () => {
    const devA = db() as ArchiveDB;
    await connectDrive();
    await repo.putPaper(paperFixture('arxiv:2404.00001'));
    const fig = await repo.putAttachment({ paperId: 'arxiv:2404.00001', kind: 'figure', mime: 'image/png', dataUrl: 'data:image/png;base64,AAAA', caption: 'Fig 1' });
    await syncNow();

    const devB = await newDevice();
    await connectDrive();
    await syncNow();
    expect(await devB.attachments.get(fig.id)).toBeTruthy();
    await repo.deleteAttachment(fig.id);
    expect(await syncNow()).toMatchObject({ pushed: true });
    expect(syncFileJson().sync.tombstones.attachments).toEqual([fig.id]);

    use(devA);
    expect(await syncNow()).toMatchObject({ pulled: 1, pushed: false });
    expect(await devA.attachments.get(fig.id)).toBeUndefined();
    expect(await syncNow()).toMatchObject({ pulled: 0, pushed: false });
  });

  it('replaces an unreadable sync file, refuses a foreign one, and reports errors instead of throwing', async () => {
    expect(await syncNow()).toMatchObject({ pulled: 0, pushed: false, error: 'Connect Google Drive to sync.' });
    await connectDrive();
    await repo.putPaper(paperFixture('arxiv:2405.00001'));
    const broken = drive.put({ name: 'library.json', mimeType: 'application/json', appProperties: { archive: 'sync' }, content: new TextEncoder().encode('{"format": "archive-ba') });
    // a lease left behind by a context that died long ago doesn't block
    await db().kv.put({ key: KV.lease, value: { owner: 'gone', until: Date.now() - 1000 } });
    expect(await syncNow()).toMatchObject({ pushed: true });
    expect(syncFileJson().papers.map((p: any) => p.id)).toEqual(['arxiv:2405.00001']);
    expect(drive.files.get(broken.id)!.headRevisionId).not.toBe('r1');

    drive.files.get(broken.id)!.content = new TextEncoder().encode(JSON.stringify({ format: 'something-else' }));
    drive.files.get(broken.id)!.headRevisionId = 'r-foreign';
    const r = await syncNow();
    expect(r.pushed).toBe(false);
    expect(r.error).toMatch(/not an Archive library/);
  });

  it('folds a duplicate sync file created by a race into the oldest one', async () => {
    const devA = db() as ArchiveDB;
    await connectDrive();
    await repo.putPaper(paperFixture('arxiv:2406.00001'));
    await syncNow();
    const devB = await newDevice();
    await connectDrive();
    await repo.putPaper(paperFixture('arxiv:2406.00002'));
    // B's own file, as if both devices created one at the same time
    const dup = drive.put({
      name: 'library.json',
      mimeType: 'application/json',
      appProperties: { archive: 'sync' },
      content: new TextEncoder().encode(JSON.stringify({ format: 'archive-backup', version: 1, papers: [await devB.papers.get('arxiv:2406.00002')] })),
    });
    expect(await syncNow()).toMatchObject({ pushed: true });
    expect(drive.files.get(dup.id)!.trashed).toBe(true);
    use(devA);
    await syncNow();
    expect((await repo.listPapers()).map((p) => p.id).sort()).toEqual(['arxiv:2406.00001', 'arxiv:2406.00002']);
  });

  it('auto sync debounces local changes and ignores its own merges', async () => {
    await connectDrive();
    await repo.putPaper(paperFixture('arxiv:2407.00001'));
    await syncNow();

    await newDevice();
    await connectDrive();
    const stop = startAutoSync(async () => true, { debounceMs: 40, intervalMs: 60 * 60 * 1000 });
    try {
      await until(async () => (await repo.listPapers()).length === 1);
      const lists = drive.count('list');
      await tick(250); // the merge's change event must not schedule another run
      expect(drive.count('list')).toBe(lists);

      const uploads = drive.count('update-multipart');
      await repo.createProject({ name: 'Auto' });
      await repo.createProject({ name: 'Auto 2' });
      await until(() => drive.count('update-multipart') > uploads);
      await tick(150);
      expect(drive.count('update-multipart')).toBe(uploads + 1); // two quick changes, one upload
      expect(syncFileJson().projects.map((p: any) => p.name).sort()).toEqual(['Auto', 'Auto 2']);
    } finally {
      stop();
    }
    const lists = drive.count('list');
    await repo.createProject({ name: 'After stop' });
    await tick(150);
    expect(drive.count('list')).toBe(lists);
  });
});

describe('sync and background work', () => {
  it("background writes on a stale device don't undo edits made on another", async () => {
    const devA = db() as ArchiveDB;
    await connectDrive();
    await repo.putPaper(paperFixture('arxiv:2403.00001'));
    await repo.ensureEntry('arxiv:2403.00001');
    await syncNow();
    const devB = await newDevice();
    await connectDrive();
    await syncNow();

    // A: the user edits the cite key and BibTeX and files the paper, then syncs
    use(devA);
    await tick();
    await repo.updatePaper('arxiv:2403.00001', { citeKey: 'mykey', bibtex: '@misc{mykey,}', bibtexSource: 'manual' });
    await repo.updateEntry('arxiv:2403.00001', { status: 'read', tags: ['thesis'], willCite: true });
    expect(await syncNow()).toMatchObject({ pushed: true });

    // B, before pulling: background jobs touch the same records (they are derived writes)
    use(devB);
    await tick();
    await repo.updateEntry('arxiv:2403.00001', { lastOpenedAt: new Date().toISOString(), priority: 0.9, topicId: 'topic-b' }, { derived: true });
    await repo.updatePaper('arxiv:2403.00001', { s2: { paperId: 'x', checkedAt: new Date().toISOString() } as any }, { derived: true });
    await syncNow();
    // B now has A's edits, and keeps the values it computed itself
    let e = await repo.getEntry('arxiv:2403.00001');
    expect(e).toMatchObject({ status: 'read', tags: ['thesis'], willCite: true, topicId: 'topic-b', priority: 0.9 });
    expect((await repo.getPaper('arxiv:2403.00001'))?.citeKey).toBe('mykey');

    // A pulls again: nothing of its edits is reverted
    use(devA);
    await syncNow();
    const p = await repo.getPaper('arxiv:2403.00001');
    e = await repo.getEntry('arxiv:2403.00001');
    expect(p).toMatchObject({ citeKey: 'mykey', bibtexSource: 'manual' });
    expect(e).toMatchObject({ status: 'read', tags: ['thesis'], willCite: true });
  });

  it('derived writes keep updatedAt and stay out of the change log', async () => {
    await repo.putPaper(paperFixture('arxiv:2403.00002'));
    await repo.ensureEntry('arxiv:2403.00002');
    const before = await repo.getEntry('arxiv:2403.00002');
    const seq = (await db().changes.toCollection().last())?.seq;
    await tick();
    await repo.updateEntry('arxiv:2403.00002', { priority: 0.5 }, { derived: true });
    const after = await repo.getEntry('arxiv:2403.00002');
    expect(after?.updatedAt).toBe(before?.updatedAt);
    expect(after?.priority).toBe(0.5);
    expect((await db().changes.toCollection().last())?.seq).toBe(seq);
  });
});
