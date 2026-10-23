// Host permissions and Firefox's data-collection consent.
//
// Chrome grants the manifest's host permissions at install. Firefox (MV3) shows
// them in the install prompt but lets people decline or revoke them later, and
// without them content scripts don't run and arXiv/OpenReview/DBLP requests hit
// CORS. The web app has no permissions at all, so everything here is a no-op there.

import { isFirefox, isWebApp } from '@/lib/platform';

/** Data that leaves the browser when AI features are on (declared optional in the Firefox manifest). */
export const AI_DATA_COLLECTION = ['websiteContent', 'authenticationInfo'] as const;

/** Match patterns for every site Archive reads, normalized to `scheme://host/*`. */
export function hostOrigins(): string[] {
  if (isWebApp()) return [];
  const m = chrome.runtime.getManifest() as chrome.runtime.ManifestV3;
  const patterns = [...(m.host_permissions ?? []), ...(m.content_scripts ?? []).flatMap((c) => c.matches ?? [])];
  const out = new Set<string>();
  for (const p of patterns) {
    const i = p.indexOf('://');
    if (i < 0) continue;
    const slash = p.indexOf('/', i + 3);
    out.add(`${slash < 0 ? p : p.slice(0, slash)}/*`);
  }
  return [...out];
}

/** Whether Archive can read arXiv, OpenReview and its metadata sources. */
export async function hasHostPermissions(): Promise<boolean> {
  if (isWebApp()) return true;
  const origins = hostOrigins();
  if (!origins.length || !chrome.permissions?.contains) return true;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return true;
  }
}

/**
 * Ask for the manifest's host permissions. Firefox only shows the prompt for a
 * user action, so call this directly in a click handler, before any await.
 * Resolves true when access is (or already was) granted.
 */
export function ensureHostPermissions(): Promise<boolean> {
  if (isWebApp() || !chrome.permissions?.request) return Promise.resolve(true);
  try {
    return chrome.permissions.request({ origins: hostOrigins() }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/** Calls `cb` whenever host permissions are granted or revoked (e.g. in about:addons). */
export function onHostPermissionsChanged(cb: (granted: boolean) => void): () => void {
  if (isWebApp() || !chrome.permissions?.onAdded) return () => {};
  const h = () => void hasHostPermissions().then(cb);
  chrome.permissions.onAdded.addListener(h);
  chrome.permissions.onRemoved?.addListener(h);
  return () => {
    chrome.permissions.onAdded.removeListener(h);
    chrome.permissions.onRemoved?.removeListener(h);
  };
}

// ---- Firefox data-collection consent (Firefox 140+, Android 142+) ----

function browserPermissions(): any {
  const g = globalThis as any;
  return g.browser?.permissions ?? g.chrome?.permissions;
}

/** Whether the person agreed to send page text and their API key to Anthropic (always true outside Firefox). */
export async function hasAiDataConsent(): Promise<boolean> {
  if (isWebApp() || !isFirefox()) return true;
  try {
    const all = await browserPermissions()?.getAll?.();
    if (!all || !Array.isArray(all.data_collection)) return true; // Firefox without the consent API
    return AI_DATA_COLLECTION.every((d) => all.data_collection.includes(d));
  } catch {
    return true;
  }
}

/**
 * Firefox: ask for the optional data-collection consent the AI features need.
 * Call it from the click that turns AI on, before any await. Resolves true
 * outside Firefox, and on Firefox versions without the consent API.
 */
export function requestAiDataConsent(): Promise<boolean> {
  if (isWebApp() || !isFirefox()) return Promise.resolve(true);
  const perms = browserPermissions();
  if (!perms?.request) return Promise.resolve(true);
  try {
    return Promise.resolve(perms.request({ data_collection: [...AI_DATA_COLLECTION] })).then(
      (ok: boolean) => ok,
      // older Firefox rejects the unknown `data_collection` key: nothing to ask for there
      (e: unknown) => /data_collection|Unexpected property|Type error/i.test(String((e as Error)?.message ?? e)),
    );
  } catch (e) {
    return Promise.resolve(/data_collection|Unexpected property|Type error/i.test(String((e as Error)?.message ?? e)));
  }
}
