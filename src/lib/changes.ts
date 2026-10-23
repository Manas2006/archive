// Change notifications. Every write goes through the repository, which emits a
// ChangeEvent locally and on a BroadcastChannel so every extension page (and the
// background, which relays to content scripts) can refresh.

export interface ChangeEvent {
  table: string;
  keys: string[];
  paperIds: string[];
  /** Written by background work (enrichment, sorting, reading progress), not by the user. Not synced. */
  derived?: boolean;
}

const CHANNEL = 'marginalia:changes';
const local = new EventTarget();
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e) => local.dispatchEvent(new CustomEvent('change', { detail: e.data }));
  return channel;
}

export function emitChange(evt: ChangeEvent) {
  local.dispatchEvent(new CustomEvent('change', { detail: evt }));
  try {
    getChannel()?.postMessage(evt);
  } catch {
    /* channel closed */
  }
}

export function onChange(cb: (evt: ChangeEvent) => void): () => void {
  getChannel();
  const h = (e: Event) => cb((e as CustomEvent<ChangeEvent>).detail);
  local.addEventListener('change', h);
  return () => local.removeEventListener('change', h);
}

/** Used by content scripts, which receive relayed events from the background. */
export function dispatchRemoteChange(evt: ChangeEvent) {
  local.dispatchEvent(new CustomEvent('change', { detail: evt }));
}
