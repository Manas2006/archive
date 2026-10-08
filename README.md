# Marginalia

A Chrome extension for reading research papers: save arXiv and OpenReview papers in one click, highlight and annotate them, keep a sorted library, and export BibTeX and lab-meeting factoids. AI features are optional and use your own Claude API key.

## Install

1. Unzip `marginalia-extension.zip`.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder.
3. Pin Marginalia to the toolbar. Settings open on first install.

To update, replace the folder's contents and click the reload icon on the extension card. Your library is kept.

## Using it

| Where | What you can do |
| --- | --- |
| arXiv abstract and OpenReview pages | Save (button at the bottom right, or Alt+Shift+S), set reading status, mark "will cite", open the PDF in the reader |
| arXiv HTML pages | Select text to highlight with a label (keys 1 to 6), add notes, hover a citation for its abstract and a Save button, hover a math symbol to see where it's defined |
| PDFs (arXiv, OpenReview) | Open in the Marginalia reader automatically. Same highlights and notes as HTML, plus Snip to capture a figure |
| Side panel (Alt+Shift+M) | Highlights, notes, AI questions, extracted fields, reviews, BibTeX and the factoid export for the paper in the current tab |
| Library (Alt+Shift+L) | Inbox ranked by priority, projects, topics, a sortable table with extracted fields, search across highlights and notes, .bib export |

Highlight labels are Highlight, Problem, Method, Result, Interesting and Weakness. The last five fill the lab factoid template (Problem, Method, Results, What interested me, What could be better).

## AI features (optional)

Turn them on in Settings and paste a Claude API key. When AI is off, every AI control is hidden and no request is made to the API. With a key you get: Explain and Where's-the-evidence on a selection, Ask and Compare in the side panel, symbol definitions, field extraction on save, OpenReview review summaries, topic names, project relevance ratings, and factoid drafts. Bulk work uses the fast model (Haiku by default) and reading uses Sonnet; both are configurable. The paper text is sent with prompt caching so follow-up questions are cheap.

The key is stored in the extension's own IndexedDB, where content scripts on arXiv and OpenReview can't read it. Requests go straight from your browser to `api.anthropic.com`.

## Background work

After you save a paper, Marginalia looks it up on Semantic Scholar (ids, SPECTER embedding, references), fetches OpenReview scores and the decision, files it into matching projects, and assigns a topic. Once a day it checks whether your arXiv preprints were published and swaps in the venue BibTeX from DBLP, then re-sorts topics and the inbox. A free Semantic Scholar API key (Settings) makes this more reliable on large libraries.

## Built for lab sharing later

- Annotations follow the W3C Web Annotation model (TextQuoteSelector plus TextPositionSelector), so they move between users and a server without conversion. Settings has a JSON-LD export.
- Papers are identified by arXiv id (without version), OpenReview forum id or DOI, so two people's annotations on the same paper line up.
- Every record has an owner, a visibility (private for now), a group slot, timestamps and soft deletes.
- All reads and writes go through `src/lib/repo.ts`. Every write is also appended to a `changes` table, which a sync layer can upload.
- Reading status, projects and tags live in a separate `library` table from annotations, so sharing annotations never exposes a reading list.

Lab mode would add a backend (for example Supabase with utexas.edu sign-in), group invites, per-person highlight colors and reply threads.

## Development

```bash
npm install
npm run build        # outputs .output/chrome-mv3
npm test             # unit tests (vitest)
npm run e2e          # browser tests against mock arXiv/OpenReview/S2/DBLP/Claude servers
```

Stack: WXT, TypeScript, React, Tailwind, Dexie (IndexedDB), pdf.js. The browser tests run Chromium with the extension loaded and map the real hostnames to a local HTTPS mock (`e2e/server.mjs`), so they need root to listen on port 443.

### Layout

- `src/entrypoints/` background worker, content script (`paper.content`), popup, side panel, library, options, PDF reader
- `src/lib/anchoring/` quote anchoring, DOM text index, highlighter
- `src/lib/sources/` arXiv, OpenReview, Semantic Scholar, DBLP clients
- `src/lib/sorting/` TF-IDF, relevance, clustering, inbox priority
- `src/lib/ai/` Claude client, features, streaming port
- `src/components/` shared React UI
