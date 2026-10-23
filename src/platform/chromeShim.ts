// A minimal stand-in for the extension APIs, so Archive's extension pages run as a
// plain web app (phones and iPads). It covers only what the pages and the
// in-page background (src/lib/bg/setup.ts) use:
//
// - storage.local: localStorage-backed JSON, change events in this tab and across tabs
// - storage.session: sessionStorage (memory if unavailable)
// - runtime messaging and ports, delivered to listeners in this page
// - tabs.* navigate this page or open a new one; there are no other tabs to talk to
// - alarms run on timers while the page is open; notifications use the Notification API
//
// There is no chrome.sidePanel and no chrome.identity. Importing this module installs it.

declare const __ARCHIVE_VERSION__: string | undefined;

type Fn = (...args: any[]) => any;

class Hub<F extends Fn = Fn> {
  private ls = new Set<F>();
  addListener = (l: F) => void this.ls.add(l);
  removeListener = (l: F) => void this.ls.delete(l);
  hasListener = (l: F) => this.ls.has(l);
  hasListeners = () => this.ls.size > 0;
  get list(): F[] {
    return [...this.ls];
  }
  emit(...args: Parameters<F>) {
    for (const l of this.list) {
      try {
        l(...args);
      } catch (e) {
        console.error('[archive] listener failed', e);
      }
    }
  }
}

/** Copy a message the way the extension's messaging serializes it, so neither side shares objects. */
function clone<T>(v: T): T {
  if (v === undefined) return v;
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v)) as T;
  }
}

function lastArgCallback(args: unknown[]): Fn | undefined {
  const last = args[args.length - 1];
  return typeof last === 'function' ? (last as Fn) : undefined;
}

/** Return a promise and also call an old-style callback when one is passed. */
function settle<T>(p: Promise<T>, cb?: Fn): Promise<T> {
  if (cb) p.then((v) => cb(v), () => cb(undefined));
  return p;
}

/** The web app's root URL, e.g. https://manas2006.github.io/archive/ */
export function appBase(): string {
  return new URL(import.meta.env.BASE_URL || '/', location.origin).href;
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
const storageChanged = new Hub<(changes: Changes, area: string) => void>();

interface Backend {
  keys(): string[];
  read(key: string): unknown;
  write(key: string, value: unknown): void;
  remove(key: string): void;
}

function webStorageBackend(store: () => Storage | null, prefix: string): Backend {
  const memory = new Map<string, string>();
  const s = (): Storage | null => {
    try {
      return store();
    } catch {
      return null;
    }
  };
  const raw = (k: string): string | null => {
    const st = s();
    return st ? st.getItem(prefix + k) : memory.get(k) ?? null;
  };
  return {
    keys() {
      const st = s();
      if (!st) return [...memory.keys()];
      const out: string[] = [];
      for (let i = 0; i < st.length; i++) {
        const k = st.key(i);
        if (k?.startsWith(prefix)) out.push(k.slice(prefix.length));
      }
      return out;
    },
    read(k) {
      const r = raw(k);
      if (r === null) return undefined;
      try {
        return JSON.parse(r);
      } catch {
        return undefined;
      }
    },
    write(k, v) {
      const json = JSON.stringify(v);
      const st = s();
      if (st) st.setItem(prefix + k, json);
      else memory.set(k, json);
    },
    remove(k) {
      const st = s();
      if (st) st.removeItem(prefix + k);
      else memory.delete(k);
    },
  };
}

function storageArea(area: 'local' | 'session', backend: Backend) {
  const onChanged = new Hub<(changes: Changes) => void>();
  const fire = (changes: Changes) => {
    if (!Object.keys(changes).length) return;
    // the extension delivers change events asynchronously
    setTimeout(() => {
      storageChanged.emit(changes, area);
      onChanged.emit(changes);
    }, 0);
  };
  const get = (keys?: string | string[] | Record<string, unknown> | null): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (keys === null || keys === undefined) {
      for (const k of backend.keys()) {
        const v = backend.read(k);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    const wanted: [string, unknown][] =
      typeof keys === 'string' ? [[keys, undefined]] : Array.isArray(keys) ? keys.map((k) => [k, undefined]) : Object.entries(keys);
    for (const [k, def] of wanted) {
      const v = backend.read(k);
      if (v !== undefined) out[k] = v;
      else if (def !== undefined) out[k] = def;
    }
    return out;
  };
  return {
    onChanged,
    /** Used by the cross-tab `storage` event to report another tab's write. */
    _fire: fire,
    get(...args: any[]) {
      const cb = lastArgCallback(args);
      const keys = args.length && typeof args[0] !== 'function' ? args[0] : null;
      return settle(Promise.resolve().then(() => clone(get(keys))), cb);
    },
    set(items: Record<string, unknown>, cb?: Fn) {
      return settle(
        Promise.resolve().then(() => {
          const changes: Changes = {};
          for (const [k, v] of Object.entries(items ?? {})) {
            if (v === undefined) continue;
            const old = backend.read(k);
            backend.write(k, v); // throws QuotaExceededError when storage is full
            if (JSON.stringify(old) !== JSON.stringify(v)) changes[k] = { oldValue: old, newValue: clone(v) };
          }
          fire(changes);
        }),
        cb,
      );
    },
    remove(keys: string | string[], cb?: Fn) {
      return settle(
        Promise.resolve().then(() => {
          const changes: Changes = {};
          for (const k of typeof keys === 'string' ? [keys] : keys ?? []) {
            const old = backend.read(k);
            if (old === undefined) continue;
            backend.remove(k);
            changes[k] = { oldValue: old };
          }
          fire(changes);
        }),
        cb,
      );
    },
    clear(cb?: Fn) {
      return settle(
        Promise.resolve().then(() => {
          const changes: Changes = {};
          for (const k of backend.keys()) {
            changes[k] = { oldValue: backend.read(k) };
            backend.remove(k);
          }
          fire(changes);
        }),
        cb,
      );
    },
    getBytesInUse() {
      return Promise.resolve(backend.keys().reduce((n, k) => n + k.length + JSON.stringify(backend.read(k) ?? null).length, 0));
    },
  };
}

const LOCAL_PREFIX = 'archive.local:';
const SESSION_PREFIX = 'archive.session:';
const local = storageArea('local', webStorageBackend(() => window.localStorage, LOCAL_PREFIX));
const session = storageArea('session', webStorageBackend(() => window.sessionStorage, SESSION_PREFIX));

function parseStored(v: string | null): unknown {
  if (v === null) return undefined;
  try {
    return JSON.parse(v);
  } catch {
    return undefined;
  }
}

// another tab wrote to localStorage
window.addEventListener('storage', (e) => {
  if (e.storageArea !== window.localStorage || !e.key?.startsWith(LOCAL_PREFIX)) return;
  const key = e.key.slice(LOCAL_PREFIX.length);
  const change: { oldValue?: unknown; newValue?: unknown } = { oldValue: parseStored(e.oldValue) };
  const nv = parseStored(e.newValue);
  if (nv !== undefined) change.newValue = nv;
  local._fire({ [key]: change });
});

// ---------------------------------------------------------------------------
// runtime: messages and ports, all inside this page
// ---------------------------------------------------------------------------

const RUNTIME_ID = 'archive-web';
const onMessage = new Hub<(msg: any, sender: chrome.runtime.MessageSender, sendResponse: (r?: any) => void) => boolean | void | Promise<unknown>>();
const onConnect = new Hub<(port: chrome.runtime.Port) => void>();

function fakeSender(): chrome.runtime.MessageSender {
  return { id: RUNTIME_ID, url: location.href, origin: location.origin } as chrome.runtime.MessageSender;
}

function sendMessage(...args: any[]): Promise<any> {
  const cb = lastArgCallback(args);
  // sendMessage(message), (message, options), (extensionId, message, ...)
  const message = typeof args[0] === 'string' && args.length > 1 && typeof args[1] !== 'function' ? args[1] : args[0];
  const p = new Promise<any>((resolve, reject) => {
    queueMicrotask(() => {
      const listeners = onMessage.list;
      if (!listeners.length) {
        reject(new Error('Could not establish connection. Receiving end does not exist.'));
        return;
      }
      let done = false;
      let pending = 0;
      const respond = (r?: unknown) => {
        if (done) return;
        done = true;
        resolve(clone(r));
      };
      for (const l of listeners) {
        let out: unknown;
        try {
          out = l(clone(message), fakeSender(), respond);
        } catch (e) {
          console.error('[archive] message listener failed', e);
          continue;
        }
        if (out === true) pending++;
        else if (out && typeof (out as Promise<unknown>).then === 'function') {
          pending++;
          (out as Promise<unknown>).then(respond, (e) => respond({ ok: false, error: String((e as Error)?.message ?? e) }));
        }
      }
      // nobody answered and nobody will: the extension resolves with undefined
      if (!done && pending === 0) respond(undefined);
    });
  });
  return settle(p, cb);
}

interface ShimPort extends chrome.runtime.Port {
  _peer?: ShimPort;
  _closed: boolean;
  _onMessage: Hub;
  _onDisconnect: Hub;
}

function makePort(name: string, sender?: chrome.runtime.MessageSender): ShimPort {
  const _onMessage = new Hub();
  const _onDisconnect = new Hub();
  const port: ShimPort = {
    name,
    sender,
    _closed: false,
    _onMessage,
    _onDisconnect,
    onMessage: _onMessage as unknown as chrome.runtime.Port['onMessage'],
    onDisconnect: _onDisconnect as unknown as chrome.runtime.Port['onDisconnect'],
    postMessage(msg: unknown) {
      if (port._closed) throw new Error('Attempting to use a disconnected port object');
      const peer = port._peer;
      const copy = clone(msg);
      // queued like the extension's messaging, so a listener added right after connect() still gets it
      queueMicrotask(() => {
        if (peer && !peer._closed) peer._onMessage.emit(copy, peer);
      });
    },
    disconnect() {
      if (port._closed) return;
      port._closed = true;
      const peer = port._peer;
      if (peer && !peer._closed) {
        peer._closed = true;
        // only the other end hears about it
        queueMicrotask(() => peer._onDisconnect.emit(peer));
      }
    },
  } as ShimPort;
  return port;
}

function connect(...args: any[]): chrome.runtime.Port {
  const info = (typeof args[0] === 'string' ? args[1] : args[0]) as { name?: string } | undefined;
  const name = info?.name ?? '';
  const client = makePort(name);
  const server = makePort(name, fakeSender());
  client._peer = server;
  server._peer = client;
  queueMicrotask(() => {
    // nobody listening: the caller's end disconnects, as in the extension
    if (!onConnect.hasListeners()) server.disconnect();
    else onConnect.emit(server);
  });
  return client;
}

// ---------------------------------------------------------------------------
// tabs and navigation
// ---------------------------------------------------------------------------

function isAppUrl(url: string): boolean {
  try {
    return new URL(url, location.href).href.startsWith(appBase());
  } catch {
    return false;
  }
}

function navigate(url: string) {
  location.assign(new URL(url, location.href).href);
}

function openUrl(url: string) {
  // Archive's own pages open in place: in an installed app a new window would leave the app
  if (isAppUrl(url)) navigate(url);
  else window.open(url, '_blank', 'noopener');
}

const tabs = {
  create(props: { url?: string }) {
    if (props?.url) openUrl(props.url);
    return Promise.resolve({ id: undefined, index: 0, url: props?.url, active: true } as unknown as chrome.tabs.Tab);
  },
  update(...args: any[]) {
    const props = (typeof args[0] === 'number' ? args[1] : args[0]) as { url?: string } | undefined;
    if (props?.url) navigate(props.url);
    return Promise.resolve(undefined);
  },
  getCurrent: () => Promise.resolve(undefined),
  get: () => Promise.resolve(undefined),
  query: () => Promise.resolve([] as chrome.tabs.Tab[]),
  sendMessage: () => Promise.resolve(undefined),
  remove: () => Promise.resolve(),
  onUpdated: new Hub(),
  onActivated: new Hub(),
  onRemoved: new Hub(),
};

// ---------------------------------------------------------------------------
// alarms (only while the page is open) and notifications
// ---------------------------------------------------------------------------

interface AlarmInfo {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}
const alarmTimers = new Map<string, { info: AlarmInfo; timer: ReturnType<typeof setTimeout> }>();
const onAlarm = new Hub<(alarm: AlarmInfo) => void>();

function scheduleAlarm(info: AlarmInfo) {
  const delay = Math.max(0, info.scheduledTime - Date.now());
  const timer = setTimeout(() => {
    const fired = { ...info };
    if (info.periodInMinutes) scheduleAlarm({ ...info, scheduledTime: Date.now() + info.periodInMinutes * 60_000 });
    else alarmTimers.delete(info.name);
    onAlarm.emit(fired);
  }, Math.min(delay, 2 ** 31 - 1));
  alarmTimers.set(info.name, { info, timer });
}

const alarms = {
  create(...args: any[]) {
    const name: string = typeof args[0] === 'string' ? args[0] : '';
    const opts = (typeof args[0] === 'string' ? args[1] : args[0]) as { when?: number; delayInMinutes?: number; periodInMinutes?: number } | undefined;
    const prev = alarmTimers.get(name);
    if (prev) clearTimeout(prev.timer);
    const when = opts?.when ?? Date.now() + (opts?.delayInMinutes ?? opts?.periodInMinutes ?? 0) * 60_000;
    scheduleAlarm({ name, scheduledTime: when, periodInMinutes: opts?.periodInMinutes });
    return Promise.resolve();
  },
  get: (name = '') => Promise.resolve(alarmTimers.get(name)?.info),
  getAll: () => Promise.resolve([...alarmTimers.values()].map((a) => a.info)),
  clear(name = '') {
    const a = alarmTimers.get(name);
    if (a) clearTimeout(a.timer);
    return Promise.resolve(alarmTimers.delete(name));
  },
  clearAll() {
    for (const a of alarmTimers.values()) clearTimeout(a.timer);
    alarmTimers.clear();
    return Promise.resolve(true);
  },
  onAlarm,
};

const onNotificationClicked = new Hub<(id: string) => void>();
let notificationSeq = 0;
const notifications = {
  create(...args: any[]) {
    const id: string = typeof args[0] === 'string' ? args[0] : `archive-${++notificationSeq}`;
    const opts = (typeof args[0] === 'string' ? args[1] : args[0]) as { title?: string; message?: string; iconUrl?: string } | undefined;
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const n = new Notification(opts?.title ?? 'Archive', { body: opts?.message, icon: opts?.iconUrl, tag: id });
        n.onclick = () => {
          window.focus();
          onNotificationClicked.emit(id);
          n.close();
        };
      }
    } catch {
      /* iOS only allows notifications from an installed app, and only through a service worker */
    }
    return Promise.resolve(id);
  },
  clear: () => Promise.resolve(true),
  onClicked: onNotificationClicked,
};

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const shim = {
  storage: { local, session, onChanged: storageChanged },
  runtime: {
    id: RUNTIME_ID,
    lastError: undefined,
    getURL: (path: string) => new URL(String(path ?? '').replace(/^\/+/, ''), appBase()).href,
    getManifest: () => ({
      manifest_version: 3,
      name: 'Archive',
      version: typeof __ARCHIVE_VERSION__ !== 'undefined' ? __ARCHIVE_VERSION__ : '0.0.0',
    }),
    sendMessage,
    onMessage,
    connect,
    onConnect,
    openOptionsPage() {
      navigate(shim.runtime.getURL('/options.html'));
      return Promise.resolve();
    },
    onInstalled: new Hub(),
    onStartup: new Hub(),
  },
  tabs,
  permissions: {
    request: () => Promise.resolve(true),
    contains: () => Promise.resolve(true),
    getAll: () => Promise.resolve({ permissions: [], origins: [] }),
    onAdded: new Hub(),
    onRemoved: new Hub(),
  },
  alarms,
  notifications,
};

export type ChromeShim = typeof shim;

export function installChromeShim(): ChromeShim {
  const g = globalThis as any;
  if (g.chrome?.runtime?.id === RUNTIME_ID) return g.chrome as ChromeShim;
  try {
    Object.defineProperty(g, 'chrome', { value: shim, configurable: true, writable: true, enumerable: true });
  } catch {
    g.chrome = shim;
  }
  return shim;
}

installChromeShim();
