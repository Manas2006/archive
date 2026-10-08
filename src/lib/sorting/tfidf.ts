// Small TF-IDF implementation used when embeddings aren't available yet,
// and for keyword topic names when AI is off.

const STOP = new Set(
  `a about above after again against all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves
  paper papers propose proposed proposes approach approaches method methods methodology result results show shows shown demonstrate demonstrates based using use used new novel work works study studies task tasks model models via existing extensive experiments experimental achieve achieves achieved performance state art sota significantly significant improve improves improved improvement improvements however furthermore moreover across several various different well however first second large small high low way ways problem problems present presents introduce introduces framework frameworks code available github com https http www may might also many much one two three via et al within without toward towards`.split(
    /\s+/,
  ),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    let t = raw;
    if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
    else if (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is')) t = t.slice(0, -1);
    out.push(t);
  }
  // add bigrams of adjacent tokens for phrase-y keywords ("language model")
  const n = out.length;
  for (let i = 0; i + 1 < n; i++) out.push(`${out[i]} ${out[i + 1]}`);
  return out;
}

export type SparseVec = Map<string, number>;

export class Corpus {
  private df = new Map<string, number>();
  private n = 0;

  constructor(docs: string[] = []) {
    for (const d of docs) this.add(d);
  }

  add(doc: string) {
    this.n++;
    for (const t of new Set(tokenize(doc))) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  idf(term: string): number {
    return Math.log((1 + this.n) / (1 + (this.df.get(term) ?? 0))) + 1;
  }

  vector(doc: string): SparseVec {
    const tf = new Map<string, number>();
    for (const t of tokenize(doc)) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: SparseVec = new Map();
    let norm = 0;
    for (const [t, c] of tf) {
      const w = (1 + Math.log(c)) * this.idf(t) * (t.includes(' ') ? 0.8 : 1);
      v.set(t, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  }
}

export function cosineSparse(a: SparseVec, b: SparseVec): number {
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [t, w] of small) {
    const o = big.get(t);
    if (o) dot += w * o;
  }
  return dot;
}

export function cosineDense(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function addSparse(acc: SparseVec, v: SparseVec, scale = 1) {
  for (const [t, w] of v) acc.set(t, (acc.get(t) ?? 0) + w * scale);
}

export function normalizeSparse(v: SparseVec): SparseVec {
  let n = 0;
  for (const w of v.values()) n += w * w;
  n = Math.sqrt(n) || 1;
  const out: SparseVec = new Map();
  for (const [t, w] of v) out.set(t, w / n);
  return out;
}

/** Terms that best characterize a group of docs relative to the corpus. */
export function topTerms(group: SparseVec[], k = 4): string[] {
  const sum: SparseVec = new Map();
  for (const v of group) addSparse(sum, v);
  const ranked = [...sum.entries()].sort((a, b) => b[1] - a[1]);
  const picked: string[] = [];
  for (const [t] of ranked) {
    // skip unigrams already covered by a picked bigram, and vice versa
    if (picked.some((p) => p.includes(t) || t.includes(p))) continue;
    picked.push(t);
    if (picked.length >= k) break;
  }
  return picked;
}

export const paperDoc = (p: { title: string; abstract: string }) => `${p.title}. ${p.title}. ${p.abstract}`;
