// The Claude API key, kept in the extension origin's IndexedDB. Content scripts run in
// the page's origin, so they can neither read it nor receive it through storage events.
// Only the background and extension pages import this module.

import { db } from './db';
import { updateSettings } from './settings';

const LEGACY_KEY = 'secrets';

export async function getApiKey(): Promise<string> {
  const row = await db().kv.get('anthropicKey');
  if (row) return String(row.value ?? '');
  // one-time migration from the first build, which used chrome.storage.local
  const legacy = (await chrome.storage.local.get(LEGACY_KEY))[LEGACY_KEY] as { anthropicKey?: string } | undefined;
  if (legacy) {
    await chrome.storage.local.remove(LEGACY_KEY);
    if (legacy.anthropicKey) {
      await db().kv.put({ key: 'anthropicKey', value: legacy.anthropicKey });
      return legacy.anthropicKey;
    }
  }
  return '';
}

export async function setApiKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (trimmed) await db().kv.put({ key: 'anthropicKey', value: trimmed });
  else await db().kv.delete('anthropicKey');
  await chrome.storage.local.remove(LEGACY_KEY);
  await updateSettings({ hasApiKey: trimmed.length > 0 });
}
