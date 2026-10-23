// Automatic topics: cluster the library, keep pinned topics stable, and name
// new groups with Claude (AI on) or their top keywords (AI off).

import { nameTopics } from './ai/features';
import * as repo from './repo';
import { aiAvailable, getSettings } from './settings';
import { clusterPapers, nearestTopic, overlap } from './sorting/cluster';
import { Corpus, paperDoc } from './sorting/tfidf';
import { uuid } from './ids';
import type { LibraryEntry, Paper, Topic } from './types';

const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

export function keywordName(keywords: string[]): string {
  return keywords.slice(0, 2).map(titleCase).join(' & ') || 'Misc';
}

async function load() {
  const entries = await repo.listEntries();
  const papers = new Map((await repo.getPapers(entries.map((e) => e.paperId))).map((p) => [p.id, p] as const));
  const topics = await repo.listTopics();
  return { entries, papers, topics };
}

function members(topicId: string, entries: LibraryEntry[]) {
  return entries.filter((e) => e.topicId === topicId).map((e) => e.paperId);
}

export async function reclusterTopics(): Promise<{ topics: number }> {
  const s = await getSettings();
  const { entries, papers, topics } = await load();
  const pinned = topics.filter((t) => t.pinned);
  const pinnedIds = new Set(pinned.map((t) => t.id));
  const free = entries.filter((e) => !(e.topicId && pinnedIds.has(e.topicId)));
  const freePapers = free.map((e) => papers.get(e.paperId)).filter((p): p is Paper => !!p);
  const corpus = new Corpus([...papers.values()].map(paperDoc));
  const oldUnpinned = topics.filter((t) => !t.pinned).map((t) => ({ topic: t, memberIds: members(t.id, entries) }));

  if (freePapers.length < 6) {
    // too few to cluster: attach to the nearest existing topic if any is close
    const pool = topics.map((t) => ({ id: t.id, memberIds: members(t.id, entries) }));
    for (const e of free) {
      const p = papers.get(e.paperId);
      if (!p) continue;
      const near = nearestTopic(p, pool, papers, corpus);
      if ((near?.topicId ?? null) !== e.topicId) await repo.updateEntry(e.paperId, { topicId: near?.topicId ?? null });
    }
    return { topics: topics.length };
  }

  const { groups } = clusterPapers(freePapers, corpus);
  const used = new Set<string>();
  const assigned: { topic: Topic; paperIds: string[]; keywords: string[]; needsName: boolean }[] = [];
  for (const g of groups) {
    let best: (typeof oldUnpinned)[number] | null = null;
    let bestOv = 0.4;
    for (const o of oldUnpinned) {
      if (used.has(o.topic.id)) continue;
      const ov = overlap(o.memberIds, g.paperIds);
      if (ov >= bestOv) {
        bestOv = ov;
        best = o;
      }
    }
    if (best) {
      used.add(best.topic.id);
      const keepName = best.topic.nameSource !== 'keywords';
      assigned.push({
        topic: { ...best.topic, keywords: g.keywords, name: keepName ? best.topic.name : keywordName(g.keywords) },
        paperIds: g.paperIds,
        keywords: g.keywords,
        needsName: !keepName,
      });
    } else {
      assigned.push({
        topic: { ...(await repo.newMeta()), id: uuid(), name: keywordName(g.keywords), nameSource: 'keywords', keywords: g.keywords, pinned: false },
        paperIds: g.paperIds,
        keywords: g.keywords,
        needsName: true,
      });
    }
  }

  if (aiAvailable(s)) {
    const need = assigned.filter((a) => a.needsName);
    if (need.length) {
      try {
        const names = await nameTopics(need.map((a) => ({ titles: a.paperIds.map((id) => papers.get(id)?.title ?? ''), keywords: a.keywords })));
        need.forEach((a, i) => {
          if (names[i]) a.topic = { ...a.topic, name: names[i], nameSource: 'ai' };
        });
      } catch (e) {
        console.warn('[archive] topic naming failed', e);
      }
    }
  }

  for (const a of assigned) await repo.putTopic(a.topic);
  for (const o of oldUnpinned) if (!used.has(o.topic.id)) await repo.deleteTopic(o.topic.id);

  const newTopicOf = new Map<string, string>();
  for (const a of assigned) for (const id of a.paperIds) newTopicOf.set(id, a.topic.id);
  for (const e of free) {
    const t = newTopicOf.get(e.paperId) ?? null;
    if (t !== e.topicId) await repo.updateEntry(e.paperId, { topicId: t });
  }
  return { topics: pinned.length + assigned.length };
}

/** Place one newly saved paper into an existing topic (if one is close). */
export async function assignTopic(paperId: string): Promise<void> {
  const { entries, papers, topics } = await load();
  const entry = entries.find((e) => e.paperId === paperId);
  const paper = papers.get(paperId);
  if (!entry || !paper || entry.topicId || !topics.length) return;
  const corpus = new Corpus([...papers.values()].map(paperDoc));
  const near = nearestTopic(paper, topics.map((t) => ({ id: t.id, memberIds: members(t.id, entries) })), papers, corpus);
  if (near) await repo.updateEntry(paperId, { topicId: near.topicId });
}

export async function mergeTopics(intoId: string, fromId: string): Promise<void> {
  const entries = await repo.listEntries();
  for (const e of entries) if (e.topicId === fromId) await repo.updateEntry(e.paperId, { topicId: intoId });
  await repo.deleteTopic(fromId);
}
