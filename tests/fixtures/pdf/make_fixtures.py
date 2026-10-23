"""Generate the PDFs used by tests/pdfExport.test.ts (needs reportlab).

    python3 tests/fixtures/pdf/make_fixtures.py

sample.pdf     three pages of body text, a URI link on page 1, a rotated margin
               stamp on page 1 (like arXiv's) and a paragraph repeated on pages
               2 and 3. (The tests make a copy with rotated pages using pdf-lib.)
encrypted.pdf  one page with an empty user password and an owner password, so
               pdf.js can read it but pdf-lib refuses to edit it.
"""
import os

from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfgen import canvas
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer

HERE = os.path.dirname(os.path.abspath(__file__))

TITLE = "Filtered Attention for Long-Context Retrieval"
STAMP = "arXiv:2401.00001v1 [cs.CL] 2 Jan 2024"
REPEATED = (
    "Because pruned blocks never enter the softmax, the savings grow with context length, "
    "which makes the method most useful exactly where long-context models are most expensive."
)
FILLER = [
    "Retrieval failures are not uniform across the context window. Facts near the beginning and the end of the input "
    "are recovered reliably, while facts in the middle are frequently ignored, a pattern earlier work calls the "
    "lost-in-the-middle effect.",
    "We argue that much of this failure comes from attention mass being spread over many irrelevant blocks. When most "
    "of the probability mass goes to filler text, the few tokens that matter receive too little weight to influence "
    "the output.",
    "Our approach keeps the base model frozen. We add a small scoring layer that looks at each block of keys and "
    "decides whether the block is worth attending to at all, which keeps training cheap and the method easy to retrofit.",
]


def sample(path):
    styles = getSampleStyleSheet()
    body = styles["BodyText"]

    def first_page(c, doc):
        c.saveState()
        c.setFont("Times-Roman", 14)
        c.translate(36, 250)
        c.rotate(90)
        c.drawString(0, 0, STAMP)
        c.restoreState()

    story = [
        Paragraph(TITLE, styles["Title"]),
        Paragraph("Ada Lovelace, Alan Turing", styles["Normal"]),
        Spacer(1, 12),
        Paragraph("<b>Abstract</b>", styles["Heading3"]),
        Paragraph(
            "Long-context language models often fail to retrieve facts buried in the middle of their input. "
            "We introduce filtered attention, a lightweight scoring layer that prunes irrelevant key blocks before "
            "the softmax. Code is available at "
            '<a href="https://github.com/ada/filtered-attention" color="blue">github.com/ada/filtered-attention</a>.',
            body,
        ),
        Paragraph("1 Introduction", styles["Heading2"]),
    ]
    story += [Paragraph(f, body) for f in FILLER]
    story += [
        PageBreak(),
        Paragraph("2 Method", styles["Heading2"]),
        # θ comes out in a separate font, so this line is several text items
        Paragraph("Let θ denote the parameters of a pretrained transformer.", body),
        Paragraph("Filtered attention improves retrieval recall by 11.4 points at 128k tokens on NeedleBench, as shown in Table 1.", body),
        Paragraph(REPEATED, body),
        PageBreak(),
        Paragraph("3 Related work", styles["Heading2"]),
        Paragraph("Sparse attention has a long history, and retrieval heads were recently identified in long-context models.", body),
        Paragraph(REPEATED, body),
    ]
    SimpleDocTemplate(path, pagesize=letter, title=TITLE, author="Ada Lovelace").build(
        story, onFirstPage=first_page
    )


def encrypted(path):
    from reportlab.lib.pdfencrypt import StandardEncryption

    enc = StandardEncryption("", ownerPassword="owner", canPrint=1, canModify=0, canCopy=1, canAnnotate=0, strength=128)
    c = canvas.Canvas(path, pagesize=letter, encrypt=enc)
    c.setFont("Helvetica", 11)
    c.drawString(72, 700, "This document is protected with an owner password.")
    c.drawString(72, 684, "Readers can open it, but editing tools are asked to leave it alone.")
    c.linkURL("https://example.org/", (72, 680, 300, 712), relative=0)
    c.showPage()
    c.save()


if __name__ == "__main__":
    sample(os.path.join(HERE, "sample.pdf"))
    encrypted(os.path.join(HERE, "encrypted.pdf"))
    print("fixtures written to", HERE)
