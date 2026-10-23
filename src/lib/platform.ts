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

/** Touch-first device (phone or tablet), used to adapt selection handling and layout. */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 1;
}
