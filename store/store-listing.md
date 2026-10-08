# Marginalia: Chrome Web Store submission kit

Fill these in from top to bottom in the developer dashboard. Everything referenced here is in this folder.

## 1. Upload

Dashboard → **New item** → upload `marginalia-0.2.0.zip`.

The item ID appears in the address bar and on the item page. Your unlisted install link will be:
`https://chromewebstore.google.com/detail/<item-id>`

## 2. Store listing tab

**Description** (paste as is):

```
Marginalia is a reading companion for research papers on arXiv and OpenReview.

SAVE AND CITE
• Save any arXiv or OpenReview paper in one click (or Alt+Shift+S).
• Clean BibTeX with consistent citation keys and protected acronyms ({LLM}, {GPT-4}).
• When a preprint is published, Marginalia finds the venue version on DBLP and updates its BibTeX automatically.
• Export a .bib file for any project or selection.

HIGHLIGHT AND TAKE NOTES
• Highlight on arXiv HTML pages and in a built-in PDF reader, with labels: Problem, Method, Result, Interesting, Weakness.
• Add Markdown notes to highlights or to the whole paper.
• Highlights re-attach when a paper gets a new arXiv version, and carry over between the HTML and PDF versions.
• Hover a citation to see its abstract and save it. Hover a math symbol to see where it is defined.

ORGANIZE YOUR LIBRARY
• Reading status (Inbox, To read, Reading, Read) that updates as you scroll.
• Projects: new papers that match a project are filed into it or suggested.
• Topics that group your papers automatically.
• An inbox ranked by relevance, papers that cite your library, and authors you follow.
• OpenReview scores and decisions, code links, and a searchable table of tasks, benchmarks and models.

LAB MEETINGS
• Turn your labeled highlights into a lab-meeting factoid (Problem, Method, Results, What interested me, What could be better), with a figure you snip from the PDF, ready to paste into a shared doc.

OPTIONAL AI FEATURES (your own Claude API key)
• Explain a passage, find the evidence for a claim, ask questions, compare two papers, extract key fields, summarize reviews and draft factoids.
• Off by default. With AI off, nothing is sent to any AI service and every AI control is hidden.

PRIVATE BY DESIGN
• Your library, highlights and notes stay in your browser. There is no account and no server.
```

**Category:** Education (under Productivity)
**Language:** English (United States)
**Store icon:** `store-icon-128.png`
**Screenshots** (1280x800, upload in this order):
1. `1-highlights-and-panel.png`
2. `2-explain.png`
3. `3-reader.png`
4. `4-library.png`
5. `5-factoid.png`

**Small promo tile:** `promo-small-440x280.png`
**Official URL / Homepage / Support URL:** leave blank (optional)

## 3. Privacy tab

**Single purpose description:**

```
Help researchers save, annotate and organize the academic papers they read on arXiv and OpenReview.
```

**Permission justifications:**

| Permission | Justification |
| --- | --- |
| storage | Saves the user's settings and a queue of pending metadata lookups. |
| unlimitedStorage | The user's library, highlights, notes, captured figures and paper text are stored locally in IndexedDB and can exceed the default quota. |
| sidePanel | Shows the highlights, notes and BibTeX for the paper in the current tab. |
| contextMenus | Adds right-click items: save the paper, use an image as the lab-meeting figure, open a PDF link in the built-in reader. |
| alarms | Runs a daily check for published versions of saved preprints, and retries pending metadata lookups. |
| notifications | Tells the user when a saved preprint's published version was found and its BibTeX updated. |
| clipboardWrite | Copies BibTeX entries and the lab-meeting factoid to the clipboard. |
| Host permissions | arxiv.org: save and highlight papers on abstract and HTML pages, and load PDFs into the reader. export.arxiv.org: paper metadata. openreview.net, api.openreview.net, api2.openreview.net: paper pages, PDFs, metadata and public reviews. api.semanticscholar.org: citations, references, venues and embeddings for sorting. dblp.org: BibTeX of published versions. api.anthropic.com: optional AI features, used only after the user adds their own API key. |

**Remote code:** No, I am not using remote code.

**Data usage:** check these two:
- **Website content:** the text of papers the user opens is stored locally, and sent to Anthropic only when the user invokes an AI feature with their own key.
- **Authentication information:** the user's own Claude API key, stored locally and sent only to api.anthropic.com.

Then check all three certifications (no selling, no unrelated use, no creditworthiness use).

**Privacy policy URL:** the public link to `privacy-policy.md` (see the chat).

## 4. Distribution tab

- **Payments:** Free of charge
- **Visibility:** Unlisted
- **Regions:** All regions

## 5. Test instructions (optional, helps the reviewer)

```
No account or login is needed. Open any paper on arxiv.org (abstract, HTML or PDF page) or openreview.net and click "Save paper" at the bottom right. On an arXiv HTML page (the "HTML (experimental)" link on any recent paper), select text to highlight it. Open the library with Alt+Shift+L. AI features are off by default and need the user's own Claude API key in Settings; everything else works without one.
```

## 6. Submit

Click **Submit for review**. Review usually takes a few days. After approval, anyone with the link above can install it.
