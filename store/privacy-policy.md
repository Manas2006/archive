# Archive privacy policy

Last updated: October 23, 2026

Archive (formerly Marginalia) is a browser extension and web app for saving, annotating and organizing research papers from arXiv and OpenReview. It is open source (MIT license) and is not affiliated with arXiv or OpenReview. This policy explains what data it handles.

## What stays on your device

Everything you create in Archive is stored in your browser on your device: your saved papers, highlights, notes, projects, topics, reading status, the authors you follow, your "For you" suggestions, settings, the text of papers you open (used for AI features and search), figures you capture, and your Claude API key if you add one. The developer has no server and never receives any of this.

## What is sent to other services, and why

Archive contacts these services only to do what you ask:

- **arXiv (arxiv.org, export.arxiv.org)** and **OpenReview (openreview.net and its APIs):** the identifier of a paper you open or save, to fetch its title, authors, abstract and PDF, public reviews and decisions, and (once a day, if you have projects) lists of new arXiv submissions in your fields.
- **Semantic Scholar (api.semanticscholar.org):** paper identifiers and titles, to look up citations, references, venues and paper embeddings used to sort your library; names of authors you search for or follow, to find their new papers; and identifiers of papers in your projects, to get recommendations of related new papers.
- **DBLP (dblp.org):** paper titles and DBLP identifiers, to fetch the BibTeX of a paper's published version.
- **Anthropic (api.anthropic.com):** only if you turn on AI features and add your own Claude API key. When you use an AI feature (for example, explaining a passage or asking a question about your library), the relevant paper text, your selection or question, and the highlights and notes needed for that request are sent to Anthropic with your key. Anthropic's handling of that data is governed by its own policies and your agreement with Anthropic.
- **Google Drive (www.googleapis.com, accounts.google.com, oauth2.googleapis.com):** only if you connect Google Drive. (In the web app, Google's sign-in script loads when you point at or tap the Connect button, and afterwards whenever Settings is open.) Archive asks for the narrowest Drive permission, which lets it see and manage only files it creates. Depending on the options you turn on, it saves paper PDFs (optionally with your highlights and notes embedded), project bibliography (.bib) files, and one sync file with your library so your other devices can read it. Your Google account email is read so Settings can show which account is connected. Files you choose to share by link (for Overleaf) are readable by anyone with the link, until you turn the link off, delete the project or disconnect Drive. Bibliography files never include your notes, abstracts or file paths from imported references. Google's handling of that data is governed by Google's policies.

No data is sent to the developer. Archive does not use analytics, does not track your browsing outside arXiv and OpenReview paper pages, and does not sell or share data with anyone else.

## Your control

You can export or delete all of your data at any time from Archive's Settings page. Deleting removes your library, notes, Claude API key, Ask history and settings from the browser, turns off any public .bib links, disconnects Google Drive and, if you choose, moves the synced copy in Drive to the trash. Uninstalling the extension deletes everything it stored in the browser; files it saved to your Google Drive stay there until you delete them. You can disconnect Google Drive at any time in Settings. AI features and Google Drive are off by default and send nothing until you turn them on.

## Contact

Questions: manaspathak11@gmail.com, or open an issue at https://github.com/Manas2006/archive
