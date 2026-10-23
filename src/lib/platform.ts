// Where this code is running. The same pages ship as the browser extension and
// as the web app (phones and iPads); a few features depend on which one it is.

declare const __ARCHIVE_WEB__: boolean | undefined;

/** True in the web app build (no content scripts, no host permissions, CORS applies). */
export function isWebApp(): boolean {
  return typeof __ARCHIVE_WEB__ !== 'undefined' && !!__ARCHIVE_WEB__;
}

export function isFirefox(): boolean {
  return typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent);
}

export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

/** iPhone or iPad (iPadOS reports a Mac user agent, so check for touch too). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent) || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/** Touch-first device (phone or tablet), used to adapt selection handling and layout. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;
}

/** Narrow screen (phone portrait), where toolbars collapse into menus. */
export function isNarrowScreen(): boolean {
  return typeof window !== 'undefined' && window.innerWidth < 640;
}
