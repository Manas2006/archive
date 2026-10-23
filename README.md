# Archive

A reading companion for research papers. Save arXiv and OpenReview papers in one click, highlight and take notes as you read, let your library sort itself, and get clean BibTeX for whatever you're writing. Works in Chrome and Firefox, and as a web app on your phone and iPad. AI features are optional and use your own Claude API key.

Archive is free, open source (MIT) and keeps your data in your own browser. It is not affiliated with arXiv or OpenReview.

## Get it

| Where | How |
| --- | --- |
| **Chrome** (also Edge, Brave, Arc) | [Chrome Web Store](https://chromewebstore.google.com/detail/igggcdjhmjbdndkblipknecchjepglco) |
| **iPhone and iPad** | Open [manas2006.github.io/archive](https://manas2006.github.io/archive/) in Safari, tap Share, then Add to Home Screen. Needs iOS 17.4 or later. |
| **Android** | Open the same link in Chrome and choose Install app. Or use Firefox for Android with the extension. |
| **Firefox** (computer and Android) | Build it with `npm run build:firefox` and load `.output/firefox-mv3` from `about:debugging`. A listing on addons.mozilla.org is planned. |

To use one library on every device, connect Google Drive in Settings on each of them (same Google account).

## What it does

**Save and cite**
- One click (or Alt+Shift+S) saves the paper you're on, with BibTeX that has consistent citation keys and protected acronyms.
- When a preprint is published, Archive finds the venue version and updates its BibTeX.
- Cite buttons copy `\cite{key}` (or `\citep`, `\citet`, `\autocite`, Pandoc `[@key]`) for one paper or a whole selection.
- Keep a project's `.bib` file up to date in Google Drive with a link Overleaf can pull from.
- Import from Zotero, Mendeley, EndNote or Paperpile (BibTeX, RIS, CSL JSON). Export RIS with your highlights and notes back to Zotero.

**Read and highlight**
- Highlight on arXiv HTML pages and in a built-in PDF reader, with labels: Problem, Method, Result, Interesting, Weakness. Works with touch and Apple Pencil.
- Notes in Markdown on highlights or on the whole paper.
- Highlights find their place again when a paper gets a new arXiv version, and move between the HTML and PDF versions.
- Download a PDF, or save it to Google Drive, with your highlights and notes embedded as normal PDF annotations.

**A library that sorts itself**
- Reading status that updates as you scroll.
- Projects: new papers that fit a project are filed into it or suggested.
- Topics found automatically, and an inbox ranked by what fits your projects, cites your papers, or is by authors you follow.
- **Follow authors** and get a daily **For you** list: their new papers, plus new papers that fit each of your projects.
- OpenReview scores and decisions, code links, and a table of tasks, benchmarks and models.

**Lab meetings**
- Turn your labeled highlights into a factoid (Problem, Method, Results, What interested me, What could be better), with a figure snipped from the PDF.

**Optional AI (your own Claude API key)**
- Explain a passage, find the evidence for a claim, ask a paper questions, compare two papers.
- **Ask your whole library**: answers cite the exact passages from your saved papers, highlights and notes.
- **Draft related work** for a project from your papers and highlights, citing only your own citation keys.
- Field extraction, review summaries, topic names and factoid drafts.
- Off by default. With AI off, every AI button is hidden and nothing is sent to any AI service.

## Privacy

Your library, highlights and notes stay in your browser. There is no account and no server. Archive only contacts arXiv, OpenReview, Semantic Scholar and DBLP to look up papers, Anthropic when you use an AI feature with your own key, and Google Drive if you connect it (with a permission that only covers files Archive creates). Full policy: [store/privacy-policy.md](store/privacy-policy.md).

## Built for lab sharing later

Annotations follow the W3C Web Annotation model, papers have ids that line up between people, every record carries an owner, visibility and soft deletes, and every write goes to a change log. A shared lab space (everyone sees each other's highlights on the same paper) can be added on top without changing the data.

## Contributing and forking

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the code layout, tests and how to publish your own build. Short version:

```bash
npm install
npm run dev          # Chrome with hot reload
npm test             # unit tests
npm run e2e          # browser tests against mock services (needs root for port 443)
```

## License

[MIT](LICENSE)
