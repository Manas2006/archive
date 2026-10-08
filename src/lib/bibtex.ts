import type { Author } from './types';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'dos', 'das', 'du', 'la', 'le', 'ter', 'ten', 'bin', 'al', 'el',
]);
const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv']);

/** Split "First Middle van der Last Jr." into given / family parts. */
export function splitName(full: string): { given: string; family: string; suffix?: string } {
  const name = full.replace(/\s+/g, ' ').trim();
  if (name.includes(',')) {
    // Already "Last, First"
    const [family, ...rest] = name.split(',').map((s) => s.trim());
    return { family, given: rest.join(' ').trim() };
  }
  const parts = name.split(' ');
  if (parts.length === 1) return { given: '', family: parts[0] };
  let suffix: string | undefined;
  if (SUFFIXES.has(parts[parts.length - 1].toLowerCase())) suffix = parts.pop();
  // family starts at the first lowercase particle (after the first token), else the last token
  let start = parts.length - 1;
  for (let i = 1; i < parts.length - 1; i++) {
    if (PARTICLES.has(parts[i].toLowerCase()) && parts[i][0] === parts[i][0].toLowerCase()) {
      start = i;
      break;
    }
  }
  return { given: parts.slice(0, start).join(' '), family: parts.slice(start).join(' '), suffix };
}

export function toAuthor(full: string): Author {
  const { given, family } = splitName(full);
  return { name: full.replace(/\s+/g, ' ').trim(), given, family };
}

export function bibtexName(a: Author): string {
  const { given, family, suffix } = a.family !== undefined && a.given !== undefined
    ? { given: a.given, family: a.family, suffix: undefined as string | undefined }
    : splitName(a.name);
  const fam = escapeLatex(family);
  if (!given) return fam;
  return suffix ? `${fam}, ${escapeLatex(suffix)}, ${escapeLatex(given)}` : `${fam}, ${escapeLatex(given)}`;
}

// ---------------------------------------------------------------------------
// Citation keys
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  'a an the on of in for to and with without towards toward via is are do does can how what why when where which from by at as we our your beyond into using under over through not no its it this that these those be being'.split(
    ' ',
  ),
);

export function asciiFold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l');
}

function stripTex(s: string): string {
  return s.replace(/\$[^$]*\$/g, ' ').replace(/\\[a-zA-Z]+/g, ' ').replace(/[{}]/g, '');
}

/** Google-Scholar style key: lastname + year + first significant title word, e.g. vaswani2017attention. */
export function baseCiteKey(authors: Author[], year: number | null, title: string): string {
  const first = authors[0];
  const family = first ? (first.family ?? splitName(first.name).family) : 'anon';
  const last = asciiFold(family).toLowerCase().replace(/[^a-z]/g, '') || 'anon';
  const words = asciiFold(stripTex(title))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const word = words.find((w) => !STOPWORDS.has(w) && /[a-z]/.test(w)) ?? words[0] ?? 'paper';
  return `${last}${year ?? ''}${word}`;
}

/** Append a, b, c ... until the key is not taken. */
export function uniqueCiteKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 0; i < 26 * 27; i++) {
    const suffix = i < 26 ? String.fromCharCode(97 + i) : String.fromCharCode(97 + Math.floor(i / 26) - 1) + String.fromCharCode(97 + (i % 26));
    const k = base + suffix;
    if (!taken.has(k)) return k;
  }
  return `${base}${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Escaping and title protection
// ---------------------------------------------------------------------------

/** Escape LaTeX specials outside math. Leaves $...$ segments untouched. */
export function escapeLatex(s: string): string {
  return s
    .split(/(\$[^$]*\$)/)
    .map((seg, i) => {
      if (i % 2 === 1) return seg; // math
      return seg
        .replace(/\\(?![a-zA-Z{'"`^~=.])/g, '\\textbackslash{}')
        .replace(/([&%#_])/g, '\\$1')
        .replace(/(?<!\\)~/g, '\\textasciitilde{}')
        .replace(/(?<![\\$])\^/g, '\\textasciicircum{}');
    })
    .join('');
}

/**
 * Wrap words whose capitalization must survive a bibliography style in braces:
 * acronyms (LLM, GPT-4), mixed case (ImageNet, iPhone, RoBERTa), and words with digits+caps.
 */
export function protectTitle(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  return clean
    .split(/(\$[^$]*\$)/)
    .map((seg, i) => {
      if (i % 2 === 1) return seg;
      return seg.replace(/(?<![\\{\w])([A-Za-z0-9][\w'’-]*[A-Za-z0-9]|[A-Z])(?![\w}])/g, (word, _w, offset: number) => {
        if (needsProtection(word, offset === 0)) return `{${word}}`;
        return word;
      });
    })
    .join('');
}

function needsProtection(word: string, isFirst: boolean): boolean {
  if (/[-’']/.test(word)) {
    // judge hyphenated words part by part, so "Self-Supervised" stays unbraced but "GPT-4" is protected
    return word.split(/[-’']/).some((part, i) => part && needsProtectionPart(part, isFirst && i === 0));
  }
  return needsProtectionPart(word, isFirst);
}

function needsProtectionPart(word: string, isFirst: boolean): boolean {
  const letters = word.replace(/[^A-Za-z]/g, '');
  if (!letters) return false;
  const uppers = (word.match(/[A-Z]/g) ?? []).length;
  if (uppers === 0) return false;
  if (uppers >= 2) return true; // LLM, GPT-4, RoBERTa, ImageNet, BERT
  // single capital that is not the first character: iPhone, mAP
  if (!/^[A-Z]/.test(word)) return true;
  // single-letter capital words (e.g. "A" in "Model A") only matter mid-title
  if (word.length === 1 && !isFirst && word !== 'A') return true;
  // capital followed by digits: X2, T5
  if (/^[A-Z]\d/.test(word)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Serialize / parse
// ---------------------------------------------------------------------------

export interface BibEntry {
  type: string; // misc, inproceedings, article
  key: string;
  fields: [string, string][];
}

export function serializeBib(e: BibEntry): string {
  const width = Math.max(...e.fields.map(([k]) => k.length), 0);
  const lines = e.fields
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `  ${k.padEnd(width)} = {${v}},`);
  return `@${e.type}{${e.key},\n${lines.join('\n')}\n}`;
}

export function getField(e: BibEntry, name: string): string | undefined {
  return e.fields.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
}

export function setField(e: BibEntry, name: string, value: string | undefined): BibEntry {
  const fields = e.fields.filter(([k]) => k.toLowerCase() !== name.toLowerCase());
  if (value !== undefined && value !== '') {
    const idx = e.fields.findIndex(([k]) => k.toLowerCase() === name.toLowerCase());
    if (idx >= 0) fields.splice(Math.min(idx, fields.length), 0, [name, value]);
    else fields.push([name, value]);
  }
  return { ...e, fields };
}

/** Minimal BibTeX parser: handles braces, quotes, bare numbers/macros, and nested braces. */
export function parseBib(src: string): BibEntry[] {
  const out: BibEntry[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    const typeMatch = /^([A-Za-z]+)\s*[{(]/.exec(src.slice(i));
    if (!typeMatch) continue;
    const type = typeMatch[1].toLowerCase();
    i += typeMatch[0].length;
    if (type === 'comment' || type === 'preamble' || type === 'string') {
      // skip balanced block
      let depth = 1;
      while (i < n && depth > 0) {
        if (src[i] === '{' || src[i] === '(') depth++;
        else if (src[i] === '}' || src[i] === ')') depth--;
        i++;
      }
      continue;
    }
    const keyEnd = src.indexOf(',', i);
    if (keyEnd < 0) break;
    const key = src.slice(i, keyEnd).trim();
    i = keyEnd + 1;
    const fields: [string, string][] = [];
    while (i < n) {
      while (i < n && /[\s,]/.test(src[i])) i++;
      if (src[i] === '}' || src[i] === ')') {
        i++;
        break;
      }
      const nameMatch = /^([A-Za-z0-9_:.+-]+)\s*=\s*/.exec(src.slice(i));
      if (!nameMatch) {
        // malformed; skip to next line
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? n : nl + 1;
        continue;
      }
      const name = nameMatch[1].toLowerCase();
      i += nameMatch[0].length;
      let value = '';
      // value may be concatenation with #
      for (;;) {
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === '{') {
          let depth = 0;
          const start = i + 1;
          do {
            if (src[i] === '\\') {
              i += 2;
              continue;
            }
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          } while (i < n && depth > 0);
          value += src.slice(start, i - 1);
        } else if (src[i] === '"') {
          let depth = 0;
          const start = ++i;
          while (i < n && !(src[i] === '"' && depth === 0)) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            i++;
          }
          value += src.slice(start, i);
          i++;
        } else {
          const m = /^[^,}#\s]+/.exec(src.slice(i));
          if (m) {
            value += m[0];
            i += m[0].length;
          }
        }
        while (i < n && /\s/.test(src[i])) i++;
        if (src[i] === '#') {
          i++;
          continue;
        }
        break;
      }
      fields.push([name, value.replace(/\s+/g, ' ').trim()]);
    }
    out.push({ type, key, fields });
  }
  return out;
}

const FIELD_ORDER = [
  'title', 'author', 'editor', 'booktitle', 'journal', 'volume', 'number', 'pages', 'publisher', 'year', 'month',
  'eprint', 'archiveprefix', 'primaryclass', 'doi', 'url',
];
const DROP_FIELDS = new Set(['timestamp', 'biburl', 'bibsource', 'abstract', 'keywords', 'note_original']);

/** Re-key and tidy a BibTeX entry from another source (DBLP, OpenReview) into the house format. */
export function normalizeForeignBib(src: string, citeKey: string): string | null {
  const [entry] = parseBib(src);
  if (!entry) return null;
  let fields = entry.fields.filter(([k]) => !DROP_FIELDS.has(k));
  fields = fields.map(([k, v]) => {
    if (k === 'title') return [k, protectTitle(v.replace(/^\{(.*)\}$/s, '$1').replace(/[{}]/g, ''))];
    if (k === 'author' || k === 'editor') return [k, v.replace(/\s*\n\s*/g, ' ').replace(/\s+and\s+/g, ' and ')];
    return [k, v];
  });
  fields.sort((a, b) => {
    const ia = FIELD_ORDER.indexOf(a[0]);
    const ib = FIELD_ORDER.indexOf(b[0]);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  // canonical casing for a few fields
  fields = fields.map(([k, v]) => [k === 'archiveprefix' ? 'archivePrefix' : k === 'primaryclass' ? 'primaryClass' : k, v]);
  return serializeBib({ type: entry.type, key: citeKey, fields });
}

export interface ArxivBibInput {
  citeKey: string;
  title: string;
  authors: Author[];
  year: number | null;
  arxivId: string;
  primaryCategory?: string;
}

export function arxivBibtex(p: ArxivBibInput): string {
  return serializeBib({
    type: 'misc',
    key: p.citeKey,
    fields: [
      ['title', protectTitle(escapeLatex(p.title))],
      ['author', p.authors.map(bibtexName).join(' and ')],
      ['year', p.year ? String(p.year) : ''],
      ['eprint', p.arxivId],
      ['archivePrefix', 'arXiv'],
      ['primaryClass', p.primaryCategory ?? ''],
      ['url', `https://arxiv.org/abs/${p.arxivId}`],
    ],
  });
}

export interface GenericBibInput {
  citeKey: string;
  type: 'misc' | 'inproceedings' | 'article';
  title: string;
  authors: Author[];
  year: number | null;
  venue?: string | null;
  url?: string;
  doi?: string;
  note?: string;
}

export function genericBibtex(p: GenericBibInput): string {
  const venueField: [string, string] =
    p.type === 'inproceedings' ? ['booktitle', p.venue ?? ''] : p.type === 'article' ? ['journal', p.venue ?? ''] : ['howpublished', p.venue ?? ''];
  return serializeBib({
    type: p.type,
    key: p.citeKey,
    fields: [
      ['title', protectTitle(escapeLatex(p.title))],
      ['author', p.authors.map(bibtexName).join(' and ')],
      venueField,
      ['year', p.year ? String(p.year) : ''],
      ['doi', p.doi ?? ''],
      ['url', p.url ?? ''],
      ['note', p.note ?? ''],
    ],
  });
}

/** Replace the key of an existing entry string. */
export function rekey(bib: string, key: string): string {
  return bib.replace(/^(\s*@\w+\s*[{(])\s*[^,]*,/, `$1${key},`);
}
