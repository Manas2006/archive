// Venue upgrade: once an arXiv preprint appears at a venue, replace its arXiv
// BibTeX with the venue version from DBLP (or Semantic Scholar as a fallback).

import { genericBibtex, normalizeForeignBib } from './bibtex';
import * as repo from './repo';
import { dblpBibtex, dblpFindVenueRecord, isCorrKey } from './sources/dblp';
import { s2Venue, type S2Paper } from './sources/s2';
import type { Paper } from './types';

export interface VenueUpgrade {
  paperId: string;
  title: string;
  venue: string;
}

/** Returns the upgrade if one happened. Never touches BibTeX the user edited. */
export async function checkVenue(paper: Paper, s2: S2Paper | null): Promise<VenueUpgrade | null> {
  if (paper.bibtexSource === 'manual' || paper.bibtexSource === 'dblp') return null;
  if (paper.source === 'openreview' && paper.venueStatus === 'accepted' && paper.bibtexSource === 'openreview') return null;
  const venue = s2 ? s2Venue(s2) : null;
  let bib: string | null = null;
  let source: Paper['bibtexSource'] = 'dblp';
  let dblpKey = s2?.externalIds?.DBLP;
  let venueName = venue;

  if (dblpKey && !isCorrKey(dblpKey)) {
    bib = await dblpBibtex(dblpKey);
  }
  if (!bib && venue) {
    // S2 knows a venue but has no (or only a CoRR) DBLP key: search DBLP by title
    const hit = await dblpFindVenueRecord(paper.title);
    if (hit) {
      dblpKey = hit.key;
      venueName = venueName ?? hit.venue;
      bib = await dblpBibtex(hit.key);
    }
  }
  if (!bib && venue && s2?.publicationVenue?.type && /conference|journal/i.test(s2.publicationVenue.type)) {
    source = 's2';
    bib = genericBibtex({
      citeKey: paper.citeKey,
      type: /journal/i.test(s2.publicationVenue.type) ? 'article' : 'inproceedings',
      title: paper.title,
      authors: paper.authors,
      year: s2.year ?? paper.year,
      venue,
      doi: paper.doi,
      url: paper.urls.abs,
    });
  }
  if (!bib) return null;
  const normalized = source === 'dblp' ? normalizeForeignBib(bib, paper.citeKey) : bib;
  if (!normalized) return null;
  const display = shortVenue(venueName, s2?.year ?? paper.year, s2?.publicationVenue?.alternate_names ?? []) ?? paper.venue;
  const label = display ?? 'a venue';
  await repo.updatePaper(paper.id, {
    bibtex: normalized,
    bibtexSource: source,
    venue: display,
    venueStatus: 'accepted',
    dblpKey: dblpKey && !isCorrKey(dblpKey) ? dblpKey : paper.dblpKey,
  });
  return { paperId: paper.id, title: paper.title, venue: label };
}

const VENUE_ABBREV: [RegExp, string][] = [
  [/neural information processing systems|\bneurips\b|\bnips\b/i, 'NeurIPS'],
  [/international conference on learning representations|\biclr\b/i, 'ICLR'],
  [/international conference on machine learning|\bicml\b/i, 'ICML'],
  [/conference on language modeling|\bcolm\b/i, 'COLM'],
  [/empirical methods in natural language processing|\bemnlp\b/i, 'EMNLP'],
  [/north american chapter of the association for computational linguistics|\bnaacl\b/i, 'NAACL'],
  [/european chapter of the association for computational linguistics|\beacl\b/i, 'EACL'],
  [/findings of the association for computational linguistics/i, 'Findings of ACL'],
  [/annual meeting of the association for computational linguistics|^acl\b/i, 'ACL'],
  [/transactions of the association for computational linguistics|\btacl\b/i, 'TACL'],
  [/computer vision and pattern recognition|\bcvpr\b/i, 'CVPR'],
  [/international conference on computer vision|\biccv\b/i, 'ICCV'],
  [/european conference on computer vision|\beccv\b/i, 'ECCV'],
  [/aaai conference on artificial intelligence|\baaai\b/i, 'AAAI'],
  [/international joint conference on artificial intelligence|\bijcai\b/i, 'IJCAI'],
  [/transactions on machine learning research|\btmlr\b/i, 'TMLR'],
  [/journal of machine learning research|\bjmlr\b/i, 'JMLR'],
  [/conference on robot learning|\bcorl\b/i, 'CoRL'],
  [/artificial intelligence and statistics|\baistats\b/i, 'AISTATS'],
  [/uncertainty in artificial intelligence|\buai\b/i, 'UAI'],
  [/knowledge discovery and data mining|\bkdd\b/i, 'KDD'],
  [/the web conference|world wide web conference/i, 'WWW'],
  [/research and development in information retrieval|\bsigir\b/i, 'SIGIR'],
  [/computer and communications security|\bccs\b/i, 'CCS'],
  [/usenix security/i, 'USENIX Security'],
  [/symposium on security and privacy/i, 'IEEE S&P'],
  [/network and distributed system security|\bndss\b/i, 'NDSS'],
  [/international conference on software engineering|\bicse\b/i, 'ICSE'],
  [/foundations of software engineering|\bfse\b/i, 'FSE'],
  [/automated software engineering|\base\b/i, 'ASE'],
  [/human factors in computing systems|\bchi\b/i, 'CHI'],
  [/user interface software and technology|\buist\b/i, 'UIST'],
  [/robotics: science and systems/i, 'RSS'],
  [/international conference on robotics and automation|\bicra\b/i, 'ICRA'],
  [/intelligent robots and systems|\biros\b/i, 'IROS'],
];

/** "Neural Information Processing Systems" + 2024 → "NeurIPS 2024". */
export function shortVenue(name: string | null | undefined, year?: number | null, alternates: string[] = []): string | null {
  if (!name) return null;
  const hit = VENUE_ABBREV.find(([re]) => re.test(name) || alternates.some((a) => re.test(a)));
  let short = hit?.[1];
  if (!short) {
    const alt = alternates.filter((a) => /^[A-Z][A-Za-z&]{1,9}$/.test(a)).sort((a, b) => a.length - b.length)[0];
    short = alt ?? name;
  }
  return year && !/\b(19|20)\d{2}\b/.test(short) ? `${short} ${year}` : short;
}
