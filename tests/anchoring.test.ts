import { describe, expect, it } from 'vitest';
import { anchorQuote, describeQuote, normalize } from '@/lib/anchoring/text';
import { TextIndex } from '@/lib/anchoring/dom';
import { highlightRange, removeHighlight } from '@/lib/anchoring/highlighter';

const text = 'Alpha beta gamma. The model is trained with Adam. Later, the model is trained with SGD instead.';

describe('normalize', () => {
  it('drops whitespace and folds ligatures with an index map', () => {
    const n = normalize('ﬁne  tu­ning');
    expect(n.text).toBe('finetuning');
    expect(n.map[0]).toBe(0);
    expect(n.map[n.text.length - 1]).toBe('ﬁne  tu­ning'.length - 1);
  });
});

describe('anchorQuote', () => {
  it('finds exact quotes and uses context to pick between repeats', () => {
    const [q] = describeQuote(text, text.indexOf('the model is trained', 40), text.indexOf('the model is trained', 40) + 20);
    const r = anchorQuote(text, q)!;
    expect(text.slice(r.start, r.end)).toBe('the model is trained');
    expect(r.start).toBe(text.indexOf('the model is trained', 40));
  });
  it('matches across whitespace and line-break differences', () => {
    const pdfText = 'Alpha beta\ngamma.The model istrained with Adam.';
    const r = anchorQuote(pdfText, { type: 'TextQuoteSelector', exact: 'The model is trained with Adam', prefix: 'gamma. ', suffix: '.' })!;
    expect(pdfText.slice(r.start, r.end)).toBe('The model istrained with Adam');
  });
  it('fuzzy-matches edited text and rejects unrelated text', () => {
    const v2 = 'Long-context language models often struggle to use information placed in the middle of their input.';
    const q = { type: 'TextQuoteSelector' as const, exact: 'Long-context language models struggle to use information placed in the middle of their input', prefix: '', suffix: '' };
    const r = anchorQuote(v2, q)!;
    expect(r.score).toBeLessThan(1);
    expect(v2.slice(r.start, r.end)).toContain('often struggle');
    expect(anchorQuote('Completely different words here.', { type: 'TextQuoteSelector', exact: 'This sentence only exists in the first version', prefix: '', suffix: '' })).toBeNull();
  });
});

describe('context check', () => {
  it('leaves a short quote unplaced when only an unrelated occurrence remains', () => {
    const v2 = 'Intro text. Results show filtered attention helps a lot in practice.';
    const q = { type: 'TextQuoteSelector' as const, exact: 'filtered attention', prefix: 'This deleted sentence mentions ', suffix: ' only once here.' };
    expect(anchorQuote(v2, q)).toBeNull();
    expect(anchorQuote(v2, { ...q, prefix: 'Results show ', suffix: ' helps' })).not.toBeNull();
  });
});

describe('overlapping highlights', () => {
  it('keeps nested and overlapping highlights through sync', async () => {
    const { HtmlAnnotator } = await import('@/lib/anchoring/annotator');
    document.body.innerHTML = '<article><p>Alpha beta gamma delta epsilon zeta eta theta.</p></article>';
    const root = document.querySelector('article')!;
    const mk = (id: string, exact: string, start: number) => ({
      id, paperId: 'p', type: 'Annotation', motivation: 'highlighting', deletedAt: null,
      body: [{ type: 'TextualBody', purpose: 'tagging', value: 'plain' }],
      target: { source: 'p', selector: [{ type: 'TextQuoteSelector', exact, prefix: '', suffix: '' }, { type: 'TextPositionSelector', start, end: start + exact.length }], state: { medium: 'html' } },
    }) as any;
    const text = 'Alpha beta gamma delta epsilon zeta eta theta.';
    const ann = new HtmlAnnotator(root, 'html');
    const r = ann.sync([
      mk('A', 'beta gamma delta epsilon', text.indexOf('beta')),
      mk('B', 'gamma delta', text.indexOf('gamma')),
      mk('C', 'epsilon zeta', text.indexOf('epsilon')),
    ]);
    expect(r.orphans).toEqual([]);
    const textOf = (id: string) => [...root.querySelectorAll(`mark[data-mg-id="${id}"]`)].map((m) => m.textContent).join('');
    expect(textOf('A')).toBe('beta gamma delta epsilon');
    expect(textOf('B')).toBe('gamma delta');
    expect(textOf('C')).toBe('epsilon zeta');
  });
});

describe('TextIndex + highlighter', () => {
  it('maps ranges to offsets and back, wraps and unwraps', () => {
    document.body.innerHTML = '<article><p>Hello <b>bold</b> world</p><button>Report issue</button><p>Second para</p></article>';
    const root = document.querySelector('article')!;
    const idx = new TextIndex(root);
    expect(idx.text).toBe('Hello bold worldSecond para');
    const r = idx.offsetsToRange(6, 16)!;
    expect(r.toString()).toBe('bold world');
    expect(idx.rangeToOffsets(r)).toEqual({ start: 6, end: 16 });
    const h = highlightRange(r, root, 'a1', { 'data-mg-label': 'method' });
    expect(root.querySelectorAll('mark.mg-hl').length).toBe(2);
    expect(new TextIndex(root).text).toBe(idx.text);
    removeHighlight(h);
    expect(root.querySelectorAll('mark').length).toBe(0);
    expect(root.querySelector('p')!.innerHTML).toBe('Hello <b>bold</b> world');
  });
});
