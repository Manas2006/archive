import 'fake-indexeddb/auto'; // must load before Dexie
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { arxivBibtex, cleanImportedBib, hasPrivateBibFields, toAuthor } from '@/lib/bibtex';
import { projectBibText } from '@/lib/projectBib';
import { ArchiveDB, db, setDb } from '@/lib/db';
import { arxivUrls } from '@/lib/ids';
import * as repo from '@/lib/repo';
import type { Annotation, LibraryEntry, Paper, Project } from '@/lib/types';
import {
  detectImportFormat,
  exportFileName,
  findArxivId,
  htmlToText,
  importRefs,
  parseBibtexRefs,
  parseCslJson,
  parseImport,
  parseRis,
  toCslJson,
  toRis,
  unLatex,
  type ImportedRef,
} from '@/lib/zotero';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures/zotero', name), 'utf8');
const RIS = fixture('zotero-library.ris'); // CRLF, as Zotero writes it
const CSL = fixture('zotero-library.json');
const BIB = fixture('references.bib');

// settings (and so repo.newMeta) read chrome.storage.local
const storage: Record<string, unknown> = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (key: string) => ({ [key]: storage[key] }),
      set: async (items: Record<string, unknown>) => void Object.assign(storage, items),
    },
  },
});

const meta = { owner: 'u', visibility: 'private' as const, groupId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null };

const makePaper = (extra: Partial<Paper> & { id: string; title: string }): Paper => ({
  ...meta, aliases: [], source: 'arxiv', authors: [], abstract: '', year: 2022, published: null, venue: null, venueStatus: 'preprint',
  urls: {}, codeLinks: [], citeKey: 'key', bibtex: '', bibtexSource: 'arxiv', ...extra,
});

const makeEntry = (paperId: string, extra: Partial<LibraryEntry> = {}): LibraryEntry => ({
  ...meta, paperId, status: 'inbox', statusSetBy: 'auto', willCite: false, projectIds: [], dismissedProjectIds: [], suggestions: [], topicId: null,
  tags: [], progress: 0, lastOpenedAt: null, priority: 0, priorityReasons: [], ...extra,
});

const makeAnn = (paperId: string, i: number, o: { label?: string; quote?: string; note?: string }): Annotation => ({
  ...meta,
  createdAt: `2026-01-0${i}T00:00:00Z`,
  id: `urn:uuid:${paperId}-${i}`,
  type: 'Annotation',
  paperId,
  motivation: o.quote ? 'highlighting' : 'commenting',
  creator: { id: 'u', name: 'Me' },
  body: [
    ...(o.label ? [{ type: 'TextualBody' as const, purpose: 'tagging' as const, value: o.label }] : []),
    ...(o.note ? [{ type: 'TextualBody' as const, purpose: 'commenting' as const, value: o.note }] : []),
  ],
  target: { source: paperId, ...(o.quote ? { selector: [{ type: 'TextQuoteSelector' as const, exact: o.quote, prefix: '', suffix: '' }] } : {}) },
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('RIS import', () => {
  it('parses a Zotero export with HTML notes and tags (CRLF and a BOM)', () => {
    const refs = parseRis(`\uFEFF${RIS}`);
    expect(refs).toHaveLength(3);
    const [cot, alphafold, bert] = refs;
    expect(cot).toMatchObject({
      title: 'Chain-of-Thought Prompting Elicits Reasoning in Large Language Models',
      year: 2023,
      published: '2023-01-10',
      arxivId: '2201.11903',
      doi: '10.48550/arxiv.2201.11903',
      url: 'http://arxiv.org/abs/2201.11903',
      pdfUrl: 'http://arxiv.org/pdf/2201.11903v6',
      venue: null,
      kind: 'preprint',
    });
    expect(cot.authors).toHaveLength(9);
    expect(cot.authors[0]).toEqual({ name: 'Jason Wei', given: 'Jason', family: 'Wei' });
    expect(cot.tags).toEqual(['Computer Science - Computation and Language', 'reasoning', 'prompting']);
    expect(cot.notes).toEqual([
      'Comment: Published at NeurIPS 2022',
      '# Reading notes\n\nFew-shot exemplars pair each question with **intermediate steps** & a final answer.\n\n- Gains only appear at ~100B parameters\n- See [self-consistency](https://arxiv.org/abs/2203.11171)',
    ]);
    expect(alphafold).toMatchObject({ kind: 'journal', venue: 'Nature', doi: '10.1038/s41586-021-03819-2', year: 2021, published: '2021-08', arxivId: undefined });
    expect(alphafold.notes).toEqual(['Read for the structure module; compare with RoseTTAFold.']);
    expect(bert).toMatchObject({ kind: 'conference', venue: 'NAACL-HLT 2019', doi: '10.18653/v1/n19-1423', year: 2019, tags: ['transformers', 'pretraining'] });
  });

  it('tolerates a missing ER or TY, one-space tags, stray lines and wrapped values', () => {
    const text = [
      'Exported by SomeTool 1.0',
      'TY - JOUR',
      'TI  - A long title that',
      '      wraps onto a second line',
      'AU  - Lovelace, Ada',
      'AU  - Turing, Alan, Jr.',
      'JO  - arXiv preprint arXiv:2401.12345v2',
      'KW  - one',
      'two',
      'TY  - BOOK',
      'BT  - Only a book title',
      'ER  -',
      'AU  - Nobody, No',
      'ER  - ',
    ].join('\n');
    const refs = parseRis(text);
    expect(refs.map((r) => r.title)).toEqual(['A long title that wraps onto a second line', 'Only a book title', '']);
    expect(refs[0]).toMatchObject({ arxivId: '2401.12345', venue: null, kind: 'preprint', tags: ['one', 'two'] });
    expect(refs[0].authors[1]).toEqual({ name: 'Alan Turing Jr.', given: 'Alan', family: 'Turing' });
  });
});

describe('CSL JSON import', () => {
  it('parses a Zotero CSL JSON export', () => {
    const [gpt3, attention, go, cpc] = parseCslJson(CSL);
    expect(gpt3).toMatchObject({ arxivId: '2005.14165', kind: 'preprint', venue: null, year: 2020, published: '2020-07-22', doi: '10.48550/arxiv.2005.14165', key: undefined });
    expect(gpt3.authors[0]).toEqual({ name: 'Tom B. Brown', given: 'Tom B.', family: 'Brown' });
    expect(attention).toMatchObject({ kind: 'conference', venue: 'Advances in Neural Information Processing Systems', year: 2017, arxivId: undefined, key: 'vaswani2017attention' });
    expect(go).toMatchObject({ kind: 'journal', venue: 'Nature', doi: '10.1038/nature16961', published: '2016-01-28' });
    expect(cpc).toMatchObject({ arxivId: '1807.03748', kind: 'preprint', pdfUrl: 'https://arxiv.org/pdf/1807.03748v2.pdf' });
    expect(cpc.authors[0]).toEqual({ name: 'Aaron van den Oord', given: 'Aaron', family: 'van den Oord' });
  });

  it('returns nothing for broken JSON and refuses Archive backups', () => {
    expect(parseCslJson('[{"title": "x",')).toEqual([]);
    expect(() => parseCslJson(JSON.stringify({ format: 'archive-backup', version: 1, papers: [] }))).toThrow(/Import backup/);
  });
});

describe('BibTeX import', () => {
  it('parses arXiv eprints, DBLP CoRR entries, Scholar-style entries and conference papers', () => {
    const refs = parseBibtexRefs(BIB);
    expect(refs).toHaveLength(6); // the @comment is skipped
    const [wei, he, kr, bert, brown, lecun] = refs;
    expect(wei).toMatchObject({ arxivId: '2201.11903', kind: 'preprint', venue: null, year: 2022, published: '2022-01', key: 'wei2022chain', tags: ['reasoning', 'prompting'] });
    expect(wei.notes).toEqual(['Read with the self-consistency paper.']);
    expect(wei.bibtex?.startsWith('@misc{wei2022chain,')).toBe(true);
    expect(he).toMatchObject({ kind: 'conference', venue: 'Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR)', doi: '10.1109/cvpr.2016.90' });
    expect(kr.title).toBe('Efficient Inference in Fully Connected CRFs with Gaussian Edge Potentials');
    expect(kr.authors[0]).toEqual({ name: 'Philipp Krähenbühl', given: 'Philipp', family: 'Krähenbühl' });
    expect(bert).toMatchObject({ arxivId: '1810.04805', kind: 'preprint', venue: null, title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding' });
    expect(bert.authors[1].name).toBe('Ming-Wei Chang');
    expect(brown).toMatchObject({ arxivId: '2005.14165', venue: null, kind: 'preprint' });
    expect(brown.authors).toHaveLength(3); // "and others" dropped
    expect(lecun).toMatchObject({ kind: 'journal', venue: 'Proceedings of the IEEE', doi: '10.1109/5.726791' });
    expect(lecun.authors[1].name).toBe('Léon Bottou');
  });

  it('un-escapes LaTeX and keeps organizations whole', () => {
    expect(unLatex('{\\"O}zt{\\"u}rk')).toBe('Öztürk');
    expect(unLatex("Caf\\'e \\& Bar")).toBe('Café & Bar');
    expect(unLatex('Stra\\ss e')).toBe('Straße');
    expect(unLatex('\\emph{Deep} {L}earning, pages 1--2')).toBe('Deep Learning, pages 1\u20132');
    expect(unLatex('On the $\\alpha$-Divergence of 50\\% of {LLM}s')).toBe('On the $\\alpha$-Divergence of 50% of LLMs');
    expect(unLatex('X \\textasciitilde{} Y\\textbackslash{}Z \\{a\\}')).toBe('X ~ Y\\Z {a}');
    const [r] = parseBibtexRefs('@misc{k, title = {T}, author = {{Google DeepMind} and Ada Lovelace}}');
    expect(r.authors).toEqual([
      { name: 'Google DeepMind', given: '', family: 'Google DeepMind' },
      { name: 'Ada Lovelace', given: 'Ada', family: 'Lovelace' },
    ]);
    // Archive's own BibTeX reads back cleanly
    const [own] = parseBibtexRefs(arxivBibtex({ citeKey: 'k', title: 'Q&A for GPT-4', authors: [toAuthor('Ada Lovelace')], year: 2024, arxivId: '2401.00001' }));
    expect(own).toMatchObject({ title: 'Q&A for GPT-4', arxivId: '2401.00001', year: 2024 });
  });
});

describe('arXiv ids', () => {
  it('finds ids in DOIs, URLs and arXiv text, without versions', () => {
    expect(findArxivId('10.48550/arXiv.2401.12345')).toBe('2401.12345');
    expect(findArxivId('https://doi.org/10.48550/arXiv.2401.12345')).toBe('2401.12345');
    expect(findArxivId('https://arxiv.org/abs/2401.12345v3')).toBe('2401.12345');
    expect(findArxivId('https://arxiv.org/pdf/2401.12345v2.pdf')).toBe('2401.12345');
    expect(findArxivId('arXiv preprint arXiv:2401.12345')).toBe('2401.12345');
    expect(findArxivId('https://arxiv.org/abs/hep-th/9901001v2')).toBe('hep-th/9901001');
    expect(findArxivId('arXiv:math.GT/0309136')).toBe('math.GT/0309136');
    expect(findArxivId(undefined, '', 'Published at NeurIPS', 'arXiv: 2201.11903 [cs]')).toBe('2201.11903');
  });
  it('ignores numbers that only look like arXiv ids', () => {
    expect(findArxivId('https://doi.org/10.1145/3292500.3330701')).toBeUndefined();
    expect(findArxivId('2401.12345')).toBeUndefined();
  });
});

describe('format detection', () => {
  it('uses content first and the extension as a fallback', () => {
    expect(detectImportFormat('library.bib', BIB)).toBe('bibtex');
    expect(detectImportFormat('library.ris', RIS)).toBe('ris');
    expect(detectImportFormat('library.json', CSL)).toBe('csljson');
    expect(detectImportFormat('export.txt', RIS)).toBe('ris');
    expect(detectImportFormat('mislabeled.bib', RIS)).toBe('ris');
    expect(detectImportFormat('empty.bib', '')).toBe('bibtex');
    expect(detectImportFormat('notes.txt', 'hello')).toBeNull();
    expect(parseImport('export.txt', BIB)).toHaveLength(6);
    expect(parseImport('notes.txt', 'hello')).toEqual([]);
    expect(() => parseImport('archive-backup.json', JSON.stringify({ format: 'archive-backup', version: 1 }))).toThrow(/Import backup/);
  });
});

describe('HTML notes', () => {
  it('keeps paragraphs, line breaks and quotes, and decodes entities', () => {
    expect(htmlToText('<p>A&nbsp;&lt;b&gt;</p><blockquote><p>quoted</p></blockquote><p>x<br>y &#8211; <em>z</em></p>')).toBe('A <b>\n\n> quoted\n\nx\ny \u2013 *z*');
  });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const cotPaper = makePaper({
  id: 'arxiv:2201.11903',
  title: 'Chain-of-Thought Prompting Elicits Reasoning in Large Language Models',
  authors: [toAuthor('Jason Wei'), toAuthor('Xuezhi Wang'), toAuthor('Ludwig van Beethoven')],
  abstract: 'We explore how generating a chain of thought improves reasoning.',
  year: 2022,
  published: '2022-01-28T18:59:00Z',
  arxivId: '2201.11903',
  urls: arxivUrls('2201.11903'),
  citeKey: 'wei2022chain',
  bibtex: arxivBibtex({ citeKey: 'wei2022chain', title: 'Chain-of-Thought Prompting Elicits Reasoning in Large Language Models', authors: [toAuthor('Jason Wei')], year: 2022, arxivId: '2201.11903' }),
});
const attentionPaper = makePaper({
  id: 'arxiv:1706.03762',
  title: 'Attention Is All You Need',
  authors: [toAuthor('Ashish Vaswani')],
  year: 2017,
  arxivId: '1706.03762',
  venue: 'NeurIPS 2017',
  venueStatus: 'accepted',
  urls: arxivUrls('1706.03762'),
  citeKey: 'vaswani2017attention',
  bibtexSource: 'dblp',
  bibtex: '@inproceedings{vaswani2017attention,\n  title     = {Attention Is All You Need},\n  booktitle = {Advances in Neural Information Processing Systems},\n  volume    = {30},\n  pages     = {5998--6008},\n  year      = {2017}\n}',
});
const goPaper = makePaper({
  id: 'doi:10.1038/nature16961',
  source: 'doi',
  title: 'Mastering the game of Go with deep neural networks and tree search',
  authors: [toAuthor('David Silver')],
  year: 2016,
  doi: '10.1038/nature16961',
  venue: 'Nature 2016',
  venueStatus: 'accepted',
  urls: { abs: 'https://doi.org/10.1038/nature16961' },
  citeKey: 'silver2016mastering',
  bibtexSource: 's2',
  bibtex: '@article{silver2016mastering,\n  title   = {Mastering the game of {Go} with deep neural networks and tree search},\n  journal = {Nature},\n  volume  = {529},\n  number  = {7587},\n  pages   = {484--489},\n  year    = {2016}\n}',
});
const projects = new Map<string, Project>([['p1', { ...meta, id: 'p1', name: 'Agents', description: '', seedPaperIds: [], color: '#000' }]]);
const cotAnnotations = [
  makeAnn(cotPaper.id, 1, { note: 'My summary.\n\nSecond paragraph.' }),
  makeAnn(cotPaper.id, 2, { label: 'method', quote: 'Let us   think step\nby step.', note: 'Works on GSM8K.' }),
  makeAnn(cotPaper.id, 3, { label: 'plain', quote: 'plain one' }),
  makeAnn(cotPaper.id, 4, { note: 'first\nAB  - not a tag' }),
];
const items = [
  { paper: cotPaper, entry: makeEntry(cotPaper.id, { tags: ['reasoning'], projectIds: ['p1'] }), annotations: cotAnnotations },
  { paper: attentionPaper, entry: null, annotations: [] },
  { paper: goPaper, annotations: [] },
];

describe('RIS export', () => {
  const text = toRis(items, { projects });
  const records = text.split('ER  - ').map((r) => r.split('\r\n').filter(Boolean));

  it('writes CRLF records Zotero reads as the right item types', () => {
    expect(text.replace(/\r\n/g, '').includes('\n')).toBe(false);
    expect(text.endsWith('ER  - \r\n')).toBe(true);
    const [cot, attention, go] = records;
    expect(cot.slice(0, 3)).toEqual(['TY  - JOUR', 'ID  - wei2022chain', 'TI  - Chain-of-Thought Prompting Elicits Reasoning in Large Language Models']);
    expect(cot).toEqual(
      expect.arrayContaining([
        'AU  - Wei, Jason',
        'AU  - van Beethoven, Ludwig',
        'T2  - arXiv',
        'DA  - 2022/01/28/',
        'PY  - 2022',
        'DO  - 10.48550/arXiv.2201.11903',
        'UR  - https://arxiv.org/abs/2201.11903',
        'L1  - https://arxiv.org/pdf/2201.11903',
        'KW  - reasoning',
        'KW  - Agents',
        'N1  - Method: “Let us think step by step.”',
        'Works on GSM8K.',
        'N1  - “plain one”',
        ' AB  - not a tag',
      ]),
    );
    expect(attention).toEqual(expect.arrayContaining(['TY  - CONF', 'T2  - NeurIPS 2017', 'C3  - Advances in Neural Information Processing Systems', 'VL  - 30', 'SP  - 5998', 'EP  - 6008']));
    expect(attention.some((l) => l.startsWith('DO  -'))).toBe(false);
    expect(go).toEqual(expect.arrayContaining(['TY  - JOUR', 'T2  - Nature', 'DO  - 10.1038/nature16961', 'VL  - 529', 'IS  - 7587', 'SP  - 484', 'EP  - 489', 'DA  - 2016///']));
  });

  it('round trips through parseRis', () => {
    const [cot, attention, go] = parseRis(text);
    expect(cot).toMatchObject({ title: cotPaper.title, year: 2022, arxivId: '2201.11903', kind: 'preprint', venue: null, key: 'wei2022chain' });
    expect(cot.authors.map((a) => a.name)).toEqual(['Jason Wei', 'Xuezhi Wang', 'Ludwig van Beethoven']);
    expect(cot.authors[2].family).toBe('van Beethoven');
    expect(cot.tags).toEqual(['reasoning', 'Agents']);
    // the indented line stays part of its note (whitespace inside lines is tidied)
    expect(cot.notes).toEqual(['My summary.\n\nSecond paragraph.', 'first\nAB - not a tag', 'Method: “Let us think step by step.”\nWorks on GSM8K.', '“plain one”']);
    expect(attention).toMatchObject({ kind: 'conference', venue: 'NeurIPS 2017', year: 2017, arxivId: '1706.03762' });
    expect(go).toMatchObject({ kind: 'journal', venue: 'Nature', doi: '10.1038/nature16961' });
  });
});

describe('CSL JSON export', () => {
  it('writes Zotero CSL types and fields', () => {
    const [cot, attention, go] = JSON.parse(toCslJson(items.map((i) => i.paper)));
    expect(cot).toMatchObject({
      id: 'wei2022chain',
      'citation-key': 'wei2022chain',
      type: 'article',
      publisher: 'arXiv',
      number: 'arXiv:2201.11903',
      DOI: '10.48550/arXiv.2201.11903',
      URL: 'https://arxiv.org/abs/2201.11903',
      issued: { 'date-parts': [[2022, 1, 28]] },
    });
    expect(cot.author[2]).toEqual({ family: 'van Beethoven', given: 'Ludwig' });
    expect(attention).toMatchObject({ type: 'paper-conference', 'container-title': 'Advances in Neural Information Processing Systems', 'event-title': 'NeurIPS 2017', page: '5998-6008' });
    expect(go).toMatchObject({ type: 'article-journal', 'container-title': 'Nature', volume: '529', issue: '7587', page: '484-489', DOI: '10.1038/nature16961' });
  });

  it('round trips through parseCslJson', () => {
    const [cot, attention, go] = parseCslJson(toCslJson(items.map((i) => i.paper)));
    expect(cot).toMatchObject({ arxivId: '2201.11903', kind: 'preprint', venue: null, published: '2022-01-28', key: 'wei2022chain' });
    expect(attention).toMatchObject({ kind: 'conference', venue: 'Advances in Neural Information Processing Systems', arxivId: '1706.03762' });
    expect(go).toMatchObject({ kind: 'journal', venue: 'Nature', doi: '10.1038/nature16961' });
  });

  it('names export files', () => {
    expect(exportFileName('ris', 'Reading group: Agents')).toBe('reading-group-agents.ris');
    expect(exportFileName('csljson', 'Müller lab')).toBe('muller-lab.json');
    expect(exportFileName('ris', '')).toBe('archive-library.ris');
  });
});

// ---------------------------------------------------------------------------
// Import into the library
// ---------------------------------------------------------------------------

describe('importRefs', () => {
  let n = 0;
  beforeEach(() => setDb(new ArchiveDB(`zotero-test-${++n}`)));
  afterEach(async () => {
    await db().delete();
  });

  const counts = async () => ({ papers: (await repo.listPapers()).length, entries: (await repo.listEntries()).length, annotations: (await repo.listAllAnnotations()).length });

  it('creates papers, library entries, tags and one note per paper', async () => {
    const res = await importRefs(parseRis(RIS));
    expect(res).toEqual({ added: 3, updated: 0, skipped: 0, paperIds: ['arxiv:2201.11903', 'doi:10.1038/s41586-021-03819-2', 'doi:10.18653/v1/n19-1423'] });

    const cot = (await repo.getPaper('arxiv:2201.11903'))!;
    expect(cot).toMatchObject({
      source: 'arxiv',
      arxivId: '2201.11903',
      aliases: [],
      venue: null,
      venueStatus: 'preprint',
      published: '2023-01-10',
      citeKey: 'wei2023chain',
      bibtexSource: 'arxiv',
      urls: arxivUrls('2201.11903'),
      codeLinks: [],
    });
    expect(cot.doi).toBeUndefined(); // the arXiv DOI is not a venue DOI
    expect(cot.bibtex).toContain('eprint        = {2201.11903}');

    const alphafold = (await repo.getPaper('doi:10.1038/s41586-021-03819-2'))!;
    expect(alphafold).toMatchObject({ source: 'doi', venue: 'Nature 2021', venueStatus: 'accepted', bibtexSource: 'import', urls: { abs: 'https://doi.org/10.1038/s41586-021-03819-2' } });
    expect(alphafold.bibtex.startsWith('@article{jumper2021highly,')).toBe(true);
    expect(alphafold.bibtex).toContain('{Nature}');
    const bert = (await repo.getPaper('doi:10.18653/v1/n19-1423'))!;
    expect(bert).toMatchObject({ venue: 'NAACL 2019', citeKey: 'devlin2019bert' });
    expect(bert.bibtex.startsWith('@inproceedings{devlin2019bert,')).toBe(true);

    expect(await repo.getEntry(cot.id)).toMatchObject({ status: 'inbox', tags: ['Computer Science - Computation and Language', 'reasoning', 'prompting'] });
    const notes = await repo.listAnnotations(cot.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ motivation: 'commenting', target: { source: cot.id } });
    expect(notes[0].target.selector).toBeUndefined();
    expect(notes[0].body).toEqual([{ type: 'TextualBody', purpose: 'commenting', format: 'text/markdown', value: expect.stringMatching(/^Comment: Published at NeurIPS 2022\n\n# Reading notes\n\n/) }]);
    expect(await repo.listAnnotations(bert.id)).toEqual([]);
  });

  it('is idempotent: importing the same file again adds no papers, tags or notes', async () => {
    await importRefs(parseRis(RIS));
    await importRefs(parseCslJson(CSL));
    await importRefs(parseBibtexRefs(BIB));
    const before = await counts();
    const tagsBefore = (await repo.listEntries()).map((e) => e.tags);
    expect(await importRefs(parseRis(RIS))).toMatchObject({ added: 0, updated: 3, skipped: 0 });
    expect(await importRefs(parseCslJson(CSL))).toMatchObject({ added: 0, updated: 4 });
    expect(await importRefs(parseBibtexRefs(BIB))).toMatchObject({ added: 0, updated: 6 });
    expect(await counts()).toEqual(before);
    expect((await repo.listEntries()).map((e) => e.tags)).toEqual(tagsBefore);
  });

  it('gives refs without an arXiv id or DOI a stable ref: id', async () => {
    const res = await importRefs(parseCslJson(CSL));
    const refId = res.paperIds.find((id) => id.startsWith('ref:'))!;
    expect(refId).toMatch(/^ref:[0-9a-z]+$/);
    expect(await repo.getPaper(refId)).toMatchObject({ source: 'import', title: 'Attention Is All You Need', venue: 'NeurIPS 2017', venueStatus: 'accepted' });
    expect((await repo.getPaper(refId))!.bibtex).toContain('booktitle = {Advances in Neural Information Processing Systems}');
    expect((await importRefs(parseCslJson(CSL))).paperIds).toContain(refId);
  });

  it('updates an existing paper without overwriting its metadata', async () => {
    await repo.putPaper(makePaper({ id: 'arxiv:2201.11903', title: 'My title for CoT', citeKey: 'mykey', bibtex: '@misc{mykey,}' }));
    await repo.ensureEntry('arxiv:2201.11903');
    await repo.updateEntry('arxiv:2201.11903', { tags: ['mine', 'Reasoning'] });
    const res = await importRefs(parseRis(RIS).slice(0, 1));
    expect(res).toEqual({ added: 0, updated: 1, skipped: 0, paperIds: ['arxiv:2201.11903'] });
    expect(await repo.getPaper('arxiv:2201.11903')).toMatchObject({ title: 'My title for CoT', citeKey: 'mykey', bibtex: '@misc{mykey,}', authors: [] });
    expect((await repo.getEntry('arxiv:2201.11903'))!.tags).toEqual(['mine', 'Reasoning', 'Computer Science - Computation and Language', 'prompting']);
    expect(await repo.listAnnotations('arxiv:2201.11903')).toHaveLength(1);
  });

  it('finds papers by alias or by title and records the new ids', async () => {
    await repo.putPaper(makePaper({ id: 'arxiv:1706.03762', title: 'Attention Is All You Need', aliases: ['doi:10.5555/3295222.3295349'] }));
    await repo.putPaper(makePaper({ id: 'openreview:AbC_12', source: 'openreview', title: 'Some OpenReview Paper' }));
    const byAlias: ImportedRef[] = [
      { title: 'Attention is all you need', authors: [], year: 2017, abstract: '', doi: '10.5555/3295222.3295349', notes: [], tags: [] },
      { title: 'Some OpenReview paper (camera ready)', authors: [], year: 2024, abstract: '', url: 'https://openreview.net/forum?id=AbC_12', notes: [], tags: [] },
    ];
    expect(await importRefs(byAlias)).toEqual({ added: 0, updated: 2, skipped: 0, paperIds: ['arxiv:1706.03762', 'openreview:AbC_12'] });

    // BERT arrives from RIS with its ACL DOI, then from DBLP BibTeX as the CoRR preprint
    await importRefs(parseRis(RIS));
    const res = await importRefs(parseBibtexRefs(BIB));
    expect(res).toMatchObject({ added: 4, updated: 2, skipped: 0 });
    const bert = (await repo.getPaper('arxiv:1810.04805'))!;
    expect(bert.id).toBe('doi:10.18653/v1/n19-1423');
    expect(bert.aliases).toEqual(['arxiv:1810.04805']);
    // the BibTeX note on CoT is new, so CoT now has two notes
    expect(await repo.listAnnotations('arxiv:2201.11903')).toHaveLength(2);
  });

  it('applies the chosen project and files tags that name a project', async () => {
    const protein = await repo.createProject({ name: 'Protein' });
    const reasoning = await repo.createProject({ name: 'Reasoning' });
    await importRefs(parseRis(RIS), { projectId: protein.id });
    const entries = await repo.listEntries();
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.projectIds.includes(protein.id))).toBe(true);
    const cot = (await repo.getEntry('arxiv:2201.11903'))!;
    expect(cot.projectIds).toEqual([protein.id, reasoning.id]);
    expect(cot.tags).toEqual(['Computer Science - Computation and Language', 'prompting']);
    await expect(importRefs(parseRis(RIS), { projectId: 'gone' })).rejects.toThrow('That project no longer exists.');
  });

  it('skips refs without a title', async () => {
    const blank: ImportedRef = { title: '  ', authors: [], year: null, abstract: '', notes: ['orphan note'], tags: [] };
    const res = await importRefs([blank, ...parseRis(RIS).slice(1, 2)]);
    expect(res).toMatchObject({ added: 1, updated: 0, skipped: 1 });
    expect((await counts()).papers).toBe(1);
  });

  it("adds no notes when re-importing Archive's own RIS export", async () => {
    await repo.putPaper(cotPaper);
    await repo.ensureEntry(cotPaper.id);
    for (const a of cotAnnotations) await repo.createAnnotation({ paperId: a.paperId, motivation: a.motivation, body: a.body, target: a.target });
    const annotations = await repo.listAnnotations(cotPaper.id);
    const exported = toRis([{ paper: cotPaper, entry: await repo.getEntry(cotPaper.id), annotations }]);
    expect(await importRefs(parseRis(exported))).toMatchObject({ added: 0, updated: 1 });
    expect(await repo.listAnnotations(cotPaper.id)).toHaveLength(cotAnnotations.length);
  });

  it('keeps the file citation keys when asked', async () => {
    await importRefs(parseBibtexRefs(BIB), { keepCiteKeys: true });
    const bert = (await repo.getPaper('arxiv:1810.04805'))!;
    expect(bert.citeKey).toBe('DBLP:journals/corr/abs-1810-04805');
    expect(bert).toMatchObject({ bibtexSource: 'import', venue: null, venueStatus: 'preprint' });
    expect(bert.bibtex.startsWith('@article{DBLP:journals/corr/abs-1810-04805,')).toBe(true);
    const he = (await repo.getPaper('doi:10.1109/cvpr.2016.90'))!;
    expect(he).toMatchObject({ citeKey: 'he2016deep', venue: 'CVPR 2016' });
  });
});

describe('private BibTeX fields', () => {
  beforeEach(() => setDb(new ArchiveDB(`zotero-private-${Math.random()}`)));
  afterEach(async () => {
    await db().delete();
  });

  it('cleanImportedBib drops notes, files and ratings and keeps the rest as written', () => {
    const src = `@article{old,
  title = {The {LLM} Book},
  author = {Doe, Jane},
  month = jan,
  file = {/Users/me/Papers/doe.pdf:pdf},
  annote = {my private thoughts},
  mendeley-groups = {Thesis},
  date-added = {2024-01-01},
  bdsk-file-1 = {YnBsaXN0},
  journal = {Nature},
}`;
    const out = cleanImportedBib(src, 'doe2024llm')!;
    expect(out.startsWith('@article{doe2024llm,')).toBe(true);
    expect(out).toContain('{The {LLM} Book}');
    expect(out).toContain('= jan,');
    expect(out).toContain('{Nature}');
    for (const f of ['file', 'annote', 'mendeley-groups', 'date-added', 'bdsk-file-1', 'private', '/Users/me']) expect(out).not.toContain(f);
    expect(hasPrivateBibFields(out)).toBe(false);
    expect(hasPrivateBibFields(src)).toBe(true);
  });

  it("imported BibTeX keeps the note as a note, not in the paper's BibTeX or the project .bib", async () => {
    const project = await repo.createProject({ name: 'Reasoning' });
    await importRefs(parseBibtexRefs(BIB), { projectId: project.id });
    const cot = (await repo.getPaper('arxiv:2201.11903'))!;
    expect(cot.bibtex).not.toMatch(/annote|keywords|self-consistency/);
    expect((await repo.listAnnotations(cot.id)).some((a) => /self-consistency/.test(JSON.stringify(a.body)))).toBe(true);

    // an older entry that still carries one is cleaned on the way out
    await repo.updatePaper(cot.id, { bibtex: cot.bibtex.replace(/\n\}$/, ',\n  annote = {secret}\n}') });
    const bib = await projectBibText(project.id);
    expect(bib).toContain(`{${cot.citeKey},`);
    expect(bib).not.toMatch(/annote|secret/);
  });
});
