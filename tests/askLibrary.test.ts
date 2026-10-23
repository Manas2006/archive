import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import type { ClaudeRequest } from '@/lib/ai/client';

// ---- mocks: settings (AI on/off), change events (no BroadcastChannel), Claude client (canned replies) ----

type Reply = string | Error | ((req: ClaudeRequest) => string);
const state = vi.hoisted(() => ({ ai: true, replies: [] as unknown[], calls: [] as unknown[], deltas: [] as string[] }));

vi.mock('@/lib/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/settings')>();
  return {
    ...actual,
    getSettings: async () => ({ ...actual.DEFAULT_SETTINGS, aiEnabled: state.ai, hasApiKey: true, userId: 'u1', displayName: 'Tester' }),
  };
});

vi.mock('@/lib/changes', () => ({ emitChange: () => {}, onChange: () => () => {}, dispatchRemoteChange: () => {} }));

vi.mock('@/lib/ai/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/client')>();
  return {
    ...actual,
    // Same contract as the real client: with onDelta it streams text deltas as they arrive, then resolves with the full text.
    callClaude: vi.fn(async (req: ClaudeRequest) => {
      state.calls.push(req);
      const next = state.replies.shift() as Reply | undefined;
      if (next === undefined) throw new Error('test: no canned reply left');
      if (next instanceof Error) throw next;
      const text = typeof next === 'function' ? next(req) : next;
      if (req.onDelta) {
        for (let i = 0; i < text.length; i += 7) {
          await Promise.resolve();
          req.onDelta(text.slice(i, i + 7));
        }
      }
      return { text, stopReason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
    }),
  };
});

import { ArchiveDB, setDb } from '@/lib/db';
import * as repo from '@/lib/repo';
import { DEFAULT_SETTINGS } from '@/lib/settings';
import { bestWindow, buildIndex, chunkCacheStats, chunkText, clearChunkCache, search, sentenceStarts, type IndexDoc } from '@/lib/search/chunks';
import { askLibrary, clearAskHistory, cleanCitations, cleanCiteKeys, draftRelatedWork, listAskHistory, type AskSource } from '@/lib/ai/library';
import type { HighlightLabel, Paper } from '@/lib/types';

Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;

let dbn = 0;
beforeEach(() => {
  setDb(new ArchiveDB(`ask-test-${++dbn}`));
  state.ai = true;
  state.replies = [];
  state.calls = [];
  state.deltas = [];
  clearChunkCache();
});

const calls = () => state.calls as ClaudeRequest[];

// ---- fixtures ----

const meta = { owner: 'u1', visibility: 'private' as const, groupId: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', deletedAt: null };
const paper = (id: string, citeKey: string, title: string, abstract: string, extra: Partial<Paper> = {}): Paper => ({
  ...meta, id, aliases: [], source: 'arxiv', title, authors: [{ name: 'Ada Lovelace' }], abstract, year: 2024, published: null, venue: null,
  venueStatus: 'preprint', urls: {}, codeLinks: [], citeKey, bibtex: '', bibtexSource: 'arxiv', ...extra,
});

async function addPaper(p: Paper, fullText?: string, projectIds: string[] = []) {
  await repo.putPaper(p);
  await repo.putEntry({ ...(await repo.newEntry(p.id)), projectIds });
  if (fullText) await repo.putFullText({ paperId: p.id, medium: 'html', version: 1, text: fullText, savedAt: '2024-01-02T00:00:00Z' });
}

function addHighlight(paperId: string, exact: string, label: HighlightLabel = 'plain', note?: string) {
  return repo.createAnnotation({
    paperId,
    motivation: 'highlighting',
    body: [{ type: 'TextualBody', purpose: 'tagging', value: label }, ...(note ? [{ type: 'TextualBody' as const, purpose: 'commenting' as const, value: note }] : [])],
    target: { source: paperId, selector: [{ type: 'TextQuoteSelector', exact, prefix: '', suffix: '' }], state: { medium: 'html' } },
  });
}

function addPaperNote(paperId: string, note: string) {
  return repo.createAnnotation({ paperId, motivation: 'commenting', body: [{ type: 'TextualBody', purpose: 'commenting', value: note }], target: { source: paperId } });
}

const NEUTRAL = [
  'The experimental setup follows standard practice for this kind of study.',
  'We report averages over five random seeds with standard deviations.',
  'Hyperparameters were tuned on a held-out validation split.',
  'Training used eight accelerators for roughly two days.',
  'Related baselines are described in the appendix for completeness.',
  'Bold entries mark the strongest configuration in each column.',
  'The datasets cover news, scientific writing and conversational text.',
  'Implementation details such as optimizer settings appear later.',
  'We release scripts so that others can reproduce the numbers.',
  'Ablations isolate the contribution of each design choice.',
  'Error bars are omitted when they are smaller than the markers.',
  'Qualitative examples are collected from the evaluation logs.',
];
const filler = (n: number, from = 0) => Array.from({ length: n }, (_, i) => NEUTRAL[(i + from) % NEUTRAL.length]).join(' ');

const KEY_SENTENCE = 'We prune attention blocks whose scores fall below a learned threshold, which cuts memory use by four times on long contexts.';
const A = paper('arxiv:2401.00001', 'lovelace2024block', 'Block-sparse attention for long contexts', 'Long-context transformers spend most of their compute on attention.');
const B = paper('arxiv:2402.00002', 'turing2023reward', 'Reward shaping for tool-use agents', 'Agents that call tools get sparse feedback.', { year: 2023 });
const C = paper('arxiv:2403.00003', 'hopper2022protein', 'Diffusion models for protein design', 'Diffusion models generate protein backbones with designable folds.', { year: 2022 });
const A_TEXT = `${filler(14)} ${KEY_SENTENCE} ${filler(30, 2)} Sparse attention patterns remain stable across layers. ${filler(20, 5)}`;
const B_TEXT = `${filler(10, 3)} Reward shaping gives tool-use agents denser feedback during long tasks. ${filler(25, 7)}`;

async function seedLibrary() {
  const project = await repo.createProject({ name: 'Agents', description: 'Tool-use agents' });
  await addPaper(A, A_TEXT);
  await addPaper(B, B_TEXT, [project.id]);
  await addPaper(C);
  const hl = await addHighlight(A.id, 'We prune attention blocks whose scores fall below a learned threshold', 'method', 'Threshold is learned per layer, check the ablation.');
  await addPaperNote(B.id, 'Useful baseline for reward densification in agents.');
  return { project, hl };
}

/** Source numbers by how the prompt introduced them, e.g. "[3] Title (key, 2024), full text:". */
function numbersIn(req: ClaudeRequest): { n: number; key: string; kind: string }[] {
  return [...req.messages[0].content.matchAll(/^\[(\d+)\] .+? \(([^,)]+)(?:, \d{4})?\), ([^:\n]+?)(?: \(|:| ")/gm)].map((m) => ({ n: Number(m[1]), key: m[2], kind: m[3] }));
}

// ---- chunking ----

describe('chunking', () => {
  const sentences = Array.from({ length: 220 }, (_, i) => `Sentence ${i} ${'carries extra words '.repeat(i % 5)}ends here.`);
  const text = sentences.join(' ');

  it('cuts full text at sentence boundaries into ~900 to 1200 characters with ~150 of overlap', () => {
    const spans = chunkText(text);
    expect(spans.length).toBeGreaterThan(8);
    expect(spans[0].offset).toBe(0);
    expect(spans.at(-1)!.end).toBe(text.length);
    const overlaps: number[] = [];
    spans.forEach((s, i) => {
      if (i < spans.length - 1) {
        expect(s.end - s.offset).toBeGreaterThanOrEqual(900);
        expect(s.end - s.offset).toBeLessThanOrEqual(1200);
      }
      expect(text[s.end - 1]).toBe('.'); // ends at a sentence end
      if (i > 0) {
        expect(text.slice(s.offset - 2, s.offset)).toBe('. '); // starts at a sentence start
        expect(s.offset).toBeLessThan(spans[i - 1].end); // no gaps
        overlaps.push(spans[i - 1].end - s.offset);
      }
    });
    expect(Math.min(...overlaps)).toBeGreaterThanOrEqual(50);
    expect(Math.max(...overlaps)).toBeLessThanOrEqual(330);
    const avg = overlaps.reduce((a, b) => a + b, 0) / overlaps.length;
    expect(avg).toBeGreaterThan(100);
    expect(avg).toBeLessThan(220);
  });

  it('keeps chunk text and offsets consistent; highlights and notes are their own chunks', () => {
    const docs: IndexDoc[] = [
      { paperId: 'p1', kind: 'fulltext', text: `\n  ${text}` },
      { paperId: 'p1', kind: 'highlight', text: 'A short highlight.', annotationId: 'urn:uuid:h1' },
      { paperId: 'p1', kind: 'note', text: 'My note about it.', annotationId: 'urn:uuid:h1' },
    ];
    const index = buildIndex(docs);
    for (const c of index.chunks) {
      const src = docs.find((d) => d.kind === c.kind)!.text;
      expect(c.text).toBe(src.slice(c.offset, c.end));
    }
    expect(index.chunks[0].offset).toBe(3); // leading whitespace skipped
    expect(index.chunks.filter((c) => c.kind === 'highlight')).toEqual([expect.objectContaining({ text: 'A short highlight.', annotationId: 'urn:uuid:h1', offset: 0 })]);
    expect(index.chunks.filter((c) => c.kind === 'note')).toHaveLength(1);
  });

  it('does not split at abbreviations or initials, and falls back to word boundaries', () => {
    const s = 'We use e.g. dropout here. Then Fig. 3 shows it. Work by J. Smith et al. agrees. approx. the same.';
    const starts = sentenceStarts(s);
    expect(starts.map((i) => s.slice(i, i + 4))).toEqual(['Then', 'Work']);
    expect(chunkText('Just one short sentence.')).toEqual([{ offset: 0, end: 24 }]);
    const runOn = Array.from({ length: 900 }, (_, i) => `word${i}`).join(' ');
    const spans = chunkText(runOn);
    expect(spans.length).toBeGreaterThan(3);
    for (const sp of spans.slice(0, -1)) {
      expect(sp.end - sp.offset).toBeLessThanOrEqual(1200);
      expect(runOn[sp.end]).toBe(' '); // cut between words
      expect(sp.offset === 0 || runOn[sp.offset - 1] === ' ').toBe(true);
    }
  });

  it('builds a 300-paper x 60k-character index well under 2 s, and reuses cached chunking', () => {
    let seed = 7;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const syl = ['ka', 'lo', 'mi', 'ne', 'ra', 'to', 'su', 'vi', 'de', 'po', 'qua', 'zen', 'tri', 'mor', 'lex', 'gan'];
    const vocab = Array.from({ length: 5000 }, () => Array.from({ length: 2 + Math.floor(rand() * 3) }, () => syl[Math.floor(rand() * syl.length)]).join(''));
    const stop = 'the of and to in a is that for with as on by this we are be from which it an or at our than'.split(' ');
    const makeText = (len: number) => {
      const out: string[] = [];
      let n = 0;
      while (n < len) {
        const words = Array.from({ length: 8 + Math.floor(rand() * 18) }, () => (rand() < 0.42 ? stop[Math.floor(rand() * stop.length)] : vocab[Math.floor(rand() ** 2 * vocab.length)]));
        const s = `${words.join(' ')}.${rand() < 0.1 ? '\n\n' : ' '}`;
        out.push(s[0].toUpperCase() + s.slice(1));
        n += s.length;
      }
      return out.join('');
    };
    const docs: IndexDoc[] = Array.from({ length: 300 }, (_, i) => ({ paperId: `p${i}`, kind: 'fulltext', text: makeText(60_000), version: '2024-01-01' }));

    let t0 = performance.now();
    const index = buildIndex(docs);
    const cold = performance.now() - t0;
    t0 = performance.now();
    const again = buildIndex(docs);
    const warm = performance.now() - t0;
    t0 = performance.now();
    const hits = search(again, [`${vocab[3]} ${vocab[40]}`, `${vocab[700]} ${vocab[12]} ${vocab[1500]}`], { k: 14, perPaper: 3 });
    const query = performance.now() - t0;
    console.info(`index: ${index.chunks.length} chunks, cold ${cold.toFixed(0)} ms, cached ${warm.toFixed(0)} ms, search ${query.toFixed(0)} ms`);

    expect(index.chunks.length).toBeGreaterThan(15_000);
    expect(cold).toBeLessThan(2000);
    expect(warm).toBeLessThan(Math.max(150, cold / 4));
    expect(chunkCacheStats()).toMatchObject({ docs: 300, hits: 300, misses: 300 });
    expect(hits).toHaveLength(14);
    expect(query).toBeLessThan(500);
    // a re-saved full text (new savedAt) is chunked again
    buildIndex([{ ...docs[0], version: '2024-02-01' }]);
    expect(chunkCacheStats().misses).toBe(301);
  }, 30_000);
});

// ---- BM25 ----

describe('BM25 search', () => {
  const docs: IndexDoc[] = [
    { paperId: 'A', kind: 'fulltext', text: A_TEXT },
    { paperId: 'B', kind: 'fulltext', text: B_TEXT },
    { paperId: 'C', kind: 'abstract', text: C.abstract, heading: C.title },
  ];

  it('ranks the passage that discusses the query first', () => {
    const index = buildIndex(docs);
    expect(search(index, 'how do sparse attention methods prune blocks', { k: 5, perPaper: 3 })[0].chunk.paperId).toBe('A');
    expect(search(index, ['reward shaping', 'feedback for agents'], { k: 5, perPaper: 3 })[0].chunk.paperId).toBe('B');
    // the abstract's heading (title) is searchable
    expect(search(index, 'protein design', { k: 5, perPaper: 3 })[0].chunk).toMatchObject({ paperId: 'C', kind: 'abstract' });
    expect(search(index, 'zzqx flurb', { k: 5, perPaper: 3 })).toEqual([]);
  });

  it('caps hits per paper', () => {
    const many = Array.from({ length: 40 }, (_, i) => `Attention head ${i} is analysed in this section with care.`).join(' ');
    const index = buildIndex([
      { paperId: 'A', kind: 'fulltext', text: `${many} ${many}` },
      { paperId: 'B', kind: 'abstract', text: 'One attention variant.' },
    ]);
    const hits = search(index, 'attention head', { k: 10, perPaper: 2 });
    expect(hits.filter((h) => h.chunk.paperId === 'A')).toHaveLength(2);
    expect(hits.some((h) => h.chunk.paperId === 'B')).toBe(true);
    expect(index.chunks.filter((c) => c.paperId === 'A').length).toBeGreaterThan(4);
  });

  it('boosts highlights and notes', () => {
    const same = 'Gradient clipping stabilizes training of recurrent networks.';
    const index = buildIndex([
      { paperId: 'X', kind: 'abstract', text: same },
      { paperId: 'Y', kind: 'highlight', text: same, annotationId: 'h1' },
      { paperId: 'Z', kind: 'note', text: same, annotationId: 'n1' },
    ]);
    const plain = search(index, 'gradient clipping', { k: 3, perPaper: 3 });
    expect(plain[0].score).toBeCloseTo(plain[1].score, 9);
    const boosted = search(index, 'gradient clipping', { k: 3, perPaper: 3, boostKinds: { highlight: 1.3, note: 1.3 } });
    expect(boosted.map((h) => h.chunk.kind)).toEqual(['highlight', 'note', 'abstract']);
    expect(boosted[0].score / boosted[2].score).toBeCloseTo(1.3, 6);
  });

  it('picks the best-matching quote window', () => {
    const w = bestWindow(A_TEXT, 'learned threshold memory', 300);
    expect(w.score).toBeGreaterThan(0);
    expect(w.end - w.start).toBeLessThanOrEqual(300);
    expect(A_TEXT.slice(w.start, w.end)).toMatch(/^We prune attention blocks .*learned threshold/); // opens on the evidence
    expect(bestWindow(A_TEXT, 'zzqx', 300)).toMatchObject({ start: 0, score: 0 });
    // no sentence breaks at all (a table or equation run in PDF text): still reaches a match deep inside
    const runOn = `${Array.from({ length: 120 }, (_, i) => `cell${i}`).join(' ')} gradient clipping value ${Array.from({ length: 60 }, (_, i) => `row${i}`).join(' ')}`;
    const r = bestWindow(runOn, 'gradient clipping', 300);
    expect(r.end - r.start).toBeLessThanOrEqual(300);
    expect(runOn.slice(r.start, r.end)).toContain('gradient clipping');
    expect(r.start === 0 || runOn[r.start - 1] === ' ').toBe(true);
  });
});

// ---- Ask your library ----

describe('askLibrary', () => {
  it('retrieves passages, streams a cited answer and returns sources that point at the passages', async () => {
    const { hl } = await seedLibrary();
    let ftN = 0;
    let hlN = 0;
    state.replies = [
      '["block sparse attention", "attention pruning threshold"]',
      (req: ClaudeRequest) => {
        const nums = numbersIn(req);
        ftN = nums.find((x) => x.key === 'lovelace2024block' && x.kind === 'full text')!.n;
        hlN = nums.find((x) => x.kind === 'my highlight')!.n;
        return `Block-sparse attention drops blocks whose scores fall below a learned threshold, cutting memory by four times [${ftN}]. You highlighted the same rule [${hlN}, 9].`;
      },
    ];
    const deltas: string[] = [];
    const seen: AskSource[][] = [];
    const res = await askLibrary('How do sparse attention methods prune blocks?', {}, { onText: (d) => deltas.push(d), onSources: (s) => seen.push(s) });

    // models and prompts
    expect(calls().map((c) => c.model)).toEqual([DEFAULT_SETTINGS.fastModel, DEFAULT_SETTINGS.smartModel]);
    const prompt = calls()[1].messages[0].content;
    expect(prompt).toContain('[1] Block-sparse attention for long contexts (lovelace2024block, 2024), ');
    expect(prompt).toContain(`[${ftN}] Block-sparse attention for long contexts (lovelace2024block, 2024), full text:\n`);
    expect(prompt).toContain('my highlight (Method):');
    expect(prompt).toContain('My note on it: Threshold is learned per layer');
    expect(prompt).toMatch(/Question: How do sparse attention methods prune blocks\?$/);
    expect(calls()[1].system![0].text).toContain('Cite with [n] right after each claim');

    // streaming: deltas are the raw reply; the final answer drops the citation to a source that doesn't exist
    expect(deltas.join('')).toContain(`[${hlN}, 9]`);
    expect(res.answer).toContain(`threshold, cutting memory by four times [${ftN}].`);
    expect(res.answer).toContain(`the same rule [${hlN}].`);
    expect(res.answer).not.toContain('9]');
    expect(res.citedNumbers).toEqual([ftN, hlN].sort((a, b) => a - b));

    // sources
    expect(res.sources.length).toBeGreaterThanOrEqual(2);
    expect(res.sources.length).toBeLessThanOrEqual(14);
    expect(res.sources.map((s) => s.n)).toEqual(res.sources.map((_, i) => i + 1));
    expect(res.sources[0].paperId).toBe(A.id);
    expect(res.sources.some((s) => s.paperId === C.id)).toBe(false);
    for (const s of res.sources) {
      expect(s.quote.length).toBeLessThanOrEqual(300);
      expect(s.cited).toBe(res.citedNumbers.includes(s.n));
    }
    const ft = res.sources.find((s) => s.n === ftN)!;
    expect(ft).toMatchObject({ kind: 'fulltext', citeKey: 'lovelace2024block', title: A.title, year: 2024, cited: true });
    expect(ft.quote).toMatch(/^We prune attention blocks .*learned threshold/); // matched to the claim, not the chunk start
    expect(A_TEXT.replace(/\s+/g, ' ')).toContain(ft.quote);
    expect(ft.target!.medium).toBe('html');
    expect(A_TEXT.slice(ft.target!.position.start, ft.target!.position.end)).toBe(ft.target!.quote.exact);
    expect(ft.target!.quote.exact.replace(/\s+/g, ' ')).toBe(ft.quote);
    expect(ft.target!.quote.prefix.length).toBeGreaterThan(0);
    const h = res.sources.find((s) => s.n === hlN)!;
    expect(h).toMatchObject({ kind: 'highlight', annotationId: hl.id, label: 'method', cited: true });
    expect(h.target).toBeUndefined();

    // onSources: once after retrieval (nothing cited yet), once at the end
    expect(seen).toHaveLength(2);
    expect(seen[0].every((s) => !s.cited)).toBe(true);
    expect(seen[1].filter((s) => s.cited).map((s) => s.n)).toEqual(res.citedNumbers);

    const [last] = await listAskHistory();
    expect(last).toMatchObject({ question: 'How do sparse attention methods prune blocks?', answer: res.answer, citedNumbers: res.citedNumbers });
    expect(last.sources).toHaveLength(res.sources.length);
  });

  it('uses the question alone when expansion fails, and scopes to a project', async () => {
    const { project } = await seedLibrary();
    state.replies = [new Error('overloaded'), 'Reward shaping gives agents denser feedback [1].'];
    const res = await askLibrary('Which papers use reward shaping for agents?', { projectId: project.id }, {});
    expect(calls()).toHaveLength(2);
    expect(calls()[1].onDelta).toBeUndefined(); // no onText: not streamed
    expect(res.sources.length).toBeGreaterThan(0);
    expect(res.sources.every((s) => s.paperId === B.id)).toBe(true);
    expect(res.sources.some((s) => s.kind === 'note')).toBe(true);
    expect(calls()[1].messages[0].content).toContain('my note on the paper:\nUseful baseline for reward densification in agents.');
    expect(res.citedNumbers).toEqual([1]);
  });

  it('says so without calling the smart model when nothing matches', async () => {
    await seedLibrary();
    const deltas: string[] = [];
    const res = await askLibrary('zzqx flurb wibble?', { expand: false }, { onText: (d) => deltas.push(d) });
    expect(calls()).toHaveLength(0);
    expect(res).toMatchObject({ sources: [], citedNumbers: [] });
    expect(res.answer).toMatch(/couldn't find anything in your saved papers/);
    expect(deltas.join('')).toBe(res.answer);
  });

  it('keeps the last 30 questions in history', async () => {
    await seedLibrary();
    for (let i = 0; i < 32; i++) {
      state.replies.push(`Answer ${i} [1].`);
      await askLibrary(`sparse attention question ${i}`, { expand: false });
    }
    const history = await listAskHistory();
    expect(history).toHaveLength(30);
    expect(history[0].question).toBe('sparse attention question 31');
    expect(history[29].question).toBe('sparse attention question 2');
    expect(history[0]).toMatchObject({ answer: 'Answer 31 [1].', citedNumbers: [1] });
    expect(typeof history[0].at).toBe('string');
    // repeated questions reuse the cached chunking of the full texts
    expect(chunkCacheStats().hits).toBeGreaterThan(0);
    await clearAskHistory();
    expect(await listAskHistory()).toEqual([]);
  });

  it('normalizes [n] citations and drops ones with no source', () => {
    expect(cleanCitations('A [2, 5]. B [3-4]. C [9]. D [1](https://x.org). E in [0, 1]. F [2023].', 5)).toEqual({
      text: 'A [2][5]. B [3][4]. C. D [1](https://x.org). E in [0, 1]. F [2023].',
      cited: [2, 3, 4, 5],
    });
  });
});

// ---- Related-work drafter ----

async function seedRelated() {
  const a = paper('arxiv:2401.00001', 'lovelace2024block', 'Block-sparse attention', 'We prune attention blocks.', {
    authors: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }, { name: 'Grace Hopper' }, { name: 'Edsger Dijkstra' }],
    venue: 'NeurIPS 2024',
    extracted: { task: 'long-context attention', benchmarks: ['LongBench'], models: ['Llama'], metrics: ['accuracy'], headlineResult: 'Four times less memory at equal accuracy.', source: 'ai', updatedAt: '2024-01-01T00:00:00Z' },
  });
  const b = paper('arxiv:2402.00002', 'turing2023reward', 'Reward shaping for agents', 'Dense rewards for tool use.', { year: 2023 });
  const c = paper('arxiv:2403.00003', 'hopper2022protein', 'Protein diffusion', 'Diffusion for proteins.', { year: 2022 });
  for (const p of [a, b, c]) await addPaper(p);
  await addHighlight(a.id, 'blocks below a learned threshold are skipped', 'method', 'per-layer threshold');
  await addHighlight(a.id, 'only evaluated up to 32k tokens', 'weakness');
  await addPaperNote(b.id, 'Strong baseline but needs a reward model.');
  return [a, b, c];
}

describe('draftRelatedWork', () => {
  it('drafts LaTeX from cached paper context, removes unknown keys and reports missing papers', async () => {
    const [a, b, c] = await seedRelated();
    const raw =
      '\\paragraph{Sparse attention.} Block pruning skips low-scoring blocks \\citep{lovelace2024block,smith2020fake}. ' +
      'Others prune heads~\\citep{jones2021ghost}. \\citet{Turing2023Reward} shape rewards \\cite{turing2023reward}.';
    state.replies = [raw];
    const deltas: string[] = [];
    const res = await draftRelatedWork(
      { paperIds: [c.id, b.id, a.id], topic: 'efficient long-context agents', style: 'paragraphs', length: 'medium', format: 'latex' },
      { onText: (d) => deltas.push(d) },
    );
    expect(deltas.join('')).toBe(raw);
    expect(res.text).toBe(
      '\\paragraph{Sparse attention.} Block pruning skips low-scoring blocks \\citep{lovelace2024block}. Others prune heads. \\citet{turing2023reward} shape rewards \\cite{turing2023reward}.',
    );
    expect(res.usedKeys).toEqual(['lovelace2024block', 'turing2023reward']);
    expect(res.unknownKeys).toEqual(['smith2020fake', 'jones2021ghost']);
    expect(res.missingKeys).toEqual(['hopper2022protein']);

    const req = calls()[0];
    expect(req.model).toBe(DEFAULT_SETTINGS.smartModel);
    expect(req.system).toHaveLength(2);
    expect(req.system![1].cache).toBe(true);
    const ctx = req.system![1].text;
    expect(ctx).toContain('<paper key="lovelace2024block">');
    expect(ctx).toContain('Authors: Ada Lovelace, Alan Turing, Grace Hopper et al.');
    expect(ctx).toContain('Venue: NeurIPS 2024');
    expect(ctx).toContain('Headline result: Four times less memory at equal accuracy.');
    expect(ctx).toMatch(/Method:\n- "blocks below a learned threshold are skipped" \(my note: per-layer threshold\)/);
    expect(ctx).toContain('Weakness:\n- "only evaluated up to 32k tokens"');
    expect(ctx).toContain('My notes on the paper:\n- Strong baseline but needs a reward model.');
    // papers sorted by key, so the cached block is stable whatever order the ids come in
    expect(ctx.indexOf('hopper2022protein')).toBeLessThan(ctx.indexOf('lovelace2024block'));
    const user = req.messages[0].content;
    expect(user).toContain('efficient long-context agents');
    expect(user).toContain('about 350 words');
    expect(user).toContain('\\citep{key}');
    expect(user).toContain('hopper2022protein, lovelace2024block, turing2023reward');
    expect(`${req.system![0].text}${ctx}${user}`).not.toContain('\u2014');
  });

  it('handles Markdown citations and strips code fences', async () => {
    const [a, b] = await seedRelated();
    state.replies = [
      '```markdown\n- **Sparse attention.** Block pruning [@lovelace2024block; @ghost2020]. Rewards [@ghost2021].\n  - As @turing2023reward and @nobody2019 show, see [see @lovelace2024block, p. 3].\n```',
    ];
    const res = await draftRelatedWork({ paperIds: [a.id, b.id], style: 'bullets', length: 'short', format: 'markdown' });
    expect(res.text).toBe(
      '- **Sparse attention.** Block pruning [@lovelace2024block]. Rewards.\n  - As @turing2023reward and show, see [see @lovelace2024block, p. 3].',
    );
    expect(res.usedKeys).toEqual(['lovelace2024block', 'turing2023reward']);
    expect(res.unknownKeys).toEqual(['ghost2020', 'ghost2021', 'nobody2019']);
    expect(res.missingKeys).toEqual([]);
    expect(calls()[0].messages[0].content).toContain('[@key]');
    expect(calls()[0].messages[0].content).toContain('about 150 words');
  });

  it('cleans citations without touching other text', () => {
    expect(cleanCiteKeys('See \\citealp[e.g.][]{a, B, x}. Mail me@host.org.', ['a', 'b'], 'latex')).toEqual({
      text: 'See \\citealp[e.g.][]{a,b}. Mail me@host.org.',
      usedKeys: ['a', 'b'],
      unknownKeys: ['x'],
    });
  });
});

describe('AI off', () => {
  it('both features throw before doing anything', async () => {
    await seedLibrary();
    state.ai = false;
    state.replies = ['should not be used'];
    await expect(askLibrary('How do sparse attention methods prune blocks?')).rejects.toThrow(/AI features are turned off/);
    await expect(draftRelatedWork({ paperIds: [A.id], style: 'paragraphs', length: 'short', format: 'latex' })).rejects.toThrow(/AI features are turned off/);
    expect(calls()).toHaveLength(0);
    expect(await listAskHistory()).toEqual([]);
  });
});
