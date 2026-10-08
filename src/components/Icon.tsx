// Inline stroke icons (24x24 grid, 1.75 stroke), no icon-font dependency.

const PATHS: Record<string, string> = {
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.8L12 16.9l-5.25 2.7 1-5.8L3.5 9.7l5.9-.9z',
  x: 'M6 6l12 12M18 6L6 18',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  note: 'M5 4h14v12H9l-4 4z',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronRight: 'M9 6l6 6-6 6',
  panel: 'M4 4h16v16H4zM14 4v16',
  library: 'M4 4h4v16H4zM10 4h4v16h-4zM16 5l3.8-.9 3 15.6-3.8.9z',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 13a7.7 7.7 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.7 7.7 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.7 7.7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.7 7.7 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 1.7-1l2.4 1 2-3.4z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  plus: 'M12 5v14M5 12h14',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  quote: 'M7 7h4v4c0 3-1.5 5-4 6M15 7h4v4c0 3-1.5 5-4 6',
  file: 'M6 3h8l5 5v13H6zM14 3v5h5',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  pin: 'M9 3h6l-1 6 4 4H6l4-4zM12 13v8',
  alert: 'M12 4l9.5 16h-19zM12 10v4M12 17.5v.01',
  book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19V5M8 7h7',
  code: 'M9 7l-5 5 5 5M15 7l5 5-5 5',
  scissors: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.5 7.5L20 19M8.5 16.5L20 5',
  zoomIn: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8M10.5 8v5M8 10.5h5',
  zoomOut: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4.8-4.8M8 10.5h5',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  send: 'M4 12l16-8-6 16-2.5-6.5z',
  stop: 'M7 7h10v10H7z',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5v.01',
  folder: 'M3 6h6l2 2h10v11H3z',
  inbox: 'M4 13l2.5-8h11L20 13v6H4zM4 13h5l1 2h4l1-2h5',
  merge: 'M7 4v6a5 5 0 0 0 5 5h5M14 12l3 3-3 3M7 20v-4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
};

export function Icon({ name, size = 16, className = '', title }: { name: keyof typeof PATHS | string; size?: number; className?: string; title?: string }) {
  const d = PATHS[name] ?? PATHS.alert;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="3" y="2" width="22" height="28" rx="3" fill="#22766c" />
      <rect x="7" y="7" width="11" height="2" rx="1" fill="#d6f1ec" />
      <rect x="7" y="12" width="11" height="2" rx="1" fill="#d6f1ec" />
      <rect x="7" y="17" width="8" height="2" rx="1" fill="#d6f1ec" />
      <rect x="21" y="9" width="8" height="14" rx="2" fill="#facc15" />
    </svg>
  );
}
