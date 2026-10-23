// A small in-memory Google Drive v3 for browser tests (www.googleapis.com and
// oauth2.googleapis.com). Covers what src/lib/drive/api.ts uses.

import crypto from 'node:crypto';

export const drive = { files: new Map(), calls: [], revoked: [], token: 'drive-test-token' };
let n = 0;
const now = () => new Date().toISOString();

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

const unq = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

function matches(f, q) {
  let m;
  if (!q) return true;
  if ((m = q.match(/appProperties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' \}/)) && (f.appProperties ?? {})[unq(m[1])] !== unq(m[2])) return false;
  if ((m = q.match(/'((?:[^'\\]|\\.)*)' in parents/)) && !(f.parents ?? []).includes(unq(m[1]))) return false;
  if ((m = q.match(/(?:^|\s)name = '((?:[^'\\]|\\.)*)'/)) && f.name !== unq(m[1])) return false;
  if ((m = q.match(/mimeType = '([^']*)'/)) && f.mimeType !== m[1]) return false;
  if ((m = q.match(/mimeType != '([^']*)'/)) && f.mimeType === m[1]) return false;
  if ((m = q.match(/trashed = (true|false)/)) && f.trashed !== (m[1] === 'true')) return false;
  return true;
}

function meta(f) {
  const { content, permissions, ...rest } = f;
  return { ...rest, size: String(content?.length ?? 0), webViewLink: `https://drive.google.com/file/d/${f.id}/view` };
}

function create(md, content) {
  const id = `f${++n}`;
  const f = {
    id,
    name: md.name ?? 'Untitled',
    mimeType: md.mimeType ?? 'application/octet-stream',
    parents: md.parents ?? ['root'],
    appProperties: md.appProperties ?? {},
    trashed: false,
    createdTime: now(),
    modifiedTime: now(),
    headRevisionId: `r${++n}`,
    md5Checksum: content ? crypto.createHash('md5').update(content).digest('hex') : undefined,
    content: content ?? Buffer.alloc(0),
    permissions: [],
  };
  drive.files.set(id, f);
  return f;
}

function update(f, md, content) {
  if (md) {
    for (const k of ['name', 'mimeType', 'trashed']) if (md[k] !== undefined) f[k] = md[k];
    if (md.appProperties) f.appProperties = { ...f.appProperties, ...md.appProperties };
  }
  if (content) {
    f.content = content;
    f.md5Checksum = crypto.createHash('md5').update(content).digest('hex');
    f.headRevisionId = `r${++n}`;
  }
  f.modifiedTime = now();
  return f;
}

/** multipart/related body: first part JSON metadata, second part the media. */
function parseMultipart(buf, contentType) {
  const boundary = /boundary="?([^";]+)"?/.exec(contentType ?? '')?.[1];
  if (!boundary) return { md: JSON.parse(buf.toString() || '{}'), content: null };
  const sep = Buffer.from(`--${boundary}`);
  const parts = [];
  let i = buf.indexOf(sep);
  while (i >= 0) {
    const next = buf.indexOf(sep, i + sep.length);
    if (next < 0) break;
    parts.push(buf.subarray(i + sep.length, next));
    i = next;
  }
  const body = (p) => {
    const h = p.indexOf('\r\n\r\n');
    let b = p.subarray(h + 4);
    if (b.subarray(-2).toString() === '\r\n') b = b.subarray(0, -2);
    return b;
  };
  return { md: JSON.parse(body(parts[0]).toString() || '{}'), content: parts[1] ? Buffer.from(body(parts[1])) : null };
}

export async function handleGoogle(req, res, host, url, readBuffer) {
  const p = url.pathname;
  drive.calls.push({ method: req.method, path: p + url.search });
  if (host === 'oauth2.googleapis.com' && p === '/revoke') {
    drive.revoked.push(url.searchParams.get('token'));
    return send(res, 200, {});
  }
  if (host !== 'www.googleapis.com') return send(res, 404, { error: 'no route' });
  if (req.headers.authorization !== `Bearer ${drive.token}`) return send(res, 401, { error: { code: 401, message: 'Invalid Credentials' } });

  let m;
  if (p === '/drive/v3/about') return send(res, 200, { user: { emailAddress: 'manas@example.com', displayName: 'Manas' } });

  if (p === '/drive/v3/files' && req.method === 'GET') {
    const q = url.searchParams.get('q') ?? '';
    const list = [...drive.files.values()].filter((f) => matches(f, q)).sort((a, b) => a.createdTime.localeCompare(b.createdTime));
    return send(res, 200, { files: list.map(meta) });
  }
  if (p === '/drive/v3/files' && req.method === 'POST') {
    const md = JSON.parse((await readBuffer(req)).toString() || '{}');
    return send(res, 200, meta(create(md, null)));
  }
  if ((m = p.match(/^\/drive\/v3\/files\/([^/]+)$/))) {
    const f = drive.files.get(m[1]);
    if (!f) return send(res, 404, { error: { code: 404, message: 'File not found' } });
    if (req.method === 'GET' && url.searchParams.get('alt') === 'media') {
      res.writeHead(200, { 'content-type': f.mimeType, 'access-control-allow-origin': '*' });
      return res.end(f.content);
    }
    if (req.method === 'GET') return send(res, 200, meta(f));
    if (req.method === 'PATCH') return send(res, 200, meta(update(f, JSON.parse((await readBuffer(req)).toString() || '{}'), null)));
    if (req.method === 'DELETE') {
      drive.files.delete(f.id);
      return send(res, 204);
    }
  }
  if ((m = p.match(/^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/))) {
    const f = drive.files.get(m[1]);
    if (!f) return send(res, 404, { error: { code: 404, message: 'File not found' } });
    if (req.method === 'GET') return send(res, 200, { permissions: f.permissions });
    if (req.method === 'POST') {
      const perm = { id: `p${++n}`, ...JSON.parse((await readBuffer(req)).toString() || '{}') };
      f.permissions.push(perm);
      return send(res, 200, { id: perm.id });
    }
    if (req.method === 'DELETE') {
      f.permissions = f.permissions.filter((x) => x.id !== m[2]);
      return send(res, 204);
    }
  }
  if ((m = p.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/))) {
    const { md, content } = parseMultipart(await readBuffer(req), req.headers['content-type']);
    if (m[1]) {
      const f = drive.files.get(m[1]);
      if (!f) return send(res, 404, { error: { code: 404, message: 'File not found' } });
      return send(res, 200, meta(update(f, md, content)));
    }
    return send(res, 200, meta(create(md, content)));
  }
  return send(res, 404, { error: { message: `mock drive: no route for ${req.method} ${p}` } });
}

export function driveFiles() {
  return [...drive.files.values()].map((f) => ({ ...meta(f), text: f.mimeType.startsWith('application/pdf') ? null : f.content.toString(), bytes: f.content }));
}
