// Library-wide AI features: "Ask your library" (answers from saved papers, with
// numbered sources pointing at the exact passages) and the related-work
// drafter. Both call requireAi() first, so nothing here runs or costs anything
// when AI mode is off. Retrieval is local (../search/chunks); only the
// retrieved passages, or the chosen papers' metadata and notes, are sent.

import { callClaude, parseJsonReply } from './client';
import { requireAi } from './features';
import * as repo from '../repo';
import { db } from '../db';
import { nowIso, uuid } from '../ids';
import { labelOf, noteOf } from '../exports';
import { describeQuote, quoteOf } from '../anchoring/text';
import { projectMembers } from '../sorting/relevance';
import { bestWindow, buildIndex, search, type Chunk, type ChunkKind, type IndexDoc } from '../search/chunks';
import { HIGHLIGHT_LABELS } from '../types';
import type { Annotation, HighlightLabel, Medium, Paper, TextPositionSelector, TextQuoteSelector } from '../types';

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Whitespace-collapsed, cut at a word boundary with "..." when longer than n. */
function clip(s: string, n: number): string {
  const t = collapse(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return `${sp > n * 0.6 ? cut.slice(0, sp) : cut}...`;
}

const LABEL_ORDER: HighlightLabel[] = ['problem', 'method', 'result', 'interesting', 'weakness', 'plain'];

function labelFor(a: Annotation): HighlightLabel {
  const l = labelOf(a);
  return LABEL_ORDER.includes(l) ? l : 'plain';
}

const labelName = (l: HighlightLabel) => HIGHLIGHT_LABELS.find((x) => x.id === l)?.name ?? l;

/** Library papers, narrowed to a project and/or explicit ids. */
async function scopePapers(opts: { paperIds?: string[]; projectId?: string }): Promise<Paper[]> {
  const entries = await repo.listEntries();
  let ids = entries.map((e) => e.paperId);
  if (opts.projectId) {
    const project = await repo.getProject(opts.projectId);
    if (!project) throw new Error('Project not found.');
    const members = new Set(projectMembers(project, entries, ''));
    ids = ids.filter((id) => members.has(id));
  }
  if (opts.paperIds) {
    const want = new Set(opts.paperIds);
    ids = ids.filter((id) => want.has(id));
  }
  return (await repo.getPapers(ids)).filter((p) => !p.deletedAt);
}

// ===========================================================================
// Ask your library
// ===========================================================================

export interface AskOptions {
  paperIds?: string[];
  projectId?: string;
  /** Ask the fast model for extra search phrases before retrieving (default true). */
  expand?: boolean;
}

export interface AskCallbacks {
  onText?(delta: string): void;
  /** Called when retrieval finishes (before any text), then again at the end with `cited` set and quotes matched to the claims. */
  onSources?(sources: AskSource[]): void;
  signal?: AbortSignal;
}

export interface AskSource {
  /** The number the answer cites as [n]. */
  n: number;
  paperId: string;
  title: string;
  citeKey: string;
  year: number | null;
  kind: ChunkKind;
  /**
   * Up to 300 characters of the passage, whitespace collapsed and cut at word
   * boundaries: the part that best matches the claims citing it, else the
   * question, else the start of the passage. An exact (whitespace-insensitive)
   * substring of the stored text.
   */
  quote: string;
  /** Highlights and notes: the annotation. Jump with the 'scroll-to-annotation' tab command. */
  annotationId?: string;
  /** Highlights: their label. */
  label?: HighlightLabel;
  /** Full text and abstracts: where `quote` sits in the stored text, as W3C selectors (find it with anchorQuote). */
  target?: { medium?: Medium; quote: TextQuoteSelector; position: TextPositionSelector };
  /** True when the answer cites [n]. */
  cited: boolean;
  /** Retrieval score (BM25 with kind boosts). */
  score: number;
}

export interface AskResult {
  /** Final answer in Markdown. Citations are normalized to [n] (several as [2][5]) and only reference listed sources. */
  answer: string;
  /** Every passage the model was given, numbered from 1. */
  sources: AskSource[];
  /** Sorted, distinct source numbers the answer cites. */
  citedNumbers: number[];
}

export interface AskHistoryItem extends AskResult {
  id: string;
  question: string;
  at: string;
  paperIds?: string[];
  projectId?: string;
}

const ASK_K = 14;
const ASK_PER_PAPER = 3;
const ASK_BOOST: Partial<Record<ChunkKind, number>> = { highlight: 1.3, note: 1.3 };
const QUOTE_CHARS = 300;
const HISTORY_KEY = 'askHistory';
const HISTORY_MAX = 30;

const NO_MATCH =
  "I couldn't find anything in your saved papers that matches this question. Try other words for the key terms, or save papers that cover it.";

const ASK_SYSTEM = `You answer a researcher's questions about their own library of saved papers, using only the numbered sources provided. Each source is a passage from a paper's full text or abstract, or one of the researcher's own highlights or notes.

Rules:
- Answer only from the sources. Do not add outside knowledge, and never invent papers, results or numbers.
- Cite with [n] right after each claim, using the source numbers given. Cite several as [2][5]. Only cite a source that actually says what you claim.
- If the sources do not cover the question, or only part of it, say so plainly and say what is missing (for example, which result or which kind of paper would be needed).
- When sources disagree, say so and cite each side.
- Highlights and notes are the researcher's own selections and words: say "you highlighted" or "your note" when you rely on them.
- Be concise: a direct answer first, then the supporting points. Refer to papers by title or first author, not by cite key. Use Markdown, with $...$ for math. Do not use em dashes.`;

const EXPAND_SYSTEM = 'You turn questions about research papers into search phrases for a keyword index. Reply with JSON only.';

interface Gathered {
  docs: IndexDoc[];
  papers: Map<string, Paper>;
  annotations: Map<string, Annotation>;
  /** Stored text per `${kind}|${paperId}` for full texts and abstracts, to build selectors. */
  texts: Map<string, { text: string; medium?: Medium }>;
}

async function gatherDocs(papers: Paper[]): Promise<Gathered> {
  const byId = new Map(papers.map((p) => [p.id, p]));
  const docs: IndexDoc[] = [];
  const texts = new Map<string, { text: string; medium?: Medium }>();
  const fulltexts = await Promise.all(papers.map((p) => repo.getFullText(p.id)));
  papers.forEach((p, i) => {
    const ft = fulltexts[i];
    if (ft?.text) {
      docs.push({ paperId: p.id, kind: 'fulltext', text: ft.text, version: ft.savedAt });
      texts.set(`fulltext|${p.id}`, { text: ft.text, medium: ft.medium });
    }
    if (p.abstract?.trim()) {
      docs.push({ paperId: p.id, kind: 'abstract', text: p.abstract, heading: p.title, version: p.updatedAt });
      texts.set(`abstract|${p.id}`, { text: p.abstract });
    }
  });
  const annotations = new Map<string, Annotation>();
  for (const a of await repo.listAllAnnotations()) {
    if (!byId.has(a.paperId)) continue;
    annotations.set(a.id, a);
    const q = quoteOf(a.target.selector)?.exact;
    if (q?.trim()) docs.push({ paperId: a.paperId, kind: 'highlight', text: q, annotationId: a.id, version: a.updatedAt });
    const note = noteOf(a);
    if (note.trim()) docs.push({ paperId: a.paperId, kind: 'note', text: note, annotationId: a.id, version: a.updatedAt });
  }
  return { docs, papers: byId, annotations, texts };
}

async function expandQuery(question: string, model: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const res = await callClaude({
      model,
      maxTokens: 200,
      temperature: 0,
      system: [{ text: EXPAND_SYSTEM }],
      messages: [
        {
          role: 'user',
          content: `Question: ${question}\n\nWrite 3 to 6 short search phrases (2 to 5 words each) that passages answering this question would likely contain: the key technical terms, common synonyms and abbreviations, and any method, model, dataset or metric names the question implies. Return a JSON array of strings.`,
        },
      ],
      signal,
    });
    const j = parseJsonReply<unknown>(res.text);
    const arr: unknown[] = Array.isArray(j) ? j : Array.isArray((j as { phrases?: unknown })?.phrases) ? (j as { phrases: unknown[] }).phrases : [];
    return arr
      .map((x) => String(x).trim())
      .filter((x) => x && x.length <= 100)
      .slice(0, 6);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return []; // expansion is only a recall aid: fall back to the question alone
  }
}

interface Retrieved {
  chunk: Chunk;
  source: AskSource;
}

/** Hits regrouped paper by paper (best paper first), keeping score order within a paper. */
function groupByPaper<T extends { chunk: Chunk }>(hits: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const h of hits) {
    const g = groups.get(h.chunk.paperId);
    if (g) g.push(h);
    else groups.set(h.chunk.paperId, [h]);
  }
  return [...groups.values()].flat();
}

/** Choose the quote window: the first of `queries` that matches anything, else the chunk start. */
function placeQuote(r: Retrieved, g: Gathered, queries: (string | string[])[]) {
  const { chunk } = r;
  let w = bestWindow(chunk.text, [], QUOTE_CHARS);
  for (const q of queries) {
    const c = bestWindow(chunk.text, q, QUOTE_CHARS);
    if (c.score > 0) {
      w = c;
      break;
    }
  }
  r.source.quote = collapse(chunk.text.slice(w.start, w.end));
  const src = g.texts.get(`${chunk.kind}|${chunk.paperId}`);
  if (src && (chunk.kind === 'fulltext' || chunk.kind === 'abstract')) {
    const [quote, position] = describeQuote(src.text, chunk.offset + w.start, chunk.offset + w.end);
    r.source.target = { ...(src.medium ? { medium: src.medium } : {}), quote, position };
  }
}

function sourceBlock(r: Retrieved, g: Gathered): string {
  const { chunk, source: s } = r;
  const head = `[${s.n}] ${s.title} (${s.citeKey}${s.year ? `, ${s.year}` : ''})`;
  const body = collapse(chunk.text);
  const a = chunk.annotationId ? g.annotations.get(chunk.annotationId) : undefined;
  switch (chunk.kind) {
    case 'fulltext':
      return `${head}, full text:\n${body}`;
    case 'abstract':
      return `${head}, abstract:\n${body}`;
    case 'highlight': {
      const label = a ? labelFor(a) : 'plain';
      const note = a ? collapse(noteOf(a)) : '';
      return `${head}, my highlight${label !== 'plain' ? ` (${labelName(label)})` : ''}:\n"${body}"${note ? `\nMy note on it: ${clip(note, 600)}` : ''}`;
    }
    case 'note': {
      const q = a ? quoteOf(a.target.selector)?.exact : undefined;
      return `${head}, ${q?.trim() ? `my note on the passage "${clip(q, 240)}"` : 'my note on the paper'}:\n${body}`;
    }
  }
}

const CITE_GROUP = /([ \t]*)\[(\s*\d+\s*(?:[-–,;]\s*\d+\s*)*)\](?!\()/g;

/**
 * Normalize [n] citations against `count` sources: "[2, 5]" and "[2-3]" become
 * "[2][5]" and "[2][3]", numbers with no source are dropped (and an emptied
 * bracket with them). Brackets that don't look like citations ([0, 1], years)
 * are left alone.
 */
export function cleanCitations(text: string, count: number): { text: string; cited: number[] } {
  const cited = new Set<number>();
  const out = text.replace(CITE_GROUP, (m: string, lead: string, inner: string) => {
    const nums: number[] = [];
    for (const part of inner.split(/[,;]/)) {
      const ends = part.split(/[-–]/).map((x) => Number(x.trim()));
      if (ends.length === 1) nums.push(ends[0]);
      else if (ends.length === 2 && ends[1] >= ends[0] && ends[1] - ends[0] <= 20) for (let k = ends[0]; k <= ends[1]; k++) nums.push(k);
      else return m;
    }
    if (nums.some((k) => !Number.isInteger(k) || k < 1 || k > 999)) return m;
    const valid = [...new Set(nums.filter((k) => k <= count))];
    for (const k of valid) cited.add(k);
    return valid.length ? lead + valid.map((k) => `[${k}]`).join('') : '';
  });
  return { text: out, cited: [...cited].sort((a, b) => a - b) };
}

/** The sentences citing each source number, with the markers stripped. */
function claimsBySource(answer: string): Map<number, string> {
  const out = new Map<number, string[]>();
  let prev = '';
  for (const seg of answer.split(/(?<=[.!?])\s+|\n+/)) {
    const nums = [...seg.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const claim = seg.replace(/\[\d+\]/g, ' ').replace(/[*_#>`]+/g, ' ').trim();
    // citations left on their own after a sentence belong to that sentence
    const text = /[a-z0-9]/i.test(claim) ? claim : prev;
    for (const n of nums) out.set(n, [...(out.get(n) ?? []), text]);
    if (/[a-z0-9]/i.test(claim)) prev = claim;
  }
  return new Map([...out].map(([n, xs]) => [n, xs.join(' ')]));
}

async function remember(question: string, result: AskResult, opts: AskOptions) {
  const item: AskHistoryItem = {
    id: uuid(),
    question,
    ...result,
    at: nowIso(),
    ...(opts.paperIds ? { paperIds: opts.paperIds } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  };
  try {
    const d = db();
    await d.transaction('rw', d.kv, async () => {
      const cur = (await d.kv.get(HISTORY_KEY))?.value;
      const list = Array.isArray(cur) ? (cur as AskHistoryItem[]) : [];
      await d.kv.put({ key: HISTORY_KEY, value: [item, ...list].slice(0, HISTORY_MAX) });
    });
  } catch {
    /* history is a convenience; never lose the answer over it */
  }
}

/** Past questions, newest first (at most 30). */
export async function listAskHistory(): Promise<AskHistoryItem[]> {
  const v = (await db().kv.get(HISTORY_KEY))?.value;
  return Array.isArray(v) ? (v as AskHistoryItem[]) : [];
}

export async function clearAskHistory(): Promise<void> {
  await db().kv.delete(HISTORY_KEY);
}

/**
 * Answer a question from the saved papers (optionally only some papers or one
 * project), citing numbered passages. Streams the answer through cb.onText;
 * the returned answer is the final, citation-checked text.
 */
export async function askLibrary(question: string, opts: AskOptions = {}, cb: AskCallbacks = {}): Promise<AskResult> {
  const s = await requireAi();
  const q = question.trim();
  if (!q) throw new Error('Type a question first.');
  const papers = await scopePapers(opts);
  if (!papers.length) {
    throw new Error(opts.paperIds || opts.projectId ? 'None of the chosen papers are in your library.' : 'Your library is empty. Save some papers first.');
  }
  const [phrases, g] = await Promise.all([opts.expand === false ? Promise.resolve([]) : expandQuery(q, s.fastModel, cb.signal), gatherDocs(papers)]);
  const queries = [q, ...phrases];
  const hits = search(buildIndex(g.docs), queries, { k: ASK_K, perPaper: ASK_PER_PAPER, boostKinds: ASK_BOOST });

  const retrieved: Retrieved[] = groupByPaper(hits).map((h, i) => {
    const p = g.papers.get(h.chunk.paperId)!;
    const a = h.chunk.annotationId ? g.annotations.get(h.chunk.annotationId) : undefined;
    const r: Retrieved = {
      chunk: h.chunk,
      source: {
        n: i + 1,
        paperId: p.id,
        title: p.title,
        citeKey: p.citeKey,
        year: p.year,
        kind: h.chunk.kind,
        quote: '',
        ...(h.chunk.annotationId ? { annotationId: h.chunk.annotationId } : {}),
        ...(a && h.chunk.kind === 'highlight' ? { label: labelFor(a) } : {}),
        cited: false,
        score: h.score,
      },
    };
    placeQuote(r, g, [queries]);
    return r;
  });
  cb.onSources?.(retrieved.map((r) => ({ ...r.source })));

  if (!retrieved.length) {
    cb.onText?.(NO_MATCH);
    const result: AskResult = { answer: NO_MATCH, sources: [], citedNumbers: [] };
    await remember(q, result, opts);
    return result;
  }

  const content = `<sources>\n${retrieved.map((r) => sourceBlock(r, g)).join('\n\n')}\n</sources>\n\nQuestion: ${q}`;
  const res = await callClaude({
    model: s.smartModel,
    maxTokens: 1200,
    temperature: 0,
    system: [{ text: ASK_SYSTEM }],
    messages: [{ role: 'user', content }],
    onDelta: cb.onText ? (d) => cb.onText!(d) : undefined,
    signal: cb.signal,
  });

  const { text: answer, cited } = cleanCitations(res.text.trim(), retrieved.length);
  const claims = claimsBySource(answer);
  const citedSet = new Set(cited);
  for (const r of retrieved) {
    r.source.cited = citedSet.has(r.source.n);
    const claim = claims.get(r.source.n);
    if (claim) placeQuote(r, g, [claim, queries]);
  }
  const sources = retrieved.map((r) => r.source);
  cb.onSources?.(sources.map((x) => ({ ...x })));
  const result: AskResult = { answer, sources, citedNumbers: cited };
  await remember(q, result, opts);
  return result;
}

// ===========================================================================
// Related-work drafter
// ===========================================================================

export interface RelatedWorkInput {
  paperIds: string[];
  projectId?: string;
  topic?: string;
  style: 'paragraphs' | 'bullets';
  length: 'short' | 'medium' | 'long';
  format: 'latex' | 'markdown';
}

export interface RelatedWorkResult {
  /** Post-processed text: citations hold only provided keys. */
  text: string;
  /** Provided keys the text cites, in order of first citation. */
  usedKeys: string[];
  /** Keys the model cited that weren't provided (removed from the text). */
  unknownKeys: string[];
  /** Provided papers never cited. */
  missingKeys: string[];
}

const RW_WORDS = { short: 150, medium: 350, long: 700 } as const;
const RW_MAX_TOKENS = { short: 700, medium: 1400, long: 2600 } as const;
const RW_MAX_HIGHLIGHTS = 16;

const RW_SYSTEM = `You write related-work sections for machine learning research papers, working from a researcher's own reading notes. You are given the papers to cover in <papers>: each has a cite key, metadata, an abstract, sometimes extracted fields, and the researcher's labeled highlights (Problem, Method, Result, Interesting, Weakness) and notes.

Rules:
- Group the papers into 2 to 4 themes. Within each theme, contrast the approaches: what each paper does differently and what follows from it.
- Be specific about what each paper does: its method, setting and main finding. Lean on the researcher's highlights and notes where they say what matters about a paper, and use Weakness highlights to point out open gaps.
- Cite only with the cite keys given in <papers>. Never invent papers, cite keys, results or numbers; state a number only if it appears in that paper's material.
- Cite every provided paper at least once unless it truly does not fit, and attribute each claim to the right paper.
- No filler: no "In recent years", no generic praise, no closing summary that adds nothing.
- Output only the section body in the requested format: no preamble, no section heading, no code fences. Do not use em dashes.`;

/** Context block for one paper: metadata, abstract, extracted fields, highlights by label (with notes), paper notes. */
export function relatedWorkPaperBlock(p: Paper, annotations: Annotation[]): string {
  const names = p.authors.map((a) => a.name);
  const lines = [`<paper key="${p.citeKey}">`, `Title: ${collapse(p.title)}`];
  if (names.length) lines.push(`Authors: ${names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ')}`);
  lines.push(`Year: ${p.year ?? 'unknown'}`, `Venue: ${p.venue ?? 'preprint'}`);
  if (p.abstract?.trim()) lines.push(`Abstract: ${clip(p.abstract, 1200)}`);
  const x = p.extracted;
  if (x) {
    if (x.task) lines.push(`Task: ${x.task}`);
    if (x.benchmarks?.length) lines.push(`Benchmarks: ${x.benchmarks.join(', ')}`);
    if (x.models?.length) lines.push(`Models: ${x.models.join(', ')}`);
    if (x.metrics?.length) lines.push(`Metrics: ${x.metrics.join(', ')}`);
    if (x.headlineResult) lines.push(`Headline result: ${x.headlineResult}`);
  }
  const highlights = annotations.filter((a) => quoteOf(a.target.selector)?.exact.trim());
  if (highlights.length) {
    lines.push('My highlights:');
    let left = RW_MAX_HIGHLIGHTS;
    for (const label of LABEL_ORDER) {
      const group = highlights.filter((a) => labelFor(a) === label).slice(0, left);
      if (!group.length) continue;
      left -= group.length;
      lines.push(`${label === 'plain' ? 'Other' : labelName(label)}:`);
      for (const a of group) {
        const note = collapse(noteOf(a));
        lines.push(`- "${clip(quoteOf(a.target.selector)!.exact, 400)}"${note ? ` (my note: ${clip(note, 500)})` : ''}`);
      }
    }
  }
  const notes = annotations
    .filter((a) => !a.target.selector)
    .map((a) => collapse(noteOf(a)))
    .filter(Boolean);
  if (notes.length) {
    lines.push('My notes on the paper:');
    for (const n of notes.slice(0, 4)) lines.push(`- ${clip(n, 800)}`);
  }
  lines.push('</paper>');
  return lines.join('\n');
}

function relatedWorkPrompt(input: RelatedWorkInput, keys: string[], topic: string | undefined): string {
  const latex = input.format === 'latex';
  const format = latex
    ? 'LaTeX. Cite with \\citep{key}, or \\citet{key} when the authors are the subject of the sentence; put several keys in one command, as in \\citep{a,b}. Escape %, & and _ in prose.'
    : 'Markdown. Cite with [@key]; put several in one bracket, as in [@a; @b].';
  const style =
    input.style === 'bullets'
      ? latex
        ? 'Bullets: an itemize list with one \\item per theme (theme name in \\textbf{...}), each with a nested itemize of specific points about its papers.'
        : 'Bullets: one top-level bullet per theme (theme name in bold), each with nested sub-bullets of specific points about its papers.'
      : latex
        ? 'Paragraphs: one paragraph per theme, each opening with \\paragraph{Theme name.}'
        : 'Paragraphs: one paragraph per theme, each opening with a bold run-in theme name, as in **Theme name.**';
  return [
    topic
      ? `Write the related-work section for my paper, which is about: ${topic}\nFrame the themes around how this prior work relates to my topic. You may end a theme with one sentence on how my work differs, stated as what we do (for example "We instead study ..."), never as a result.`
      : 'Write a related-work section that organizes these papers on their own terms.',
    `Cite keys you may use (and no others): ${keys.join(', ')}`,
    `Format: ${format}`,
    `Style: ${style}`,
    `Length: about ${RW_WORDS[input.length]} words.`,
  ].join('\n\n');
}

function stripFences(s: string): string {
  const m = s.trim().match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : s;
}

const LATEX_CITE = /(~|[ \t]+)?\\(cite[a-zA-Z]*|nocite|parencite|textcite|autocite|footcite|smartcite|supercite)(\*?)((?:\[[^\]]*\]){0,2})\{([^{}]*)\}/g;
const MD_GROUP = /([ \t]*)\[([^[\]]*@[^[\]]*)\](?!\()/g;
const MD_KEY_SRC = String.raw`@(\{[^{}\s]+\}|[A-Za-z0-9_](?:[A-Za-z0-9_:.#$%&+?<>~/-]*[A-Za-z0-9_])?)`;
const MD_BARE = new RegExp(String.raw`(^|[^\w@\\])` + MD_KEY_SRC, 'g');

/**
 * Check every citation against `keys`: LaTeX \cite-family commands (\citep{a,b},
 * \cite{a}, \citet[p.~3]{a}, ...), Pandoc groups ([@a; @b], [see @a, p. 3]) and,
 * for Markdown, bare in-text @a. Unknown keys are removed (a citation left empty
 * is dropped whole, with the space before it); keys differing only in case are
 * corrected to the provided spelling.
 */
export function cleanCiteKeys(text: string, keys: string[], format: 'latex' | 'markdown'): { text: string; usedKeys: string[]; unknownKeys: string[] } {
  const exact = new Set(keys);
  const lower = new Map(keys.map((k) => [k.toLowerCase(), k]));
  const used: string[] = [];
  const unknown: string[] = [];
  const resolve = (raw: string): string | null => {
    const k = raw.trim().replace(/^\{|\}$/g, '');
    if (!k) return null;
    const hit = exact.has(k) ? k : lower.get(k.toLowerCase());
    if (hit) {
      if (!used.includes(hit)) used.push(hit);
      return hit;
    }
    if (!unknown.includes(k)) unknown.push(k);
    return null;
  };

  let out = text.replace(LATEX_CITE, (_m, lead: string | undefined, cmd: string, star: string, opt: string, list: string) => {
    const kept = [...new Set(list.split(',').map(resolve).filter((k): k is string => !!k))];
    return kept.length ? `${lead ?? ''}\\${cmd}${star}${opt}{${kept.join(',')}}` : '';
  });

  // Pandoc groups; kept groups are parked so the bare-key pass doesn't see them again
  const parked: string[] = [];
  out = out.replace(MD_GROUP, (_m, lead: string, inner: string) => {
    const items: string[] = [];
    let cites = 0;
    for (const item of inner.split(';')) {
      if (!item.includes('@')) {
        items.push(item.trim());
        continue;
      }
      let known = 0;
      const fixed = item.replace(new RegExp(MD_KEY_SRC, 'g'), (km, k: string) => {
        const hit = resolve(k);
        if (!hit) return '';
        known++;
        return `@${hit}`;
      });
      if (known) {
        items.push(fixed.replace(/\s+/g, ' ').trim());
        cites++;
      }
    }
    if (!cites) return '';
    parked.push(`${lead}[${items.filter(Boolean).join('; ')}]`);
    return `\u0000${parked.length - 1}\u0000`;
  });
  if (format === 'markdown') {
    out = out.replace(MD_BARE, (m, lead: string, k: string, offset: number, whole: string) => {
      const hit = resolve(k);
      if (hit) return `${lead}@${hit}`;
      // drop the key and one of the spaces around it
      return lead === ' ' && whole[offset + m.length] === ' ' ? '' : lead;
    });
  }
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => parked[Number(i)]);
  return { text: out, usedKeys: used, unknownKeys: unknown };
}

/**
 * Draft a related-work section from the chosen papers' metadata, abstracts,
 * extracted fields, highlights and notes. Streams the raw draft through
 * cb.onText; the returned text is the post-processed one (unknown cite keys
 * removed), so show that once the promise resolves.
 */
export async function draftRelatedWork(input: RelatedWorkInput, cb: { onText?(delta: string): void; signal?: AbortSignal } = {}): Promise<RelatedWorkResult> {
  const s = await requireAi();
  let ids = input.paperIds;
  if (!ids.length && input.projectId) ids = (await scopePapers({ projectId: input.projectId })).map((p) => p.id);
  const found = (await repo.getPapers([...new Set(ids)])).filter((p) => !p.deletedAt);
  if (!found.length) throw new Error('Pick at least one paper for the related-work section.');
  // sorted by key so the cached paper block is identical across retries
  const papers = [...found].sort((a, b) => a.citeKey.localeCompare(b.citeKey));
  const annotations = await Promise.all(papers.map((p) => repo.listAnnotations(p.id)));
  const keys = papers.map((p) => p.citeKey);

  let topic = input.topic?.trim() || undefined;
  if (!topic && input.projectId) {
    const project = await repo.getProject(input.projectId);
    if (project) topic = project.description.trim() ? `${project.name}. ${project.description.trim()}` : project.name;
  }

  const res = await callClaude({
    model: s.smartModel,
    maxTokens: RW_MAX_TOKENS[input.length],
    temperature: 0.3,
    system: [{ text: RW_SYSTEM }, { text: `<papers>\n${papers.map((p, i) => relatedWorkPaperBlock(p, annotations[i])).join('\n\n')}\n</papers>`, cache: true }],
    messages: [{ role: 'user', content: relatedWorkPrompt(input, keys, topic) }],
    onDelta: cb.onText ? (d) => cb.onText!(d) : undefined,
    signal: cb.signal,
  });

  const cleaned = cleanCiteKeys(stripFences(res.text).trim(), keys, input.format);
  const used = new Set(cleaned.usedKeys);
  return {
    text: cleaned.text,
    usedKeys: cleaned.usedKeys,
    unknownKeys: cleaned.unknownKeys,
    missingKeys: found.map((p) => p.citeKey).filter((k) => !used.has(k)),
  };
}
