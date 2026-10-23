// Minimal Claude Messages API client for the browser (your own key, sent only to api.anthropic.com).

import { getApiKey } from '../secrets';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClaudeRequest {
  model: string;
  system?: { text: string; cache?: boolean }[];
  messages: ClaudeMessage[];
  maxTokens?: number;
  temperature?: number;
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ClaudeResult {
  text: string;
  stopReason: string | null;
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export class AiError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

const ENDPOINT = 'https://api.anthropic.com/v1/messages';

function headers(key: string): HeadersInit {
  return {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
}

function describeError(status: number, body: string): string {
  let msg = body;
  try {
    msg = JSON.parse(body)?.error?.message ?? body;
  } catch {
    /* not json */
  }
  if (status === 401) return 'Your Claude API key was rejected. Check it in Archive settings.';
  if (status === 429) return 'Claude API rate limit reached. Try again in a moment.';
  if (status === 529) return 'Claude is overloaded right now. Try again in a moment.';
  return `Claude API error ${status}: ${msg}`;
}

export async function callClaude(req: ClaudeRequest, keyOverride?: string): Promise<ClaudeResult> {
  const key = keyOverride ?? (await getApiKey());
  if (!key) throw new AiError('Add a Claude API key in Archive settings to use AI features.');
  const stream = !!req.onDelta;
  const body = {
    model: req.model,
    max_tokens: req.maxTokens ?? 1500,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.system?.length
      ? {
          system: req.system.map((s) => ({
            type: 'text',
            text: s.text,
            ...(s.cache ? { cache_control: { type: 'ephemeral' } } : {}),
          })),
        }
      : {}),
    messages: req.messages,
    stream,
  };
  let res: Response;
  try {
    res = await fetch(ENDPOINT, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal: req.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new AiError(`Couldn't reach the Claude API: ${(e as Error).message}`);
  }
  if (!res.ok) throw new AiError(describeError(res.status, await res.text()), res.status);
  if (!stream) {
    const json = await res.json();
    const text = (json.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    return { text, stopReason: json.stop_reason ?? null, usage: json.usage };
  }
  // Server-sent events
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let text = '';
  let stopReason: string | null = null;
  let usage: ClaudeResult['usage'];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let evt: any;
      try {
        evt = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        text += evt.delta.text;
        req.onDelta!(evt.delta.text);
      } else if (evt.type === 'message_start') {
        usage = evt.message?.usage;
      } else if (evt.type === 'message_delta') {
        stopReason = evt.delta?.stop_reason ?? stopReason;
        if (evt.usage) usage = { ...(usage ?? { input_tokens: 0, output_tokens: 0 }), ...evt.usage };
      } else if (evt.type === 'error') {
        throw new AiError(evt.error?.message ?? 'Claude stream error');
      }
    }
  }
  return { text, stopReason, usage };
}

/** Parse the first JSON object or array in a model reply. */
export function parseJsonReply<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fenced ? fenced[1] : text;
  const start = src.search(/[[{]/);
  const lastObj = src.lastIndexOf('}');
  const lastArr = src.lastIndexOf(']');
  const end = Math.max(lastObj, lastArr);
  if (start < 0 || end < start) throw new AiError('Claude returned an unexpected format.');
  return JSON.parse(src.slice(start, end + 1)) as T;
}

/** Validate a key and list available models. */
export async function testKey(key: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/models?limit=100', { headers: headers(key) });
    if (!res.ok) return { ok: false, models: [], error: describeError(res.status, await res.text()) };
    const json = await res.json();
    return { ok: true, models: (json.data ?? []).map((m: any) => m.id) };
  } catch (e) {
    return { ok: false, models: [], error: (e as Error).message };
  }
}
