// Typed request/response messaging from content scripts (and pages) to the background.

import type { Handlers } from './bg/handlers';

type Strip<F> = F extends (ctx: any, ...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;
export type RpcClient = { [K in keyof Handlers]: Strip<Handlers[K]> };

export interface RpcRequest {
  __mg_rpc: string;
  args: unknown[];
}

export type RpcResponse = { ok: true; result: unknown } | { ok: false; error: string };

export const rpc: RpcClient = new Proxy({} as RpcClient, {
  get(_t, method: string) {
    return async (...args: unknown[]) => {
      const req: RpcRequest = { __mg_rpc: method, args };
      let res: RpcResponse | undefined;
      try {
        res = await chrome.runtime.sendMessage(req);
      } catch (e) {
        throw new Error(`Marginalia background unavailable: ${(e as Error).message}`);
      }
      if (!res) throw new Error(`No response for ${method}`);
      if (!res.ok) throw new Error(res.error);
      return res.result;
    };
  },
});

// ---- commands sent to a tab (content script or the reader page) ----

export type TabCommand =
  | { type: 'scroll-to-annotation'; id: string }
  | { type: 'refresh' }
  | { type: 'explain-selection' }
  | { type: 'get-selection' };

export async function sendToTab(tabId: number, cmd: TabCommand): Promise<unknown> {
  const results = await Promise.allSettled([
    chrome.tabs.sendMessage(tabId, { __mg_tab: cmd }),
    chrome.runtime.sendMessage({ __mg_tab: cmd, tabId }),
  ]);
  for (const r of results) if (r.status === 'fulfilled' && r.value !== undefined) return r.value;
  return undefined;
}

export function onTabCommand(myTabId: () => number | null, cb: (cmd: TabCommand) => unknown) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg?.__mg_tab) return;
    if (msg.tabId !== undefined && msg.tabId !== myTabId()) return;
    const out = cb(msg.__mg_tab);
    if (out instanceof Promise) {
      out.then(sendResponse);
      return true;
    }
    if (out !== undefined) sendResponse(out);
  });
}
