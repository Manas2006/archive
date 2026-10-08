// Exports: lab factoid, BibTeX files, Markdown notes, W3C annotations.

import type { Annotation, HighlightLabel, LibraryEntry, Paper } from './types';
import { quoteOf } from './anchoring/text';

export interface FactoidDraft {
  problem: string[];
  method: string[];
  results: string[];
  interesting: string[];
  better: string[];
}

export const FACTOID_SECTIONS: { key: keyof FactoidDraft; title: string }[] = [
  { key: 'problem', title: 'Problem' },
  { key: 'method', title: 'Method' },
  { key: 'results', title: 'Results' },
  { key: 'interesting', title: 'What interested me' },
  { key: 'better', title: 'What could be better' },
];

export function labelOf(a: Annotation): HighlightLabel {
  return (a.body.find((b) => b.purpose === 'tagging')?.value as HighlightLabel) ?? 'plain';
}

export function noteOf(a: Annotation): string {
  return a.body.find((b) => b.purpose === 'commenting')?.value ?? '';
}

const clip = (s: string, n = 280) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Non-AI draft: the labeled highlights (and their notes) slotted into the template. */
export function factoidFromHighlights(annotations: Annotation[]): FactoidDraft {
  const d: FactoidDraft = { problem: [], method: [], results: [], interesting: [], better: [] };
  const slot: Record<HighlightLabel, keyof FactoidDraft | null> = {
    problem: 'problem',
    method: 'method',
    result: 'results',
    interesting: 'interesting',
    weakness: 'better',
    plain: null,
  };
  for (const a of annotations) {
    const q = quoteOf(a.target.selector);
    if (!q) continue;
    const key = slot[labelOf(a)];
    if (!key) continue;
    const note = noteOf(a);
    // for opinion sections the note is the point; for the others the quote is
    if ((key === 'interesting' || key === 'better') && note) d[key].push(`${note} ("${clip(q.exact, 160)}")`);
    else d[key].push(note ? `"${clip(q.exact)}" (${note})` : `"${clip(q.exact)}"`);
  }
  return d;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function paperLink(p: Paper): string {
  return p.urls.abs ?? p.urls.openreview ?? p.urls.html ?? p.urls.s2 ?? '';
}

export function factoidHtml(p: Paper, d: FactoidDraft, figure?: { src: string; caption?: string } | null): string {
  const link = paperLink(p);
  const parts = [`<p><b>Paper:</b> ${link ? `<a href="${esc(link)}">${esc(p.title)}</a>` : esc(p.title)}</p>`];
  for (const s of FACTOID_SECTIONS) {
    const items = d[s.key];
    if (!items.length) continue;
    parts.push(`<p><b>${s.title}</b></p><ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`);
  }
  if (figure?.src) {
    parts.push(`<p><img src="${esc(figure.src)}" alt="Figure from ${esc(p.title)}" style="max-width:520px"></p>`);
    if (figure.caption) parts.push(`<p><i>${esc(figure.caption)}</i></p>`);
  }
  return parts.join('\n');
}

export function factoidText(p: Paper, d: FactoidDraft): string {
  const link = paperLink(p);
  const lines = [`Paper: ${p.title}${link ? ` (${link})` : ''}`];
  for (const s of FACTOID_SECTIONS) {
    if (!d[s.key].length) continue;
    lines.push('', s.title, ...d[s.key].map((i) => `- ${i}`));
  }
  return lines.join('\n');
}

export async function copyRich(html: string, text: string): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return;
    } catch {
      /* fall through */
    }
  }
  await navigator.clipboard.writeText(text);
}

export function bibFile(papers: Paper[]): string {
  return papers
    .slice()
    .sort((a, b) => a.citeKey.localeCompare(b.citeKey))
    .map((p) => p.bibtex.trim())
    .join('\n\n') + '\n';
}

const LABEL_NAMES: Record<HighlightLabel, string> = {
  plain: 'Highlight',
  problem: 'Problem',
  method: 'Method',
  result: 'Result',
  interesting: 'Interesting',
  weakness: 'Weakness',
};

export function notesMarkdown(p: Paper, annotations: Annotation[], entry?: LibraryEntry | null): string {
  const authors = p.authors.map((a) => a.name).join(', ');
  const lines: string[] = [`# ${p.title}`, '', `${authors}${p.year ? ` (${p.year})` : ''}${p.venue ? `. ${p.venue}` : ''}`, ''];
  const link = paperLink(p);
  if (link) lines.push(`Link: ${link}`);
  lines.push(`Cite key: \`${p.citeKey}\``);
  if (entry) lines.push(`Status: ${entry.status}${entry.willCite ? ' (will cite)' : ''}`);
  if (p.extracted) {
    const x = p.extracted;
    lines.push('', '## At a glance');
    if (x.task) lines.push(`- Task: ${x.task}`);
    if (x.benchmarks.length) lines.push(`- Benchmarks: ${x.benchmarks.join(', ')}`);
    if (x.models.length) lines.push(`- Models: ${x.models.join(', ')}`);
    if (x.metrics.length) lines.push(`- Metrics: ${x.metrics.join(', ')}`);
    if (x.headlineResult) lines.push(`- Headline result: ${x.headlineResult}`);
  }
  const paperNotes = annotations.filter((a) => !a.target.selector).map(noteOf).filter(Boolean);
  if (paperNotes.length) lines.push('', '## Notes', '', ...paperNotes);
  const hls = annotations.filter((a) => a.target.selector);
  if (hls.length) {
    lines.push('', '## Highlights');
    for (const a of hls) {
      const q = quoteOf(a.target.selector);
      lines.push('', `**${LABEL_NAMES[labelOf(a)]}**`, '', `> ${(q?.exact ?? '').replace(/\s+/g, ' ').trim()}`);
      const n = noteOf(a);
      if (n) lines.push('', n);
    }
  }
  lines.push('', '## BibTeX', '', '```bibtex', p.bibtex, '```', '');
  return lines.join('\n');
}

/** Annotations as a W3C Web Annotation collection (JSON-LD). */
export function annotationsJsonLd(annotations: Annotation[], papers: Map<string, Paper>) {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'AnnotationCollection',
    total: annotations.length,
    first: {
      type: 'AnnotationPage',
      items: annotations.map((a) => {
        const p = papers.get(a.paperId);
        return {
          id: a.id,
          type: 'Annotation',
          motivation: a.motivation,
          created: a.createdAt,
          modified: a.updatedAt,
          creator: { id: `urn:marginalia:user:${a.creator.id}`, type: 'Person', name: a.creator.name },
          body: a.body,
          target: {
            source: p ? paperLink(p) || a.target.source : a.target.source,
            ...(a.target.selector ? { selector: a.target.selector } : {}),
            ...(a.target.state ? { state: a.target.state } : {}),
          },
        };
      }),
    },
  };
}

export function download(filename: string, content: string, mime = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
