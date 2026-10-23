import Dexie, { type Table } from 'dexie';
import type {
  Annotation,
  Attachment,
  ChangeRecord,
  FeedItem,
  Follow,
  FullText,
  LibraryEntry,
  Paper,
  Project,
  Thread,
  Topic,
} from './types';

export class ArchiveDB extends Dexie {
  papers!: Table<Paper, string>;
  library!: Table<LibraryEntry, string>;
  annotations!: Table<Annotation, string>;
  projects!: Table<Project, string>;
  topics!: Table<Topic, string>;
  threads!: Table<Thread, string>;
  fulltext!: Table<FullText, [string, string]>;
  attachments!: Table<Attachment, string>;
  changes!: Table<ChangeRecord, number>;
  kv!: Table<{ key: string; value: unknown }, string>;
  follows!: Table<Follow, string>;
  feed!: Table<FeedItem, string>;

  constructor(name = 'marginalia') {
    super(name);
    this.version(1).stores({
      papers: 'id, *aliases, citeKey, updatedAt',
      library: 'paperId, status, updatedAt, *projectIds, topicId',
      annotations: 'id, paperId, updatedAt',
      projects: 'id, updatedAt',
      topics: 'id, updatedAt',
      threads: 'id, paperId, updatedAt',
      fulltext: '[paperId+medium], paperId',
      attachments: 'id, paperId',
      changes: '++seq, synced, table',
    });
    // v2: extension-only key/value store (the API key lives here, out of reach of content scripts)
    this.version(2).stores({ kv: 'key' });
    // v3: followed authors and the "For you" feed
    this.version(3).stores({ follows: 'id, s2AuthorId, updatedAt', feed: 'id, status, foundAt, updatedAt' });
  }
}

let instance: ArchiveDB | null = null;

export function db(): ArchiveDB {
  if (!instance) instance = new ArchiveDB();
  return instance;
}

/** For tests. */
export function setDb(d: ArchiveDB) {
  instance = d;
}
