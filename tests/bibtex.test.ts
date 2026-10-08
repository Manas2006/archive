import { describe, expect, it } from 'vitest';
import { arxivBibtex, baseCiteKey, bibtexName, escapeLatex, normalizeForeignBib, parseBib, protectTitle, splitName, toAuthor, uniqueCiteKey } from '@/lib/bibtex';

describe('names', () => {
  it('splits particles and suffixes', () => {
    expect(splitName('Ludwig van Beethoven')).toEqual({ given: 'Ludwig', family: 'van Beethoven', suffix: undefined });
    expect(splitName('Martin Luther King Jr.')).toMatchObject({ given: 'Martin Luther', family: 'King', suffix: 'Jr.' });
    expect(splitName('Lovelace, Ada')).toEqual({ family: 'Lovelace', given: 'Ada' });
    expect(bibtexName(toAuthor('Ada Lovelace'))).toBe('Lovelace, Ada');
  });
});

describe('cite keys', () => {
  it('uses lastname + year + first significant word', () => {
    expect(baseCiteKey([toAuthor('Ashish Vaswani')], 2017, 'Attention Is All You Need')).toBe('vaswani2017attention');
    expect(baseCiteKey([toAuthor('José Müller')], 2021, 'On the $\\alpha$-Divergence of Things')).toBe('muller2021divergence');
    expect(baseCiteKey([], null, 'A Survey')).toBe('anonsurvey');
  });
  it('disambiguates collisions', () => {
    expect(uniqueCiteKey('a2020b', new Set(['a2020b']))).toBe('a2020ba');
    expect(uniqueCiteKey('a2020b', new Set(['a2020b', 'a2020ba']))).toBe('a2020bb');
  });
});

describe('title protection', () => {
  it('braces acronyms and mixed case but not title case', () => {
    expect(protectTitle('Scaling LLM Agents with GPT-4 on ImageNet')).toBe('Scaling {LLM} Agents with {GPT-4} on {ImageNet}');
    expect(protectTitle('Self-Supervised Learning of iPhone Photos')).toBe('Self-Supervised Learning of {iPhone} Photos');
    expect(protectTitle('Attention Is All You Need')).toBe('Attention Is All You Need');
    expect(protectTitle('Bounds for $O(n)$ BERT Models')).toBe('Bounds for $O(n)$ {BERT} Models');
  });
  it('escapes specials outside math', () => {
    expect(escapeLatex('Q&A at 50% with $x_1$ and a_b')).toBe('Q\\&A at 50\\% with $x_1$ and a\\_b');
  });
});

describe('bib parse / normalize', () => {
  const dblp = `@inproceedings{DBLP:conf/nips/LovelaceT24,
  author       = {Ada Lovelace and
                  Alan Turing},
  title        = {Filtered Attention for {LLM} Retrieval},
  booktitle    = {NeurIPS},
  year         = {2024},
  timestamp    = {Thu, 13 Feb 2025},
  biburl       = {https://dblp.org/rec/conf/nips/LovelaceT24.bib}
}`;
  it('parses nested braces and multiline values', () => {
    const [e] = parseBib(dblp);
    expect(e.type).toBe('inproceedings');
    expect(e.key).toBe('DBLP:conf/nips/LovelaceT24');
    expect(e.fields.find(([k]) => k === 'author')![1]).toBe('Ada Lovelace and Alan Turing');
  });
  it('re-keys, drops noise, protects title', () => {
    const out = normalizeForeignBib(dblp, 'lovelace2024filtered')!;
    expect(out.startsWith('@inproceedings{lovelace2024filtered,')).toBe(true);
    expect(out).not.toContain('timestamp');
    expect(out).toContain('title     = {Filtered Attention for {LLM} Retrieval}');
  });
  it('builds arXiv entries', () => {
    const b = arxivBibtex({ citeKey: 'k', title: 'X & Y', authors: [toAuthor('Ada Lovelace')], year: 2024, arxivId: '2401.00001', primaryCategory: 'cs.CL' });
    expect(b).toContain('eprint        = {2401.00001}');
    expect(b).toContain('title         = {X \\& {Y}}');
    expect(parseBib(b)[0].fields.length).toBe(7);
  });
});
