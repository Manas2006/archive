// Google sign-in for Drive. The extension uses the identity API (launchWebAuthFlow),
// the web app uses Google Identity Services (GIS). Both use the implicit flow: a
// short-lived access token (about an hour), no refresh token and no client secret.
// Tokens are renewed silently when the browser allows it; when it doesn't, the
// account is flagged `needsReconnect` and the UI shows "Reconnect Google Drive".
//
// The token, its expiry and the account email live in db().kv under 'drive.auth'
// (the extension origin's IndexedDB, out of reach of content scripts).

import { db } from '../db';
import { emitChange } from '../changes';
import { nowIso, uuid } from '../ids';
import { fetchWithRetry } from '../net';
import { isFirefox, isWebApp } from '../platform';
import {
  DRIVE_API,
  DRIVE_PERMISSIONS,
  DRIVE_SCOPES,
  GIS_SCRIPT_URL,
  GOOGLE_AUTH_URL,
  GOOGLE_REVOKE_URL,
  KV,
  driveConfigured,
  driveSupported,
  googleClientId,
} from './config';

export interface DriveAccount {
  email: string;
  connectedAt: string;
  /** The token expired and could not be renewed without a click. Show "Reconnect Google Drive". */
  needsReconnect?: boolean;
}

export type DriveAuthErrorCode =
  | 'not_configured'
  | 'unsupported'
  | 'not_connected'
  | 'needs_reconnect'
  | 'denied'
  | 'cancelled'
  | 'popup_blocked'
  | 'failed';

export class DriveAuthError extends Error {
  constructor(public code: DriveAuthErrorCode, message: string) {
    super(message);
    this.name = 'DriveAuthError';
  }
}

export interface TokenOptions {
  /** Allowed to show Google's sign-in UI. Only from a click handler. */
  interactive?: boolean;
  /** Ignore the cached token (it was just rejected with a 401). */
  forceRefresh?: boolean;
}

export type TokenProvider = (opts: TokenOptions) => Promise<string | null>;

interface StoredAuth {
  token: string;
  expiresAt: number; // epoch ms
  email: string;
  connectedAt: string;
  needsReconnect?: boolean;
}

interface Grant {
  token: string;
  expiresIn: number; // seconds
  scope?: string;
}

const MIN_LEFT_MS = 2 * 60 * 1000;

// In-memory copy of the stored auth, per database (tests swap databases), so a click
// handler can start a sign-in popup synchronously without first awaiting IndexedDB.
const mem = new WeakMap<object, StoredAuth | null>();
const inflight = new WeakMap<object, Promise<string | null>>();
let tokenProvider: TokenProvider | null = null;

const isFresh = (a: StoredAuth | null | undefined): a is StoredAuth => !!a?.token && a.expiresAt - Date.now() > MIN_LEFT_MS;

async function readAuth(): Promise<StoredAuth | null> {
  const d = db();
  const row = await d.kv.get(KV.auth);
  const v = (row?.value as StoredAuth | undefined) ?? null;
  mem.set(d, v);
  return v;
}

async function writeAuth(v: StoredAuth): Promise<void> {
  const d = db();
  await d.kv.put({ key: KV.auth, value: v });
  mem.set(d, v);
}

function emitAuthChange(connected = false) {
  emitChange({ table: 'drive', keys: connected ? ['auth', 'connected'] : ['auth'], paperIds: [] });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getDriveAccount(): Promise<DriveAccount | null> {
  const a = await readAuth();
  if (!a) return null;
  return { email: a.email, connectedAt: a.connectedAt, ...(a.needsReconnect ? { needsReconnect: true } : {}) };
}

/**
 * First-time connect. Call it directly from the click handler, not after an await:
 * Firefox only shows the permission prompt, and iOS Safari only opens the sign-in
 * popup, while the click is being handled.
 */
export function connectDrive(): Promise<DriveAccount> {
  return startConnect(true);
}

/** Same as connectDrive but without forcing the consent screen. For the "Reconnect Google Drive" button. */
export function reconnectDrive(): Promise<DriveAccount> {
  return startConnect(false);
}

/**
 * Web app, when Drive is connected: load Google's sign-in script ahead of time, so the
 * Reconnect button can open the popup synchronously. Call it when Settings (or any
 * page with a Reconnect button) mounts. Google's script is not loaded for people who
 * never connect Drive. No-op in the extension.
 */
export function prepareDriveAuth(): Promise<void> {
  if (!driveConfigured()) return Promise.resolve();
  return readAuth().then(
    (a) => (a && isWebApp() ? loadGis().catch(() => undefined) : undefined),
    () => undefined,
  );
}

/** Web app: start loading Google's sign-in script, e.g. when the pointer reaches the Connect button. */
export function warmDriveSignIn(): void {
  if (driveConfigured() && isWebApp() && !tokenProvider) void loadGis().catch(() => undefined);
}

/** False in the web app until Google's sign-in script is loaded (a tap then can't open the popup yet). */
export function driveSignInReady(): boolean {
  return !isWebApp() || !!tokenProvider || !!gis;
}

/** Web app: load Google's sign-in script now. Resolves when Connect can open the popup. */
export function loadDriveSignIn(): Promise<void> {
  return isWebApp() && !tokenProvider ? loadGis() : Promise.resolve();
}

/**
 * A valid access token, or null when not connected or when it can't be renewed
 * without showing Google's UI. With `interactive`, it may show that UI (call it from
 * a click) and throws a DriveAuthError if the user cancels.
 */
export function getAccessToken(opts: TokenOptions = {}): Promise<string | null> {
  if (tokenProvider) return tokenProvider(opts);
  const d = db();
  const cached = mem.get(d);
  if (!opts.forceRefresh && isFresh(cached)) return Promise.resolve(cached.token);
  const running = inflight.get(d);
  if (running) return running;
  let p: Promise<string | null>;
  if (cached && isWebApp() && gis && (opts.interactive || userActive())) {
    // Start the popup now, while the click's user activation is still valid.
    p = gisRequest('', cached.email).then(
      async (g) => (await saveGrant(cached, g)).token,
      async (e) => {
        if (opts.interactive) throw e;
        await markNeedsReconnect();
        return null;
      },
    );
  } else {
    p = refreshSlow(opts);
  }
  const tracked = p.finally(() => {
    if (inflight.get(d) === tracked) inflight.delete(d);
  });
  inflight.set(d, tracked);
  return tracked;
}

/** Revoke the token, forget the account and, in the extension, give back the optional permissions. */
export async function disconnectDrive(): Promise<void> {
  const d = db();
  const cur = await readAuth().catch(() => null);
  if (cur) {
    let token: string | null = isFresh(cur) ? cur.token : null;
    if (!token && !tokenProvider) token = (await silentGrant(cur).catch(() => null))?.token ?? null;
    if (token) await revokeToken(token);
  }
  await d.kv.bulkDelete([KV.auth, KV.folders, KV.sync, KV.lease]);
  mem.set(d, null);
  if (!isWebApp()) {
    try {
      await ext()?.permissions?.remove?.(DRIVE_PERMISSIONS);
    } catch {
      /* not granted, or permissions are required in this build */
    }
  }
  emitAuthChange();
}

/** For tests: replace the whole token mechanism. connectDrive also uses it. */
export function __setTokenProviderForTests(fn: TokenProvider | null) {
  tokenProvider = fn;
}

// ---------------------------------------------------------------------------
// Connect and refresh
// ---------------------------------------------------------------------------

function startConnect(first: boolean): Promise<DriveAccount> {
  if (!driveConfigured()) return Promise.reject(new DriveAuthError('not_configured', 'This copy of Archive was built without a Google sign-in client.'));
  if (!driveSupported()) return Promise.reject(unsupported());
  if (tokenProvider) {
    return tokenProvider({ interactive: true }).then((t) => {
      if (!t) throw new DriveAuthError('cancelled', 'Google sign-in was cancelled.');
      return finishConnect({ token: t, expiresIn: 3600 });
    });
  }
  if (isWebApp()) {
    const hint = first ? undefined : mem.get(db())?.email;
    return gisRequest(first ? 'consent' : '', hint).then(finishConnect);
  }
  // Must be the first thing that happens in the click (Firefox requirement).
  const granted = requestPermissions();
  return granted.then(async (ok) => {
    if (!ok) throw new DriveAuthError('denied', 'Archive needs permission to sign in to Google. Click Connect again and allow it.');
    const hint = first ? undefined : (await readAuth())?.email;
    const grant = await extensionGrant({ interactive: true, prompt: first ? 'consent select_account' : undefined, hint });
    return finishConnect(grant);
  });
}

async function finishConnect(grant: Grant): Promise<DriveAccount> {
  const email = await fetchEmail(grant.token);
  const prev = await readAuth();
  const sameAccount = !!prev && prev.email.toLowerCase() === email.toLowerCase();
  // Another Google account has its own Drive: forget folder ids and sync revisions.
  if (prev && !sameAccount) await db().kv.bulkDelete([KV.folders, KV.sync, KV.lease]);
  const next: StoredAuth = {
    token: grant.token,
    expiresAt: Date.now() + grant.expiresIn * 1000,
    email,
    connectedAt: sameAccount ? prev!.connectedAt : nowIso(),
  };
  await writeAuth(next);
  emitAuthChange(true);
  return { email: next.email, connectedAt: next.connectedAt };
}

/** Email of the signed-in account, from Drive's about.get (covered by drive.file, so no extra scope). */
async function fetchEmail(token: string): Promise<string> {
  const res = await fetchWithRetry(`${DRIVE_API}/about?fields=${encodeURIComponent('user(emailAddress,displayName)')}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new DriveAuthError('failed', `Could not read your Google account (${res.status}).`);
  const j = (await res.json()) as { user?: { emailAddress?: string; displayName?: string } };
  return String(j.user?.emailAddress || j.user?.displayName || 'Google account');
}

async function refreshSlow(opts: TokenOptions): Promise<string | null> {
  const cur = await readAuth();
  if (!cur) return null;
  if (!opts.forceRefresh && isFresh(cur)) return cur.token;
  let grant = await silentGrant(cur).catch(() => null);
  if (!grant && opts.interactive) grant = await (isWebApp() ? gisRequest('', cur.email) : extensionGrant({ interactive: true, hint: cur.email }));
  if (!grant) {
    await markNeedsReconnect();
    return null;
  }
  return (await saveGrant(cur, grant)).token;
}

/** Renew without UI. In the web app a popup is needed even then, so only try during a user gesture. */
async function silentGrant(cur: StoredAuth): Promise<Grant | null> {
  if (isWebApp()) {
    if (!gis || !userActive()) return null;
    return gisRequest('', cur.email);
  }
  return extensionGrant({ interactive: false, prompt: 'none', hint: cur.email });
}

async function saveGrant(prev: StoredAuth, grant: Grant): Promise<StoredAuth> {
  const latest = (await readAuth()) ?? prev;
  const { needsReconnect, ...rest } = latest;
  const next: StoredAuth = { ...rest, token: grant.token, expiresAt: Date.now() + grant.expiresIn * 1000 };
  await writeAuth(next);
  if (needsReconnect) emitAuthChange();
  return next;
}

async function markNeedsReconnect(): Promise<void> {
  const cur = await readAuth();
  if (!cur || cur.needsReconnect) return;
  await writeAuth({ ...cur, needsReconnect: true });
  emitAuthChange();
}

async function revokeToken(token: string): Promise<void> {
  const oauth2 = (globalThis as any).google?.accounts?.oauth2;
  if (isWebApp() && oauth2?.revoke) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 5000);
      try {
        oauth2.revoke(token, () => {
          clearTimeout(t);
          resolve();
        });
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    return;
  }
  try {
    await fetchWithRetry(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      retries: 0,
      timeoutMs: 10000,
    });
  } catch {
    /* best effort: Google also drops the grant when the token expires unused */
  }
}

const unsupported = () => new DriveAuthError('unsupported', 'This browser cannot sign in to Google from an extension. Use the Archive web app instead.');

const scopeError = () =>
  new DriveAuthError('denied', 'Archive needs access to the files it creates in your Drive. Connect again and leave the Drive box checked.');

// ---------------------------------------------------------------------------
// Extension: identity.launchWebAuthFlow
// ---------------------------------------------------------------------------

/** Firefox exposes promise-based APIs as `browser`; Chrome as `chrome` (and `browser` since Chrome 148). */
function ext(): any {
  const g = globalThis as any;
  return g.browser?.runtime ? g.browser : g.chrome;
}

/** Synchronous start of permissions.request, so it runs inside the user gesture. */
function requestPermissions(): Promise<boolean> {
  const perms = ext()?.permissions;
  if (!perms?.request) return Promise.resolve(true);
  // If a browser refuses these as optional permissions, they must be required ones in its build.
  const fallback = () => !!ext()?.identity?.launchWebAuthFlow;
  try {
    // Firefox: identity is a required permission there (it can't be optional), and PDFs going to Drive
    // count as website content under its data-collection consent, which is asked for here
    const req = isFirefox() ? { origins: DRIVE_PERMISSIONS.origins, data_collection: ['websiteContent'] } : DRIVE_PERMISSIONS;
    // a "no" in Firefox's consent prompt is an answer; elsewhere a refusal can mean the permissions are required ones
    return Promise.resolve(perms.request(req)).then((ok: unknown) => !!ok || (!isFirefox() && fallback()), fallback);
  } catch {
    return Promise.resolve(fallback());
  }
}

function redirectUri(identity: any): string {
  const base = String(identity.getRedirectURL());
  if (!isFirefox()) return base; // https://<extension-id>.chromiumapp.org/
  // Firefox's https://<hash>.extensions.allizom.org/ can't be verified with Google, so use
  // the loopback form Firefox 86+ accepts for exactly this case (Mozilla bug 1635344).
  const hash = new URL(base).hostname.split('.')[0];
  return `http://127.0.0.1/mozoauth2/${hash}`;
}

function authUrl(opts: { redirectUri: string; state: string; prompt?: string; hint?: string }): string {
  const q = new URLSearchParams({
    client_id: googleClientId(),
    redirect_uri: opts.redirectUri,
    response_type: 'token',
    scope: DRIVE_SCOPES.join(' '),
    include_granted_scopes: 'true',
    state: opts.state,
  });
  if (opts.prompt) q.set('prompt', opts.prompt);
  if (opts.hint) q.set('login_hint', opts.hint);
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

/** Read access_token / expires_in / error from the URL Google redirected to (fragment, or query for some errors). */
export function parseAuthRedirect(url: string, expectedState?: string): Grant {
  const u = new URL(url);
  const p = new URLSearchParams(u.search);
  new URLSearchParams(u.hash.replace(/^#/, '')).forEach((v, k) => p.set(k, v));
  const error = p.get('error');
  if (error) {
    if (error === 'access_denied') throw new DriveAuthError('denied', 'Google Drive access was not granted.');
    throw new DriveAuthError('failed', `Google sign-in failed (${error}).`);
  }
  if (expectedState && p.get('state') !== expectedState) throw new DriveAuthError('failed', 'Google sign-in failed (unexpected response).');
  const token = p.get('access_token');
  if (!token) throw new DriveAuthError('failed', 'Google sign-in failed (no access token).');
  const scope = p.get('scope') ?? undefined;
  if (scope && !DRIVE_SCOPES.every((s) => scope.split(/\s+/).includes(s))) throw scopeError();
  return { token, expiresIn: Number(p.get('expires_in')) || 3600, scope };
}

async function extensionGrant(opts: { interactive: boolean; prompt?: string; hint?: string }): Promise<Grant> {
  const identity = ext()?.identity;
  if (!identity?.launchWebAuthFlow || !identity.getRedirectURL) throw unsupported();
  const state = uuid();
  const details: Record<string, unknown> = {
    url: authUrl({ redirectUri: redirectUri(identity), state, prompt: opts.prompt, hint: opts.hint }),
    interactive: opts.interactive,
  };
  if (!opts.interactive && !isFirefox()) {
    // Chrome 113+: let Google's silent redirect finish instead of giving up at the first page load.
    details.abortOnLoadForNonInteractive = false;
    details.timeoutMsForNonInteractive = 10000;
  }
  let responseUrl: string | undefined;
  try {
    responseUrl = await identity.launchWebAuthFlow(details);
  } catch (e) {
    if (!opts.interactive) throw new DriveAuthError('needs_reconnect', 'Reconnect Google Drive to continue.');
    const msg = e instanceof Error ? e.message : String((e as { message?: string })?.message ?? e);
    if (/did not approve|cancel|closed|denied/i.test(msg)) throw new DriveAuthError('cancelled', 'Google sign-in was cancelled.');
    throw new DriveAuthError('failed', `Google sign-in failed: ${msg}`);
  }
  if (!responseUrl) throw new DriveAuthError(opts.interactive ? 'cancelled' : 'needs_reconnect', 'Google sign-in was cancelled.');
  return parseAuthRedirect(responseUrl, state);
}

// ---------------------------------------------------------------------------
// Web app: Google Identity Services token client
// ---------------------------------------------------------------------------

interface Waiter {
  resolve: (g: Grant) => void;
  reject: (e: Error) => void;
}

let gis: { client: { requestAccessToken: (o: Record<string, unknown>) => void }; waiter: Waiter | null } | null = null;
let gisLoading: Promise<void> | null = null;

function userActive(): boolean {
  const ua = (globalThis.navigator as unknown as { userActivation?: { isActive?: boolean } } | undefined)?.userActivation;
  return !!ua?.isActive;
}

function loadGis(): Promise<void> {
  if (gis) return Promise.resolve();
  if (!gisLoading) {
    gisLoading = new Promise<void>((resolve, reject) => {
      const ready = () => {
        try {
          initGis();
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      if ((globalThis as any).google?.accounts?.oauth2) return ready();
      const s = document.createElement('script');
      s.src = GIS_SCRIPT_URL;
      s.async = true;
      s.onload = ready;
      s.onerror = () => reject(new DriveAuthError('failed', 'Could not load Google sign-in. Check your connection and try again.'));
      document.head.appendChild(s);
    }).catch((e) => {
      gisLoading = null;
      throw e;
    });
  }
  return gisLoading;
}

function initGis() {
  const oauth2 = (globalThis as any).google.accounts.oauth2;
  const state: NonNullable<typeof gis> = { client: null as never, waiter: null };
  const settle = (fn: (w: Waiter) => void) => {
    const w = state.waiter;
    state.waiter = null;
    if (w) fn(w);
  };
  state.client = oauth2.initTokenClient({
    client_id: googleClientId(),
    scope: DRIVE_SCOPES.join(' '),
    include_granted_scopes: true,
    callback: (resp: { access_token?: string; expires_in?: string | number; scope?: string; error?: string }) =>
      settle((w) => {
        if (resp?.error || !resp?.access_token) {
          w.reject(resp?.error === 'access_denied' ? new DriveAuthError('denied', 'Google Drive access was not granted.') : new DriveAuthError('failed', `Google sign-in failed (${resp?.error ?? 'no token'}).`));
        } else if (!oauth2.hasGrantedAllScopes(resp, ...DRIVE_SCOPES)) {
          w.reject(scopeError());
        } else {
          w.resolve({ token: resp.access_token, expiresIn: Number(resp.expires_in) || 3600, scope: resp.scope });
        }
      }),
    error_callback: (err: { type?: string }) =>
      settle((w) =>
        w.reject(
          err?.type === 'popup_failed_to_open'
            ? new DriveAuthError('popup_blocked', 'Your browser blocked the Google sign-in window. Tap the button again.')
            : err?.type === 'popup_closed'
              ? new DriveAuthError('cancelled', 'Google sign-in was cancelled.')
              : new DriveAuthError('failed', 'Google sign-in failed.'),
        ),
      ),
  });
  gis = state;
}

/** Opens the GIS popup. Synchronous when the script is loaded, which keeps the user gesture. */
function gisRequest(prompt: '' | 'consent', hint?: string): Promise<Grant> {
  return new Promise<Grant>((resolve, reject) => {
    const start = () => {
      const g = gis!;
      g.waiter?.reject(new DriveAuthError('cancelled', 'Google sign-in was replaced by a newer request.'));
      g.waiter = { resolve, reject };
      try {
        g.client.requestAccessToken({ prompt, ...(hint ? { login_hint: hint } : {}) });
      } catch (e) {
        g.waiter = null;
        reject(e instanceof Error ? e : new DriveAuthError('failed', String(e)));
      }
    };
    if (gis) start();
    else loadGis().then(start, reject);
  });
}
