import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, aiAvailable, getSettings, onSettingsChanged, type Settings } from '@/lib/settings';

export function useSettings(): Settings & { loaded: boolean; ai: boolean } {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    getSettings().then((v) => {
      if (alive) {
        setS(v);
        setLoaded(true);
      }
    });
    const off = onSettingsChanged((v) => setS(v));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return { ...s, loaded, ai: aiAvailable(s) };
}
