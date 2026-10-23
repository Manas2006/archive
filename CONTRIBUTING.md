# Contributing to Archive

Thanks for helping. Archive is a reading companion for research papers: a browser extension (Chrome and Firefox) plus a web app for phones and iPads, all built from one codebase. Bug reports, ideas and pull requests are all welcome. Forks are welcome too: the MIT license lets you change it however your lab likes.

## Getting set up

```bash
git clone https://github.com/Manas2006/archive.git
cd archive
npm install          # also copies pdf.js fonts and maps into public/pdfjs
npm run dev          # opens Chrome with the extension loaded and hot reload
```

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Chrome build in `.output/chrome-mv3` (load it from `chrome://extensions` with Developer mode on) |
| `npm run build:firefox` | Firefox build in `.output/firefox-mv3` (load it from `about:debugging`) |
| `npm run build:web` | Web app in `dist-web/` (serve it with any static server) |
| `npm run typecheck` | TypeScript |
| `npm test` | Unit tests (Vitest) |
| `npm run e2e` | Browser tests against mock arXiv, OpenReview, Semantic Scholar, DBLP and Claude servers. They map the real hostnames to a local HTTPS server, so they need root to listen on port 443. |

## How the code is organized

- `src/entrypoints/` the extension's pages and scripts: `background.ts`, the content script on paper pages (`paper.content/`), the PDF reader, the library, the side panel, the popup and Settings.
- `src/lib/repo.ts` is the only place that reads or writes the database (IndexedDB through Dexie). Every write also goes to a change log, which is what sync is built on.
- `src/lib/types.ts` has the data model. Annotations follow the W3C Web Annotation model, so they can move between people and tools without conversion.
- `src/lib/anchoring/` finds highlights again in HTML and PDF text, even after a paper gets a new version.
- `src/lib/sources/` talks to arXiv, OpenReview, Semantic Scholar and DBLP.
- `src/lib/sorting/` project relevance, topics and inbox priority. `src/lib/feed.ts` and `src/lib/follows.ts` build the For you list.
- `src/lib/ai/` the optional Claude features. `src/lib/drive/` the optional Google Drive features.
- `src/platform/` and `web/` turn the same pages into the web app (a small stand-in for the extension APIs, a manifest and a service worker).

## A few rules that keep Archive working

- **AI is optional.** Every AI feature checks `aiAvailable()` (or calls `requireAi()`), and its buttons are hidden when AI is off. Everything else must work without an API key.
- **Google Drive is optional** and uses only the `drive.file` permission. Nobody should see a Google prompt unless they click Connect.
- **Go through `repo.ts`** for data, and keep personal data (reading list, projects) separate from shareable data (papers, annotations). That separation is what will make lab sharing safe.
- **The web app has no host permissions.** Only sites that allow cross-origin requests work there (arXiv PDFs and HTML pages, Semantic Scholar, Anthropic, Google). Guard anything else with `isWebApp()`.
- Keep UI text short and plain.

## Making your own build

If you publish your own copy (for your lab, say), change:

1. The Firefox add-on id in `wxt.config.ts` (`browser_specific_settings.gecko.id`).
2. The Google sign-in client, if you want Drive features: the one in `.env` only works for the official builds, so make your own (see [docs/google-drive-setup.md](docs/google-drive-setup.md)) and put it in `.env.local`.
3. `WEB_BASE` when building the web app, if it isn't served from `/archive/`.

## Pull requests

Keep them focused, add or update tests for logic changes, and run `npm run typecheck && npm test` before opening one. Describe how you tested it by hand on a real paper.
