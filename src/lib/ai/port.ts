// Streaming AI requests over a runtime port (works from content scripts and pages).

import type { StartThreadInput } from './features';
import type { Thread } from '../types';

export type AiPortRequest = { op: 'start'; input: StartThreadInput } | { op: 'followup'; threadId: string; text: string };

export type AiPortEvent =
  | { type: 'thread'; thread: Thread }
  | { type: 'delta'; text: string }
  | { type: 'done'; thread: Thread }
  | { type: 'error'; message: string };

export interface StreamCallbacks {
  onThread?: (t: Thread) => void;
  onDelta?: (text: string) => void;
  onDone?: (t: Thread) => void;
  onError?: (message: string) => void;
}

export function streamThread(req: AiPortRequest, cb: StreamCallbacks): () => void {
  const port = chrome.runtime.connect({ name: 'mg-ai' });
  let finished = false;
  port.onMessage.addListener((evt: AiPortEvent) => {
    if (evt.type === 'thread') cb.onThread?.(evt.thread);
    else if (evt.type === 'delta') cb.onDelta?.(evt.text);
    else if (evt.type === 'done') {
      finished = true;
      cb.onDone?.(evt.thread);
      port.disconnect();
    } else if (evt.type === 'error') {
      finished = true;
      cb.onError?.(evt.message);
      port.disconnect();
    }
  });
  port.onDisconnect.addListener(() => {
    if (!finished) cb.onError?.('Connection to Archive was interrupted. Try again.');
  });
  port.postMessage(req);
  return () => {
    finished = true;
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
  };
}
