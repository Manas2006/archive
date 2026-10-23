// Daily background check: venue upgrades, embeddings and references for new
// papers, topic re-clustering, inbox priority, and the "For you" feed.

import { isWebApp } from './platform';
import * as repo from './repo';
import { applyS2, rescoreLibrary, updatePriorities } from './enrich';
import { refreshFeed } from './feed';
import { getSettings } from './settings';
import { fetchReviews } from './sources/openreview';
import { canonicalFromS2, s2Batch, s2References, S2_FIELDS, toS2Id } from './sources/s2';
import { reclusterTopics } from './topics';
import { checkVenue, type VenueUpgrade } from './venue';
import { nowIso } from './ids';

export interface DailyReport {
  ranAt: string;
  checked: number;
  upgrades: VenueUpgrade[];
  embeddingsAdded: number;
  referencesAdded: number;
  topics: number;
  /** New "For you" papers (absent when the feed is off, and in reports saved before v0.3). */
  feed?: { added: number; byAuthor: number; byProject: number };
  errors: string[];
}

export const FEED_NOTIFICATION_ID = 'mg-feed';

function notifyFeed(n: number) {
  if (typeof chrome === 'undefined' || !chrome.notifications?.create) return;
  try {
    const p = chrome.notifications.create(FEED_NOTIFICATION_ID, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('/icon/128.png'),
      title: 'Archive',
      message: `${n} new paper${n === 1 ? '' : 's'} in For you`,
      priority: 0,
    }) as unknown;
    if (p && typeof (p as Promise<unknown>).catch === 'function') (p as Promise<unknown>).catch(() => {});
  } catch {
    /* notifications unavailable */
  }
}

const LAST_KEY = 'lastDailyReport';

export async function lastDailyReport(): Promise<DailyReport | null> {
  return ((await chrome.storage.local.get(LAST_KEY))[LAST_KEY] as DailyReport | undefined) ?? null;
}

export async function runDaily(opts: { force?: boolean; onUpgrade?: (u: VenueUpgrade) => void } = {}): Promise<DailyReport | null> {
  const s = await getSettings();
  if (!s.dailyChecks && !opts.force) return null;
  const report: DailyReport = { ranAt: nowIso(), checked: 0, upgrades: [], embeddingsAdded: 0, referencesAdded: 0, topics: 0, errors: [] };
  const entries = await repo.listEntries();
  let papers = await repo.getPapers(entries.map((e) => e.paperId));

  // 1. One batch call for metadata + embeddings
  const lookups = papers.map((p) => ({ p, id: p.s2Id ?? toS2Id(p.id) ?? p.aliases.map(toS2Id).find(Boolean) ?? null })).filter((x) => x.id);
  try {
    const res = await s2Batch(lookups.map((x) => x.id!), `${S2_FIELDS},embedding.specter_v2`);
    for (let i = 0; i < lookups.length; i++) {
      const s2 = res[i];
      if (!s2) continue;
      report.checked++;
      let paper = await applyS2(lookups[i].p, s2);
      if (!paper.s2?.embedding && s2.embedding?.vector?.length) {
        paper = (await repo.updatePaper(paper.id, { s2: { ...paper.s2!, embedding: s2.embedding.vector } }, { derived: true })) ?? paper;
        report.embeddingsAdded++;
      }
      if (paper.venueStatus !== 'accepted' || paper.bibtexSource === 'arxiv') {
        try {
          const up = await checkVenue(paper, s2);
          if (up) {
            report.upgrades.push(up);
            opts.onUpgrade?.(up);
          }
        } catch (e) {
          report.errors.push(`venue ${paper.id}: ${(e as Error).message}`);
        }
      }
    }
  } catch (e) {
    report.errors.push(`Semantic Scholar: ${(e as Error).message}`);
  }

  // 2. References for a limited number of papers per day (rate limits)
  papers = await repo.getPapers(entries.map((e) => e.paperId));
  const needRefs = papers.filter((p) => p.s2?.paperId && !p.s2.referenceIds).slice(0, 15);
  for (const p of needRefs) {
    try {
      const refs = await s2References(p.s2!.paperId);
      const ids = refs.flatMap((r) => [canonicalFromS2(r), `s2:${r.paperId}`]);
      await repo.updatePaper(p.id, { s2: { ...p.s2!, referenceIds: [...new Set(ids)] } }, { derived: true });
      report.referencesAdded++;
    } catch (e) {
      report.errors.push(`references ${p.id}: ${(e as Error).message}`);
      break;
    }
  }

  // 3. OpenReview papers still under review: refresh scores/decision
  // (the web app can't reach OpenReview: it doesn't allow cross-site requests)
  for (const p of isWebApp() ? [] : papers.filter((x) => x.openreviewId && x.venueStatus === 'under-review').slice(0, 10)) {
    const review = await fetchReviews(p.openreviewId!, p.venue ?? 'OpenReview').catch(() => null);
    if (review && (review.decision !== p.review?.decision || review.scores.length !== p.review?.scores.length)) {
      await repo.updatePaper(p.id, { review: { ...review, summary: p.review?.summary } }, { derived: true });
    }
  }

  // 4. Topics and priority
  try {
    report.topics = (await reclusterTopics()).topics;
  } catch (e) {
    report.errors.push(`topics: ${(e as Error).message}`);
  }
  await rescoreLibrary().catch((e) => report.errors.push(`relevance: ${(e as Error).message}`));
  await updatePriorities().catch((e) => report.errors.push(`priority: ${(e as Error).message}`));

  // 5. "For you": new papers by followed authors and for each project
  if (s.feedEnabled) {
    try {
      const f = await refreshFeed();
      report.feed = { added: f.added, byAuthor: f.byAuthor, byProject: f.byProject };
      report.errors.push(...f.errors.map((e) => `For you: ${e}`));
      if (s.feedNotify && f.added > 0) notifyFeed(f.added);
    } catch (e) {
      report.errors.push(`For you: ${(e as Error).message}`);
    }
  }

  await chrome.storage.local.set({ [LAST_KEY]: report });
  return report;
}
