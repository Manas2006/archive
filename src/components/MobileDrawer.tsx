import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { cx } from './common';

/**
 * A panel that slides over the page from the right (full width on phones).
 * Stands in for the browser's side panel where there is none: the web app and
 * Firefox for Android.
 */
export function MobileDrawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // the panel is still off-screen (sliding in): scrolling it into view would shift the whole drawer
    panel.current?.focus({ preventScroll: true });
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return (
    <div data-mg-ui className={cx('fixed inset-0 z-50 overflow-hidden', !open && 'pointer-events-none')} aria-hidden={!open}>
      <div className={cx('absolute inset-0 bg-stone-950/30 transition-opacity duration-200', open ? 'opacity-100' : 'opacity-0')} onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cx(
          'absolute inset-y-0 right-0 flex w-full max-w-[440px] flex-col bg-white shadow-2xl outline-none transition-transform duration-200 dark:bg-stone-950 sm:border-l sm:border-stone-200 sm:dark:border-stone-800',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-stone-200 px-3 dark:border-stone-800">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</span>
          <button type="button" className="mg-btn-ghost min-h-10 min-w-10 px-2" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{open && children}</div>
      </div>
    </div>
  );
}
