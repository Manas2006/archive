// The message-driven half of the background: typed RPC and the AI streaming port.
// The extension's service worker registers it, and so does the web app, where
// the chrome shim (src/platform/chromeShim.ts) delivers messages inside the page.

import { handlers, type RpcCtx } from './handlers';
import type { RpcRequest, RpcResponse } from '../rpc';
import { onChange, type ChangeEvent } from '../changes';
import { followUp, startThread } from '../ai/features';
import type { AiPortEvent, AiPortRequest } from '../ai/port';
import { openNotesPanel } from '@/platform/panel';

export interface BackgroundOptions {
  platform: 'extension' | 'web';
}

let registered = false;

export function registerBackground(opts: BackgroundOptions) {
  if (registered) return;
  registered = true;

  // ---- RPC ----
  chrome.runtime.onMessage.addListener((msg: RpcRequest, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || !('__mg_rpc' in msg)) return;
    const method = msg.__mg_rpc;
    const ctx: RpcCtx = { tabId: sender.tab?.id, windowId: sender.tab?.windowId, url: sender.url };
    // the side panel (Chrome) and sidebar (Firefox) must open synchronously inside the user gesture
    if (method === 'openSidePanel') {
      if (opts.platform === 'web') {
        sendResponse({ ok: false, error: 'The notes panel is part of the browser extension.' } satisfies RpcResponse);
        return;
      }
      if (ctx.tabId !== undefined) {
        openNotesPanel({ tabId: ctx.tabId })
          .then(() => sendResponse({ ok: true, result: true } satisfies RpcResponse))
          .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) } satisfies RpcResponse));
        return true;
      }
      sendResponse({ ok: false, error: 'No tab' });
      return;
    }
    const fn = (handlers as Record<string, (...a: unknown[]) => Promise<unknown>>)[method];
    if (!fn) {
      sendResponse({ ok: false, error: `Unknown method ${method}` } satisfies RpcResponse);
      return;
    }
    fn(ctx, ...(msg.args ?? []))
      .then((result) => sendResponse({ ok: true, result } satisfies RpcResponse))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies RpcResponse));
    return true;
  });

  // ---- change relay to content scripts, and AI streaming ----
  const tabPorts = new Set<chrome.runtime.Port>();
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'mg-tab') {
      tabPorts.add(port);
      port.onDisconnect.addListener(() => tabPorts.delete(port));
      return;
    }
    if (port.name === 'mg-ai') {
      const ctrl = new AbortController();
      let closed = false;
      port.onDisconnect.addListener(() => {
        closed = true;
        ctrl.abort();
      });
      const send = (e: AiPortEvent) => {
        if (!closed) port.postMessage(e);
      };
      port.onMessage.addListener(async (req: AiPortRequest) => {
        const cb = { onThread: (thread: any) => send({ type: 'thread', thread }), onDelta: (text: string) => send({ type: 'delta', text }), signal: ctrl.signal };
        try {
          const thread = req.op === 'start' ? await startThread(req.input, cb) : await followUp(req.threadId, req.text, cb);
          send({ type: 'done', thread });
        } catch (e) {
          if ((e as Error).name !== 'AbortError') send({ type: 'error', message: (e as Error).message });
        }
      });
    }
  });
  if (opts.platform === 'extension') {
    onChange((evt: ChangeEvent) => {
      for (const p of tabPorts) {
        try {
          p.postMessage({ type: 'change', evt });
        } catch {
          tabPorts.delete(p);
        }
      }
    });
  }
}
