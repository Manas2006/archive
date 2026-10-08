import { useCallback, useEffect, useRef, useState } from 'react';
import { onChange, type ChangeEvent } from '@/lib/changes';

/**
 * Run an async loader and re-run it whenever the repository reports a change
 * matching `filter` (default: any change). Works in extension pages and, via
 * relayed events, in content scripts.
 */
export function useLive<T>(load: () => Promise<T>, deps: unknown[], filter?: (e: ChangeEvent) => boolean): { data: T | undefined; loading: boolean; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const filterRef = useRef(filter);
  filterRef.current = filter;

  const run = useCallback(() => {
    const mine = ++seq.current;
    load()
      .then((v) => {
        if (mine === seq.current) {
          setData(v);
          setError(null);
        }
      })
      .catch((e) => {
        if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    setLoading(true);
    run();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onChange((e) => {
      if (filterRef.current && e.table !== '*' && !filterRef.current(e)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, 60);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [run]);

  return { data, loading, error, reload: run };
}
