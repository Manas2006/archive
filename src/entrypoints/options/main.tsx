import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/assets/tailwind.css';
import { useSettings } from '@/hooks/useSettings';
import { Spinner, Toggle, cx } from '@/components/common';
import { Icon, Logo } from '@/components/Icon';
import { updateSettings } from '@/lib/settings';
import { getApiKey, setApiKey } from '@/lib/secrets';
import { testKey } from '@/lib/ai/client';
import { runDaily, lastDailyReport, type DailyReport } from '@/lib/daily';
import * as repo from '@/lib/repo';
import { annotationsJsonLd, download } from '@/lib/exports';

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="mg-card p-5">
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
  const modelOptions = test.models.length ? test.models : [s.fastModel, s.smartModel, 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];
  const uniq = [...new Set(modelOptions)];

  return (
    <Section
      title="AI features"
      description="Explanations, evidence finding, field extraction, topic names, review summaries and factoid drafts. They use your own Claude API key, and requests go straight from your browser to Anthropic. When this is off, every AI button is hidden and the rest of Marginalia works the same."
    >
      <Toggle checked={s.aiEnabled} onChange={(v) => updateSettings({ aiEnabled: v })} label="Turn on AI features" />
      {s.aiEnabled && (
        <div className="flex flex-col gap-4 rounded-lg bg-stone-50 p-4 dark:bg-stone-900">
          <label className="block">
            <span className="text-sm font-medium">Claude API key</span>
            <span className="mt-0.5 block text-sm text-stone-500">
              Create one at{' '}
              <a className="text-accent-700 underline" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                console.anthropic.com
              </a>
              . It's stored only in this browser's extension storage.
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
      description="Once a day Marginalia asks Semantic Scholar and DBLP whether your preprints were published (and swaps in the venue BibTeX), fetches embeddings and references for new papers, re-sorts topics and re-ranks the inbox."
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

function DataSection() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <Section title="Your data" description="Everything is stored in this browser. Back it up, move it to another browser, or export your annotations in the W3C Web Annotation format.">
      <div className="flex flex-wrap gap-2">
        <button className="mg-btn" onClick={async () => download(`marginalia-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await repo.exportAll(), null, 1), 'application/json')}>
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
            download('marginalia-annotations.jsonld', JSON.stringify(annotationsJsonLd(anns, papers), null, 2), 'application/ld+json');
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
        <button
          className="mg-btn text-rose-700"
          onClick={async () => {
            if (confirm('Delete every saved paper, highlight, note and project from this browser? This cannot be undone.')) {
              await repo.clearAll();
              setMsg('All data deleted.');
            }
          }}
        >
          <Icon name="trash" size={14} /> Delete all data
        </button>
      </div>
    </Section>
  );
}

function App() {
  const s = useSettings();
  const [authors, setAuthors] = useState('');
  useEffect(() => {
    if (s.loaded) setAuthors(s.followedAuthors.join('\n'));
  }, [s.loaded]);
  const welcome = location.hash === '#welcome';
  if (!s.loaded) return null;
  return (
    <div className="min-h-screen bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-10">
        <header className="flex items-center gap-3">
          <Logo size={28} />
          <div>
            <h1 className="text-xl font-semibold">Marginalia settings</h1>
            <p className="text-sm text-stone-500">Version {chrome.runtime.getManifest().version}</p>
          </div>
        </header>
        {welcome && (
          <div className="rounded-lg border border-accent-200 bg-accent-50 p-4 text-sm text-accent-900 dark:border-accent-800 dark:bg-accent-900/30 dark:text-accent-100">
            <div className="font-semibold">Marginalia is installed.</div>
            Open any paper on arXiv or OpenReview and press <kbd className="rounded bg-white px-1 font-mono text-xs dark:bg-stone-800">Alt+Shift+S</kbd> (or the save button at the bottom right) to save it. Highlight text on arXiv HTML pages or in the PDF reader. Pin the extension to your toolbar for quick access.
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
          <Toggle
            checked={s.readerRedirect}
            onChange={(v) => updateSettings({ readerRedirect: v })}
            label="Open arXiv and OpenReview PDFs in the Marginalia reader"
            description="Chrome's own PDF viewer can't be annotated. You can always switch back to the original from the reader."
          />
          <Toggle checked={s.inferReadStatus} onChange={(v) => updateSettings({ inferReadStatus: v })} label="Update reading status as you scroll" description="Moves a paper to Reading once you're into it and to Read near the end. Never moves a paper backwards." />
          <Toggle checked={s.showFloatingButton} onChange={(v) => updateSettings({ showFloatingButton: v })} label="Show the save button on paper pages" />
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
          <label className="block">
            <span className="text-sm font-medium">Authors you follow</span>
            <span className="block text-sm text-stone-500">One per line. Their papers rise to the top of your inbox.</span>
            <textarea
              className="mg-input mt-2"
              rows={4}
              value={authors}
              onChange={(e) => setAuthors(e.target.value)}
              onBlur={() => updateSettings({ followedAuthors: authors.split('\n').map((a) => a.trim()).filter(Boolean) })}
              placeholder={'Leqi Liu\nPercy Liang'}
            />
          </label>
        </Section>

        <BackgroundSection />

        <Section title="Keyboard shortcuts">
          <ul className="grid gap-1.5 text-sm">
            {[
              ['Alt+Shift+S', 'Save the paper in the current tab'],
              ['Alt+Shift+M', 'Open the notes side panel'],
              ['Alt+Shift+L', 'Open the library'],
              ['1 to 6', 'With text selected on a paper: highlight with a label'],
            ].map(([k, d]) => (
              <li key={k} className="flex gap-3">
                <kbd className={cx('min-w-[96px] rounded border border-stone-300 bg-white px-1.5 py-0.5 text-center font-mono text-xs dark:border-stone-600 dark:bg-stone-800')}>{k}</kbd>
                <span className="text-stone-600 dark:text-stone-300">{d}</span>
              </li>
            ))}
          </ul>
          <button className="mg-btn self-start" onClick={() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
            Change shortcuts
          </button>
        </Section>

        <DataSection />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
