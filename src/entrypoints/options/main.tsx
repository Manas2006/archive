import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/tailwind.css';
import { useSettings } from '@/hooks/useSettings';
import { Modal, Spinner, Toggle, cx } from '@/components/common';
import { Icon, Logo } from '@/components/Icon';
import { updateSettings } from '@/lib/settings';
import { getApiKey, setApiKey } from '@/lib/secrets';
import { testKey } from '@/lib/ai/client';
import { runDaily, lastDailyReport, type DailyReport } from '@/lib/daily';
import * as repo from '@/lib/repo';
import { annotationsJsonLd, download } from '@/lib/exports';
import { CITE_COMMANDS, citeText } from '@/lib/cite';
import { isAndroid, isFirefox, isWebApp } from '@/lib/platform';
import { ensureHostPermissions, hasAiDataConsent, hasHostPermissions, onHostPermissionsChanged, requestAiDataConsent } from '@/platform/permissions';
import { pageUrl } from '@/lib/nav';
import { useLive } from '@/hooks/useLive';
import { driveConfigured } from '@/lib/drive/config';
import { connectDrive, disconnectDrive, driveSignInReady, getDriveAccount, loadDriveSignIn, prepareDriveAuth, reconnectDrive, warmDriveSignIn } from '@/lib/drive/auth';
import { syncNow, type SyncReport } from '@/lib/drive/sync';
import { revokeAllBibLinks } from '@/lib/projectBib';
import { deleteAllData } from '@/lib/wipe';

function Section({ id, title, description, children }: { id?: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className="mg-card scroll-mt-4 p-5">
      <h2 className="text-base font-semibold text-stone-900 dark:text-stone-50">{title}</h2>
      {description && <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </section>
  );
}

function AiSection() {
  const s = useSettings();
  const [key, setKey] = useState('');
  const [stored, setStored] = useState('');
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'bad'; msg?: string; models: string[] }>({ state: 'idle', models: [] });
  useEffect(() => {
    getApiKey().then((k) => {
      setStored(k);
      setKey(k);
    });
  }, []);
  const masked = stored ? `${stored.slice(0, 10)}…${stored.slice(-4)}` : '';
  const runTest = async (k: string) => {
    setTest({ state: 'busy', models: [] });
    const r = await testKey(k);
    setTest(r.ok ? { state: 'ok', models: r.models } : { state: 'bad', msg: r.error, models: [] });
    return r.ok;
  };
  const [consent, setConsent] = useState(true);
  useEffect(() => {
    void hasAiDataConsent().then(setConsent);
  }, [s.aiEnabled]);
  const modelOptions = test.models.length ? test.models : [s.fastModel, s.smartModel, 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
  const uniq = [...new Set(modelOptions)];

  return (
    <Section
      id="ai"
      title="AI features"
      description="Explanations, evidence finding, questions across your whole library, related-work drafts, field extraction, topic names, review summaries and factoid drafts. They use your own Claude API key, and requests go straight from your browser to Anthropic. When this is off, every AI button is hidden and the rest of Archive works the same."
    >
      <Toggle
        checked={s.aiEnabled}
        onChange={(v) => {
          // Firefox asks for data-collection consent here; it must start in the click itself
          if (!v) void updateSettings({ aiEnabled: false });
          else
            void requestAiDataConsent().then((ok) => {
              if (ok) void updateSettings({ aiEnabled: true });
            });
        }}
        label="Turn on AI features"
      />
      {s.aiEnabled && !consent && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          Firefox needs your permission to send paper text and your API key to Anthropic.
          <button className="mg-btn py-0.5 text-xs" onClick={() => void requestAiDataConsent().then(setConsent)}>
            Allow
          </button>
        </div>
      )}
      {s.aiEnabled && (
        <div className="flex flex-col gap-4 rounded-lg bg-stone-50 p-4 dark:bg-stone-900">
          <label className="block">
            <span className="text-sm font-medium">Claude API key</span>
            <span className="mt-0.5 block text-sm text-stone-500">
              Create one at{' '}
              <a className="text-accent-700 underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                console.anthropic.com
              </a>
              . {isWebApp() ? "It's stored only in this browser on this device." : "It's stored only in this browser's extension storage."}
            </span>
            <div className="mt-2 flex gap-2">
              <input
                className="mg-input font-mono"
                type="password"
                autoComplete="off"
                placeholder="sk-ant-…"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <button
                className="mg-btn-primary"
                disabled={!key.trim() || key === stored}
                onClick={async () => {
                  const ok = await runTest(key.trim());
                  if (ok) {
                    await setApiKey(key.trim());
                    setStored(key.trim());
                  }
                }}
              >
                Save
              </button>
              {stored && (
                <button className="mg-btn" onClick={() => runTest(stored)}>
                  Test
                </button>
              )}
            </div>
          </label>
          <div className="text-sm">
            {test.state === 'busy' && (
              <span className="inline-flex items-center gap-2 text-stone-500">
                <Spinner /> Checking key…
              </span>
            )}
            {test.state === 'ok' && <span className="text-emerald-700 dark:text-emerald-300">Key works. AI features are on.</span>}
            {test.state === 'bad' && <span className="text-rose-700 dark:text-rose-300">{test.msg}</span>}
            {test.state === 'idle' && stored && <span className="text-stone-500">Saved key: <span className="font-mono">{masked}</span></span>}
            {test.state === 'idle' && !stored && <span className="text-amber-700 dark:text-amber-300">Add a key to turn the AI features on. Until then they stay hidden.</span>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm font-medium">Fast model</span>
              <span className="block text-xs text-stone-500">Extraction, topic names, review summaries, relevance</span>
              <select className="mg-input mt-1" value={s.fastModel} onChange={(e) => updateSettings({ fastModel: e.target.value })}>
                {uniq.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-sm font-medium">Reading model</span>
              <span className="block text-xs text-stone-500">Explain, evidence, compare, questions, factoid drafts</span>
              <select className="mg-input mt-1" value={s.smartModel} onChange={(e) => updateSettings({ smartModel: e.target.value })}>
                {uniq.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
          </div>
          {stored && (
            <button
              className="mg-btn-ghost self-start text-rose-700"
              onClick={async () => {
                await setApiKey('');
                setStored('');
                setKey('');
                setTest({ state: 'idle', models: [] });
              }}
            >
              <Icon name="trash" size={14} /> Remove key
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

function BackgroundSection() {
  const s = useSettings();
  const [report, setReport] = useState<DailyReport | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    lastDailyReport().then(setReport);
  }, []);
  return (
    <Section
      title="Daily check"
      description={`${isWebApp() ? 'Once a day, when you open the app, ' : 'Once a day '}Archive asks Semantic Scholar${isWebApp() ? '' : ' and DBLP'} whether your preprints were published (and swaps in the venue BibTeX), fetches embeddings and references for new papers, re-sorts topics, re-ranks the inbox and looks for new papers for For you.`}
    >
      <Toggle checked={s.dailyChecks} onChange={(v) => updateSettings({ dailyChecks: v })} label="Run the daily check" />
      <label className="block">
        <span className="text-sm font-medium">Semantic Scholar API key (optional)</span>
        <span className="block text-sm text-stone-500">The public API is rate limited. A free key makes checks on large libraries more reliable.</span>
        <input className="mg-input mt-2 font-mono" type="password" value={s.s2ApiKey} onChange={(e) => updateSettings({ s2ApiKey: e.target.value.trim() })} placeholder="optional" />
      </label>
      <div className="flex items-center gap-3">
        <button
          className="mg-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setReport(await runDaily({ force: true }));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner /> : <Icon name="refresh" size={14} />} Run now
        </button>
        {report && (
          <span className="text-sm text-stone-500">
            Last run {new Date(report.ranAt).toLocaleString()}: checked {report.checked}, {report.upgrades.length} venue update{report.upgrades.length === 1 ? '' : 's'}, {report.topics} topics
            {report.errors.length ? `, ${report.errors.length} error${report.errors.length > 1 ? 's' : ''}` : ''}.
          </span>
        )}
      </div>
      {report?.upgrades.length ? (
        <ul className="list-disc pl-5 text-sm text-stone-600 dark:text-stone-300">
          {report.upgrades.map((u) => (
            <li key={u.paperId}>
              {u.title} → {u.venue}
            </li>
          ))}
        </ul>
      ) : null}
      {report?.errors.length ? <details className="text-xs text-stone-500"><summary>Errors</summary>{report.errors.map((e, i) => <div key={i}>{e}</div>)}</details> : null}
    </Section>
  );
}

/** Firefox lets people decline host access at install; without it nothing on arXiv or OpenReview works. */
function HostAccessBanner() {
  const [ok, setOk] = useState(true);
  useEffect(() => {
    void hasHostPermissions().then(setOk);
    return onHostPermissionsChanged(setOk);
  }, []);
  if (ok) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <div className="font-semibold">Archive can't see arXiv or OpenReview yet</div>
      It needs access to those sites to save and highlight papers, and to Semantic Scholar and DBLP to look them up.
      <button className="mg-btn-primary self-start" onClick={() => void ensureHostPermissions().then(setOk)}>
        Grant access
      </button>
    </div>
  );
}

function DriveSection() {
  const s = useSettings();
  const { data: account, reload } = useLive(() => getDriveAccount(), [], (e) => e.table === 'drive');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncReport | null>(null);
  const configured = driveConfigured();
  useEffect(() => {
    // the web app has to open Google's sign-in popup synchronously on a tap, so once
    // connected, load it early for Reconnect (Connect loads it when the pointer gets there)
    if (configured && isWebApp()) void prepareDriveAuth().catch(() => undefined);
  }, [configured, !!account]);
  return (
    <Section
      id="drive"
      title="Google Drive"
      description="Save PDFs (with your highlights in them) to your Drive, keep project .bib files there for Overleaf, and sync your library between your computer, phone and iPad. Archive can only see files it creates."
    >
      {!configured ? (
        <p className="text-sm text-stone-500">This copy of Archive wasn't built with a Google sign-in client. If you built it yourself, see docs/google-drive-setup.md in the repository.</p>
      ) : !account ? (
        <div className="flex flex-col gap-2">
          <button
            className="mg-btn-primary self-start"
            disabled={!!busy}
            onPointerEnter={warmDriveSignIn}
            onPointerDown={warmDriveSignIn}
            onFocus={warmDriveSignIn}
            onClick={() => {
              setErr(null);
              setHint(null);
              if (!driveSignInReady()) {
                // Safari only opens the popup during the tap itself, so get it ready and ask for one more tap
                setBusy('connect');
                loadDriveSignIn()
                  .then(() => setHint('Google sign-in is ready. Tap Connect Google Drive again.'))
                  .catch((e) => setErr((e as Error).message))
                  .finally(() => setBusy(null));
                return;
              }
              setBusy('connect');
              connectDrive()
                .then(() => reload())
                .catch((e) => setErr((e as Error).message))
                .finally(() => setBusy(null));
            }}
          >
            {busy === 'connect' ? <Spinner /> : <Icon name="folder" size={14} />} Connect Google Drive
          </button>
          <p className="text-xs text-stone-500">Google will ask to let Archive see and manage only the files it creates. Nothing else in your Drive is visible to it.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
              <Icon name="check" size={14} /> Connected as {account.email}
            </span>
            <button
              className="mg-btn-ghost text-xs text-stone-500"
              title="Also turns off the public .bib links you made for Overleaf"
              disabled={busy === 'disconnect'}
              onClick={async () => {
                setBusy('disconnect');
                setErr(null);
                try {
                  const { revoked, failed } = await revokeAllBibLinks();
                  if (failed.length) {
                    const names = failed.map((f) => `"${f.project.name}"`).join(', ');
                    if (!confirm(`Archive couldn't turn off the public link to the .bib file of ${names} (${failed[0].error}). Disconnect anyway? The file stays shared until you change its sharing in Google Drive.`)) return;
                  } else if (revoked) {
                    await syncNow(); // so your other devices see the links are off
                  }
                  await disconnectDrive();
                  reload();
                } catch (e) {
                  setErr((e as Error).message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === 'disconnect' ? <Spinner /> : null} Disconnect
            </button>
          </div>
          {account.needsReconnect && (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
              Google sign-in expired, so syncing is paused.
              <button
                className="mg-btn py-0.5 text-xs"
                onClick={() => {
                  setErr(null);
                  reconnectDrive()
                    .then(() => reload())
                    .catch((e) => setErr((e as Error).message));
                }}
              >
                Reconnect Google Drive
              </button>
            </div>
          )}
          <Toggle checked={s.driveSync} onChange={(v) => updateSettings({ driveSync: v })} label="Sync my library across devices" description="Papers, highlights, notes, projects and who you follow, through one file in Archive/.sync in your Drive. Sign in with the same Google account on your phone or iPad." />
          {s.driveSync && (
            <div className="flex flex-wrap items-center gap-3 pl-12">
              <button
                className="mg-btn py-1 text-xs"
                disabled={!!busy}
                onClick={async () => {
                  setBusy('sync');
                  setErr(null);
                  try {
                    setSync(await syncNow());
                  } catch (e) {
                    setErr((e as Error).message);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === 'sync' ? <Spinner size={12} /> : <Icon name="refresh" size={13} />} Sync now
              </button>
              {sync && <span className="text-xs text-stone-500">{sync.error ? sync.error : `Synced ${new Date(sync.at).toLocaleTimeString()}: ${sync.pulled} change${sync.pulled === 1 ? '' : 's'} from other devices${sync.pushed ? ', uploaded this device' : ''}.`}</span>}
            </div>
          )}
          <Toggle checked={s.driveAutoSave} onChange={(v) => updateSettings({ driveAutoSave: v })} label="Save every new paper's PDF to Drive" description="Into Archive/<first project>/ (or Unsorted), named by citation key. You can always save one by hand from a paper's page." />
          <Toggle checked={s.driveAnnotatedPdfs} onChange={(v) => updateSettings({ driveAnnotatedPdfs: v })} label="Put my highlights and notes in the PDFs" description="They show up as normal PDF highlights in Drive's preview, Preview, Acrobat and GoodNotes." />
          <p className="text-xs text-stone-500">For Overleaf: open a project in the library and click Overleaf to keep its .bib file in Drive with a link Overleaf can read.</p>
        </>
      )}
      {hint && !err && <p className="text-sm text-stone-600 dark:text-stone-300">{hint}</p>}
      {err && <p className="text-sm text-rose-700">{err}</p>}
    </Section>
  );
}

function WritingSection() {
  const s = useSettings();
  return (
    <Section id="writing" title="Citations" description="What the Cite buttons copy, for pasting into LaTeX, Overleaf or Markdown.">
      <label className="block">
        <span className="text-sm font-medium">Citation command</span>
        <select className="mg-input mt-1" value={s.citeCommand} onChange={(e) => updateSettings({ citeCommand: e.target.value })}>
          {CITE_COMMANDS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="mt-1 block font-mono text-xs text-stone-500">Example: {citeText(['vaswani2017attention', 'brown2020language'], s.citeCommand)}</span>
      </label>
    </Section>
  );
}

function ForYouSection() {
  const s = useSettings();
  return (
    <Section id="foryou" title="For you" description="Once a day Archive looks for new papers by authors you follow, and new papers that fit your projects, and lists them under For you in the library.">
      <Toggle checked={s.feedEnabled} onChange={(v) => updateSettings({ feedEnabled: v })} label="Look for new papers every day" />
      {!isWebApp() && <Toggle checked={s.feedNotify} onChange={(v) => updateSettings({ feedNotify: v })} label="Notify me when new papers show up" />}
      <a className="mg-btn self-start" href={pageUrl('library', 'view=following')}>
        <Icon name="star" size={14} /> Manage who you follow
      </a>
    </Section>
  );
}

function DataSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [wipeOpen, setWipeOpen] = useState(false);
  return (
    <Section id="data" title="Your data" description="Everything is stored in this browser. Back it up, move it to another browser, or export your annotations in the W3C Web Annotation format.">
      <div className="flex flex-wrap gap-2">
        <a className="mg-btn" href={pageUrl('library', 'view=all&import=1')}>
          <Icon name="file" size={14} /> Import from Zotero or BibTeX
        </a>
        <button className="mg-btn" onClick={async () => download(`archive-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await repo.exportAll(), null, 1), 'application/json')}>
          <Icon name="download" size={14} /> Export backup
        </button>
        <button className="mg-btn" onClick={() => fileRef.current?.click()}>
          <Icon name="undo" size={14} /> Import backup
        </button>
        <button
          className="mg-btn"
          onClick={async () => {
            const anns = await repo.listAllAnnotations();
            const papers = new Map((await repo.listPapers()).map((p) => [p.id, p] as const));
            download('archive-annotations.jsonld', JSON.stringify(annotationsJsonLd(anns, papers), null, 2), 'application/ld+json');
          }}
        >
          <Icon name="file" size={14} /> Export annotations (JSON-LD)
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const n = await repo.importAll(JSON.parse(await f.text()));
              setMsg(`Imported ${n} records.`);
            } catch (err) {
              setMsg((err as Error).message);
            }
            e.target.value = '';
          }}
        />
      </div>
      {msg && <p className="text-sm text-stone-600">{msg}</p>}
      <div className="border-t border-stone-200 pt-4 dark:border-stone-800">
        <button className="mg-btn text-rose-700" onClick={() => setWipeOpen(true)}>
          <Icon name="trash" size={14} /> Delete all data
        </button>
      </div>
      <DeleteAllDialog open={wipeOpen} onClose={() => setWipeOpen(false)} />
    </Section>
  );
}

function DeleteAllDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: account } = useLive(() => getDriveAccount(), [open], (e) => e.table === 'drive');
  const [driveCopy, setDriveCopy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const finish = () => location.reload();
  return (
    <Modal open={open} onClose={warnings ? finish : onClose} title="Delete all data">
      {warnings ? (
        <div className="flex flex-col gap-3 text-sm">
          <p>Everything in this browser is deleted, and Google Drive is disconnected.</p>
          <ul className="list-disc pl-5 text-amber-800 dark:text-amber-200">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button className="mg-btn-primary" onClick={finish}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <p>
            This deletes every paper, highlight, note, project and follow in this browser, your Claude API key, your Ask history and your settings
            {account ? ', turns off the public .bib links you made for Overleaf, and disconnects Google Drive' : ''}. It cannot be undone, so export a backup first if you might want it back.
          </p>
          {account && (
            <Toggle
              checked={driveCopy}
              onChange={setDriveCopy}
              label="Also delete the synced library in Google Drive"
              description={`Moves Archive/.sync in ${account.email}'s Drive to the trash. Without this, connecting Drive again brings your library back. PDFs and .bib files you saved in Drive stay there either way. Other devices that are still connected keep their copy.`}
            />
          )}
          <div className="flex justify-end gap-2">
            <button className="mg-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              className="mg-btn-primary bg-rose-700 hover:bg-rose-800"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const { warnings } = await deleteAllData({ driveCopy });
                  if (warnings.length) setWarnings(warnings);
                  else finish();
                } catch (e) {
                  setWarnings([(e as Error).message]);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <Spinner /> : <Icon name="trash" size={14} />} Delete everything
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function App() {
  const s = useSettings();
  const welcome = location.hash === '#welcome';
  useEffect(() => {
    if (!s.loaded) return;
    const id = location.hash.slice(1);
    if (id && id !== 'welcome') document.getElementById(id)?.scrollIntoView();
  }, [s.loaded]);
  if (!s.loaded) return null;
  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pb-10 pt-[max(2.5rem,env(safe-area-inset-top))]">
        {isWebApp() && (
          <a className="mg-btn-ghost self-start px-1.5" href={pageUrl('library')}>
            <Icon name="chevronRight" size={16} className="rotate-180" /> Library
          </a>
        )}
        <header className="flex items-center gap-3">
          <Logo size={28} />
          <div>
            <h1 className="text-xl font-semibold">Archive settings</h1>
            <p className="text-sm text-stone-500">Version {chrome.runtime.getManifest().version}</p>
          </div>
        </header>
        {!isWebApp() && <HostAccessBanner />}
        {welcome && (
          <div className="rounded-lg border border-accent-200 bg-accent-50 p-4 text-sm text-accent-900 dark:border-accent-800 dark:bg-accent-900/30 dark:text-accent-100">
            <div className="font-semibold">Archive is installed.</div>
            {isAndroid() ? (
              <>Open any paper on arXiv or OpenReview and tap the save button at the bottom right. Highlight text on arXiv HTML pages or in the PDF reader.</>
            ) : (
              <>
                Open any paper on arXiv or OpenReview and press <kbd className="rounded bg-white px-1 font-mono text-xs dark:bg-stone-800">Alt+Shift+S</kbd> (or the save button at the bottom right) to save it. Highlight text on arXiv HTML pages or in the PDF reader. Pin the extension to your toolbar for quick access.
              </>
            )}
          </div>
        )}

        <Section title="Profile" description="Your name is attached to your annotations so they're ready to share when lab sharing arrives.">
          <label className="block">
            <span className="text-sm font-medium">Display name</span>
            <input className="mg-input mt-1" value={s.displayName} onChange={(e) => updateSettings({ displayName: e.target.value })} placeholder="Your name" />
          </label>
        </Section>

        <AiSection />

        <Section title="Reading">
          {!isWebApp() && (
            <Toggle
              checked={s.readerRedirect}
              onChange={(v) => updateSettings({ readerRedirect: v })}
              label="Open arXiv and OpenReview PDFs in the Archive reader"
              description={`${isFirefox() ? "Firefox's" : "Chrome's"} own PDF viewer can't be annotated. You can always switch back to the original from the reader.`}
            />
          )}
          <Toggle checked={s.inferReadStatus} onChange={(v) => updateSettings({ inferReadStatus: v })} label="Update reading status as you scroll" description="Moves a paper to Reading once you're into it and to Read near the end. Never moves a paper backwards." />
          {!isWebApp() && <Toggle checked={s.showFloatingButton} onChange={(v) => updateSettings({ showFloatingButton: v })} label="Show the save button on paper pages" />}
        </Section>

        <Section title="Sorting" description="How confidently a new paper must match a project before it's filed automatically, or suggested.">
          <label className="block">
            <span className="flex justify-between text-sm font-medium">
              File automatically at <span className="font-mono text-stone-500">{Math.round(s.autoFileThreshold * 100)}%</span>
            </span>
            <input type="range" min={0.5} max={0.95} step={0.01} value={s.autoFileThreshold} onChange={(e) => updateSettings({ autoFileThreshold: Number(e.target.value) })} className="w-full accent-accent-600" />
          </label>
          <label className="block">
            <span className="flex justify-between text-sm font-medium">
              Suggest at <span className="font-mono text-stone-500">{Math.round(s.suggestThreshold * 100)}%</span>
            </span>
            <input type="range" min={0.2} max={0.8} step={0.01} value={s.suggestThreshold} onChange={(e) => updateSettings({ suggestThreshold: Number(e.target.value) })} className="w-full accent-accent-600" />
          </label>
        </Section>

        <ForYouSection />

        <DriveSection />

        <WritingSection />

        <BackgroundSection />

        {!isWebApp() && !isAndroid() && (
        <Section title="Keyboard shortcuts">
          <ul className="grid gap-1.5 text-sm">
            {[
              ['Alt+Shift+S', 'Save the paper in the current tab'],
              ['Alt+Shift+M', isFirefox() ? 'Open the sidebar' : 'Open the notes side panel'],
              ['Alt+Shift+L', 'Open the library'],
              ['1 to 6', 'With text selected on a paper: highlight with a label'],
            ].map(([k, d]) => (
              <li key={k} className="flex gap-3">
                <kbd className={cx('min-w-[96px] rounded border border-stone-300 bg-white px-1.5 py-0.5 text-center font-mono text-xs dark:border-stone-600 dark:bg-stone-800')}>{k}</kbd>
                <span className="text-stone-600 dark:text-stone-300">{d}</span>
              </li>
            ))}
          </ul>
          {isFirefox() ? (
            <p className="text-xs text-stone-500">To change them, open about:addons, click the gear icon and choose Manage Extension Shortcuts.</p>
          ) : (
            <button className="mg-btn self-start" onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
              Change shortcuts
            </button>
          )}
        </Section>
        )}

        <DataSection />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
