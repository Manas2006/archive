// Inbox priority: project relevance, whether the paper cites things you've
// saved, and whether it's by authors you follow.

import type { LibraryEntry, Paper, Project } from '../types';

export interface PriorityInput {
  entry: LibraryEntry;
  paper: Paper;
  projects: Map<string, Project>;
  libraryIds: Set<string>; // canonical ids + aliases of saved papers
  followedAuthors: string[];
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').trim();

export function computePriority({ entry, paper, projects, libraryIds, followedAuthors }: PriorityInput): { priority: number; reasons: string[] } {
  const reasons: string[] = [];
  // project relevance
  let rel = 0;
  let relProject: string | null = null;
  if (entry.projectIds.length) {
    rel = 0.85;
    relProject = entry.projectIds[0];
  }
  for (const s of entry.suggestions) {
    if (s.score > rel) {
      rel = s.score;
      relProject = s.projectId;
    }
  }
  if (relProject && rel >= 0.4) reasons.push(`Fits ${projects.get(relProject)?.name ?? 'a project'}`);

  // cites saved papers
  const refs = paper.s2?.referenceIds ?? [];
  const cited = refs.filter((r) => libraryIds.has(r)).length;
  const cites = Math.min(1, cited / 3);
  if (cited) reasons.push(`Cites ${cited} paper${cited > 1 ? 's' : ''} you saved`);

  // followed authors
  const followed = followedAuthors.map(norm).filter(Boolean);
  const hit = paper.authors.find((a) => followed.includes(norm(a.name)));
  if (hit) reasons.push(`By ${hit.name}`);

  const ageDays = (Date.now() - new Date(entry.createdAt).getTime()) / 86_400_000;
  const fresh = ageDays < 3 ? 0.05 : 0;

  const priority = Math.min(1, 0.5 * rel + 0.3 * cites + 0.2 * (hit ? 1 : 0) + fresh);
  return { priority: Math.round(priority * 1000) / 1000, reasons };
}
