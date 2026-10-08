import { fetchJson, fetchText } from '../net';

export function isCorrKey(key: string): boolean {
  return /^journals\/corr\//.test(key);
}

export async function dblpBibtex(key: string): Promise<string | null> {
  try {
    const bib = await fetchText(`https://dblp.org/rec/${key}.bib?param=1`, { retries: 2 });
    return bib.includes('@') ? bib : null;
  } catch {
    return null;
  }
}

export interface DblpHit {
  key: string;
  title: string;
  venue: string;
  year: number | null;
  type: string;
}

const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Find a non-CoRR DBLP record whose title matches exactly (after normalization). */
export async function dblpFindVenueRecord(title: string): Promise<DblpHit | null> {
  try {
    const r = await fetchJson<any>(
      `https://dblp.org/search/publ/api?q=${encodeURIComponent(title.slice(0, 200))}&format=json&h=10`,
      { retries: 1 },
    );
    const hits: any[] = r?.result?.hits?.hit ?? [];
    const want = normTitle(title);
    for (const h of hits) {
      const info = h.info ?? {};
      if (normTitle(String(info.title ?? '')) !== want) continue;
      if (isCorrKey(info.key ?? '') || /Informal/i.test(info.type ?? '')) continue;
      return {
        key: info.key,
        title: info.title,
        venue: Array.isArray(info.venue) ? info.venue.join(', ') : String(info.venue ?? ''),
        year: info.year ? Number(info.year) : null,
        type: String(info.type ?? ''),
      };
    }
  } catch {
    /* network */
  }
  return null;
}
