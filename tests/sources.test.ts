import { describe, expect, it } from 'vitest';
import { parseArxivAtom } from '@/lib/sources/arxiv';
import { extractCodeLinks } from '@/lib/codeLinks';
import { parseArxivId, parsePaperUrl } from '@/lib/ids';

describe('ids', () => {
  it('parses arXiv and OpenReview URLs', () => {
    expect(parsePaperUrl('https://arxiv.org/abs/2401.12345v3')).toMatchObject({ kind: 'arxiv-abs', paperId: 'arxiv:2401.12345', arxiv: { version: 3 } });
    expect(parsePaperUrl('https://arxiv.org/pdf/2401.12345.pdf')).toMatchObject({ kind: 'arxiv-pdf', paperId: 'arxiv:2401.12345' });
    expect(parsePaperUrl('https://arxiv.org/html/2401.12345v2/#S3')).toMatchObject({ kind: 'arxiv-html' });
    expect(parsePaperUrl('https://arxiv.org/abs/hep-th/9901001v2')).toMatchObject({ paperId: 'arxiv:hep-th/9901001' });
    expect(parsePaperUrl('https://openreview.net/forum?id=AbC_12&noteId=x')).toMatchObject({ kind: 'openreview-forum', paperId: 'openreview:AbC_12' });
    expect(parsePaperUrl('https://example.com/x')).toBeNull();
    expect(parseArxivId('arXiv:2402.00002v1')).toEqual({ id: '2402.00002', version: 1 });
  });
});

describe('arXiv API', () => {
  it('parses Atom entries and skips errors', () => {
    const xml = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2401.00001v2</id>
      <published>2024-01-02T00:00:00Z</published><updated>2024-02-02T00:00:00Z</updated><title>A
      Title</title><summary> Abstract text. </summary><author><name>Ada Lovelace</name></author><author><name>Alan Turing</name></author>
      <arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">ICLR 2024</arxiv:comment>
      <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.LG"/></entry>
      <entry><id>http://arxiv.org/api/errors#x</id><title>Error</title></entry></feed>`;
    const [m, ...rest] = parseArxivAtom(xml);
    expect(rest).toEqual([]);
    expect(m).toMatchObject({ id: '2401.00001', version: 2, title: 'A Title', authors: ['Ada Lovelace', 'Alan Turing'], abstract: 'Abstract text.', comments: 'ICLR 2024', primaryCategory: 'cs.LG' });
  });
  it('extracts repository links at repo granularity', () => {
    expect(extractCodeLinks('Code: https://github.com/ada/fa/tree/main. Data at https://huggingface.co/datasets/ada/nb/blob/x and https://github.com/ada')).toEqual([
      'https://github.com/ada/fa',
      'https://huggingface.co/datasets/ada/nb',
    ]);
  });
});
