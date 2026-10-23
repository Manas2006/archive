// @vitest-environment jsdom
// DOMPurify needs a full DOM; happy-dom's attribute handling lets it miss things.
import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '@/components/Markdown';

describe('markdownToHtml', () => {
  it('drops classes the app does not use, so untrusted text cannot restyle the page', () => {
    const html = markdownToHtml('Hi <span class="fixed inset-0 z-50 bg-white">fake dialog</span> and <sup class="mg-cite evil">[1]</sup>');
    expect(html).not.toMatch(/fixed|inset-0|z-50|evil/);
    expect(html).toContain('<sup class="mg-cite">[1]</sup>');
    expect(html).toContain('<span>fake dialog</span>');
  });

  it('keeps KaTeX and code-language classes', () => {
    const html = markdownToHtml('Math $x^2$ and\n\n```python\nprint(1)\n```');
    expect(html).toMatch(/class="katex/);
    expect(html).toContain('class="language-python"');
  });

  it('only allows http(s) links', () => {
    const html = markdownToHtml('[a](javascript:alert(1)) [b](https://arxiv.org)');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://arxiv.org"');
  });
});
