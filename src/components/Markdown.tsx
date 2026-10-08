import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

// Math is rendered as MathML (native in Chrome), so no fonts or stylesheet are
// needed, which matters inside content-script shadow roots.

function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { output: 'mathml', throwOnError: false, displayMode: display, strict: 'ignore' });
  } catch {
    return `<code>${tex.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!)}</code>`;
  }
}

export function markdownToHtml(src: string): string {
  const math: string[] = [];
  const stash = (html: string) => `\u0000M${math.push(html) - 1}\u0000`;
  // protect code spans/blocks from math processing
  const code: string[] = [];
  let text = src.replace(/```[\s\S]*?```|`[^`\n]+`/g, (m) => `\u0000C${code.push(m) - 1}\u0000`);
  text = text
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => stash(renderMath(t.trim(), true)))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => stash(renderMath(t.trim(), true)))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => stash(renderMath(t.trim(), false)))
    .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$(?!\d)/g, (_, pre, t) => pre + stash(renderMath(t, false)));
  text = text.replace(/\u0000C(\d+)\u0000/g, (_, i) => code[Number(i)]);
  let html = marked.parse(text, { async: false, gfm: true, breaks: false }) as string;
  html = html.replace(/\u0000M(\d+)\u0000/g, (_, i) => math[Number(i)]);
  return DOMPurify.sanitize(html, SANITIZE);
}

// Model output and page-derived text are untrusted: allow only the Markdown subset and
// KaTeX's MathML. No images, forms, inputs, buttons, styles or SVG; links must be http(s).
const SANITIZE = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'kbd', 'sup', 'sub', 'span',
    'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext', 'mspace', 'msub', 'msup', 'msubsup',
    'mfrac', 'msqrt', 'mroot', 'mstyle', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'mpadded', 'mphantom', 'menclose',
  ],
  ALLOWED_ATTR: [
    'href', 'title', 'class', 'colspan', 'rowspan', 'align',
    'encoding', 'display', 'displaystyle', 'mathvariant', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'accent', 'accentunder',
    'width', 'height', 'depth', 'scriptlevel', 'columnalign', 'rowspacing', 'columnspacing', 'notation', 'linethickness', 'movablelimits', 'symmetric', 'minsize', 'maxsize',
  ],
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
};

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => markdownToHtml(text), [text]);
  return <div className={`mg-prose ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
