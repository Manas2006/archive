# Archive: Chrome Web Store kit (0.3.0 update)

Item ID: `igggcdjhmjbdndkblipknecchjepglco`. Listing: https://chromewebstore.google.com/detail/igggcdjhmjbdndkblipknecchjepglco

## 1. Upload the new version

Developer dashboard → Archive (it may still say Marginalia) → **Package** → **Upload new package** → `archive-0.3.0-chrome.zip`. The name, icon and description in the zip replace the old ones.

## 2. Store listing tab

**Description** (paste as is):

```
Archive is a reading companion for research papers on arXiv and OpenReview. It is free and open source, and keeps your library in your own browser. Not affiliated with arXiv or OpenReview.

SAVE AND CITE
• Save any arXiv or OpenReview paper in one click (or Alt+Shift+S).
• Clean BibTeX with consistent citation keys and protected acronyms ({LLM}, {GPT-4}).
• When a preprint is published, Archive finds the venue version and updates its BibTeX.
• Cite buttons copy \cite{key} (or \citep, \citet, \autocite, Pandoc [@key]) for one paper or a whole selection.
• Keep a project's .bib file up to date in Google Drive, with a link Overleaf can pull from.
• Import from Zotero, Mendeley, EndNote or Paperpile. Export back to Zotero with your highlights and notes.

READ AND HIGHLIGHT
• Highlight on arXiv HTML pages and in a built-in PDF reader, with labels: Problem, Method, Result, Interesting, Weakness.
• Markdown notes on highlights or on the whole paper.
• Highlights re-attach when a paper gets a new arXiv version, and carry over between the HTML and PDF versions.
• Download a PDF, or save it to Google Drive, with your highlights and notes embedded.
• Hover a citation to see its abstract and save it. Hover a math symbol to see where it is defined.

A LIBRARY THAT SORTS ITSELF
• Reading status (Inbox, To read, Reading, Read) that updates as you scroll.
• Projects: new papers that fit a project are filed into it or suggested.
• Topics that group your papers automatically.
• Follow authors, and get a daily For you list of their new papers and new papers that fit your projects.
• OpenReview scores and decisions, code links, and a searchable table of tasks, benchmarks and models.

ON YOUR PHONE AND IPAD
• The same library as a free web app for iPhone, iPad and Android, synced through your Google Drive.

LAB MEETINGS
• Turn your labeled highlights into a lab-meeting factoid (Problem, Method, Results, What interested me, What could be better), with a figure you snip from the PDF.

OPTIONAL AI FEATURES (your own Claude API key)
• Explain a passage, find the evidence for a claim, ask questions, compare two papers.
• Ask your whole library: answers cite the exact passages from your papers, highlights and notes.
• Draft a related-work section for a project, citing only your own citation keys.
• Off by default. With AI off, nothing is sent to any AI service and every AI control is hidden.

PRIVATE BY DESIGN
• No account and no server. Google Drive is optional and Archive can only see the files it creates there.
• Source code: https://github.com/Manas2006/archive
```

**Category:** Education (or Tools)
**Language:** English (United States)
**Screenshots:** keep the current five, or replace them later with ones that show For you and the library.
**Homepage URL:** https://github.com/Manas2006/archive
**Support URL:** https://github.com/Manas2006/archive/issues

## 3. Privacy tab

**Single purpose description** (unchanged):

```
Help researchers save, annotate and organize the academic papers they read on arXiv and OpenReview.
```

**Permission justifications:** keep the existing ones and add these:

| Permission | Justification |
| --- | --- |
| identity (optional) | Signs in to Google only when the user clicks "Connect Google Drive" in Settings, to save their PDFs and .bib files to their own Drive and sync their library between their devices. Uses the drive.file scope, so only files Archive creates are visible to it. |
| Host permissions (add to the existing text) | www.googleapis.com and oauth2.googleapis.com (optional, requested only when the user connects Google Drive): upload the user's own files to their Drive and revoke the sign-in when they disconnect. |

**Remote code:** No, I am not using remote code.

**Data usage:** keep **Website content** and **Authentication information** checked, and add **Personally identifiable information** (the connected Google account's email address, shown in Settings and stored only in the browser). The wording to keep in mind:
- Website content: the text of papers the user opens is stored locally, and sent to Anthropic only when they use an AI feature with their own key. PDFs and the library go to the user's own Google Drive only if they connect it.
- Authentication information: the user's own Claude API key and Google sign-in token, stored locally and sent only to api.anthropic.com and Google.

Keep all three certifications checked.

**Privacy policy URL:** https://manas2006.github.io/archive/privacy.html

## 4. Distribution tab

Unchanged: free, all regions. Visibility is Public right now; switch to Unlisted if you want it link-only.

## 5. Test instructions for the reviewer

```
No account or login is needed. Open any paper on arxiv.org (abstract, HTML or PDF page) or openreview.net and click "Save paper" at the bottom right. On an arXiv HTML page (the "HTML" link on any recent paper), select text to highlight it. Open the library with Alt+Shift+L. AI features are off by default and need the user's own Claude API key in Settings. Google Drive is optional (Settings, Connect Google Drive) and asks for the identity permission only then. Everything else works without either.
```

## 6. Submit

Click **Submit for review**. Everyone who has it installed gets the update automatically once it's approved, and keeps their library.
