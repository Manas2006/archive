// Settings live in chrome.storage.local (content scripts read them). The API key
// is NOT here: it lives in the extension's IndexedDB (see secrets.ts), which
// content scripts can't reach; settings only carry `hasApiKey`.

export interface Settings {
  aiEnabled: boolean;
  hasApiKey: boolean;
  fastModel: string; // bulk work: extraction, topic names, review summaries
  smartModel: string; // explanations, evidence, compare
  readerRedirect: boolean; // open arXiv/OpenReview PDFs in the Archive reader
  dailyChecks: boolean;
  s2ApiKey: string;
  displayName: string;
  userId: string;
  /** Legacy (v0.2): typed author names. Migrated into the follows table on startup. */
  followedAuthors: string[];
  feedEnabled: boolean; // daily "For you" check: new papers by followed authors and for each project
  feedNotify: boolean; // notification when new papers land in For you
  driveAutoSave: boolean; // save every new paper's PDF to Google Drive
  driveAnnotatedPdfs: boolean; // embed highlights and notes in PDFs saved to Drive
  driveSync: boolean; // sync the library across devices through Google Drive
  citeCommand: string; // what "Copy cite" produces, e.g. \cite or [@] for Pandoc
  autoFileThreshold: number; // relevance >= this is filed into the project automatically
  suggestThreshold: number; // relevance >= this is suggested
  inferReadStatus: boolean;
  showFloatingButton: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  aiEnabled: false,
  hasApiKey: false,
  fastModel: 'claude-haiku-5-5',
  smartModel: 'claude-sonnet-5-5',
  readerRedirect: true,
  dailyChecks: true,
  s2ApiKey: '',
  displayName: '',
  userId: '',
  followedAuthors: [],
  feedEnabled: true,
  feedNotify: false,
  driveAutoSave: false,
  driveAnnotatedPdfs: true,
  driveSync: true,
  citeCommand: '\\cite',
  autoFileThreshold: 0.72,
  suggestThreshold: 0.45,
  inferReadStatus: true,
  showFloatingButton: true,
};

const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const raw = (await chrome.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  const s = { ...DEFAULT_SETTINGS, ...(raw ?? {}) };
  if (!s.userId) {
    s.userId = crypto.randomUUID();
    await chrome.storage.local.set({ [KEY]: s });
  }
  return s;
}

// Serialize writes in this context so quick successive changes (a slider and a toggle) don't revert each other.
let writeChain: Promise<unknown> = Promise.resolve();

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const run = writeChain.then(async () => {
    const s = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ [KEY]: s });
    return s;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

/** Back to the defaults, with a new user id. For "Delete all data". */
export function resetSettings(): Promise<Settings> {
  const run = writeChain.then(async () => {
    const s = { ...DEFAULT_SETTINGS, userId: crypto.randomUUID() };
    await chrome.storage.local.set({ [KEY]: s });
    return s;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && changes[KEY]) cb({ ...DEFAULT_SETTINGS, ...(changes[KEY].newValue ?? {}) });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** True only when AI mode is on and a key is present. Every AI surface checks this. */
export function aiAvailable(s: Settings): boolean {
  return s.aiEnabled && s.hasApiKey;
}
