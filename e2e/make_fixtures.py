"""Generate test fixtures that mirror arXiv's abs page, its LaTeXML HTML rendering
(two versions), the PDF, and an OpenReview forum page."""
import os
from html import escape

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")
os.makedirs(OUT, exist_ok=True)

TITLE = "Filtered Attention for Long-Context Retrieval"
AUTHORS = ["Ada Lovelace", "Alan Turing"]
ABSTRACT = (
    "Long-context language models often fail to retrieve facts buried in the middle of their input. "
    "We introduce filtered attention, a lightweight scoring layer that prunes irrelevant key blocks before "
    "the softmax. On the NeedleBench and LongQA benchmarks, filtered attention improves retrieval recall by "
    "11.4 points at 128k tokens while reducing attention FLOPs by 38%. Code is available at "
    "https://github.com/ada/filtered-attention."
)


def m(tex, glyph, display="inline"):
    return (f'<math class="ltx_Math" alttext="{escape(tex)}" display="{display}"><semantics><mrow>{glyph}</mrow>'
            f'<annotation encoding="application/x-tex">{escape(tex)}</annotation></semantics></math>')


THETA = m("\\theta", "<mi>θ</mi>")
K = m("k", "<mi>k</mi>")
TAU = m("\\tau", "<mi>τ</mi>")
B = m("B", "<mi>B</mi>")
SCORE = m("s_{i}=\\max_{j\\in b_{i}}q^{\\top}k_{j}", "<msub><mi>s</mi><mi>i</mi></msub><mo>=</mo><mi>max</mi><msup><mi>q</mi><mo>⊤</mo></msup><msub><mi>k</mi><mi>j</mi></msub>", "block")

FILLER = [
    "Retrieval failures are not uniform across the context window. Facts near the beginning and the end of the input are recovered reliably, while facts in the middle are frequently ignored, a pattern earlier work calls the lost-in-the-middle effect.",
    "We argue that much of this failure comes from attention mass being spread over many irrelevant blocks. When most of the probability mass goes to filler text, the few tokens that matter receive too little weight to influence the output.",
    "Our approach keeps the base model frozen. We add a small scoring layer that looks at each block of keys and decides whether the block is worth attending to at all, which keeps training cheap and the method easy to retrofit.",
    "The scoring layer is trained with a contrastive objective on synthetic retrieval tasks, then evaluated without further tuning on natural documents such as legal contracts, scientific papers, and long chat transcripts.",
    "We also study how the filter interacts with positional encodings. Rotary embeddings remain unchanged, and we find no degradation on short-context tasks where the filter keeps nearly every block.",
    "Finally, we analyze the compute budget. Because pruned blocks never enter the softmax, the savings grow with context length, which makes the method most useful exactly where long-context models are most expensive.",
]


def paragraph(pid, html):
    return (f'<div id="{pid}" class="ltx_para"><p class="ltx_p">{html}</p></div>'
            '<button class="sr-only button" style="display:none">Report issue for preceding element</button>')


def arxiv_html(version):
    v2 = version == 2
    intro1 = (
        ("Long-context language models often struggle" if v2 else "Long-context language models struggle")
        + " to use information placed in the middle of their input "
        '<cite class="ltx_cite ltx_citemacro_citep">(<a href="#bib.bib1" class="ltx_ref">Smith and Doe, 2024</a>)</cite>. '
        f"Let {THETA} denote the parameters of a pretrained transformer, and let {K} be the number of key blocks kept per query."
    )
    removed = "This sentence only exists in the first version and will be removed later. "
    intro2 = (
        ("" if v2 else removed)
        + "We propose filtered attention, which scores every key block and keeps only the top "
        f"{K} blocks before computing attention. The threshold {TAU} controls how aggressive the filter is."
    )
    inserted = paragraph("S1.p0", "A new opening paragraph was added in the second version to motivate the problem with a concrete example from contract review.") if v2 else ""
    sections = []
    sections.append(
        '<section id="S1" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">1 </span>Introduction</h2>'
        + inserted
        + paragraph("S1.p1", intro1)
        + paragraph("S1.p2", intro2)
        + "".join(paragraph(f"S1.p{i+3}", f) for i, f in enumerate(FILLER[:3]))
        + "</section>"
    )
    sections.append(
        '<section id="S2" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">2 </span>Method</h2>'
        + paragraph("S2.p1", f"For a query q and block b_i we compute a block score {SCORE} and keep the blocks whose score exceeds {TAU}. Each block holds {B} keys.")
        + paragraph("S2.p2", "Filtered attention improves retrieval recall by 11.4 points at 128k tokens on NeedleBench, as shown in Table 1.")
        + "".join(paragraph(f"S2.p{i+3}", f) for i, f in enumerate(FILLER[3:]))
        + '<figure id="S2.F1" class="ltx_figure"><img src="x1.png" class="ltx_graphics" width="320" height="160" alt="">'
          '<figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_figure">Figure 1: </span>Recall versus context length.</figcaption></figure>'
        + '<figure id="S2.T1" class="ltx_table"><figcaption class="ltx_caption"><span class="ltx_tag ltx_tag_table">Table 1: </span>Recall at 128k tokens.</figcaption>'
          '<table class="ltx_tabular"><tbody><tr><td>Method</td><td>NeedleBench</td><td>LongQA</td></tr>'
          '<tr><td>Full attention</td><td>61.2</td><td>48.9</td></tr><tr><td>Filtered attention</td><td>72.6</td><td>55.0</td></tr></tbody></table></figure>'
        + "</section>"
    )
    sections.append(
        '<section id="S3" class="ltx_section"><h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">3 </span>Related work</h2>'
        + paragraph("S3.p1", 'Sparse attention has a long history <cite class="ltx_cite">(<a href="#bib.bib2" class="ltx_ref">Child et al., 2019</a>)</cite>, and retrieval heads were recently identified in long-context models <cite class="ltx_cite">(<a href="#bib.bib1" class="ltx_ref">Smith and Doe, 2024</a>)</cite>.')
        + "".join(paragraph(f"S3.p{i+2}", f) for i, f in enumerate(FILLER))
        + "</section>"
    )
    bib = (
        '<section id="bib" class="ltx_bibliography"><h2 class="ltx_title ltx_title_bibliography">References</h2><ul class="ltx_biblist">'
        '<li id="bib.bib1" class="ltx_bibitem"><span class="ltx_tag ltx_tag_bibitem">Smith and Doe (2024)</span>'
        '<span class="ltx_bibblock">John Smith and Jane Doe. </span><span class="ltx_bibblock">Retrieval heads in long-context transformers. </span>'
        '<span class="ltx_bibblock"><em class="ltx_emph">arXiv preprint arXiv:2402.00002</em>, 2024.</span></li>'
        '<li id="bib.bib2" class="ltx_bibitem"><span class="ltx_tag ltx_tag_bibitem">Child et al. (2019)</span>'
        '<span class="ltx_bibblock">Rewon Child, Scott Gray, Alec Radford, and Ilya Sutskever. </span>'
        '<span class="ltx_bibblock">Generating long sequences with sparse transformers. </span><span class="ltx_bibblock">2019.</span></li>'
        "</ul></section>"
    )
    authors = " ".join(
        f'<span class="ltx_creator ltx_role_author"><span class="ltx_personname">{a}<br class="ltx_break">Analytical Engines Lab</span></span>'
        for a in AUTHORS
    )
    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>{TITLE}</title>
<style>body{{font-family:Georgia,serif;max-width:760px;margin:40px auto;line-height:1.6;padding:0 16px}} .sr-only{{display:none}} figure img{{background:#eee}}</style>
</head><body>
<div class="ltx_page_main"><div class="ltx_page_content">
<article class="ltx_document ltx_authors_1line">
<h1 class="ltx_title ltx_title_document">{TITLE}</h1>
<div class="ltx_authors">{authors}</div>
<div class="ltx_abstract"><h6 class="ltx_title ltx_title_abstract">Abstract</h6><p class="ltx_p">{escape(ABSTRACT)}</p></div>
{''.join(sections)}
{bib}
</article></div></div>
<footer class="ltx_page_footer"><div class="ltx_page_logo">Generated by LaTeXML</div></footer>
</body></html>"""


def abs_page(arxiv_id, title, authors, abstract, comments):
    metas = "\n".join(
        [f'<meta name="citation_title" content="{escape(title)}">']
        + [f'<meta name="citation_author" content="{escape(a.split()[-1])}, {escape(" ".join(a.split()[:-1]))}">' for a in authors]
        + [f'<meta name="citation_date" content="2024/01/02">', f'<meta name="citation_arxiv_id" content="{arxiv_id}">', f'<meta name="citation_abstract" content="{escape(abstract)}">']
    )
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>[{arxiv_id}] {escape(title)}</title>{metas}</head>
<body><div id="abs"><h1 class="title mathjax"><span class="descriptor">Title:</span>{escape(title)}</h1>
<div class="authors">{', '.join(authors)}</div>
<blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span>{escape(abstract)}</blockquote>
<table><tr><td class="tablecell label">Comments:</td><td class="tablecell comments mathjax">{escape(comments)}</td></tr></table>
<ul><li><a href="/pdf/{arxiv_id}">View PDF</a></li><li><a href="/html/{arxiv_id}v2">HTML (experimental)</a></li></ul>
</div></body></html>"""


def openreview_page():
    return """<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sparse Reward Shaping for Tool-Use Agents | OpenReview</title>
<meta name="citation_title" content="Sparse Reward Shaping for Tool-Use Agents">
<meta name="citation_author" content="Grace Hopper"><meta name="citation_author" content="Edsger Dijkstra">
<meta name="citation_online_date" content="2024/09/27">
<meta name="description" content="We shape sparse rewards for tool-use agents using planning traces.">
</head><body><div id="__next"><div class="forum-container"><div class="forum-title"><h2 class="citation_title">Sparse Reward Shaping for Tool-Use Agents</h2></div>
<div class="forum-authors">Grace Hopper, Edsger Dijkstra</div><div class="note-content">We shape sparse rewards for tool-use agents using planning traces.</div>
<p style="height:1600px">Reviews follow.</p></div></div></body></html>"""


def make_pdf(path):
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table

    styles = getSampleStyleSheet()
    story = [Paragraph(TITLE, styles["Title"]), Paragraph(", ".join(AUTHORS), styles["Normal"]), Spacer(1, 12),
             Paragraph("<b>Abstract</b>", styles["Heading3"]), Paragraph(escape(ABSTRACT), styles["BodyText"]),
             Paragraph("1 Introduction", styles["Heading2"]),
             Paragraph("Long-context language models struggle to use information placed in the middle of their input (Smith and Doe, 2024). "
                       "Let θ denote the parameters of a pretrained transformer, and let k be the number of key blocks kept per query.", styles["BodyText"]),
             Paragraph("We propose filtered attention, which scores every key block and keeps only the top k blocks before computing attention. "
                       "The threshold τ controls how aggressive the filter is.", styles["BodyText"])]
    for f in FILLER[:3]:
        story.append(Paragraph(f, styles["BodyText"]))
    story += [Paragraph("2 Method", styles["Heading2"]),
              Paragraph("Filtered attention improves retrieval recall by 11.4 points at 128k tokens on NeedleBench, as shown in Table 1.", styles["BodyText"])]
    for f in FILLER[3:] + FILLER:
        story.append(Paragraph(f, styles["BodyText"]))
    story.append(Table([["Method", "NeedleBench", "LongQA"], ["Full attention", "61.2", "48.9"], ["Filtered attention", "72.6", "55.0"]]))
    story.append(Paragraph("3 Related work", styles["Heading2"]))
    for f in FILLER * 2:
        story.append(Paragraph(f, styles["BodyText"]))
    SimpleDocTemplate(path, pagesize=letter).build(story)


def make_png(path):
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (640, 320), "white")
    d = ImageDraw.Draw(im)
    pts = [(40 + i * 60, 280 - int(200 * (1 - 0.6 ** (i / 3)))) for i in range(10)]
    d.line(pts, fill=(34, 118, 108), width=4)
    pts2 = [(40 + i * 60, 280 - int(120 * (1 - 0.7 ** (i / 2)))) for i in range(10)]
    d.line(pts2, fill=(190, 18, 60), width=4)
    d.rectangle([0, 0, 639, 319], outline="black")
    im.save(path)


if __name__ == "__main__":
    for v in (1, 2):
        open(os.path.join(OUT, f"arxiv-html-v{v}.html"), "w").write(arxiv_html(v))
    open(os.path.join(OUT, "arxiv-abs-2401.00001.html"), "w").write(
        abs_page("2401.00001", TITLE, AUTHORS, ABSTRACT, "Accepted at NeurIPS 2024. Code: https://github.com/ada/filtered-attention"))
    open(os.path.join(OUT, "arxiv-abs-2402.00002.html"), "w").write(
        abs_page("2402.00002", "Retrieval heads in long-context transformers", ["John Smith", "Jane Doe"],
                 "We identify retrieval heads, a sparse set of attention heads responsible for copying facts from long contexts.", "12 pages"))
    open(os.path.join(OUT, "openreview-forum.html"), "w").write(openreview_page())
    make_pdf(os.path.join(OUT, "paper.pdf"))
    make_png(os.path.join(OUT, "x1.png"))
    print("fixtures written to", OUT)
