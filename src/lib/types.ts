// Core data model. Shared, shareable records (papers, annotations) are kept
// separate from personal ones (library entries, projects, topics, threads) so
// annotations can later be synced to a lab without exposing a reading list.

export type Visibility = 'private' | 'group' | 'public';

/** Fields every syncable record carries, so a lab backend can be added later. */
export interface SyncMeta {
  owner: string; // local user id (uuid) until accounts exist
  visibility: Visibility;
  groupId: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  deletedAt: string | null; // soft delete
}

export interface Author {
  name: string; // "First Last" as shown on the paper
  family?: string;
  given?: string;
}

export interface ReviewScore {
  reviewer: string;
  rating: number | null;
  ratingText?: string;
  confidence: number | null;
}

export interface ReviewInfo {
  venue: string;
  decision: string | null;
  scores: ReviewScore[];
  avgRating: number | null;
  /** Raw review text kept so an AI summary can be generated later. */
  digest?: string;
  summary?: string; // AI summary (only when AI features are on)
  fetchedAt: string;
}

export interface ExtractedFields {
  task: string;
  benchmarks: string[];
  models: string[];
  metrics: string[];
  headlineResult: string;
  source: 'ai' | 'manual';
  updatedAt: string;
}

export type PaperSource = 'arxiv' | 'openreview' | 'doi' | 's2';

/** Public metadata about a paper. Identified by a canonical id that every user derives the same way. */
export interface Paper extends SyncMeta {
  id: string; // 'arxiv:2401.12345' | 'openreview:abcXYZ' | 'doi:10.x/y' | 's2:<sha>'
  aliases: string[]; // every other id this paper is known by
  source: PaperSource;
  title: string;
  authors: Author[];
  abstract: string;
  year: number | null;
  published: string | null; // ISO date
  arxivId?: string; // without version
  arxivVersion?: number; // latest version we know of
  primaryCategory?: string;
  comments?: string;
  doi?: string;
  openreviewId?: string;
  s2Id?: string;
  dblpKey?: string;
  venue: string | null; // e.g. "NeurIPS 2024"; null while a preprint
  venueStatus: 'preprint' | 'accepted' | 'rejected' | 'under-review' | 'unknown';
  urls: { abs?: string; pdf?: string; html?: string; openreview?: string; s2?: string };
  codeLinks: string[];
  citeKey: string;
  bibtex: string;
  bibtexSource: 'arxiv' | 'openreview' | 'dblp' | 's2' | 'manual';
  review?: ReviewInfo;
  extracted?: ExtractedFields;
  s2?: {
    paperId: string;
    citationCount?: number;
    referenceIds?: string[]; // canonical ids (arxiv:/doi:/s2:) of references
    embedding?: number[]; // SPECTER v2
    checkedAt: string;
  };
  firstFigureUrl?: string;
}

export type ReadingStatus = 'inbox' | 'toread' | 'reading' | 'read';

export const READING_STATUSES: { id: ReadingStatus; label: string }[] = [
  { id: 'inbox', label: 'Inbox' },
  { id: 'toread', label: 'To read' },
  { id: 'reading', label: 'Reading' },
  { id: 'read', label: 'Read' },
];

export interface ProjectSuggestion {
  projectId: string;
  score: number;
}

/** Personal reading-list entry. Never shared. */
export interface LibraryEntry extends SyncMeta {
  paperId: string;
  status: ReadingStatus;
  statusSetBy: 'user' | 'auto';
  willCite: boolean;
  projectIds: string[];
  dismissedProjectIds: string[];
  suggestions: ProjectSuggestion[];
  topicId: string | null;
  tags: string[];
  progress: number; // 0..1 max scroll depth
  lastOpenedAt: string | null;
  priority: number; // 0..1, used to order the inbox
  priorityReasons: string[];
  factoidFigure?: { kind: 'url'; url: string } | { kind: 'attachment'; id: string };
}

export interface Project extends SyncMeta {
  id: string;
  name: string;
  description: string;
  seedPaperIds: string[];
  color: string;
}

export interface Topic extends SyncMeta {
  id: string;
  name: string;
  nameSource: 'ai' | 'keywords' | 'user';
  keywords: string[];
  pinned: boolean;
  centroid?: number[];
}

// ---- Annotations: W3C Web Annotation Data Model (https://www.w3.org/TR/annotation-model/) ----

export type HighlightLabel = 'plain' | 'problem' | 'method' | 'result' | 'interesting' | 'weakness';

export const HIGHLIGHT_LABELS: { id: HighlightLabel; name: string; key: string }[] = [
  { id: 'plain', name: 'Highlight', key: '1' },
  { id: 'problem', name: 'Problem', key: '2' },
  { id: 'method', name: 'Method', key: '3' },
  { id: 'result', name: 'Result', key: '4' },
  { id: 'interesting', name: 'Interesting', key: '5' },
  { id: 'weakness', name: 'Weakness', key: '6' },
];

export interface TextQuoteSelector {
  type: 'TextQuoteSelector';
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TextPositionSelector {
  type: 'TextPositionSelector';
  start: number;
  end: number;
}

export type Selector = TextQuoteSelector | TextPositionSelector;

export type Medium = 'html' | 'pdf';

export interface AnnotationTarget {
  source: string; // canonical paper id
  /** Absent for paper-level notes. */
  selector?: Selector[];
  state?: { medium: Medium; version?: number; page?: number };
}

export interface TextualBody {
  type: 'TextualBody';
  purpose: 'commenting' | 'tagging';
  value: string;
  format?: 'text/markdown' | 'text/plain';
}

export interface Annotation extends SyncMeta {
  id: string; // 'urn:uuid:...'
  type: 'Annotation';
  paperId: string;
  motivation: 'highlighting' | 'commenting';
  body: TextualBody[];
  target: AnnotationTarget;
  creator: { id: string; name: string };
}

export interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export type ThreadKind = 'explain' | 'evidence' | 'compare' | 'symbol' | 'chat';

export interface Thread extends SyncMeta {
  id: string;
  paperId: string;
  kind: ThreadKind;
  title: string;
  quote?: string; // passage the thread is about
  annotationId?: string;
  comparePaperId?: string;
  messages: ThreadMessage[];
}

export interface FullText {
  paperId: string;
  medium: Medium;
  version: number | null;
  text: string;
  savedAt: string;
}

export interface Attachment {
  id: string;
  paperId: string;
  kind: 'figure';
  mime: string;
  dataUrl: string;
  caption: string;
  createdAt: string;
}

export interface ChangeRecord {
  seq?: number;
  table: string;
  key: string;
  op: 'put' | 'delete';
  at: string;
  synced: 0 | 1;
}

// ---- Page context reported by content scripts and the reader ----

export type PageKind = 'arxiv-abs' | 'arxiv-html' | 'arxiv-pdf' | 'openreview-forum' | 'openreview-pdf' | 'reader';

export interface PageMeta {
  title?: string;
  authors?: string[];
  abstract?: string;
  published?: string;
  comments?: string;
  firstFigureUrl?: string;
  codeLinks?: string[];
}

export interface TabContext {
  kind: PageKind;
  url: string;
  paperId: string | null; // canonical id derived from the URL
  version?: number;
  title?: string;
  medium?: Medium;
}
