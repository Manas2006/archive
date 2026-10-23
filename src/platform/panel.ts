// The notes panel: Chrome's side panel, Firefox's sidebar, or (Firefox for
// Android, which has neither) the panel page opened in its own tab.

import { isWebApp } from '@/lib/platform';

type SidebarAction = { open: () => Promise<void>; close?: () => Promise<void> };

function sidePanelApi(): typeof chrome.sidePanel | undefined {
  return (globalThis as any).chrome?.sidePanel;
}

function sidebarActionApi(): SidebarAction | undefined {
  const g = globalThis as any;
  return g.browser?.sidebarAction ?? g.chrome?.sidebarAction;
}

/** True when the browser has a panel next to the page (Chrome side panel, Firefox desktop sidebar). */
export function hasNotesPanel(): boolean {
  if (isWebApp()) return false;
  return !!sidePanelApi()?.open || !!sidebarActionApi()?.open;
}

/**
 * Open the notes panel for a tab. Chrome and Firefox only allow this inside a
 * user gesture, so call it synchronously from the click (or command) handler,
 * before any await.
 */
export function openNotesPanel(target: { tabId?: number | null; windowId?: number | null }): Promise<void> {
  try {
    const sp = sidePanelApi();
    if (sp?.open) {
      // a window id opens the panel for the whole window (the popup's behavior); a tab id, for that tab
      if (target.windowId != null) return sp.open({ windowId: target.windowId });
      if (target.tabId != null) return sp.open({ tabId: target.tabId });
      return Promise.reject(new Error('No tab'));
    }
    const sb = sidebarActionApi();
    if (sb?.open) return sb.open();
    if (isWebApp()) return Promise.reject(new Error('The notes panel is part of the browser extension.'));
    // Firefox for Android: show the panel as a page pinned to the paper's tab
    const q = target.tabId != null ? `?tabId=${target.tabId}` : '';
    return chrome.tabs.create({ url: chrome.runtime.getURL(`/sidepanel.html${q}`) }).then(() => undefined);
  } catch (e) {
    return Promise.reject(e);
  }
}
