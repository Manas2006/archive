import { useCallback, useEffect, useRef, useState } from 'react';
import { streamThread } from '@/lib/ai/port';
import type { StartThreadInput } from '@/lib/ai/features';
import type { Thread } from '@/lib/types';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { Spinner, cx } from './common';

export function useThread(initial?: Thread | null) {
  const [thread, setThread] = useState<Thread | null>(initial ?? null);
  const [streamText, setStreamText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<(() => void) | null>(null);

  useEffect(() => () => cancel.current?.(), []);

  const run = useCallback((req: Parameters<typeof streamThread>[0]) => {
    cancel.current?.();
    setBusy(true);
    setError(null);
    setStreamText('');
    cancel.current = streamThread(req, {
      onThread: (t) => setThread(t),
      onDelta: (d) => setStreamText((s) => s + d),
      onDone: (t) => {
        setThread(t);
        setStreamText('');
        setBusy(false);
      },
      onError: (m) => {
        setError(m);
        setBusy(false);
      },
    });
  }, []);

  return {
    thread,
    setThread,
    streamText,
    busy,
    error,
    start: (input: StartThreadInput) => run({ op: 'start', input }),
    followUp: (text: string) => thread && run({ op: 'followup', threadId: thread.id, text }),
    stop: () => {
      cancel.current?.();
      cancel.current = null;
      setBusy(false);
    },
  };
}

export function ThreadView({ t, compact, autoFocus }: { t: ReturnType<typeof useThread>; compact?: boolean; autoFocus?: boolean }) {
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const { thread, streamText, busy, error } = t;

  useEffect(() => {
    if (!compact) bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [thread?.messages.length, streamText, compact]);

  const messages = thread?.messages ?? [];
  return (
    <div className="flex flex-col gap-3">
      {messages.map((m, i) =>
        m.role === 'user' ? (
          i === 0 && (thread?.kind === 'explain' || thread?.kind === 'evidence') ? (
            <blockquote key={i} className="border-l-[3px] border-accent-400 pl-3 text-sm italic text-stone-600 dark:text-stone-300">
              {m.content.length > 400 ? `${m.content.slice(0, 400)}…` : m.content}
            </blockquote>
          ) : (
            <div key={i} className="ml-6 self-end rounded-lg bg-accent-50 px-3 py-2 text-sm text-stone-800 dark:bg-accent-900/30 dark:text-stone-100">
              <Markdown text={m.content} />
            </div>
          )
        ) : (
          <div key={i} className="text-sm text-stone-800 dark:text-stone-100">
            <Markdown text={m.content} />
          </div>
        ),
      )}
      {busy && (
        <div className="text-sm text-stone-800 dark:text-stone-100">
          {streamText ? (
            <Markdown text={streamText} />
          ) : (
            <span className="inline-flex items-center gap-2 text-stone-500">
              <Spinner /> Reading the paper…
            </span>
          )}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">
          <Icon name="alert" size={15} className="mt-0.5" />
          <span>{error}</span>
        </div>
      )}
      {thread && (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const text = draft.trim();
            if (!text || busy) return;
            t.followUp(text);
            setDraft('');
          }}
        >
          <textarea
            className="mg-input min-h-[38px] flex-1 resize-none"
            rows={1}
            value={draft}
            autoFocus={autoFocus}
            placeholder="Ask a follow-up…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                (e.currentTarget.form as HTMLFormElement).requestSubmit();
              }
            }}
          />
          {busy ? (
            <button type="button" className="mg-btn" onClick={t.stop} title="Stop">
              <Icon name="stop" size={14} />
            </button>
          ) : (
            <button type="submit" className={cx('mg-btn-primary', !draft.trim() && 'opacity-60')} title="Send">
              <Icon name="send" size={14} />
            </button>
          )}
        </form>
      )}
      <div ref={bottom} />
    </div>
  );
}
