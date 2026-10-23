import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchiveDB, db, setDb } from '@/lib/db';
import * as repo from '@/lib/repo';
import { getSettings, updateSettings } from '@/lib/settings';
import { s2AuthorSearch, setS2MinGap } from '@/lib/sources/s2';
import { setArxivMinGap } from '@/lib/sources/arxiv';
import { followPaperAuthor, isFollowed, mergeAuthorIds, migrateLegacyFollows, resolveFollow, searchAuthors } from '@/lib/follows';
import { dismissFeedItem, PER_PROJECT, refreshFeed, saveFeedItem } from '@/lib/feed';
import { applyS2 } from '@/lib/enrich';
import { runDaily } from '@/lib/daily';
import { computePriority } from '@/lib/sorting/priority';
import type { FeedItem, Follow, LibraryEntry, Paper } from '@/lib/types';

// ---- chrome.storage and notifications ----
const store = new Map<string, unknown>();
const notifications = { create: vi.fn(async (id: string) => id) };
(globalThis as any).chrome = {
  storage: {
    local: {
      async get(key: string | string[] | null) {
        const keys = key == null ? [...store.keys()] : Array.isArray(key) ? key : [key];
        const out: Record<string, unknown> = {};
        for (const k of keys) if (store.has(k)) out[k] = structuredClone(store.get(k));
        return out;
      },
      async set(obj: Record<string, unknown>) {
        for (const [k, v] of Object.entries(obj)) store.set(k, structuredClone(v));
      },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
  runtime: { getURL: (p: string) => `chrome-extension://test${p}` },
  notifications,
};

// ---- fetch ----
interface Call {
  url: URL;
  method: string;
  body: any;
}
let calls: Call[] = [];
type Route = (url: URL, body: any, method: string) => unknown;
function serve(route: Route) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const r = route(url, body, method);
      if (r instanceof Response) return r;
      if (r === undefined) return new Response('{"error":"Not found"}', { status: 404 });
      if (typeof r === 'string') return new Response(r, { status: 200 });
      return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}
const hit = (u: URL, path: string) => u.hostname === 'api.semanticscholar.org' && u.pathname === path;

// ---- fixtures ----
const meta = { owner: 'u', visibility: 'private' as const, groupId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null };
const DAY = 86_400_000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
const dateDaysAgo = (n: number) => isoDaysAgo(n).slice(0, 10);
const thisYear = new Date().getUTCFullYear();

const paper = (id: string, title: string, abstract: string, extra: Partial<Paper> = {}): Paper => ({
  ...meta, id, aliases: [], source: 'arxiv', title, authors: [{ name: 'Ada Lovelace' }], abstract, year: 2026, published: null, venue: null,
  venueStatus: 'preprint', urls: {}, codeLinks: [], citeKey: id, bibtex: `@misc{${id},}`, bibtexSource: 'arxiv', ...extra,
});
async function addToLibrary(p: Paper, extra: Partial<LibraryEntry> = {}) {
  await repo.putPaper(p);
  await repo.putEntry({ ...(await repo.newEntry(p.id)), ...extra });
}
const feedItem = (id: string, extra: Partial<FeedItem> = {}): FeedItem => ({
  ...meta, id, title: id, authors: [], abstract: '', year: 2026, published: null, venue: null, urls: {}, reasons: [{ kind: 'cites', count: 1 }],
  score: 0.5, status: 'new', foundAt: new Date().toISOString(), ...extra,
});
const vec = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0, 0]; // cosine `cos` with [1, 0, 0, 0]

const AGENT_TITLE = 'Reward shaping for tool-use agents';
const AGENT_ABS = 'Sparse rewards for tool-use agents shaped with planning traces and credit assignment.';

function atom(entries: { id: string; title: string; abstract: string; published: string; authors?: string[] }[]) {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries
    .map(
      (e) => `<entry><id>http://arxiv.org/abs/${e.id}v1</id><published>${e.published}</published><updated>${e.published}</updated>
      <title>${e.title}</title><summary>${e.abstract}</summary>${(e.authors ?? ['Alan Turing']).map((a) => `<author><name>${a}</name></author>`).join('')}
      <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="cs.LG"/></entry>`,
    )
    .join('')}</feed>`;
}

let n = 0;
beforeEach(() => {
  setDb(new ArchiveDB(`feed-test-${++n}`));
  store.clear();
  notifications.create.mockClear();
  setS2MinGap(0);
  setArxivMinGap(0);
  delete (globalThis as any).__ARCHIVE_WEB__;
  serve(() => undefined);
});

// ---------------------------------------------------------------------------

describe('legacy follows', () => {
  it('turns typed names into follow records once', async () => {
    await updateSettings({ followedAuthors: ['Grace Hopper', '  Ada   Lovelace ', '', 'grace hopper'] });
    expect(await migrateLegacyFollows()).toBe(2);
    expect((await repo.listFollows()).map((f) => [f.id, f.name])).toEqual([
      ['name:ada lovelace', 'Ada Lovelace'],
      ['name:grace hopper', 'Grace Hopper'],
    ]);
    expect((await getSettings()).followedAuthors).toEqual([]);
    expect(await migrateLegacyFollows()).toBe(0);
    expect(await repo.listFollows()).toHaveLength(2);
  });

  it('keeps names in any script apart', async () => {
    await updateSettings({ followedAuthors: ['张三', '李四', 'Łukasz Kaiser', 'José Hernández-Orallo'] });
    expect(await migrateLegacyFollows()).toBe(4);
    expect((await repo.listFollows()).map((f) => f.id).sort()).toEqual(['name:jose hernandez orallo', 'name:łukasz kaiser', 'name:张三', 'name:李四']);
  });

  it('keeps names it could not migrate for the next start', async () => {
    const spy = vi.spyOn(repo, 'follow').mockRejectedValueOnce(new Error('disk full'));
    await updateSettings({ followedAuthors: ['Grace Hopper', 'Ada Lovelace'] });
    expect(await migrateLegacyFollows()).toBe(1);
    expect((await getSettings()).followedAuthors).toEqual(['Grace Hopper']);
    spy.mockRestore();
    expect(await migrateLegacyFollows()).toBe(1);
    expect((await getSettings()).followedAuthors).toEqual([]);
  });

  it('does not duplicate an author who is already followed', async () => {
    await repo.follow({ name: 'Grace Hopper', s2AuthorId: 'A1' });
    await updateSettings({ followedAuthors: ['Grace Hopper'] });
    expect(await migrateLegacyFollows()).toBe(0);
    expect((await repo.listFollows()).map((f) => f.id)).toEqual(['s2a:A1']);
  });
});

describe('resolveFollow', () => {
  const hits = [
    { authorId: 'A1', name: 'Wei Wang', paperCount: 900 },
    { authorId: 'A2', name: 'Wei Wang', paperCount: 40, affiliations: ['UT Austin'] },
    { authorId: 'A3', name: 'Wei Wangs', paperCount: 5000 },
  ];
  beforeEach(() => serve((u) => (hit(u, '/graph/v1/author/search') ? { total: 3, data: hits } : undefined)));

  it('prefers the profile that wrote a paper in the library', async () => {
    await addToLibrary(paper('arxiv:2601.00001', 't', 'a', { authors: [{ name: 'W. Wang', s2Id: 'A2' }] }));
    const f = await resolveFollow(await repo.follow({ name: 'wei wang' }));
    expect(f).toMatchObject({ id: 's2a:A2', s2AuthorId: 'A2', name: 'Wei Wang', affiliation: 'UT Austin', paperCount: 40 });
    expect((await repo.listFollows()).map((x) => x.id)).toEqual(['s2a:A2']); // the name-only record is retired
    expect(calls[0].url.searchParams.get('query')).toBe('wei wang');
  });

  it('else takes the exact-name profile with the most papers', async () => {
    const f = await resolveFollow(await repo.follow({ name: 'Wei Wang' }));
    expect(f.s2AuthorId).toBe('A1');
  });

  it('leaves the follow alone when no profile has that name', async () => {
    const f0 = await repo.follow({ name: 'Nobody Atall' });
    expect(await resolveFollow(f0)).toEqual(f0);
    expect((await repo.listFollows()).map((x) => x.id)).toEqual(['name:nobody atall']);
  });
});

describe('author ids on papers', () => {
  it('merges by position when the counts match, else by name', () => {
    const authors = [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }];
    expect(mergeAuthorIds(authors, [{ name: 'A. Lovelace', authorId: 'L' }, { name: 'A. M. Turing', authorId: 'T' }])?.map((a) => a.s2Id)).toEqual(['L', 'T']);
    expect(mergeAuthorIds(authors, [{ name: 'Alan Turing', authorId: 'T' }, { name: 'Someone Else', authorId: 'S' }, { name: 'A. Lovelace', authorId: 'L' }])?.map((a) => a.s2Id)).toEqual(['L', 'T']);
    expect(mergeAuthorIds([{ name: 'Ada Lovelace', s2Id: 'L' }], [{ name: 'Ada Lovelace', authorId: 'L' }])).toBeNull();
  });

  it('applyS2 stores author ids', async () => {
    const p = paper('arxiv:2601.00002', 't', 'a', { authors: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }] });
    await repo.putPaper(p);
    const next = await applyS2(p, { paperId: 'S2P', authors: [{ name: 'Ada Lovelace', authorId: 'L' }, { name: 'Alan Turing', authorId: null }] });
    expect(next.authors).toEqual([{ name: 'Ada Lovelace', s2Id: 'L' }, { name: 'Alan Turing' }]);
    expect(next.s2Id).toBe('S2P');
  });

  it('followPaperAuthor learns the id from the paper on S2', async () => {
    serve((u) => (hit(u, '/graph/v1/paper/S2P') ? { paperId: 'S2P', authors: [{ name: 'Ada Lovelace', authorId: 'L' }, { name: 'Alan Turing', authorId: 'T' }] } : undefined));
    const p = paper('arxiv:2601.00003', 't', 'a', { s2Id: 'S2P', authors: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }] });
    await repo.putPaper(p);
    const f = await followPaperAuthor(p, 1);
    expect(f).toMatchObject({ id: 's2a:T', name: 'Alan Turing' });
    expect((await repo.getPaper(p.id))!.authors.map((a) => a.s2Id)).toEqual(['L', 'T']);
  });

  it('searchAuthors marks followed profiles and counts library papers', async () => {
    serve((u) => (hit(u, '/graph/v1/author/search') ? { data: [{ authorId: 'A1', name: 'Wei Wang' }, { authorId: 'A2', name: 'Wei Wang' }] } : undefined));
    await addToLibrary(paper('arxiv:2601.00004', 't', 'a', { authors: [{ name: 'Wei Wang', s2Id: 'A2' }] }));
    await repo.follow({ name: 'Wei Wang', s2AuthorId: 'A1' });
    const r = await searchAuthors('Wei Wang');
    expect(r.map((x) => [x.authorId, x.followed, x.libraryPapers])).toEqual([
      ['A2', false, 1],
      ['A1', true, 0],
    ]);
  });
});

describe('priority with follows', () => {
  const entry = { ...meta, paperId: 'p', status: 'inbox' as const, statusSetBy: 'auto' as const, willCite: false, projectIds: [], dismissedProjectIds: [], suggestions: [], topicId: null, tags: [], progress: 0, lastOpenedAt: null, priority: 0, priorityReasons: [] };
  const follow = (name: string, s2AuthorId: string | null): Follow => ({ ...meta, id: s2AuthorId ? `s2a:${s2AuthorId}` : `name:${repo.normAuthorName(name)}`, name, s2AuthorId, lastCheckedAt: null });
  const run = (authors: Paper['authors'], follows: Follow[]) =>
    computePriority({ entry, paper: paper('p', 't', 'a', { authors }), projects: new Map(), libraryIds: new Set(), follows });

  it('matches by S2 id even when the names differ', () => {
    expect(run([{ name: 'Grace B. Hopper', s2Id: 'G' }], [follow('Grace Hopper', 'G')]).reasons).toEqual(['By Grace B. Hopper']);
  });
  it('matches by normalized name', () => {
    expect(run([{ name: 'Grace Hopper' }], [follow('grace  hopper', null)]).reasons).toEqual(['By Grace Hopper']);
    expect(run([{ name: 'Grace Hopper', s2Id: 'G' }], [follow('Grace Hopper', null)]).priority).toBeCloseTo(0.2, 3);
  });
  it('does not match a namesake with a different id', () => {
    expect(run([{ name: 'Wei Wang', s2Id: 'A1' }], [follow('Wei Wang', 'A2')]).reasons).toEqual([]);
    expect(isFollowed({ name: 'Wei Wang' }, [follow('Wei Wang', 'A2')])?.id).toBe('s2a:A2');
  });
});

describe('refreshFeed', () => {
  const recs = Array.from({ length: 8 }, (_, i) => ({ paperId: `R${i}`, externalIds: { ArXiv: `2610.1000${i}` }, title: AGENT_TITLE, abstract: AGENT_ABS, year: thisYear, publicationDate: dateDaysAgo(3), authors: [{ name: 'Rec Author', authorId: `RA${i}` }], cos: 0.9 - 0.02 * i }));
  const authorPapers = [
    { paperId: 'AP1', externalIds: { ArXiv: '2610.00001' }, title: 'Compilers for everyone', abstract: 'A compiler.', year: thisYear, publicationDate: dateDaysAgo(5), authors: [{ name: 'Grace Hopper', authorId: 'A1' }, { name: 'Kathleen Booth', authorId: null }] },
    { paperId: 'AP2', title: 'Old compiler paper', abstract: '', year: thisYear, publicationDate: dateDaysAgo(45), authors: [{ name: 'Grace Hopper', authorId: 'A1' }] },
    { paperId: 'AP3', externalIds: { ArXiv: '2601.00010' }, title: 'Already saved', abstract: '', year: thisYear, publicationDate: dateDaysAgo(2), authors: [{ name: 'Grace Hopper', authorId: 'A1' }] },
    { paperId: 'AP4', externalIds: { DOI: '10.1/ABC' }, title: 'Undated but this year', abstract: '', year: thisYear, publicationDate: null, authors: [{ name: 'Grace Hopper', authorId: 'A1' }] },
    { paperId: 'AP5', title: 'Undated, last year', abstract: '', year: thisYear - 1, publicationDate: null, authors: [{ name: 'Grace Hopper', authorId: 'A1' }] },
    { paperId: 'AP6', title: 'Dismissed before', abstract: '', year: thisYear, publicationDate: dateDaysAgo(1), authors: [{ name: 'Grace Hopper', authorId: 'A1' }] },
  ];
  const arxivEntries = [
    { id: '2610.20001', title: AGENT_TITLE, abstract: AGENT_ABS, published: isoDaysAgo(1) }, // fresh, on topic, no embedding yet
    { id: '2610.20002', title: AGENT_TITLE, abstract: AGENT_ABS, published: isoDaysAgo(20) }, // too old
    { id: '2610.20003', title: 'Protein folding with diffusion', abstract: 'Molecular dynamics of proteins in solvent.', published: isoDaysAgo(1) }, // off topic
  ];
  const embeddings = new Map<string, number[]>([
    ...recs.map((r) => [r.paperId, vec(r.cos)] as [string, number[]]),
    ['OFF', [0, 0, 1, 0]],
    ['AP1', [0, 0, 0, 1]],
  ]);

  function route(u: URL, body: any, method: string) {
    if (hit(u, '/graph/v1/author/A1/papers')) return { data: authorPapers };
    if (u.hostname === 'api.semanticscholar.org' && u.pathname === '/recommendations/v1/papers/' && method === 'POST') {
      return {
        recommendedPapers: [
          ...recs.map(({ cos, ...r }) => r),
          { paperId: 'OFF', title: 'Protein folding with diffusion', abstract: 'Molecular dynamics of proteins in solvent.', year: thisYear, publicationDate: dateDaysAgo(2), authors: [] },
          { paperId: 'LIB', externalIds: { ArXiv: '2601.00011' }, title: AGENT_TITLE, abstract: AGENT_ABS, year: thisYear, authors: [] },
          { paperId: 'DIS', title: AGENT_TITLE, abstract: AGENT_ABS, year: thisYear, authors: [] },
        ],
      };
    }
    if (hit(u, '/graph/v1/paper/batch')) return body.ids.map((id: string) => (embeddings.has(id) ? { paperId: id, embedding: { model: 'specter_v2', vector: embeddings.get(id) } } : null));
    if (u.hostname === 'export.arxiv.org' && u.searchParams.get('search_query')) return atom(arxivEntries);
    return undefined;
  }

  async function setup() {
    await repo.follow({ name: 'Grace Hopper', s2AuthorId: 'A1' });
    const project = await repo.createProject({ name: 'Agents', description: 'Reward shaping and credit assignment for tool-use agents.' });
    const s1 = paper('arxiv:2601.00010', AGENT_TITLE, AGENT_ABS, { arxivId: '2601.00010', s2Id: 'M1', primaryCategory: 'cs.LG', s2: { paperId: 'M1', embedding: [1, 0, 0, 0], checkedAt: '' } });
    const s2 = paper('arxiv:2601.00011', 'Credit assignment for web agents', 'Web navigation agents with sparse rewards and tool calls.', { arxivId: '2601.00011', primaryCategory: 'cs.LG', s2: { paperId: 'M2', embedding: [1, 0, 0, 0], checkedAt: '' } });
    await addToLibrary(s1, { projectIds: [project.id] });
    await addToLibrary(s2, { projectIds: [project.id] });
    await repo.addFeedItems([feedItem('s2:AP6', { s2Id: 'AP6', status: 'dismissed' }), feedItem('s2:DIS', { s2Id: 'DIS', status: 'dismissed' })]);
    serve(route);
    return project;
  }

  it('adds papers by followed authors and for projects, skipping what was seen', async () => {
    const project = await setup();
    const report = await refreshFeed();
    expect(report.errors).toEqual([]);
    const items = await repo.listFeed('new');
    const byId = new Map(items.map((i) => [i.id, i] as const));

    // authors: recent and current-year undated papers only; library and dismissed ones skipped
    const authored = items.filter((i) => i.reasons.some((r) => r.kind === 'author')).map((i) => i.id).sort();
    expect(authored).toEqual(['arxiv:2610.00001', 'doi:10.1/abc']);
    const ap1 = byId.get('arxiv:2610.00001')!;
    expect(ap1.reasons).toEqual([{ kind: 'author', followId: 's2a:A1', name: 'Grace Hopper' }]);
    expect(ap1.urls).toEqual({ abs: 'https://arxiv.org/abs/2610.00001', pdf: 'https://arxiv.org/pdf/2610.00001', s2: 'https://www.semanticscholar.org/paper/AP1' });
    expect(ap1.authors[0]).toMatchObject({ name: 'Grace Hopper', s2Id: 'A1' });
    expect(ap1.score).toBeGreaterThanOrEqual(0.6);
    expect(ap1.score).toBeLessThan(0.75); // off-topic for the project
    expect((await repo.listFollows())[0].lastCheckedAt).not.toBeNull();

    // projects: best first, capped, nothing off topic, nothing from the library or dismissed
    const projectIds = items.filter((i) => i.reasons.some((r) => r.kind === 'project')).map((i) => i.id);
    expect(projectIds).toHaveLength(PER_PROJECT);
    expect(projectIds).toContain('arxiv:2610.20001'); // fresh arXiv submission, scored on words
    for (const i of [0, 1, 2, 3]) expect(projectIds).toContain(`arxiv:2610.1000${i}`);
    for (const id of ['s2:OFF', 'arxiv:2601.00011', 's2:DIS', 'arxiv:2610.20002', 'arxiv:2610.20003', 'arxiv:2610.10007']) expect(byId.has(id)).toBe(false);
    const r0 = byId.get('arxiv:2610.10000')!;
    expect(r0.reasons[0]).toMatchObject({ kind: 'project', projectId: project.id });
    expect(r0.embedding).toEqual(vec(0.9));
    expect(r0.score).toBeGreaterThan(byId.get('arxiv:2610.10003')!.score);

    expect(report).toMatchObject({ added: 2 + PER_PROJECT, byAuthor: 2, byProject: PER_PROJECT });

    // requests: dismissed papers are negative examples; one embeddings batch; arXiv by category and terms
    const rec = calls.find((c) => c.url.pathname === '/recommendations/v1/papers/')!;
    expect(rec.body.positivePaperIds.sort()).toEqual(['M1', 'M2']);
    expect(rec.body.negativePaperIds.sort()).toEqual(['AP6', 'DIS']);
    expect(calls.filter((c) => c.url.pathname === '/graph/v1/paper/batch')).toHaveLength(1);
    const q = calls.find((c) => c.url.hostname === 'export.arxiv.org')!;
    expect(q.url.searchParams.get('search_query')).toMatch(/^cat:cs\.LG AND \(abs:".+"( OR abs:".+")*\)$/);
    expect(q.url.searchParams.get('sortBy')).toBe('submittedDate');
  });

  it('suggests the next best papers on the next run', async () => {
    await setup();
    await refreshFeed();
    const again = await refreshFeed();
    expect(again.byAuthor).toBe(0);
    const ids = (await repo.listFeed('new')).filter((i) => i.reasons.some((r) => r.kind === 'project')).map((i) => i.id);
    expect(again.byProject).toBe(4); // R4..R7 were left out of the first run's five
    expect(ids).toHaveLength(PER_PROJECT + 4);
  });

  it('skips arXiv in the web app', async () => {
    (globalThis as any).__ARCHIVE_WEB__ = true;
    await setup();
    const report = await refreshFeed();
    expect(calls.some((c) => c.url.hostname === 'export.arxiv.org')).toBe(false);
    expect(report.byProject).toBe(PER_PROJECT);
  });

  it('does nothing when the feed is off, unless forced', async () => {
    await setup();
    await updateSettings({ feedEnabled: false });
    expect((await refreshFeed()).added).toBe(0);
    expect(calls).toHaveLength(0);
    expect((await refreshFeed({ force: true })).added).toBeGreaterThan(0);
  });

  it('scores author papers at 0.7 without projects and prunes old unread suggestions', async () => {
    await repo.follow({ name: 'Grace Hopper', s2AuthorId: 'A1' });
    await repo.addFeedItems([
      feedItem('arxiv:old-new', { foundAt: isoDaysAgo(61) }),
      feedItem('arxiv:old-saved', { foundAt: isoDaysAgo(61), status: 'saved' }),
    ]);
    serve(route);
    await refreshFeed();
    const items = await repo.listFeed();
    expect(items.find((i) => i.id === 'arxiv:2610.00001')?.score).toBe(0.7);
    expect(items.some((i) => i.id === 'arxiv:old-new')).toBe(false);
    expect(items.some((i) => i.id === 'arxiv:old-saved')).toBe(true);
    expect((await db().feed.get('arxiv:old-new'))?.deletedAt).not.toBeNull();
  });

  it('resolves name-only follows before checking them', async () => {
    await repo.follow({ name: 'Grace Hopper' });
    serve((u, b, m) => (hit(u, '/graph/v1/author/search') ? { data: [{ authorId: 'A1', name: 'Grace Hopper', paperCount: 10 }] } : route(u, b, m)));
    const report = await refreshFeed();
    expect(report.byAuthor).toBe(4); // nothing in the library or dismissed here: AP1, AP3, AP4, AP6
    expect((await repo.listFollows()).map((f) => f.id)).toEqual(['s2a:A1']);
  });
});

describe('acting on suggestions', () => {
  it('saveFeedItem saves an arXiv suggestion into the library and marks it saved', async () => {
    serve((u) =>
      u.hostname === 'export.arxiv.org' && u.searchParams.get('id_list') === '2610.00001'
        ? atom([{ id: '2610.00001', title: 'Compilers for everyone', abstract: 'A compiler.', published: isoDaysAgo(5), authors: ['Grace Hopper', 'Kathleen Booth'] }])
        : undefined,
    );
    await repo.addFeedItems([
      feedItem('arxiv:2610.00001', { arxivId: '2610.00001', s2Id: 'AP1', title: 'Compilers for everyone', authors: [{ name: 'Grace Hopper', s2Id: 'A1' }, { name: 'Kathleen Booth' }] }),
    ]);
    const id = await saveFeedItem('arxiv:2610.00001');
    expect(id).toBe('arxiv:2610.00001');
    expect(await repo.getEntry(id)).toBeTruthy();
    const p = (await repo.getPaper(id))!;
    expect(p.title).toBe('Compilers for everyone');
    expect(p.authors.map((a) => a.s2Id)).toEqual(['A1', undefined]);
    expect((await repo.getFeedItem('arxiv:2610.00001'))!.status).toBe('saved');
  });

  it('saveFeedItem saves a Semantic Scholar only suggestion', async () => {
    serve((u) =>
      hit(u, '/graph/v1/paper/AP4')
        ? { paperId: 'AP4', externalIds: { DOI: '10.1/ABC' }, title: 'Undated but this year', abstract: 'x', year: thisYear, venue: 'Journal of Things', authors: [{ name: 'Grace Hopper', authorId: 'A1' }] }
        : undefined,
    );
    await repo.addFeedItems([feedItem('doi:10.1/abc', { s2Id: 'AP4', doi: '10.1/abc', title: 'Undated but this year' })]);
    const id = await saveFeedItem('doi:10.1/abc');
    expect(id).toBe('doi:10.1/abc');
    expect(await repo.getEntry(id)).toBeTruthy();
    expect((await repo.getFeedItem(id))!.status).toBe('saved');
  });

  it('saveFeedItem reuses a paper that is already saved under another id', async () => {
    await repo.putPaper(paper('arxiv:2610.00009', 't', 'a', { aliases: ['s2:X9'] }));
    await repo.addFeedItems([feedItem('s2:X9', { s2Id: 'X9' })]);
    expect(await saveFeedItem('s2:X9')).toBe('arxiv:2610.00009');
    expect(calls).toHaveLength(0);
  });

  it('dismissFeedItem marks the item dismissed', async () => {
    await repo.addFeedItems([feedItem('s2:Z')]);
    await dismissFeedItem('s2:Z');
    expect((await repo.getFeedItem('s2:Z'))!.status).toBe('dismissed');
  });
});

describe('daily check', () => {
  it('runs the feed and notifies when asked to', async () => {
    await updateSettings({ feedNotify: true });
    await repo.follow({ name: 'Grace Hopper', s2AuthorId: 'A1' });
    serve((u) =>
      hit(u, '/graph/v1/author/A1/papers')
        ? { data: [{ paperId: 'AP1', externalIds: { ArXiv: '2610.00001' }, title: 'Compilers for everyone', abstract: '', year: thisYear, publicationDate: dateDaysAgo(5), authors: [] }] }
        : undefined,
    );
    const report = await runDaily();
    expect(report?.feed).toEqual({ added: 1, byAuthor: 1, byProject: 0 });
    expect(notifications.create).toHaveBeenCalledTimes(1);
    expect(notifications.create.mock.calls[0][0]).toBe('mg-feed');
    expect((notifications.create.mock.calls[0] as any[])[1].message).toBe('1 new paper in For you');
  });
});

describe('network', () => {
  it('retries a CORS-blocked rate limit (TypeError) with backoff', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (n++ === 0) throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ data: [{ authorId: 'A1', name: 'Grace Hopper' }] }), { status: 200 });
      }),
    );
    vi.useFakeTimers();
    try {
      const p = s2AuthorSearch('Grace Hopper');
      await vi.advanceTimersByTimeAsync(5000);
      expect((await p).map((h) => h.authorId)).toEqual(['A1']);
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
