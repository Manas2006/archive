// Mock HTTPS server standing in for arXiv, OpenReview, Semantic Scholar, DBLP and
// the Claude API during browser tests. Chromium maps those hosts to 127.0.0.1.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FX = (f) => fs.readFileSync(path.join(HERE, 'fixtures', f));
export const requests = [];

const PAPERS = {
  '2401.00001': {
    title: 'Filtered Attention for Long-Context Retrieval',
    authors: ['Ada Lovelace', 'Alan Turing'],
    abstract:
      'Long-context language models often fail to retrieve facts buried in the middle of their input. We introduce filtered attention, a lightweight scoring layer that prunes irrelevant key blocks before the softmax. On the NeedleBench and LongQA benchmarks, filtered attention improves retrieval recall by 11.4 points at 128k tokens while reducing attention FLOPs by 38%. Code is available at https://github.com/ada/filtered-attention.',
    published: '2024-01-02T18:00:00Z',
    version: 2,
    comment: 'Accepted at NeurIPS 2024. Code: https://github.com/ada/filtered-attention',
    category: 'cs.CL',
  },
  '2402.00002': {
    title: 'Retrieval heads in long-context transformers',
    authors: ['John Smith', 'Jane Doe'],
    abstract: 'We identify retrieval heads, a sparse set of attention heads responsible for copying facts from long contexts.',
    published: '2024-02-01T18:00:00Z',
    version: 1,
    comment: '12 pages',
    category: 'cs.CL',
  },
  '2403.00003': {
    title: 'Sparse Reward Shaping for Tool-Use Agents',
    authors: ['Grace Hopper', 'Edsger Dijkstra'],
    abstract: 'We shape sparse rewards for tool-use agents using planning traces.',
    published: '2024-03-01T18:00:00Z',
    version: 1,
    comment: '',
    category: 'cs.LG',
  },
  '2404.00004': { title: 'Planning Traces Improve Credit Assignment for Tool-Use Agents', authors: ['Barbara Liskov'], abstract: 'Agents that call tools receive sparse rewards. We use planning traces to densify reward and improve credit assignment for tool-use agents in web navigation.', published: '2024-04-01T18:00:00Z', version: 1, comment: '', category: 'cs.LG' },
  '2405.00005': { title: 'Reward Models for Long-Horizon Agents', authors: ['Leslie Lamport'], abstract: 'We train reward models that judge long-horizon agent trajectories with tool calls, improving agent success under sparse rewards.', published: '2024-05-01T18:00:00Z', version: 1, comment: '', category: 'cs.LG' },
  '2406.00006': { title: 'Block-Sparse Attention Kernels for Long Contexts', authors: ['Donald Knuth'], abstract: 'We implement block-sparse attention kernels that prune key blocks and speed up long-context transformers with little loss in retrieval accuracy.', published: '2024-06-01T18:00:00Z', version: 1, comment: '', category: 'cs.CL' },
  '2407.00007': { title: 'Agentic Web Navigation with Sparse Rewards', authors: ['Frances Allen'], abstract: 'Web navigation agents learn from sparse rewards; we propose curriculum and reward shaping for tool-use agents.', published: '2024-07-01T18:00:00Z', version: 1, comment: '', category: 'cs.LG' },
};

function atom(ids) {
  const entries = ids
    .map((id) => {
      const p = PAPERS[id.replace(/v\d+$/, '')];
      if (!p) return `<entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_${id}</id><title>Error</title><summary>incorrect id format for ${id}</summary></entry>`;
      return `<entry>
  <id>http://arxiv.org/abs/${id.replace(/v\d+$/, '')}v${p.version}</id>
  <updated>${p.published}</updated><published>${p.published}</published>
  <title>${p.title.replace(/ /, '\n  ')}</title>
  <summary>  ${p.abstract}\n</summary>
  ${p.authors.map((a) => `<author><name>${a}</name></author>`).join('\n  ')}
  ${p.comment ? `<arxiv:comment xmlns:arxiv="http://arxiv.org/schemas/atom">${p.comment}</arxiv:comment>` : ''}
  <link href="http://arxiv.org/abs/${id}v${p.version}" rel="alternate" type="text/html"/>
  <link title="pdf" href="http://arxiv.org/pdf/${id}v${p.version}" rel="related" type="application/pdf"/>
  <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="${p.category}" scheme="http://arxiv.org/schemas/atom"/>
  <category term="${p.category}" scheme="http://arxiv.org/schemas/atom"/>
</entry>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query</title>
  ${entries}
</feed>`;
}

// ---- Semantic Scholar ----
function vec(seed, base) {
  // deterministic 768-d vector around a topic direction
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  return Array.from({ length: 768 }, (_, i) => base(i) + 0.15 * rnd());
}
const topicA = (i) => Math.sin(i * 0.37);
const topicB = (i) => Math.cos(i * 0.91);
const S2 = {
  's2-p1': { paperId: 's2-p1', externalIds: { ArXiv: '2401.00001', DBLP: 'conf/nips/LovelaceT24', CorpusId: 1 }, title: PAPERS['2401.00001'].title, abstract: PAPERS['2401.00001'].abstract, venue: 'Neural Information Processing Systems', publicationVenue: { name: 'Neural Information Processing Systems', type: 'conference' }, year: 2024, authors: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }], citationCount: 42, publicationTypes: ['Conference'], emb: vec(1, topicA) },
  's2-p2': { paperId: 's2-p2', externalIds: { ArXiv: '2402.00002', CorpusId: 2 }, title: PAPERS['2402.00002'].title, abstract: PAPERS['2402.00002'].abstract, venue: 'arXiv.org', publicationVenue: { name: 'arXiv.org', type: 'repository' }, year: 2024, authors: [{ name: 'John Smith' }, { name: 'Jane Doe' }], citationCount: 7, emb: vec(2, topicA) },
  's2-p3': { paperId: 's2-p3', externalIds: { ArXiv: '2403.00003', CorpusId: 3 }, title: PAPERS['2403.00003'].title, abstract: PAPERS['2403.00003'].abstract, venue: '', year: 2024, authors: [{ name: 'Grace Hopper' }, { name: 'Edsger Dijkstra' }], citationCount: 0, emb: vec(3, topicB) },
  's2-p4': { paperId: 's2-p4', externalIds: { CorpusId: 4 }, title: 'Generating long sequences with sparse transformers', abstract: 'Sparse factorizations of the attention matrix reduce cost to O(n sqrt n).', venue: '', year: 2019, authors: [{ name: 'Rewon Child' }, { name: 'Scott Gray' }], citationCount: 2000, emb: vec(4, topicA) },
};
function s2Lookup(id) {
  id = decodeURIComponent(id);
  if (S2[id]) return S2[id];
  const m = id.match(/^arXiv:(.+)$/i);
  if (m) return Object.values(S2).find((p) => p.externalIds.ArXiv === m[1].replace(/v\d+$/, '')) ?? null;
  return null;
}
function s2Project(p, fields) {
  if (!p) return null;
  const f = new Set((fields ?? '').split(','));
  const out = {};
  for (const k of Object.keys(p)) if (k !== 'emb' && (f.has(k) || k === 'paperId')) out[k] = p[k];
  if (f.has('embedding.specter_v2') || f.has('embedding')) out.embedding = { model: 'specter_v2', vector: p.emb };
  return out;
}

const DBLP_BIB = `@inproceedings{DBLP:conf/nips/LovelaceT24,
  author       = {Ada Lovelace and
                  Alan Turing},
  title        = {Filtered Attention for Long-Context Retrieval},
  booktitle    = {Advances in Neural Information Processing Systems 37: Annual Conference
                  on Neural Information Processing Systems 2024, NeurIPS 2024, Vancouver,
                  BC, Canada, December 10 - 15, 2024},
  year         = {2024},
  url          = {http://papers.nips.cc/paper_files/paper/2024/hash/abc-Abstract-Conference.html},
  timestamp    = {Thu, 13 Feb 2025 16:50:30 +0100},
  biburl       = {https://dblp.org/rec/conf/nips/LovelaceT24.bib},
  bibsource    = {dblp computer science bibliography, https://dblp.org}
}
`;

// ---- OpenReview ----
const OR_ID = 'ORabc123';
const orNote = {
  id: OR_ID,
  forum: OR_ID,
  invitations: ['ICLR.cc/2025/Conference/-/Submission'],
  cdate: Date.parse('2024-09-27'),
  pdate: Date.parse('2025-01-22'),
  content: {
    title: { value: 'Sparse Reward Shaping for Tool-Use Agents' },
    authors: { value: ['Grace Hopper', 'Edsger Dijkstra'] },
    abstract: { value: 'We shape sparse rewards for tool-use agents using planning traces.' },
    venue: { value: 'ICLR 2025 poster' },
    venueid: { value: 'ICLR.cc/2025/Conference' },
    pdf: { value: `/pdf/abc123.pdf` },
    _bibtex: {
      value: `@inproceedings{\nhopper2025sparse,\ntitle={Sparse Reward Shaping for Tool-Use Agents},\nauthor={Grace Hopper and Edsger Dijkstra},\nbooktitle={The Thirteenth International Conference on Learning Representations},\nyear={2025},\nurl={https://openreview.net/forum?id=${OR_ID}}\n}`,
    },
  },
};
const orForum = [
  orNote,
  { id: 'r1', forum: OR_ID, invitations: [`ICLR.cc/2025/Conference/Submission42/-/Official_Review`], signatures: ['ICLR.cc/2025/Conference/Submission42/Reviewer_aB1c'], content: { rating: { value: 6 }, confidence: { value: 4 }, summary: { value: 'Shapes rewards with planning traces.' }, weaknesses: { value: 'Limited baselines; no comparison to dense reward models. Ablations missing for trace quality.' } } },
  { id: 'r2', forum: OR_ID, invitations: [`ICLR.cc/2025/Conference/Submission42/-/Official_Review`], signatures: ['ICLR.cc/2025/Conference/Submission42/Reviewer_xY9z'], content: { rating: { value: 8 }, confidence: { value: 3 }, summary: { value: 'Clear paper.' }, weaknesses: { value: 'Compute cost is not reported.' } } },
  { id: 'r3', forum: OR_ID, invitations: [`ICLR.cc/2025/Conference/Submission42/-/Official_Review`], signatures: ['ICLR.cc/2025/Conference/Submission42/Reviewer_Qq77'], content: { rating: { value: 5 }, confidence: { value: 4 }, weaknesses: { value: 'Missing baselines against dense reward models.' } } },
  { id: 'c1', forum: OR_ID, invitations: [`ICLR.cc/2025/Conference/Submission42/-/Official_Comment`], signatures: ['ICLR.cc/2025/Conference/Submission42/Authors'], content: { comment: { value: 'We added two dense-reward baselines and report compute in Appendix C.' } } },
  { id: 'd1', forum: OR_ID, invitations: [`ICLR.cc/2025/Conference/Submission42/-/Decision`], signatures: ['ICLR.cc/2025/Conference/Program_Chairs'], content: { decision: { value: 'Accept (poster)' } } },
];

// ---- Claude API mock ----
function claudeText(body) {
  const last = body.messages?.[body.messages.length - 1]?.content ?? '';
  const text = typeof last === 'string' ? last : JSON.stringify(last);
  if (text.includes('Return JSON with exactly these keys')) {
    // per-paper fields so library screenshots look realistic; tests only check the first paper
    const t = text.split('\n')[0];
    const table = [
      [/Retrieval heads/, { task: 'mechanistic interpretability', benchmarks: ['Needle-in-a-Haystack'], models: ['LLaMA-2-7B', 'Mistral-7B'], metrics: ['Retrieval score'], headlineResult: 'Fewer than 5% of heads do retrieval; masking them drops NIAH accuracy to 9%.' }],
      [/Planning Traces/, { task: 'credit assignment for agents', benchmarks: ['WebArena', 'ToolBench'], models: ['GPT-4o agent'], metrics: ['Success rate'], headlineResult: '+8.2 points success rate on WebArena.' }],
      [/Reward Models for Long-Horizon/, { task: 'reward modeling', benchmarks: ['WebShop', 'ALFWorld'], models: ['Trajectory RM-8B'], metrics: ['Success rate', 'AUC'], headlineResult: 'Reward model AUC 0.87 on held-out trajectories.' }],
      [/Block-Sparse Attention/, { task: 'efficient attention kernels', benchmarks: ['RULER', 'LongBench'], models: ['Llama-3-8B'], metrics: ['Throughput', 'Accuracy'], headlineResult: '3.1x prefill speedup at 128k with under 1 point accuracy loss.' }],
      [/Agentic Web Navigation/, { task: 'web navigation', benchmarks: ['Mind2Web', 'WebArena'], models: ['Qwen2-7B agent'], metrics: ['Step accuracy'], headlineResult: 'Curriculum plus shaping reaches 41% step accuracy.' }],
      [/Sparse Reward Shaping/, { task: 'reward shaping', benchmarks: ['ToolBench'], models: ['Llama-3-8B agent'], metrics: ['Pass rate'], headlineResult: 'Pass rate 62% vs 48% with sparse rewards.' }],
    ];
    const hit = table.find(([re]) => re.test(t));
    if (hit) return JSON.stringify(hit[1]);
    return JSON.stringify({ task: 'long-context retrieval', benchmarks: ['NeedleBench', 'LongQA'], models: ['Filtered attention', 'Full attention'], metrics: ['Recall'], headlineResult: '+11.4 recall points at 128k tokens on NeedleBench.' });
  }
  if (text.includes('Give each cluster')) {
    const n = (text.match(/Cluster \d+/g) ?? []).length;
    return JSON.stringify(Array.from({ length: n }, (_, i) => ['Long-Context Retrieval', 'Agent Reward Design', 'Sparse Attention'][i] ?? `Topic ${i + 1}`));
  }
  if (text.includes('rate 0 to 10')) {
    const ids = [...text.matchAll(/id=([\w-]+)/g)].map((m) => m[1]);
    const isRetrieval = /retriev|attention/i.test(text.split('Projects:')[0]);
    return JSON.stringify(Object.fromEntries(ids.map((id) => [id, isRetrieval ? 9 : 2])));
  }
  if (text.includes('Draft bullets for each section'))
    return JSON.stringify({ problem: ['Long-context models miss facts in the middle of the input.'], method: ['Prune key blocks with a learned score before the softmax.'], results: ['+11.4 recall at 128k on NeedleBench, 38% fewer FLOPs.'], interesting: ['The filter is retrofitted to a frozen model.'], better: ['(draft) Only synthetic training data.'] });
  if (text.includes('What reviewers criticized'))
    return '**What reviewers criticized**\n- Missing dense-reward baselines (2 reviewers)\n- Compute cost not reported (1 reviewer)\n\n**How the authors responded**\n- Added two dense-reward baselines and compute numbers.';
  if (text.includes('Find the evidence'))
    return '**Supported.** Table 1 reports recall of 72.6 vs 61.2 on NeedleBench at 128k tokens, a gain of 11.4 points.';
  return 'This passage says the model parameters are written $\\theta$ and the filter keeps the top $k$ blocks (Section 2). It matters because pruning happens **before** the softmax.';
}

function sse(res, text, model) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-cache' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: 1200, output_tokens: 1 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  const chunks = text.match(/.{1,24}/gs) ?? [];
  let i = 0;
  const tick = () => {
    if (i < chunks.length) {
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunks[i++] } });
      setTimeout(tick, 15);
    } else {
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    }
  };
  tick();
}

function json(res, code, obj, extra = {}) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...extra });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

export const state = { s2Calls: 0, claudeCalls: [], arxivVersion: 2 };

async function handle(req, res) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  const url = new URL(req.url, `https://${host}`);
  requests.push({ method: req.method, host, path: url.pathname + url.search, at: Date.now() });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    return res.end();
  }
  const p = url.pathname;

  if (host === 'arxiv.org' || host === 'www.arxiv.org') {
    let m;
    if ((m = p.match(/^\/abs\/(\d{4}\.\d{5})(v\d+)?$/))) {
      const f = `arxiv-abs-${m[1]}.html`;
      if (fs.existsSync(path.join(HERE, 'fixtures', f))) return res.writeHead(200, { 'content-type': 'text/html' }), res.end(FX(f));
    }
    if ((m = p.match(/^\/html\/2401\.00001(v(\d))?\/?$/))) {
      const v = m[2] ? Number(m[2]) : state.arxivVersion;
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }), res.end(FX(`arxiv-html-v${v}.html`));
    }
    if (p.match(/^\/html\/(2401\.00001(v\d)?\/)?x1\.png$/)) return res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' }), res.end(FX('x1.png'));
    if (p.match(/^\/pdf\/\d{4}\.\d{5}(v\d+)?(\.pdf)?$/)) return res.writeHead(200, { 'content-type': 'application/pdf', 'access-control-allow-origin': '*' }), res.end(FX('paper.pdf'));
  }
  if (host === 'export.arxiv.org' && p === '/api/query') {
    const ids = (url.searchParams.get('id_list') ?? '').split(',').filter(Boolean);
    return res.writeHead(200, { 'content-type': 'application/atom+xml' }), res.end(atom(ids));
  }
  if (host === 'openreview.net') {
    if (p === '/forum') return res.writeHead(200, { 'content-type': 'text/html' }), res.end(FX('openreview-forum.html'));
    if (p === '/pdf' || p.startsWith('/pdf/')) return res.writeHead(200, { 'content-type': 'application/pdf', 'access-control-allow-origin': '*' }), res.end(FX('paper.pdf'));
  }
  if (host === 'api2.openreview.net' && p === '/notes') {
    if (url.searchParams.get('id') === OR_ID) return json(res, 200, { notes: [orNote] });
    if (url.searchParams.get('forum') === OR_ID) return json(res, 200, { notes: orForum });
    return json(res, 200, { notes: [] });
  }
  if (host === 'api.openreview.net' && p === '/notes') return json(res, 200, { notes: [] });
  if (host === 'api.semanticscholar.org') {
    state.s2Calls++;
    const fields = url.searchParams.get('fields');
    let m;
    if (p === '/graph/v1/paper/batch' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      return json(res, 200, (body.ids ?? []).map((id) => s2Project(s2Lookup(id), fields)));
    }
    if (p === '/graph/v1/paper/search/match') {
      const q = (url.searchParams.get('query') ?? '').toLowerCase();
      const hit = Object.values(S2).find((x) => x.title.toLowerCase() === q.trim() || q.includes(x.title.toLowerCase()));
      return hit ? json(res, 200, { data: [{ ...s2Project(hit, fields), matchScore: 99 }] }) : json(res, 404, { error: 'Title match not found' });
    }
    if ((m = p.match(/^\/graph\/v1\/paper\/(.+)\/references$/))) {
      const paper = s2Lookup(m[1]);
      if (!paper) return json(res, 404, { error: 'not found' });
      const refs = paper.paperId === 's2-p1' ? [S2['s2-p2'], S2['s2-p4']] : [];
      return json(res, 200, { data: refs.map((r) => ({ citedPaper: { paperId: r.paperId, externalIds: r.externalIds, title: r.title } })) });
    }
    if ((m = p.match(/^\/graph\/v1\/paper\/(.+)$/))) {
      const paper = s2Lookup(m[1]);
      return paper ? json(res, 200, s2Project(paper, fields)) : json(res, 404, { error: 'Paper not found' });
    }
  }
  if (host === 'dblp.org') {
    if (p === '/rec/conf/nips/LovelaceT24.bib') return res.writeHead(200, { 'content-type': 'text/plain' }), res.end(DBLP_BIB);
    if (p === '/search/publ/api') return json(res, 200, { result: { hits: { hit: [] } } });
  }
  if (host === 'api.anthropic.com') {
    if (req.headers['x-api-key'] !== 'sk-ant-test') return json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (!req.headers['anthropic-dangerous-direct-browser-access']) return json(res, 400, { type: 'error', error: { message: 'CORS header missing' } });
    if (p === '/v1/models') return json(res, 200, { data: [{ id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-5' }, { id: 'claude-opus-5-5' }] });
    if (p === '/v1/messages' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      state.claudeCalls.push(body);
      const text = claudeText(body);
      if (body.stream) return sse(res, text, body.model);
      return json(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 60 } });
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end(`mock: no route for ${host}${p}`);
}

function ensureCerts() {
  const dir = path.join(HERE, 'certs');
  if (fs.existsSync(path.join(dir, 'cert.pem'))) return;
  fs.mkdirSync(dir, { recursive: true });
  const san = HOSTS.map((h) => `DNS:${h}`).join(',');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '60', '-subj', '/CN=marginalia-test', '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
}

export function startServer(port = 443) {
  ensureCerts();
  const server = https.createServer({ key: fs.readFileSync(path.join(HERE, 'certs/key.pem')), cert: fs.readFileSync(path.join(HERE, 'certs/cert.pem')) }, (req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export const HOSTS = ['arxiv.org', 'www.arxiv.org', 'export.arxiv.org', 'openreview.net', 'api.openreview.net', 'api2.openreview.net', 'api.semanticscholar.org', 'dblp.org', 'api.anthropic.com'];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then(() => console.log('mock server on 443'));
}
