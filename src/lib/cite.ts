// "Copy cite" helpers: turn citation keys into the command people paste into LaTeX or Markdown.

export const CITE_COMMANDS: { id: string; label: string }[] = [
  { id: '\\cite', label: '\\cite{key}' },
  { id: '\\citep', label: '\\citep{key} (natbib)' },
  { id: '\\citet', label: '\\citet{key} (natbib)' },
  { id: '\\autocite', label: '\\autocite{key} (biblatex)' },
  { id: '[@]', label: '[@key] (Markdown, Pandoc)' },
];

export function citeText(keys: string[], command = '\\cite'): string {
  const ks = [...new Set(keys.filter(Boolean))];
  if (!ks.length) return '';
  if (command === '[@]') return `[${ks.map((k) => `@${k}`).join('; ')}]`;
  return `${command}{${ks.join(',')}}`;
}
