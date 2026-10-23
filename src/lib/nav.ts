// Opening Archive's own pages, in the extension and in the web app.

import { isWebApp } from './platform';

export function pageUrl(page: 'library' | 'options' | 'reader', hash = ''): string {
  return chrome.runtime.getURL(`/${page}.html`) + (hash ? `#${hash}` : '');
}

/** Open Settings, optionally scrolled to a section (e.g. 'drive', 'ai'). */
export function openSettings(section?: string) {
  const url = pageUrl('options', section);
  if (isWebApp()) location.assign(url);
  else void chrome.tabs.create({ url });
}
