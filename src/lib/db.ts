import Dexie, { type Table } from 'dexie';
import type {
  Annotation,
  Attachment,
  ChangeRecord,
  FullText,
  LibraryEntry,
  Paper,
  Project,
  Thread,
  Topic,
} from './types';

export class MarginaliaDB extends Dexie {
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
  }
}

let instance: MarginaliaDB | null = null;

export function db(): MarginaliaDB {
  if (!instance) instance = new MarginaliaDB();
  return instance;
}

/** For tests. */
export function setDb(d: MarginaliaDB) {
  instance = d;
}
