import { fetchJson, HttpError } from '../net';
import type { ReviewInfo, ReviewScore } from '../types';

export interface OpenReviewMeta {
  id: string;
  title: string;
  authors: string[];
  abstract: string;
  venue: string | null;
  venueId: string | null;
  status: 'accepted' | 'rejected' | 'under-review' | 'unknown';
  bibtex?: string;
  pdfUrl?: string;
  published: string | null;
  year: number | null;
  keywords: string[];
}

const val = (x: any): any => (x && typeof x === 'object' && 'value' in x ? x.value : x);

function noteToMeta(note: any): OpenReviewMeta {
  const c = note.content ?? {};
  const venue: string | null = val(c.venue) ?? null;
  const venueId: string | null = val(c.venueid) ?? null;
  let status: OpenReviewMeta['status'] = 'unknown';
  if ((venueId && /Rejected|Withdrawn/i.test(venueId)) || (venue && /Withdrawn|Rejected/i.test(venue))) status = 'rejected';
  else if ((venue && /submitted|under review|preprint/i.test(venue)) || (venueId && /Submission/i.test(venueId))) status = 'under-review';
  else if (venue && venueId) status = 'accepted';
  const ts = note.pdate ?? note.odate ?? note.cdate ?? note.tcdate;
  const published = ts ? new Date(ts).toISOString() : null;
  const pdf = val(c.pdf);
  const yearInVenue = venue?.match(/\b(19|20)\d{2}\b/)?.[0];
  return {
    id: note.forum ?? note.id,
    title: String(val(c.title) ?? '').replace(/\s+/g, ' ').trim(),
    authors: (val(c.authors) ?? []) as string[],
    abstract: String(val(c.abstract) ?? '').trim(),
    venue,
    venueId,
    status,
    bibtex: val(c._bibtex) ?? undefined,
    pdfUrl: pdf ? (String(pdf).startsWith('http') ? pdf : `https://openreview.net${pdf}`) : undefined,
    published,
    year: yearInVenue ? Number(yearInVenue) : published ? new Date(published).getFullYear() : null,
    keywords: (val(c.keywords) ?? []) as string[],
  };
}

async function getNotes(params: string): Promise<{ notes: any[]; api: 1 | 2 }> {
  try {
    const r = await fetchJson<{ notes: any[] }>(`https://api2.openreview.net/notes?${params}`);
    if (r.notes?.length) return { notes: r.notes, api: 2 };
  } catch (e) {
    if (!(e instanceof HttpError) || e.status >= 500) throw e;
  }
  const r = await fetchJson<{ notes: any[] }>(`https://api.openreview.net/notes?${params}`);
  return { notes: r.notes ?? [], api: 1 };
}

export async function fetchOpenReview(id: string): Promise<OpenReviewMeta | null> {
  const { notes } = await getNotes(`id=${encodeURIComponent(id)}`);
  if (!notes.length) return null;
  return noteToMeta(notes[0]);
}

function invitationsOf(note: any): string[] {
  if (Array.isArray(note.invitations)) return note.invitations;
  if (note.invitation) return [note.invitation];
  return [];
}

const firstNumber = (x: unknown): number | null => {
  if (typeof x === 'number') return x;
  const m = String(x ?? '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

const RATING_FIELDS = ['rating', 'recommendation', 'overall_rating', 'overall_assessment', 'overall_recommendation', 'score', 'final_rating'];
const TEXT_FIELDS = ['summary', 'strengths', 'weaknesses', 'questions', 'limitations', 'main_review', 'review', 'summary_of_the_review', 'strengths_and_weaknesses', 'comment', 'rebuttal', 'metareview', 'decision'];

/** Fetch scores, decision, and a text digest of reviews + author responses for a forum. */
export async function fetchReviews(forumId: string, venueLabel: string): Promise<ReviewInfo | null> {
  const { notes } = await getNotes(`forum=${encodeURIComponent(forumId)}&limit=1000`);
  if (!notes.length) return null;
  const scores: ReviewScore[] = [];
  let decision: string | null = null;
  const reviewTexts: string[] = [];
  const responseTexts: string[] = [];
  let metaReview = '';
  for (const n of notes) {
    // API v2 notes edited after creation list several invitations (…/-/Official_Review, …/-/Edit)
    const invs = invitationsOf(n);
    const has = (re: RegExp) => invs.some((i) => re.test(i));
    const c = n.content ?? {};
    const sig = (n.signatures ?? []).join(' ');
    const text = TEXT_FIELDS.map((f) => (val(c[f]) ? `${f}: ${val(c[f])}` : ''))
      .filter(Boolean)
      .join('\n');
    if (has(/\/Decision$/) || (val(c.decision) && !has(/Review/))) {
      decision = String(val(c.decision) ?? decision);
    } else if (has(/Meta_Review$/)) {
      metaReview = text;
    } else if (has(/(Official_Review|\/Review)$/)) {
      const ratingKey = RATING_FIELDS.find((f) => c[f] !== undefined);
      const rawRating = ratingKey ? val(c[ratingKey]) : null;
      const reviewer = (sig.match(/Reviewer_\w+/) ?? sig.match(/AnonReviewer\d+/))?.[0] ?? `Reviewer ${scores.length + 1}`;
      scores.push({
        reviewer: reviewer.replace(/_/g, ' '),
        rating: firstNumber(rawRating),
        ratingText: rawRating != null ? String(rawRating) : undefined,
        confidence: firstNumber(val(c.confidence)),
      });
      reviewTexts.push(`### ${reviewer}\n${text}`);
    } else if (/Authors/.test(sig) && has(/(Official_Comment|Rebuttal|Author)/)) {
      responseTexts.push(text);
    }
  }
  const rated = scores.filter((s) => s.rating !== null);
  const avg = rated.length ? rated.reduce((a, s) => a + (s.rating as number), 0) / rated.length : null;
  const digest = [
    reviewTexts.length ? `## Reviews\n${reviewTexts.join('\n\n')}` : '',
    metaReview ? `## Meta-review\n${metaReview}` : '',
    responseTexts.length ? `## Author responses\n${responseTexts.join('\n\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 60000);
  if (!scores.length && !decision) return null;
  return {
    venue: venueLabel,
    decision,
    scores,
    avgRating: avg !== null ? Math.round(avg * 100) / 100 : null,
    digest,
    fetchedAt: new Date().toISOString(),
  };
}
