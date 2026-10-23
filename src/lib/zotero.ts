// Reference manager import and export (Zotero, Mendeley, EndNote, Paperpile).
// Parsers turn BibTeX, RIS and CSL JSON into ImportedRef records; importRefs
// files them into the library without duplicating papers or notes; toRis and
// toCslJson write papers back out in the shapes Zotero reads best.

import { quoteOf } from './anchoring/text';
import { arxivBibtex, asciiFold, baseCiteKey, genericBibtex, getField, parseBib, rekey, splitName, toAuthor, uniqueCiteKey, type BibEntry } from './bibtex';
import { labelOf, noteOf, paperLink } from './exports';
import { arxivUrls, normalizeDoi, openreviewUrls, parseArxivId, parsePaperUrl } from './ids';
import * as repo from './repo';
import { HIGHLIGHT_LABELS, type Annotation, type Author, type LibraryEntry, type Paper, type Project } from './types';
import { shortVenue } from './venue';

export type RefKind = 'preprint' | 'conference' | 'journal' | 'other';
export type ImportFormat = 'bibtex' | 'ris' | 'csljson';

/** One reference read from a BibTeX, RIS or CSL JSON file. */
export interface ImportedRef {
  title: string;
  authors: Author[];
  year: number | null;
  abstract: string;
  doi?: string; // normalized: lowercase, no resolver prefix
  arxivId?: string; // without version
  url?: string;
  venue?: string | null; // journal or conference as written in the file; null for preprints
  bibtex?: string; // the original entry, when the file was BibTeX
  notes: string[]; // plain text or Markdown
  tags: string[];
  kind?: RefKind;
  published?: string | null; // 'YYYY-MM-DD' or 'YYYY-MM' when the file has more than a year
  pdfUrl?: string;
  key?: string; // citation key or record id in the file
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const collapse = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const stripBom = (s: string) => s.replace(/^\uFEFF/, '');
const stripTags = (s: string) => s.replace(/<[^>]*>/g, '');
const isHttp = (s: string | null | undefined): s is string => !!s && /^https?:\/\//i.test(s.trim());
const isAuthor = (a: Author | null): a is Author => !!a;

/** Keep the first spelling of each tag, compared case-insensitively. */
function mergeTags(base: string[], extra: string[]): string[] {
  const seen = new Set(base.map((t) => t.toLowerCase()));
  const out = [...base];
  for (const raw of extra) {
    const t = collapse(raw);
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', shy: '',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '“', rdquo: '”',
  laquo: '\u00AB', raquo: '\u00BB', middot: '\u00B7', bull: '\u2022', deg: '\u00B0', times: '\u00D7', minus: '\u2212',
  plusmn: '\u00B1', copy: '\u00A9', reg: '\u00AE', trade: '\u2122',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Tidy whitespace line by line and keep paragraph breaks. */
function tidyNote(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00A0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * HTML note (Zotero stores notes as HTML) to plain text with light Markdown:
 * paragraphs and line breaks survive, headings, lists, bold, italics and links
 * become Markdown, every other tag is dropped and entities are decoded.
 */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ') // source whitespace is not significant in HTML
    .replace(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, _q, href: string, inner: string) => {
      const text = decodeEntities(stripTags(inner)).trim();
      const url = decodeEntities(href.trim());
      return !text || text === url ? url : `[${text}](${url})`;
    })
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => (inner.trim() ? `**${inner.trim()}**` : ''))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, (_m, _t, inner: string) => (inner.trim() ? `*${inner.trim()}*` : ''))
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, inner: string) => `\`${inner}\``)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<blockquote\b[^>]*>\s*(?:<p\b[^>]*>)?/gi, '\n\n> ')
    .replace(/<\/?(p|div|h[1-6]|ul|ol|blockquote|pre|table|thead|tbody|tr|section|article|header|footer|hr)\b[^>]*>/gi, '\n\n')
    .replace(/<\/(td|th)\s*>/gi, ' ');
  return tidyNote(decodeEntities(stripTags(s)));
}

function noteText(v: string): string {
  return /<\/?[a-z][a-z0-9]*\b[^>]*>/i.test(v) ? htmlToText(v) : tidyNote(v);
}

// LaTeX to Unicode, for BibTeX values.
const ACCENTS: Record<string, string> = {
  '`': '\u0300', "'": '\u0301', '^': '\u0302', '~': '\u0303', '=': '\u0304', '.': '\u0307', '"': '\u0308',
  u: '\u0306', v: '\u030C', H: '\u030B', c: '\u0327', k: '\u0328', r: '\u030A', d: '\u0323', b: '\u0331',
};
// Private-use placeholders for literal characters that later steps would otherwise rewrite.
const LBRACE = '\uE000';
const RBRACE = '\uE001';
const DOLLAR = '\uE002';
const TILDE = '\uE003';
const BACKSLASH = '\uE004';
const TEX_SYMBOLS: Record<string, string> = {
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ',
  textendash: '\u2013', textemdash: '\u2014', textquoteleft: '\u2018', textquoteright: '\u2019',
  textquotedblleft: '“', textquotedblright: '”', ldots: '\u2026', dots: '\u2026', textellipsis: '\u2026',
  textasciitilde: TILDE, textasciicircum: '^', textbackslash: BACKSLASH, textunderscore: '_', textbar: '|',
  textless: '<', textgreater: '>', textbraceleft: LBRACE, textbraceright: RBRACE, textregistered: '\u00AE',
  texttrademark: '\u2122', textcopyright: '\u00A9', LaTeX: 'LaTeX', TeX: 'TeX', BibTeX: 'BibTeX',
};
const TEX_WRAPPERS =
  /\\(?:textbf|textit|textsl|textsc|textrm|textsf|texttt|textup|textmd|textnormal|emph|mbox|hbox|text|url|nolinkurl|uppercase|lowercase|MakeUppercase|MakeLowercase)\s*(?=\{)/g;
const accent = (acc: string, a?: string, b?: string) => `${a ?? b ?? ''}${ACCENTS[acc]}`.normalize('NFC');

function unLatexText(s: string): string {
  return s
    .replace(/\\\\/g, ' ')
    .replace(/\\~\{\}/g, TILDE)
    .replace(/\\href\s*\{[^{}]*\}\s*/g, '')
    .replace(TEX_WRAPPERS, '')
    .replace(/\\([`'^"~=.])\s*(?:\{\s*\\?([A-Za-z])\s*\}|\\?([A-Za-z]))/g, (_m, acc: string, a?: string, b?: string) => accent(acc, a, b))
    .replace(/\\([uvHckrdb])(?:\s*\{\s*\\?([A-Za-z])\s*\}|\s+([A-Za-z]))/g, (_m, acc: string, a?: string, b?: string) => accent(acc, a, b))
    .replace(/\\([A-Za-z]+)(?![A-Za-z])(?:\{\}|\s+)?/g, (m, name: string) => TEX_SYMBOLS[name] ?? m)
    .replace(/\\([&%#_])/g, '$1')
    .replace(/\\\{/g, LBRACE)
    .replace(/\\\}/g, RBRACE)
    .replace(/\\[ ,;:!]/g, ' ')
    .replace(/\\-/g, '')
    .replace(/---/g, '\u2014')
    .replace(/--/g, '\u2013')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/~/g, ' ')
    .replace(/[{}]/g, '');
}

/** BibTeX value to plain text: accents, escaped specials, braces and common text commands. Math ($...$) is kept as is. */
export function unLatex(s: string): string {
  if (!s) return '';
  return s
    .replace(/\\\$/g, DOLLAR)
    .split(/(\$[^$]*\$)/)
    .map((seg, i) => (i % 2 ? seg : unLatexText(seg)))
    .join('')
    .replace(new RegExp(LBRACE, 'g'), '{')
    .replace(new RegExp(RBRACE, 'g'), '}')
    .replace(new RegExp(DOLLAR, 'g'), '$')
    .replace(new RegExp(TILDE, 'g'), '~')
    .replace(new RegExp(BACKSLASH, 'g'), '\\')
    .replace(/\s+/g, ' ')
    .trim();
}

/** URL and DOI fields: undo LaTeX escapes only. */
const unescapeTex = (s: string | undefined) => s?.replace(/\\([_%&#$~])/g, '$1').replace(/[{}]/g, '').trim() || undefined;

// ---------------------------------------------------------------------------
// Names and dates
// ---------------------------------------------------------------------------

const SUFFIX = /^(jr|sr|ii|iii|iv)\.?$/i;

/** "Family, Given", "Family, Given, Jr." (RIS), "Family, Jr., Given" (BibTeX) or "Given Family". */
function personName(raw: string): Author | null {
  const s = collapse(raw).replace(/^[,;\s]+|[,;\s]+$/g, '');
  if (!s) return null;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return toAuthor(s);
  let suffix = '';
  const rest = parts.slice(1).filter((p) => {
    if (suffix || !SUFFIX.test(p)) return true;
    suffix = p;
    return false;
  });
  const { given, family } = splitName(`${parts[0]}, ${rest.join(' ')}`);
  return { name: `${[given, family].filter(Boolean).join(' ')}${suffix ? ` ${suffix}` : ''}`, given, family };
}

/** An organization or any name that must not be split. */
const literalAuthor = (name: string): Author => ({ name, given: '', family: name });

interface DateInfo {
  year: number | null;
  published: string | null;
}

function dateFromParts(y: number, m?: number, d?: number): DateInfo {
  if (!Number.isFinite(y) || y < 1000 || y > 2999) return { year: null, published: null };
  const pad = (n: number) => String(n).padStart(2, '0');
  const month = m && m >= 1 && m <= 12 ? m : undefined; // CSL seasons (21-24) and junk are dropped
  const day = month && d && d >= 1 && d <= 31 ? d : undefined;
  return { year: y, published: month ? `${y}-${pad(month)}${day ? `-${pad(day)}` : ''}` : null };
}

/** "2023/01/10/", "2021/08//", "2023-01-10", "Spring 2021". */
function dateFromText(text: string | null | undefined): DateInfo {
  const m = text ? /(\d{4})(?:[-/.](\d{1,2})?(?:[-/.](\d{1,2}))?)?/.exec(text) : null;
  if (!m) return { year: null, published: null };
  return dateFromParts(Number(m[1]), m[2] ? Number(m[2]) : undefined, m[3] ? Number(m[3]) : undefined);
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

const ARXIV_TOKEN = String.raw`((?:\d{4}\.\d{4,5}|[a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)`;
const ARXIV_DOI = new RegExp(String.raw`10\.48550\/arxiv\.` + ARXIV_TOKEN, 'i');
const ARXIV_URL = new RegExp(String.raw`arxiv\.org\/(?:abs|pdf|html|format)\/` + ARXIV_TOKEN, 'i');
const ARXIV_TEXT = new RegExp(String.raw`\barxiv(?:\s+preprint)?(?:\s+arxiv)?\s*[:.]?\s*(?:abs\/)?` + ARXIV_TOKEN, 'i');
const ARXIV_BARE = new RegExp(String.raw`^(?:arxiv:\s*)?` + ARXIV_TOKEN + '$', 'i');
const ARXIV_NEW_BARE = /^\d{4}\.\d{4,5}(?:v\d+)?$/;
const CORR_VOLUME = new RegExp(String.raw`^abs\/` + ARXIV_TOKEN + '$', 'i');

const arxivToken = (token: string) => parseArxivId(token)?.id ?? token.replace(/v\d+$/i, '');

function bareArxivId(v: string | null | undefined): string | undefined {
  const m = v ? ARXIV_BARE.exec(v.trim()) : null;
  return m ? arxivToken(m[1]) : undefined;
}

/**
 * The arXiv id (without version) in the first value that names one: an arXiv DOI
 * (10.48550/arXiv.2401.12345), an arxiv.org URL, or text such as "arXiv:2401.12345"
 * and "arXiv preprint arXiv:2401.12345". Bare numbers are not trusted.
 */
export function findArxivId(...values: (string | null | undefined)[]): string | undefined {
  for (const v of values) {
    if (!v) continue;
    const m = ARXIV_DOI.exec(v) ?? ARXIV_URL.exec(v) ?? ARXIV_TEXT.exec(v);
    if (m) return arxivToken(m[1]);
  }
  return undefined;
}

/** A DOI from a DOI field, a doi.org URL or "doi:" text; undefined if it doesn't look like one. */
function cleanDoi(v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const m = /(?:^|doi\.org\/|doi:\s*)(10\.\d{4,9}\/[^\s"<>]+)/i.exec(v.trim());
  return m ? normalizeDoi(m[1].replace(/[.,;]+$/, '')) : undefined;
}

const isArxivDoi = (doi: string) => /^10\.48550\/arxiv\./i.test(doi);

/** Venue strings that mean "not published yet". */
function isPreprintVenue(v: string | null | undefined): boolean {
  return !!v && (/\b(arxiv|biorxiv|medrxiv|chemrxiv|ssrn|research square|preprints?|openreview)\b/i.test(v) || /^corr\b/i.test(v.trim()));
}

const CONF_RE =
  /\b(conference|proceedings|workshop|symposium|meeting|congress|neurips|nips|iclr|icml|colm|acl|emnlp|naacl|eacl|coling|cvpr|iccv|eccv|wacv|bmvc|aaai|ijcai|aistats|uai|corl|kdd|www|sigir|wsdm|cikm|recsys|ccs|usenix|ndss|icse|fse|ase|chi|uist|rss|icra|iros|interspeech|icassp|miccai|siggraph)\b|security and privacy/i;

/** Conference names and abbreviations are recognized; any other venue is treated as a journal. */
const kindFromVenue = (v: string): RefKind => (CONF_RE.test(v) ? 'conference' : 'journal');

// ---------------------------------------------------------------------------
// RIS
// ---------------------------------------------------------------------------

const RIS_TAG = /^([A-Z][A-Z0-9]) {1,2}-(?: (.*))?$/;
// Continuation lines of these tags keep their line breaks (notes, abstracts, one keyword or link per line).
const RIS_KEEP_LINES = new Set(['AB', 'N1', 'N2', 'RN', 'KW', 'UR', 'L1', 'L2', 'L3', 'L4']);
const RIS_KINDS: Record<string, RefKind> = { JOUR: 'journal', EJOUR: 'journal', JFULL: 'journal', MGZN: 'journal', CONF: 'conference', CPAPER: 'conference' };

type RisRecord = [string, string][];

function readRis(text: string): RisRecord[] {
  const records: RisRecord[] = [];
  let cur: RisRecord = [];
  let last: [string, string] | null = null;
  for (const raw of stripBom(text).split(/\r\n?|\n/)) {
    const line = raw.trimEnd();
    const m = RIS_TAG.exec(line);
    if (!m) {
      if (!last) continue; // stray text outside a record
      const t = line.trim();
      if (RIS_KEEP_LINES.has(last[0])) last[1] += `\n${t}`;
      else if (t) last[1] = last[1] ? `${last[1]} ${t}` : t;
      continue;
    }
    const tag = m[1];
    if (tag === 'TY' || tag === 'ER') {
      // a TY without the previous ER also starts a new record
      if (cur.length) records.push(cur);
      cur = [];
      last = null;
      if (tag === 'ER') continue;
    }
    last = [tag, (m[2] ?? '').trim()];
    cur.push(last);
  }
  if (cur.length) records.push(cur);
  return records;
}

function risToRef(rec: RisRecord): ImportedRef {
  const all = (...tags: string[]) => rec.filter(([t]) => tags.includes(t)).map(([, v]) => v.trim()).filter(Boolean);
  const first = (...tags: string[]) => tags.map((t) => all(t)[0]).find(Boolean);
  const each = (...tags: string[]) => all(...tags).flatMap((v) => v.split('\n')).map((v) => v.trim()).filter(Boolean);

  const ty = (first('TY') ?? '').toUpperCase();
  const title = collapse(first('TI', 'T1', 'CT') ?? (ty === 'BOOK' ? first('BT') : undefined));
  const py = dateFromText(first('PY', 'Y1', 'DA'));
  const da = dateFromText(first('DA', 'Y1'));
  const urls = each('UR').filter(isHttp);
  const files = each('L1').filter(isHttp);
  const pdfUrl = files[0] ?? urls.find((u) => /\.pdf($|[?#])|\/pdf\//i.test(u));
  const doi = cleanDoi(first('DO')) ?? cleanDoi(first('M3')) ?? urls.map(cleanDoi).find(Boolean);
  const conf = ty === 'CONF' || ty === 'CPAPER';
  const venueRaw = conf ? first('T2', 'C3', 'BT', 'JO', 'JF') : first('T2', 'JF', 'JO', 'JA', 'BT', 'C3');
  const venue = venueRaw && !isPreprintVenue(venueRaw) ? collapse(venueRaw) : null;
  const arxivId = findArxivId(first('DO'), ...urls, ...each('L1', 'L2', 'L3', 'L4'), venueRaw, first('JO'), first('JF'), first('M1'), first('M3'), first('SN'), first('AN'));
  let kind: RefKind = RIS_KINDS[ty] ?? 'other';
  if (!venue && (arxivId || isPreprintVenue(venueRaw) || isPreprintVenue(first('PB')) || isPreprintVenue(first('DP')))) kind = 'preprint';
  else if (kind === 'other' && venue) kind = kindFromVenue(venue);
  return {
    title,
    authors: each('AU', 'A1').map(personName).filter(isAuthor),
    year: py.year ?? da.year,
    published: da.published ?? py.published,
    abstract: collapse(first('AB', 'N2')),
    doi,
    arxivId,
    url: urls.find((u) => u !== pdfUrl) ?? urls[0],
    pdfUrl,
    venue,
    kind,
    // EndNote sometimes repeats the title as a note
    notes: all('N1', 'RN').map(noteText).filter((n) => n && n !== title),
    tags: mergeTags([], each('KW')),
    key: first('ID'),
  };
}

/** Parse an RIS file (Zotero, Mendeley, EndNote, Paperpile exports). */
export function parseRis(text: string): ImportedRef[] {
  return readRis(text).map(risToRef);
}

// ---------------------------------------------------------------------------
// CSL JSON
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const BACKUP_FORMATS = ['archive-backup', 'marginalia-backup', 'scribe-backup'];

function str(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return str(v[0]);
  return undefined;
}

function cslName(n: unknown): Author | null {
  if (!n || typeof n !== 'object') return null;
  const o = n as Json;
  const s = (k: string) => str(o[k]) ?? '';
  if (s('literal') && !s('family')) return literalAuthor(collapse(s('literal')));
  const family = collapse(`${s('non-dropping-particle')} ${s('family')}`);
  const given = collapse(`${s('given')} ${s('dropping-particle')}`);
  if (!family && !given) return null;
  const suffix = s('suffix');
  return { name: `${[given, family].filter(Boolean).join(' ')}${suffix ? ` ${suffix}` : ''}`, given, family: family || given };
}

function cslDate(v: unknown): DateInfo {
  if (typeof v === 'string' || typeof v === 'number') return dateFromText(String(v));
  const o = (Array.isArray(v) ? v[0] : v) as Json | undefined;
  if (!o || typeof o !== 'object') return { year: null, published: null };
  const parts = o['date-parts'];
  if (Array.isArray(parts) && Array.isArray(parts[0])) {
    const [y, m, d] = (parts[0] as unknown[]).map(Number);
    return dateFromParts(y, m, d);
  }
  if ('year' in o) return dateFromParts(Number(o.year), Number(o.month), Number(o.day));
  return dateFromText(str(o.raw) ?? str(o.literal));
}

function cslToRef(o: Json): ImportedRef {
  const type = str(o.type) ?? '';
  const doi = cleanDoi(str(o.DOI) ?? str(o.doi));
  const url = str(o.URL) ?? str(o.url);
  const container = str(o['container-title']);
  const event = str(o['event-title']) ?? str(o.event);
  const publisher = str(o.publisher);
  const number = str(o.number);
  const arxivId =
    findArxivId(doi, url, number, str(o.note), container, str(o.archive_location)) ??
    (isPreprintVenue(publisher) || isPreprintVenue(str(o.archive)) ? bareArxivId(number) ?? bareArxivId(str(o.archive_location)) : undefined);
  const venueRaw = type === 'paper-conference' ? container ?? event : type === 'article' ? container : container ?? event;
  const venue = venueRaw && !isPreprintVenue(venueRaw) ? collapse(venueRaw) : null;
  let kind: RefKind = type === 'article-journal' ? 'journal' : type === 'paper-conference' ? 'conference' : 'other';
  // CSL "article" is what Zotero writes for its Preprint item
  if (!venue && (arxivId || type === 'article' || isPreprintVenue(publisher) || isPreprintVenue(venueRaw))) kind = 'preprint';
  else if (kind === 'other' && venue) kind = kindFromVenue(venue);
  const { year, published } = cslDate(o.issued);
  const id = str(o.id);
  const key = str(o['citation-key']) ?? (id && /^[A-Za-z][\w:.+-]*$/.test(id) ? id : undefined);
  return {
    title: collapse(decodeEntities(stripTags(str(o.title) ?? ''))),
    authors: (Array.isArray(o.author) ? o.author : []).map(cslName).filter(isAuthor),
    year,
    published,
    abstract: collapse(str(o.abstract)),
    doi,
    arxivId,
    url,
    pdfUrl: url && /\.pdf($|[?#])/i.test(url) ? url : undefined,
    venue,
    kind,
    notes: [], // CSL "note" is Zotero's Extra field, not the user's notes
    tags: mergeTags([], (str(o.keyword) ?? '').split(/\s*[,;]\s*/)),
    key,
  };
}

/** Parse a CSL JSON export (Zotero, Better BibTeX, Paperpile, citation.js). */
export function parseCslJson(text: string): ImportedRef[] {
  let data: unknown;
  try {
    data = JSON.parse(stripBom(text));
  } catch {
    return [];
  }
  if (data && typeof data === 'object' && !Array.isArray(data) && BACKUP_FORMATS.includes(String((data as Json).format))) {
    throw new Error('This is an Archive backup. Restore it with Import backup in Settings.');
  }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? (Array.isArray((data as Json).items) ? ((data as Json).items as unknown[]) : [data]) : [];
  return list
    .filter((x): x is Json => !!x && typeof x === 'object' && !Array.isArray(x) && ('title' in x || 'type' in x))
    .map(cslToRef);
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function monthNum(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isInteger(n)) return n;
  const i = MONTHS.indexOf(v.trim().slice(0, 3).toLowerCase());
  return i >= 0 ? i + 1 : undefined;
}

/** Raw text of each entry (comments, strings and preambles left out). */
function splitBibEntries(src: string): string[] {
  const out: string[] = [];
  const re = /@([A-Za-z]+)\s*([{(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const paren = m[2] === '(';
    let depth = 0;
    let end = src.length - 1;
    for (let i = m.index + m[0].length; i < src.length; i++) {
      const c = src[i];
      if (c === '\\') i++;
      else if (c === '{') depth++;
      else if (c === '}' && depth === 0 && !paren) {
        end = i;
        break;
      } else if (c === '}') depth--;
      else if (c === ')' && depth === 0 && paren) {
        end = i;
        break;
      }
    }
    if (!['comment', 'string', 'preamble'].includes(m[1].toLowerCase())) out.push(src.slice(m.index, end + 1));
    re.lastIndex = end + 1;
  }
  return out;
}

/** Split an author field on "and" outside braces. */
function splitBibNames(s: string): string[] {
  const out: string[] = [];
  const and = /\s+and\s+/iy;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (depth === 0 && /\s/.test(s[i])) {
      and.lastIndex = i;
      const m = and.exec(s);
      if (m) {
        out.push(s.slice(start, i));
        start = i + m[0].length;
        i = start - 1;
      }
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

function bibName(raw: string): Author | null {
  if (!raw || /^others$/i.test(raw)) return null;
  // {OpenAI}, {Google DeepMind}: one name, never split
  if (/^\{[^{}]*\}$/.test(raw)) return literalAuthor(unLatex(raw));
  return personName(unLatex(raw));
}

function bibToRef(e: BibEntry, raw: string): ImportedRef {
  const f = (...names: string[]) => names.map((n) => getField(e, n)?.trim()).find(Boolean);
  const many = (...names: string[]) => e.fields.filter(([k]) => names.includes(k)).map(([, v]) => v);
  const type = e.type;
  const date = dateFromText(f('date'));
  const year = dateFromText(f('year')).year ?? date.year;
  const month = monthNum(f('month'));
  const howpublished = f('howpublished');
  const howUrl = howpublished ? /\\url\{([^}]+)\}/.exec(howpublished)?.[1] ?? (isHttp(howpublished) ? howpublished : undefined) : undefined;
  const url = unescapeTex(f('url') ?? howUrl);
  const doi = cleanDoi(unescapeTex(f('doi')));
  const prefix = (f('archiveprefix', 'eprinttype') ?? '').toLowerCase();
  const eprint = f('eprint');
  const journal = unLatex(f('journal', 'journaltitle') ?? '');
  const arxivId =
    (eprint && (prefix.includes('arxiv') || (!prefix && ARXIV_NEW_BARE.test(eprint))) ? bareArxivId(eprint) : undefined) ??
    bareArxivId(f('arxivid')) ?? // Mendeley
    findArxivId(doi, url, journal, f('note'), f('number'), howpublished, f('booktitle'), eprint) ??
    (/^corr$/i.test(journal) ? CORR_VOLUME.exec(f('volume') ?? '')?.[1] : undefined); // DBLP: journal = {CoRR}, volume = {abs/2401.12345}
  const confType = ['inproceedings', 'conference', 'proceedings'].includes(type);
  const booktitle = unLatex(f('booktitle') ?? '');
  const venueRaw = (confType ? booktitle || journal : journal || booktitle) || (howpublished && !howUrl ? unLatex(howpublished) : '') || null;
  const venue = venueRaw && !isPreprintVenue(venueRaw) ? venueRaw : null;
  let kind: RefKind = confType ? 'conference' : type === 'article' ? 'journal' : 'other';
  if (!venue && (arxivId || isPreprintVenue(venueRaw))) kind = 'preprint';
  else if (kind === 'other' && venue) kind = kindFromVenue(venue);
  return {
    title: unLatex(f('title') ?? ''),
    authors: splitBibNames(f('author') ?? f('editor') ?? '').map(bibName).filter(isAuthor),
    year,
    published: date.published ?? (year && month ? dateFromParts(year, month).published : null),
    abstract: unLatex(f('abstract') ?? ''),
    doi,
    arxivId: arxivId ? arxivToken(arxivId) : undefined,
    url: isHttp(url) ? url : undefined,
    pdfUrl: isHttp(url) && /\.pdf($|[?#])/i.test(url) ? url : undefined,
    venue,
    kind,
    bibtex: raw.trim(),
    notes: many('annote', 'annotation', 'comment').map((v) => noteText(unLatex(v))).filter(Boolean),
    tags: mergeTags([], [f('keywords'), f('mendeley-tags')].flatMap((v) => (v ? v.split(/\s*[,;]\s*/) : [])).map(unLatex)),
    key: e.key || undefined,
  };
}

/** Parse a BibTeX or BibLaTeX file. Each ref keeps its original entry in `bibtex`. */
export function parseBibtexRefs(text: string): ImportedRef[] {
  return splitBibEntries(stripBom(text).replace(/\r\n?/g, '\n')).flatMap((raw) => {
    const [e] = parseBib(raw);
    return e ? [bibToRef(e, raw)] : [];
  });
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

function sniffFormat(text: string): ImportFormat | null {
  const s = stripBom(text).trimStart();
  if (!s) return null;
  if (s[0] === '[' || s[0] === '{') return 'csljson';
  if (/^TY {1,2}-/m.test(s)) return 'ris';
  if (/^\s*@[A-Za-z]+\s*[{(]/m.test(s)) return 'bibtex';
  return null;
}

/** What a file holds. The content wins over the extension, so a mislabeled file still parses. */
export function detectImportFormat(filename: string, text: string): ImportFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase() ?? '';
  const byExt: ImportFormat | null = ['bib', 'bibtex', 'biblatex'].includes(ext) ? 'bibtex' : ext === 'ris' ? 'ris' : ['json', 'csljson'].includes(ext) ? 'csljson' : null;
  return sniffFormat(text) ?? byExt;
}

/** Parse any supported file. Returns [] when the format is unknown. */
export function parseImport(filename: string, text: string): ImportedRef[] {
  switch (detectImportFormat(filename, text)) {
    case 'bibtex':
      return parseBibtexRefs(text);
    case 'ris':
      return parseRis(text);
    case 'csljson':
      return parseCslJson(text);
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Import into the library
// ---------------------------------------------------------------------------

export interface ImportResult {
  added: number;
  updated: number;
  skipped: number;
  paperIds: string[];
}

interface RefIdentity {
  id: string;
  arxivId?: string;
  doi?: string;
  openreviewId?: string;
  /** Every id this ref may already be stored under, canonical first. */
  lookup: string[];
}

/** cyrb53: a small, stable 53-bit string hash. */
function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const titleKey = (t: string) => asciiFold(t).toLowerCase().replace(/[^a-z0-9]+/g, '');
const familyKey = (authors: Author[]) => {
  const a = authors[0];
  return a ? asciiFold(a.family ?? splitName(a.name).family).toLowerCase().replace(/[^a-z]/g, '') : '';
};

function refIdentity(ref: ImportedRef): RefIdentity {
  const arxivId = ref.arxivId ? arxivToken(ref.arxivId.replace(/^arxiv:/i, '')) : findArxivId(ref.doi, ref.url, ref.pdfUrl);
  const doi = ref.doi && !isArxivDoi(ref.doi) ? normalizeDoi(ref.doi) : undefined;
  const openreviewId = [ref.url, ref.pdfUrl].map((u) => (u ? parsePaperUrl(u)?.openreviewId : undefined)).find(Boolean);
  const id = arxivId ? `arxiv:${arxivId}` : doi ? `doi:${doi}` : `ref:${hash53(`${titleKey(ref.title)}|${ref.year ?? ''}`)}`;
  const lookup = [id, arxivId && `arxiv:${arxivId}`, doi && `doi:${doi}`, openreviewId && `openreview:${openreviewId}`].filter((x): x is string => !!x);
  return { id, arxivId, doi, openreviewId, lookup: [...new Set(lookup)] };
}

async function findPaper(ids: string[]): Promise<Paper | undefined> {
  for (const id of ids) {
    const p = await repo.getPaper(id);
    if (p) return p;
  }
  return undefined;
}

type TitleIndex = Map<string, Paper[]>;

function indexPaper(index: TitleIndex, p: Paper) {
  const k = titleKey(p.title);
  if (k) index.set(k, [...(index.get(k) ?? []), p]);
}

async function buildTitleIndex(): Promise<TitleIndex> {
  const index: TitleIndex = new Map();
  for (const p of await repo.listPapers()) indexPaper(index, p);
  return index;
}

/**
 * Same paper under another id (the arXiv version of a conference paper, an entry with no ids):
 * identical title, years at most one apart, same first author, and no conflicting arXiv id or DOI.
 */
function matchByTitle(index: TitleIndex, ref: ImportedRef, ids: RefIdentity): Paper | undefined {
  const k = titleKey(ref.title);
  if (k.length < 12) return undefined; // too generic to trust
  const fam = familyKey(ref.authors);
  return index.get(k)?.find(
    (p) =>
      (ref.year == null || p.year == null || Math.abs(p.year - ref.year) <= 1) &&
      (!fam || !p.authors.length || familyKey(p.authors) === fam) &&
      !(ids.arxivId && p.arxivId && p.arxivId !== ids.arxivId) &&
      !(ids.doi && p.doi && p.doi !== ids.doi),
  );
}

/** Record the ref's ids on an existing paper so the next import finds it directly. Never claims an id another paper owns. */
async function addAliases(paper: Paper, ids: string[]): Promise<Paper> {
  const fresh: string[] = [];
  for (const id of ids) {
    if (id === paper.id || paper.aliases.includes(id) || id.startsWith('ref:')) continue;
    if (!(await repo.getPaper(id))) fresh.push(id);
  }
  if (!fresh.length) return paper;
  return (await repo.updatePaper(paper.id, (cur) => ({ aliases: [...new Set([...cur.aliases, ...fresh])] }))) ?? paper;
}

const CITE_KEY = /^[A-Za-z0-9_:.+/-]+$/;

async function buildImportedPaper(ref: ImportedRef, ids: RefIdentity, taken: Set<string>, keepCiteKeys?: boolean): Promise<Paper> {
  const { title, authors, year } = ref;
  const base = keepCiteKeys && ref.key && CITE_KEY.test(ref.key) ? ref.key : baseCiteKey(authors, year, title);
  const citeKey = uniqueCiteKey(base, taken);
  taken.add(citeKey);
  const venueName = ref.venue && !isPreprintVenue(ref.venue) ? collapse(ref.venue) : null;
  const venue = shortVenue(venueName, year);
  const kind = ref.kind ?? (venueName ? kindFromVenue(venueName) : ids.arxivId ? 'preprint' : 'other');
  const isPdf = (u?: string) => !!u && /\.pdf($|[?#])/i.test(u);
  const pdf = isHttp(ref.pdfUrl) ? ref.pdfUrl : isHttp(ref.url) && isPdf(ref.url) ? ref.url : undefined;
  const page = isHttp(ref.url) && !isPdf(ref.url) ? ref.url : undefined;
  const urls: Paper['urls'] = ids.arxivId
    ? arxivUrls(ids.arxivId)
    : ids.openreviewId
      ? openreviewUrls(ids.openreviewId)
      : { ...(ids.doi ? { abs: `https://doi.org/${ids.doi}` } : page ? { abs: page } : {}), ...(pdf ? { pdf } : {}) };
  let bibtex: string;
  let bibtexSource: Paper['bibtexSource'];
  if (ref.bibtex?.trim()) {
    bibtex = rekey(ref.bibtex.trim(), citeKey);
    bibtexSource = 'import';
  } else if (ids.arxivId) {
    // the venue check during enrichment upgrades this to the venue's BibTeX once it's published
    bibtex = arxivBibtex({ citeKey, title, authors, year, arxivId: ids.arxivId });
    bibtexSource = 'arxiv';
  } else {
    const type = kind === 'journal' ? 'article' : kind === 'conference' ? 'inproceedings' : 'misc';
    bibtex = genericBibtex({ citeKey, type, title, authors, year, venue: venueName, doi: ids.doi, url: page });
    bibtexSource = 'import';
  }
  return {
    ...(await repo.newMeta()),
    id: ids.id,
    aliases: ids.lookup.filter((a) => a !== ids.id && !a.startsWith('ref:')),
    source: ids.arxivId ? 'arxiv' : ids.doi ? 'doi' : 'import',
    title,
    authors,
    abstract: collapse(ref.abstract),
    year,
    published: ref.published ?? null,
    ...(ids.arxivId ? { arxivId: ids.arxivId } : {}),
    ...(ids.doi ? { doi: ids.doi } : {}),
    ...(ids.openreviewId ? { openreviewId: ids.openreviewId } : {}),
    venue,
    venueStatus: venue ? 'accepted' : ids.arxivId || kind === 'preprint' ? 'preprint' : 'unknown',
    urls,
    codeLinks: [],
    citeKey,
    bibtex,
    bibtexSource,
  };
}

/** How an annotation reads as a note: the paper-level note, or "Label: “quote”" with the highlight's note on the next line. */
function annotationNote(a: Annotation): string {
  const note = noteOf(a).trim();
  if (!a.target.selector) return note;
  const quote = collapse(quoteOf(a.target.selector)?.exact);
  if (!quote) return note;
  const label = labelOf(a);
  const name = label === 'plain' ? '' : HIGHLIGHT_LABELS.find((l) => l.id === label)?.name ?? '';
  const head = `${name ? `${name}: ` : ''}“${quote}”`;
  return note ? `${head}\n${note}` : head;
}

/**
 * Add the notes not already on the paper as one paper-level note. A note counts as
 * present when it matches a whole paragraph block of an existing note or a highlight
 * (so re-importing a file, or re-importing Archive's own RIS export, adds nothing).
 */
async function addImportedNotes(paperId: string, notes: string[]): Promise<void> {
  const incoming = [...new Set(notes.map(tidyNote).filter(Boolean))];
  if (!incoming.length) return;
  const existing = (await repo.listAnnotations(paperId)).map((a) => `\n\n${tidyNote(annotationNote(a))}\n\n`);
  const fresh = incoming.filter((n) => !existing.some((block) => block.includes(`\n\n${n}\n\n`)));
  if (!fresh.length) return;
  await repo.createAnnotation({
    paperId,
    motivation: 'commenting',
    body: [{ type: 'TextualBody', purpose: 'commenting', value: fresh.join('\n\n'), format: 'text/markdown' }],
    target: { source: paperId },
  });
}

/**
 * Add references to the library. A paper already stored under any of the ref's ids
 * (or the same title, see matchByTitle) keeps its metadata: it only gains a library
 * entry, the ref's tags, the project and any new notes. Tags that name an existing
 * project file the paper into that project instead. Refs without a title are skipped.
 * `keepCiteKeys` keeps the file's citation keys instead of generating Archive's.
 */
export async function importRefs(refs: ImportedRef[], opts: { projectId?: string; keepCiteKeys?: boolean } = {}): Promise<ImportResult> {
  const projects = await repo.listProjects();
  if (opts.projectId && !projects.some((p) => p.id === opts.projectId)) throw new Error('That project no longer exists.');
  const projectByName = new Map(projects.map((p) => [p.name.trim().toLowerCase(), p.id] as const));
  const taken = await repo.takenCiteKeys();
  let titles: TitleIndex | null = null;
  const result: ImportResult = { added: 0, updated: 0, skipped: 0, paperIds: [] };
  const touched = new Set<string>();

  for (const raw of refs) {
    const ref: ImportedRef = { ...raw, title: collapse(raw.title), authors: raw.authors ?? [], year: raw.year ?? null };
    if (!ref.title) {
      result.skipped++;
      continue;
    }
    const ids = refIdentity(ref);
    let paper = await findPaper(ids.lookup);
    if (!paper) {
      titles ??= await buildTitleIndex();
      paper = matchByTitle(titles, ref, ids);
    }
    const created = !paper;
    if (paper) {
      paper = await addAliases(paper, ids.lookup);
    } else {
      paper = await repo.putPaper(await buildImportedPaper(ref, ids, taken, opts.keepCiteKeys));
      if (titles) indexPaper(titles, paper);
    }

    const tags: string[] = [];
    const projectIds = opts.projectId ? [opts.projectId] : [];
    for (const t of ref.tags ?? []) {
      const pid = projectByName.get(collapse(t).toLowerCase());
      if (pid) projectIds.push(pid);
      else tags.push(t);
    }
    const { entry } = await repo.ensureEntry(paper.id);
    const nextTags = mergeTags(entry.tags, tags);
    const nextProjects = [...new Set([...entry.projectIds, ...projectIds])];
    if (nextTags.length !== entry.tags.length || nextProjects.length !== entry.projectIds.length) {
      await repo.updateEntry(paper.id, (cur) => ({
        tags: mergeTags(cur.tags, tags),
        projectIds: [...new Set([...cur.projectIds, ...projectIds])],
        dismissedProjectIds: cur.dismissedProjectIds.filter((id) => !projectIds.includes(id)),
      }));
    }
    await addImportedNotes(paper.id, ref.notes ?? []);

    if (created) result.added++;
    else result.updated++;
    if (!touched.has(paper.id)) {
      touched.add(paper.id);
      result.paperIds.push(paper.id);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export interface ExportItem {
  paper: Paper;
  entry?: LibraryEntry | null;
  annotations: Annotation[];
}

function paperKind(p: Paper, bib: BibEntry | undefined): RefKind {
  const journal = bib ? getField(bib, 'journal') : undefined;
  const bibJournal = bib?.type === 'article' && !!journal && !isPreprintVenue(journal);
  const bibConf = bib?.type === 'inproceedings' || bib?.type === 'conference';
  if (p.venue) return bibJournal ? 'journal' : bibConf ? 'conference' : kindFromVenue(p.venue);
  if (p.arxivId || p.openreviewId) return 'preprint';
  return bibJournal ? 'journal' : bibConf ? 'conference' : 'other';
}

const bibText = (bib: BibEntry | undefined, field: string) => (bib ? unLatex(getField(bib, field) ?? '') || undefined : undefined);
const stripYear = (v: string | null) => v?.replace(/\s+(19|20)\d{2}$/, '') || undefined;
const yearOfPaper = (p: Paper) => p.year ?? dateFromText(p.published).year;

function pagesOf(bib: BibEntry | undefined): [string | undefined, string | undefined] {
  const pages = bibText(bib, 'pages');
  if (!pages) return [undefined, undefined];
  const [sp, ep] = pages.split(/\s*[-\u2013\u2014]+\s*/);
  return [sp || undefined, ep || undefined];
}

function keywordsOf(entry: LibraryEntry | null | undefined, projects?: Map<string, Project>): string[] {
  const names = (entry?.projectIds ?? []).map((id) => projects?.get(id)?.name).filter((n): n is string => !!n);
  return mergeTags([], [...(entry?.tags ?? []), ...names]);
}

/** Paper-level notes first, then one note per highlight, in reading order. */
function exportNotes(annotations: Annotation[]): string[] {
  const live = annotations.filter((a) => !a.deletedAt);
  return [...live.filter((a) => !a.target.selector), ...live.filter((a) => a.target.selector)].map(annotationNote).filter(Boolean);
}

const RIS_LIKE = /^[A-Z][A-Z0-9] {1,2}-/;

/** One tag; continuation lines that would read as a tag are indented so readers don't split them. */
function risField(tag: string, value: string | number | null | undefined): string[] {
  const v = value == null ? '' : String(value).replace(/\r\n?/g, '\n').trim();
  if (!v) return [];
  const [head, ...rest] = v.split('\n');
  return [`${tag}  - ${head}`, ...rest.map((l) => (RIS_LIKE.test(l) ? ` ${l}` : l.trimEnd()))];
}

function risName(a: Author): string {
  const { given, family } = a.family !== undefined ? { given: a.given ?? '', family: a.family } : splitName(a.name);
  return given ? `${family}, ${given}` : family || a.name;
}

/** Zotero's RIS date form: "YYYY/MM/DD/", with empty parts when unknown. */
function risDate(p: Paper): string | undefined {
  const m = p.published ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(p.published) : null;
  if (m) return `${m[1]}/${m[2] ?? ''}/${m[3] ?? ''}/`;
  const y = yearOfPaper(p);
  return y ? `${y}///` : undefined;
}

// RIS types, picked for how Zotero's RIS translator (zotero/translators, RIS.js) reads them:
// - Zotero has no RIS type that imports as its Preprint item. Its own exporter writes preprints
//   as GEN, which reads back as Journal Article, and UNPB, UNPD, INPR and MANSCPT become Journal
//   Article or Manuscript. So preprints go out as JOUR with T2 "arXiv" (and the arXiv DOI
//   10.48550/arXiv.<id>): they land as a Journal Article published in arXiv, which citation
//   styles render as an arXiv preprint. CSL JSON (type "article") is the export that lands as
//   a true Zotero Preprint.
// - Conference papers go out as CONF, the type Zotero writes for conferencePaper (it reads
//   CPAPER the same way). T2 is the conference name and C3 the proceedings title.
// - Journal articles are JOUR with the journal in T2. Anything else is GEN, Zotero's default.
const RIS_TYPES: Record<RefKind, string> = { preprint: 'JOUR', journal: 'JOUR', conference: 'CONF', other: 'GEN' };

/**
 * RIS for Zotero, Mendeley and EndNote. Tags and project names become KW; paper-level
 * notes and highlights become N1 notes; the PDF link is L1. Lines end in CRLF per the spec.
 */
export function toRis(items: ExportItem[], opts: { projects?: Map<string, Project> } = {}): string {
  const lines: string[] = [];
  for (const { paper: p, entry, annotations } of items) {
    const bib = parseBib(p.bibtex ?? '')[0];
    const kind = paperKind(p, bib);
    const add = (tag: string, value?: string | number | null) => lines.push(...risField(tag, value));
    add('TY', RIS_TYPES[kind]);
    add('ID', p.citeKey);
    add('TI', collapse(p.title));
    for (const a of p.authors) add('AU', risName(a));
    if (kind === 'preprint') add('T2', p.arxivId ? 'arXiv' : p.openreviewId ? 'OpenReview' : null);
    else if (kind === 'journal') add('T2', bibText(bib, 'journal') ?? stripYear(p.venue));
    else if (kind === 'conference') {
      add('T2', p.venue);
      add('C3', bibText(bib, 'booktitle') ?? p.venue);
    } else add('T2', p.venue);
    add('AB', collapse(p.abstract));
    add('DA', risDate(p));
    add('PY', yearOfPaper(p));
    add('DO', p.doi ?? (kind === 'preprint' && p.arxivId ? `10.48550/arXiv.${p.arxivId}` : null));
    if (kind === 'journal' || kind === 'conference') {
      const [sp, ep] = pagesOf(bib);
      add('VL', bibText(bib, 'volume'));
      add('IS', bibText(bib, 'number'));
      add('SP', sp);
      add('EP', ep);
      add('PB', bibText(bib, 'publisher'));
    }
    add('UR', paperLink(p));
    add('L1', p.urls.pdf);
    for (const k of keywordsOf(entry, opts.projects)) add('KW', k);
    for (const n of exportNotes(annotations)) add('N1', n);
    lines.push('ER  - ', '');
  }
  return lines.join('\r\n');
}

function cslIssued(p: Paper): { 'date-parts': number[][] } | undefined {
  const m = p.published ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(p.published) : null;
  if (m) return { 'date-parts': [[m[1], m[2], m[3]].filter((x): x is string => !!x).map(Number)] };
  const y = yearOfPaper(p);
  return y ? { 'date-parts': [[y]] } : undefined;
}

/**
 * CSL JSON. Types follow Zotero's CSL mapping: "article" lands as a Preprint (arXiv goes in
 * publisher and number, which Zotero reads as Repository and Archive ID), "paper-conference"
 * as a Conference Paper and "article-journal" as a Journal Article.
 */
export function toCslJson(papers: Paper[]): string {
  const items = papers.map((p) => {
    const bib = parseBib(p.bibtex ?? '')[0];
    const kind = paperKind(p, bib);
    const item: Json = {
      id: p.citeKey,
      'citation-key': p.citeKey,
      type: kind === 'conference' ? 'paper-conference' : kind === 'journal' ? 'article-journal' : 'article',
      title: collapse(p.title),
    };
    const set = (k: string, v: unknown) => {
      if (v !== undefined && v !== null && v !== '') item[k] = v;
    };
    const authors = p.authors.map((a) => {
      const { given, family } = a.family !== undefined ? { given: a.given ?? '', family: a.family } : splitName(a.name);
      return given ? { family, given } : { literal: family || a.name };
    });
    if (authors.length) set('author', authors);
    set('issued', cslIssued(p));
    if (kind === 'journal') set('container-title', bibText(bib, 'journal') ?? stripYear(p.venue));
    if (kind === 'conference') {
      set('container-title', bibText(bib, 'booktitle') ?? p.venue);
      set('event-title', p.venue);
    }
    if (kind === 'other') set('container-title', p.venue);
    if (kind === 'preprint' && p.arxivId) {
      set('publisher', 'arXiv');
      set('number', `arXiv:${p.arxivId}`);
    } else if (kind === 'preprint' && p.openreviewId) set('publisher', 'OpenReview');
    if (kind === 'journal' || kind === 'conference') {
      set('volume', bibText(bib, 'volume'));
      set('issue', bibText(bib, 'number'));
      set('page', bibText(bib, 'pages')?.replace(/\s*[-\u2013]+\s*/, '-'));
      set('publisher', bibText(bib, 'publisher'));
    }
    set('DOI', p.doi ?? (kind === 'preprint' && p.arxivId ? `10.48550/arXiv.${p.arxivId}` : undefined));
    set('URL', paperLink(p) || undefined);
    set('abstract', collapse(p.abstract));
    return item;
  });
  return `${JSON.stringify(items, null, 2)}\n`;
}

/** "Reading group: agents" → "reading-group-agents.ris". */
export function exportFileName(kind: 'ris' | 'csljson', label: string): string {
  const slug = asciiFold(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${slug || 'archive-library'}.${kind === 'ris' ? 'ris' : 'json'}`;
}
