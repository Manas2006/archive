import { useEffect, useState } from 'react';
import type { TabContext } from '@/lib/types';

export interface ActiveTabState {
  tabId: number | null;
  windowId: number | null;
  ctx: (TabContext & { tabId: number }) | null;
  orphanIds: string[];
  url: string | null;
}

/** The active tab in this window and the paper context its content script registered. */
export function useActiveTab(): ActiveTabState {
  const [state, setState] = useState<ActiveTabState>({ tabId: null, windowId: null, ctx: null, orphanIds: [], url: null });

  useEffect(() => {
    let alive = true;
    let currentTab: number | null = null;
    const refresh = async () => {
      // ?tabId= pins the panel to one tab (used when the panel is opened as a page, e.g. in tests)
      const forced = Number(new URLSearchParams(location.search).get('tabId'));
      const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
      if (!alive || !tab?.id) return;
      currentTab = tab.id;
      const keys = [`tab:${tab.id}`, `anchors:${tab.id}`];
      const got = await chrome.storage.session.get(keys);
      const ctx = (got[keys[0]] as ActiveTabState['ctx']) ?? null;
      const anchors = got[keys[1]] as { paperId: string; orphanIds: string[] } | undefined;
      if (!alive) return;
      setState({
        tabId: tab.id,
        windowId: tab.windowId,
        ctx,
        orphanIds: anchors && ctx && anchors.paperId === ctx.paperId ? anchors.orphanIds : [],
        url: tab.url ?? null,
      });
    };
    void refresh();
    const onActivated = () => void refresh();
    const onUpdated = (tabId: number, info: { status?: string; url?: string }) => {
      if (tabId === currentTab && (info.status === 'complete' || info.url)) void refresh();
    };
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'session' || currentTab === null) return;
      if (changes[`tab:${currentTab}`] || changes[`anchors:${currentTab}`]) void refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.storage.onChanged.addListener(onStorage);
    chrome.windows?.onFocusChanged?.addListener(onActivated);
    return () => {
      alive = false;
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.storage.onChanged.removeListener(onStorage);
      chrome.windows?.onFocusChanged?.removeListener(onActivated);
    };
  }, []);

  return state;
}
