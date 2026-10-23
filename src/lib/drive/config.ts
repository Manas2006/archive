// Google Drive settings. Drive is opt-in: nothing in these modules talks to Google,
// and no permission prompt appears, until the user clicks "Connect Google Drive".
//
// Scope: only drive.file, which lets Archive see and change the files it created
// (or that the user opened with it) and nothing else in the user's Drive. It is a
// non-sensitive scope. It also covers about.get, which is how we read the account's
// email address without asking for the email or profile scopes:
// https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get

import { isFirefox, isWebApp } from '../platform';

function envClientId(): string {
  try {
    // Vite and WXT replace import.meta.env at build time. WXT exposes WXT_* and VITE_*
    // variables, the web build only VITE_*. Guarded so plain Node and vitest work too.
    const env = import.meta.env as unknown as Record<string, string | undefined> | undefined;
    return String(env?.WXT_GOOGLE_CLIENT_ID || env?.VITE_GOOGLE_CLIENT_ID || '').trim();
  } catch {
    return '';
  }
}

/** The OAuth client id baked in at build time. Not a secret: it is sent in the clear in every sign-in request. */
export const GOOGLE_CLIENT_ID: string = envClientId();

let clientIdOverride: string | null = null;

export function googleClientId(): string {
  return clientIdOverride ?? GOOGLE_CLIENT_ID;
}

/** True when this build has a Google OAuth client id, so the Drive features can be offered. */
export function driveConfigured(): boolean {
  return googleClientId().length > 0;
}

/**
 * Whether this runtime can sign in to Google at all. False only in the Firefox for
 * Android extension, which has no identity API; the web app works there.
 */
export function driveSupported(): boolean {
  if (isWebApp()) return true;
  const android = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
  return !(isFirefox() && android);
}

export const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'];

/** Top-level folder in the user's Drive. Everything Archive writes lives under it. */
export const ROOT_FOLDER = 'Archive';
export const SYNC_FOLDER = '.sync';
export const SYNC_FILE = 'library.json';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

/**
 * Requested with chrome.permissions.request when the user clicks Connect, and removed
 * on Disconnect. The manifest must list them as optional permissions.
 */
export const DRIVE_PERMISSIONS = {
  permissions: ['identity'],
  origins: ['https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*'],
};

/** Keys in db().kv used by the Drive modules. */
export const KV = {
  auth: 'drive.auth',
  folders: 'drive.folders',
  sync: 'drive.sync',
  lease: 'drive.syncLease',
} as const;

/** For tests. */
export function __setClientIdForTests(id: string | null) {
  clientIdOverride = id;
}
