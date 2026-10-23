// RPC handlers, run in the background service worker.

import { savePaper, type SaveInput } from '../capture';
import { enqueueEnrich } from '../enrich';
import { readerUrl } from '../ids';
import * as repo from '../repo';
import { aiAvailable, getSettings } from '../settings';
import type { Annotation, FullText, LibraryEntry, Paper, Project, ReadingStatus, TabContext } from '../types';
import { lookupCitation, saveFromS2 } from '../citations';
import { refreshFeed, saveFeedItem } from '../feed';
import { autoSavePdf } from './services';

export interface RpcCtx {
  tabId?: number;
  windowId?: number;
  url?: string;
}

export interface PaperState {
  paper: Paper | null;
  entry: LibraryEntry | null;
  annotations: Annotation[];
  projects: Project[];
  ai: boolean;
}

const STATUS_RANK: Record<ReadingStatus, number> = { inbox: 0, toread: 1, reading: 2, read: 3 };

/** Tabs whose next PDF navigation should not be redirected to the reader. */
export const bypassReader = new Set<number>();

export const handlers = {
  async savePaper(_ctx: RpcCtx, input: SaveInput) {
    const res = await savePaper(input);
    void enqueueEnrich(res.paper.id);
    if (res.created) void autoSavePdf(res.paper.id);
    return { paperId: res.paper.id, created: res.created };
  },

  async getPaperState(_ctx: RpcCtx, paperId: string): Promise<PaperState> {
    const paper = (await repo.getPaper(paperId)) ?? null;
    const id = paper?.id ?? paperId;
    const [entry, annotations, projects, settings] = await Promise.all([
      repo.getEntry(id),
      repo.listAnnotations(id),
      repo.listProjects(),
      getSettings(),
    ]);
    return { paper, entry: entry ?? null, annotations, projects, ai: aiAvailable(settings) };
  },

  async updateEntry(_ctx: RpcCtx, paperId: string, patch: Partial<LibraryEntry>) {
    return (await repo.updateEntry(paperId, patch)) ?? null;
  },

  async removeFromLibrary(_ctx: RpcCtx, paperId: string) {
    await repo.removeFromLibrary(paperId);
    return true;
  },

  async listAnnotations(_ctx: RpcCtx, paperId: string) {
    return repo.listAnnotations(paperId);
  },

  /** Creating an annotation saves the paper first if needed. */
  async createAnnotation(_ctx: RpcCtx, input: repo.NewAnnotation, save?: SaveInput) {
    let paperId = input.paperId;
    const existing = await repo.getPaper(paperId);
    if (!existing || !(await repo.getEntry(existing.id))) {
      const res = await savePaper(save ?? { paperId });
      paperId = res.paper.id;
      if (res.created) {
        await repo.updateEntry(paperId, { status: 'reading', statusSetBy: 'auto' });
        void enqueueEnrich(paperId);
        void autoSavePdf(paperId);
      }
    } else paperId = existing.id;
    return repo.createAnnotation({ ...input, paperId, target: { ...input.target, source: paperId } });
  },

  async updateAnnotation(_ctx: RpcCtx, id: string, patch: Partial<Annotation>) {
    return (await repo.updateAnnotation(id, patch)) ?? null;
  },

  async setAnnotationLabel(_ctx: RpcCtx, id: string, label: string) {
    return (await repo.setAnnotationLabel(id, label)) ?? null;
  },

  async setAnnotationNote(_ctx: RpcCtx, id: string, note: string) {
    return (await repo.setAnnotationNote(id, note)) ?? null;
  },

  async deleteAnnotation(_ctx: RpcCtx, id: string) {
    await repo.deleteAnnotation(id);
    return true;
  },

  async registerTab(ctx: RpcCtx, tc: TabContext) {
    if (ctx.tabId === undefined) return false;
    let paperId = tc.paperId;
    if (paperId) {
      const p = await repo.getPaper(paperId);
      if (p) {
        paperId = p.id;
        const e = await repo.getEntry(p.id);
        if (e) await repo.updateEntry(p.id, { lastOpenedAt: new Date().toISOString() }, { derived: true });
      }
    }
    await chrome.storage.session.set({ [`tab:${ctx.tabId}`]: { ...tc, paperId, tabId: ctx.tabId } });
    return true;
  },

  /** Content scripts/reader report which annotations couldn't be placed on this version. */
  async reportAnchors(ctx: RpcCtx, paperId: string, orphanIds: string[]) {
    if (ctx.tabId === undefined) return false;
    await chrome.storage.session.set({ [`anchors:${ctx.tabId}`]: { paperId, orphanIds } });
    return true;
  },

  async reportProgress(_ctx: RpcCtx, paperId: string, progress: number) {
    const s = await getSettings();
    const compute = (e: LibraryEntry): Partial<LibraryEntry> => {
      const p = Math.max(e.progress ?? 0, Math.min(1, progress));
      const patch: Partial<LibraryEntry> = {};
      if (p > (e.progress ?? 0) + 0.02) patch.progress = p;
      if (s.inferReadStatus) {
        // never move a paper backwards, and never override a status the user set to Read
        const inferred: ReadingStatus = p >= 0.9 ? 'read' : p >= 0.15 ? 'reading' : e.status;
        if (STATUS_RANK[inferred] > STATUS_RANK[e.status]) {
          patch.status = inferred;
          patch.statusSetBy = 'auto';
        }
      }
      return patch;
    };
    const cur = await repo.getEntry(paperId);
    if (!cur) return null;
    const patch = compute(cur);
    if (!Object.keys(patch).length) return cur;
    // scroll depth is per-device bookkeeping; a status change (Reading, Read) is worth syncing
    return (await repo.updateEntry(paperId, compute, { derived: !patch.status })) ?? null;
  },

  async putFullText(_ctx: RpcCtx, ft: FullText) {
    const p = await repo.getPaper(ft.paperId);
    await repo.putFullText({ ...ft, paperId: p?.id ?? ft.paperId });
    return true;
  },

  async openReader(ctx: RpcCtx, src: string, paperId?: string | null) {
    if (ctx.tabId === undefined) return false;
    await chrome.tabs.update(ctx.tabId, { url: readerUrl(src, paperId) });
    return true;
  },

  async openOriginal(ctx: RpcCtx, url: string) {
    if (ctx.tabId === undefined || !/^https?:\/\//i.test(url)) return false;
    bypassReader.add(ctx.tabId);
    await chrome.tabs.update(ctx.tabId, { url });
    return true;
  },

  async openLibrary(_ctx: RpcCtx, paperId?: string) {
    const url = chrome.runtime.getURL('/library.html') + (paperId ? `#paper=${encodeURIComponent(paperId)}` : '');
    await chrome.tabs.create({ url });
    return true;
  },

  async openOptions() {
    await chrome.runtime.openOptionsPage();
    return true;
  },

  async setFactoidFigure(_ctx: RpcCtx, paperId: string, url: string) {
    const p = await repo.getPaper(paperId);
    if (!p) return false;
    await repo.updateEntry(p.id, { factoidFigure: { kind: 'url', url } });
    return true;
  },

  async lookupCitation(_ctx: RpcCtx, ref: Parameters<typeof lookupCitation>[0]) {
    return lookupCitation(ref);
  },

  async saveFromS2(_ctx: RpcCtx, s2Id: string) {
    const id = await saveFromS2(s2Id);
    void enqueueEnrich(id);
    return id;
  },

  /** Save a "For you" suggestion into the library. */
  async saveFeedItem(_ctx: RpcCtx, id: string) {
    const paperId = await saveFeedItem(id);
    void enqueueEnrich(paperId);
    void autoSavePdf(paperId);
    return paperId;
  },

  async refreshFeed() {
    return refreshFeed({ force: true });
  },

  /** Papers added by an import: look them up in the background. */
  async enqueueEnrich(_ctx: RpcCtx, paperIds: string[], opts: { ai?: boolean } = {}) {
    await enqueueEnrich(paperIds, opts);
    return true;
  },

  /** Intercepted in the background message listener so it runs inside the user gesture. */
  async openSidePanel() {
    return true;
  },

  async aiAvailable() {
    return aiAvailable(await getSettings());
  },
};

export type Handlers = typeof handlers;
