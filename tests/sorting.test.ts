import { describe, expect, it } from 'vitest';
import { Corpus, cosineSparse, tokenize } from '@/lib/sorting/tfidf';
import { clusterPapers } from '@/lib/sorting/cluster';
import { heuristicScores, decideFiling } from '@/lib/sorting/relevance';
import { computePriority } from '@/lib/sorting/priority';
import { shortVenue } from '@/lib/venue';
import { factoidFromHighlights, notesMarkdown } from '@/lib/exports';
import type { Annotation, Follow, LibraryEntry, Paper, Project } from '@/lib/types';

const meta = { owner: 'u', visibility: 'private' as const, groupId: null, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z', deletedAt: null };
const paper = (id: string, title: string, abstract: string, extra: Partial<Paper> = {}): Paper => ({
  ...meta, id, aliases: [], source: 'arxiv', title, authors: [{ name: 'Ada Lovelace' }], abstract, year: 2024, published: null, venue: null,
  venueStatus: 'preprint', urls: { abs: `https://arxiv.org/abs/${id}` }, codeLinks: [], citeKey: id, bibtex: `@misc{${id},}`, bibtexSource: 'arxiv', ...extra,
});
const entry = (paperId: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  ...meta, paperId, status: 'inbox', statusSetBy: 'auto', willCite: false, projectIds: [], dismissedProjectIds: [], suggestions: [], topicId: null, tags: [], progress: 0,
  lastOpenedAt: null, priority: 0, priorityReasons: [], ...extra,
});

const attn = [
  paper('a1', 'Sparse attention for long contexts', 'We prune attention blocks in long-context transformers to improve retrieval.'),
  paper('a2', 'Retrieval heads in long-context transformers', 'Attention heads that retrieve facts from long contexts.'),
  paper('a3', 'Block-sparse attention kernels', 'Fast block-sparse attention kernels for long-context transformers.'),
];
const agents = [
  paper('b1', 'Reward shaping for tool-use agents', 'Sparse rewards for tool-use agents shaped with planning traces.'),
  paper('b2', 'Credit assignment for web agents', 'Web navigation agents with sparse rewards and tool calls.'),
  paper('b3', 'Reward models for long-horizon agents', 'Reward models judge agent trajectories with tool calls.'),
];

describe('tfidf', () => {
  it('tokenizes with light stemming and bigrams', () => {
    expect(tokenize('Transformers retrieve facts')).toEqual(['transformer', 'retrieve', 'fact', 'transformer retrieve', 'retrieve fact']);
  });
  it('scores related docs higher', () => {
    const c = new Corpus([...attn, ...agents].map((p) => `${p.title} ${p.abstract}`));
    const q = c.vector('long-context attention retrieval');
    expect(cosineSparse(q, c.vector(attn[0].abstract))).toBeGreaterThan(cosineSparse(q, c.vector(agents[0].abstract)));
  });
});

describe('clustering', () => {
  it('separates two topics deterministically', () => {
    const r = clusterPapers([...attn, ...agents]);
    expect(r.groups.length).toBe(2);
    const groupOf = (id: string) => r.groups.findIndex((g) => g.paperIds.includes(id));
    expect(new Set(attn.map((p) => groupOf(p.id))).size).toBe(1);
    expect(new Set(agents.map((p) => groupOf(p.id))).size).toBe(1);
    expect(groupOf('a1')).not.toBe(groupOf('b1'));
    expect(clusterPapers([...attn, ...agents])).toEqual(r);
  });
});

describe('relevance + priority', () => {
  const project: Project = { ...meta, id: 'p1', name: 'Agents', description: 'Reward shaping and credit assignment for tool-use agents.', seedPaperIds: ['b1'], color: '#000' };
  const all = new Map([...attn, ...agents].map((p) => [p.id, p] as const));
  const entries = [...all.keys()].map((id) => entry(id));
  it('ranks on-topic papers above off-topic ones', () => {
    const on = heuristicScores({ paper: agents[1], projects: [project], papers: all, entries })[0].score;
    const off = heuristicScores({ paper: attn[1], projects: [project], papers: all, entries })[0].score;
    expect(on).toBeGreaterThan(off);
  });
  it('files, suggests or ignores by threshold, respecting dismissals', () => {
    const e = entry('x', { dismissedProjectIds: ['p2'] });
    const r = decideFiling([{ projectId: 'p1', score: 0.8 }, { projectId: 'p2', score: 0.9 }, { projectId: 'p3', score: 0.5 }, { projectId: 'p4', score: 0.1 }], e, 0.72, 0.45);
    expect(r.auto).toEqual(['p1']);
    expect(r.suggestions.map((s) => s.projectId)).toEqual(['p3']);
  });
  it('prioritizes papers citing your library and by followed authors', () => {
    const p = paper('c1', 't', 'a', { s2: { paperId: 's', referenceIds: ['arxiv:a1', 'arxiv:a2'], checkedAt: '' }, authors: [{ name: 'Grace Hopper' }] });
    const follows: Follow[] = [{ ...meta, id: 'name:grace hopper', name: 'grace hopper', s2AuthorId: null, lastCheckedAt: null }];
    const r = computePriority({ entry: entry('c1'), paper: p, projects: new Map(), libraryIds: new Set(['arxiv:a1', 'arxiv:a2']), follows });
    expect(r.reasons).toEqual(['Cites 2 papers you saved', 'By Grace Hopper']);
    expect(r.priority).toBeCloseTo(0.3 * (2 / 3) + 0.2, 2);
  });
});

describe('venue names', () => {
  it('abbreviates common venues', () => {
    expect(shortVenue('Neural Information Processing Systems', 2024)).toBe('NeurIPS 2024');
    expect(shortVenue('Annual Meeting of the Association for Computational Linguistics', 2023)).toBe('ACL 2023');
    expect(shortVenue('Some Workshop', 2022, ['SW'])).toBe('SW 2022');
    expect(shortVenue(null, 2022)).toBeNull();
  });
});

describe('exports', () => {
  const ann = (label: string, exact: string, note?: string): Annotation => ({
    ...meta, id: `urn:uuid:${label}`, type: 'Annotation', paperId: 'a1', motivation: 'highlighting', creator: { id: 'u', name: 'Me' },
    body: [{ type: 'TextualBody', purpose: 'tagging', value: label }, ...(note ? [{ type: 'TextualBody' as const, purpose: 'commenting' as const, value: note }] : [])],
    target: { source: 'a1', selector: [{ type: 'TextQuoteSelector', exact, prefix: '', suffix: '' }] },
  });
  it('slots labeled highlights into the factoid template', () => {
    const d = factoidFromHighlights([ann('problem', 'Models miss facts.'), ann('weakness', 'Only synthetic data.', 'Needs real data'), ann('plain', 'ignored')]);
    expect(d.problem).toEqual(['"Models miss facts."']);
    expect(d.better[0]).toContain('Needs real data');
    expect(d.method).toEqual([]);
  });
  it('writes Markdown notes with BibTeX', () => {
    const md = notesMarkdown(attn[0], [ann('result', 'Big gain.', 'nice')]);
    expect(md).toContain('# Sparse attention for long contexts');
    expect(md).toContain('> Big gain.');
    expect(md).toContain('```bibtex');
  });
});
