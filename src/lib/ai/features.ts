// AI features. Every entry point checks aiAvailable() first, so nothing here
// runs (or costs anything) when AI mode is off.

import { callClaude, parseJsonReply, type ClaudeMessage } from './client';
import * as repo from '../repo';
import { aiAvailable, getSettings } from '../settings';
import { nowIso, uuid } from '../ids';
import type { Annotation, ExtractedFields, HighlightLabel, Paper, Project, Thread, ThreadKind } from '../types';
import type { FactoidDraft } from '../exports';

const MAX_PAPER_CHARS = 180_000; // ~45k tokens; cached across follow-ups

export async function requireAi() {
  const s = await getSettings();
  if (!aiAvailable(s)) throw new Error('AI features are turned off. Turn them on in Archive settings.');
  return s;
}

function authorsShort(p: Paper): string {
  const names = p.authors.map((a) => a.name);
  return names.length > 6 ? `${names.slice(0, 6).join(', ')} et al.` : names.join(', ');
}

export async function paperContext(p: Paper): Promise<{ text: string; hasFullText: boolean }> {
  const ft = await repo.getFullText(p.id);
  const head = `Title: ${p.title}\nAuthors: ${authorsShort(p)}\n${p.venue ? `Venue: ${p.venue}\n` : ''}${p.arxivId ? `arXiv: ${p.arxivId}\n` : ''}`;
  if (ft?.text) {
    const body = ft.text.length > MAX_PAPER_CHARS ? `${ft.text.slice(0, MAX_PAPER_CHARS)}\n[... text truncated ...]` : ft.text;
    return { text: `${head}\nFull text:\n${body}`, hasFullText: true };
  }
  return { text: `${head}\nAbstract:\n${p.abstract}\n\n(Only the abstract is available for this paper.)`, hasFullText: false };
}

const READER_SYSTEM = `You are a careful research reading assistant helping an ML researcher read a paper. Answer from the paper text provided; when you rely on outside knowledge, say so. Refer to sections, equations, tables and figures by their numbers in the paper. Be concise and concrete. Write in Markdown and use $...$ for inline math and $$...$$ for display math. Do not use em dashes.`;

// ---------------------------------------------------------------------------
// Threads (explain, evidence, compare, symbol, free chat): streamed
// ---------------------------------------------------------------------------

export interface StartThreadInput {
  kind: ThreadKind;
  paperId: string;
  quote?: string;
  context?: string; // surrounding text for symbol lookups
  symbol?: string;
  comparePaperId?: string;
  annotationId?: string;
  question?: string;
}

function firstPrompt(input: StartThreadInput, other?: { paper: Paper; text: string }): { title: string; prompt: string } {
  switch (input.kind) {
    case 'explain':
      return {
        title: 'Explain',
        prompt: `Explain this passage from the paper:\n\n> ${input.quote}\n\nSay what it means in the context of this paper. Define any terms or symbols it uses with the paper's own definitions, and point to where they are introduced. Then say briefly why the passage matters for the paper's argument. Keep it under 200 words unless the passage is dense.`,
      };
    case 'evidence':
      return {
        title: 'Evidence',
        prompt: `Here is a claim from the paper:\n\n> ${input.quote}\n\nFind the evidence in the paper for this claim: the specific tables, figures or experiments, with the relevant numbers. Start with a one-line verdict: **Supported**, **Partially supported**, or **Not supported in the paper**. Then list the evidence. If the paper gives no direct evidence, say so plainly and say what would be needed.`,
      };
    case 'symbol':
      return {
        title: `Symbol ${input.symbol ?? ''}`.trim(),
        prompt: `What does the symbol $${input.symbol}$ mean in this paper? It appears here:\n\n> ${input.context ?? input.quote ?? ''}\n\nGive its definition as the paper uses it, where it is defined, and its type or shape if relevant. 2 to 4 sentences.`,
      };
    case 'compare':
      return {
        title: `Compare with ${other?.paper.title ?? 'paper'}`,
        prompt: `Compare this paper (the one in the system prompt) with another paper from my library:\n\n<other_paper>\n${other?.text ?? ''}\n</other_paper>\n\nCover: the problem each addresses, how the methods differ, how the results compare (only where they are directly comparable, with numbers), and when you would use one over the other. Use short headed sections.`,
      };
    default:
      return { title: input.question?.slice(0, 60) ?? 'Question', prompt: input.question ?? '' };
  }
}

export interface ThreadStreamCallbacks {
  onThread: (t: Thread) => void;
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

async function runThread(thread: Thread, apiMessages: ClaudeMessage[], cb: ThreadStreamCallbacks): Promise<Thread> {
  const s = await requireAi();
  const paper = await repo.getPaper(thread.paperId);
  if (!paper) throw new Error('Paper not found');
  const ctx = await paperContext(paper);
  const result = await callClaude({
    model: s.smartModel,
    system: [{ text: READER_SYSTEM }, { text: `<paper>\n${ctx.text}\n</paper>`, cache: true }],
    messages: apiMessages,
    maxTokens: 1800,
    onDelta: cb.onDelta,
    signal: cb.signal,
  });
  const next: Thread = {
    ...thread,
    messages: [...thread.messages, { role: 'assistant', content: result.text, at: nowIso() }],
  };
  return repo.putThread(next);
}

export async function startThread(input: StartThreadInput, cb: ThreadStreamCallbacks): Promise<Thread> {
  await requireAi();
  const paper = await repo.getPaper(input.paperId);
  if (!paper) throw new Error('Save the paper first.');
  let other: { paper: Paper; text: string } | undefined;
  if (input.kind === 'compare' && input.comparePaperId) {
    const op = await repo.getPaper(input.comparePaperId);
    if (!op) throw new Error('Comparison paper not found');
    const oc = await paperContext(op);
    other = { paper: op, text: oc.text.slice(0, 60_000) };
  }
  const { title, prompt } = firstPrompt(input, other);
  const meta = await repo.newMeta();
  const display =
    input.kind === 'compare'
      ? `Compare with "${other?.paper.title}"`
      : input.kind === 'chat'
        ? input.question ?? ''
        : input.kind === 'symbol'
          ? `What does $${input.symbol}$ mean?`
          : input.quote ?? '';
  let thread: Thread = {
    ...meta,
    id: uuid(),
    paperId: paper.id,
    kind: input.kind,
    title,
    quote: input.quote,
    annotationId: input.annotationId,
    comparePaperId: input.comparePaperId,
    messages: [{ role: 'user', content: display, at: nowIso() }],
  };
  thread = await repo.putThread(thread);
  cb.onThread(thread);
  // the API sees the full prompt for the first turn; the UI shows the short form
  return runThread(thread, [{ role: 'user', content: prompt }], cb);
}

export async function followUp(threadId: string, text: string, cb: ThreadStreamCallbacks): Promise<Thread> {
  await requireAi();
  let thread = await repo.getThread(threadId);
  if (!thread) throw new Error('Thread not found');
  const paper = await repo.getPaper(thread.paperId);
  let other: { paper: Paper; text: string } | undefined;
  if (thread.kind === 'compare' && thread.comparePaperId) {
    const op = await repo.getPaper(thread.comparePaperId);
    if (op) other = { paper: op, text: (await paperContext(op)).text.slice(0, 60_000) };
  }
  const first = firstPrompt(
    { kind: thread.kind, paperId: thread.paperId, quote: thread.quote, comparePaperId: thread.comparePaperId, question: thread.messages[0]?.content, symbol: thread.title.replace(/^Symbol\s*/, '') },
    other,
  ).prompt;
  const history: ClaudeMessage[] = thread.messages.map((m, i) => ({ role: m.role, content: i === 0 ? first : m.content }));
  thread = await repo.putThread({ ...thread, messages: [...thread.messages, { role: 'user', content: text, at: nowIso() }] });
  cb.onThread(thread);
  if (!paper) throw new Error('Paper not found');
  return runThread(thread, [...history, { role: 'user', content: text }], cb);
}

// ---------------------------------------------------------------------------
// One-shot features (fast model)
// ---------------------------------------------------------------------------

export async function extractFields(paper: Paper): Promise<ExtractedFields> {
  const s = await requireAi();
  const ft = await repo.getFullText(paper.id);
  const body = ft?.text ? ft.text.slice(0, 40_000) : paper.abstract;
  const res = await callClaude({
    model: s.fastModel,
    maxTokens: 600,
    temperature: 0,
    system: [{ text: 'You extract structured metadata from ML papers. Reply with JSON only.' }],
    messages: [
      {
        role: 'user',
        content: `Paper title: ${paper.title}\n\n${ft?.text ? 'Paper text (may be truncated)' : 'Abstract'}:\n${body}\n\nReturn JSON with exactly these keys:\n{"task": short phrase for the main task or problem (<= 8 words),\n "benchmarks": list of benchmark or dataset names used for evaluation (canonical names, max 8),\n "models": list of models proposed or evaluated (max 8),\n "metrics": list of evaluation metrics (max 6),\n "headlineResult": one sentence with the main quantitative result, or "" if none}\nUse [] or "" when the paper does not say.`,
      },
    ],
  });
  const j = parseJsonReply<any>(res.text);
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 8) : []);
  return {
    task: String(j.task ?? '').trim(),
    benchmarks: arr(j.benchmarks),
    models: arr(j.models),
    metrics: arr(j.metrics),
    headlineResult: String(j.headlineResult ?? '').trim(),
    source: 'ai',
    updatedAt: nowIso(),
  };
}

export async function summarizeReviews(paper: Paper): Promise<string> {
  const s = await requireAi();
  if (!paper.review?.digest) throw new Error('No reviews to summarize.');
  const res = await callClaude({
    model: s.fastModel,
    maxTokens: 700,
    temperature: 0,
    system: [{ text: 'You summarize peer reviews for a researcher. Be specific and neutral. Use Markdown. Do not use em dashes.' }],
    messages: [
      {
        role: 'user',
        content: `Paper: ${paper.title}\nDecision: ${paper.review.decision ?? 'unknown'}\n\n${paper.review.digest}\n\nWrite two short sections:\n**What reviewers criticized**: 3 to 5 bullets, most important first, noting how many reviewers raised each point.\n**How the authors responded**: 2 to 4 bullets (or "No author response found.").`,
      },
    ],
  });
  return res.text.trim();
}

export async function nameTopics(clusters: { titles: string[]; keywords: string[] }[]): Promise<string[]> {
  const s = await requireAi();
  const res = await callClaude({
    model: s.fastModel,
    maxTokens: 400,
    temperature: 0,
    system: [{ text: 'You name clusters of research papers. Reply with JSON only.' }],
    messages: [
      {
        role: 'user',
        content: `Give each cluster a short, specific topic name (2 to 4 words, title case, no generic names like "Machine Learning").\n\n${clusters
          .map((c, i) => `Cluster ${i + 1} (keywords: ${c.keywords.join(', ')}):\n${c.titles.slice(0, 12).map((t) => `- ${t}`).join('\n')}`)
          .join('\n\n')}\n\nReturn a JSON array of ${clusters.length} strings, in order.`,
      },
    ],
  });
  const names = parseJsonReply<string[]>(res.text);
  return clusters.map((_, i) => String(names[i] ?? '').trim());
}

export async function aiProjectScores(paper: Paper, projects: Project[], seedTitles: Map<string, string[]>): Promise<Map<string, number>> {
  const s = await requireAi();
  if (!projects.length) return new Map();
  const res = await callClaude({
    model: s.fastModel,
    maxTokens: 300,
    temperature: 0,
    system: [{ text: 'You judge how relevant a paper is to research projects. Reply with JSON only.' }],
    messages: [
      {
        role: 'user',
        content: `Paper: ${paper.title}\nAbstract: ${paper.abstract.slice(0, 2500)}\n\nProjects:\n${projects
          .map((p) => `- id=${p.id}\n  name: ${p.name}\n  description: ${p.description || '(none)'}\n  example papers: ${(seedTitles.get(p.id) ?? []).slice(0, 5).join(' | ') || '(none)'}`)
          .join('\n')}\n\nFor each project, rate 0 to 10 how useful this paper is for that project (10 = core reading, 5 = related background, 0 = unrelated). Return JSON: {"<project id>": score, ...}`,
      },
    ],
  });
  const j = parseJsonReply<Record<string, number>>(res.text);
  const out = new Map<string, number>();
  for (const p of projects) {
    const v = Number(j[p.id]);
    if (Number.isFinite(v)) out.set(p.id, Math.max(0, Math.min(10, v)) / 10);
  }
  return out;
}

const LABEL_TITLES: Record<HighlightLabel, string> = {
  plain: 'Other highlights',
  problem: 'Problem',
  method: 'Method',
  result: 'Results',
  interesting: 'What interested me',
  weakness: 'What could be better',
};


export async function draftFactoid(paper: Paper, annotations: Annotation[]): Promise<FactoidDraft> {
  const s = await requireAi();
  const lines = annotations
    .filter((a) => a.target.selector)
    .map((a) => {
      const label = (a.body.find((b) => b.purpose === 'tagging')?.value ?? 'plain') as HighlightLabel;
      const quote = a.target.selector?.find((x) => x.type === 'TextQuoteSelector') as any;
      const note = a.body.find((b) => b.purpose === 'commenting')?.value;
      return `[${LABEL_TITLES[label] ?? label}] "${quote?.exact ?? ''}"${note ? ` (my note: ${note})` : ''}`;
    })
    .join('\n');
  const notes = annotations.filter((a) => !a.target.selector).map((a) => a.body.find((b) => b.purpose === 'commenting')?.value).filter(Boolean).join('\n');
  const res = await callClaude({
    model: s.smartModel,
    maxTokens: 900,
    temperature: 0.2,
    system: [{ text: 'You help a researcher write a short "paper factoid" for their lab meeting doc. Write in the first person where giving opinions. Plain, specific language. No em dashes. Reply with JSON only.' }],
    messages: [
      {
        role: 'user',
        content: `Paper: ${paper.title}\nAbstract: ${paper.abstract}\n\nMy labeled highlights:\n${lines || '(none)'}\n\nMy notes:\n${notes || '(none)'}\n\nDraft bullets for each section. Base "What interested me" and "What could be better" on my highlights and notes; if I gave nothing for a section, write one short bullet marked "(draft)". Keep each bullet to one sentence, 1 to 3 bullets per section.\nReturn JSON: {"problem": [...], "method": [...], "results": [...], "interesting": [...], "better": [...]}`,
      },
    ],
  });
  const j = parseJsonReply<any>(res.text);
  const arr = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
  return { problem: arr(j.problem), method: arr(j.method), results: arr(j.results), interesting: arr(j.interesting), better: arr(j.better) };
}
