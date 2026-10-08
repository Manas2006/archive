export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface FetchOpts extends RequestInit {
  timeoutMs?: number;
  retries?: number;
}

export async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 20000, retries = 2, ...init } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: init.signal ?? ctrl.signal });
      clearTimeout(timer);
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1500 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function fetchJson<T = any>(url: string, opts: FetchOpts = {}): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts: FetchOpts = {}): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
