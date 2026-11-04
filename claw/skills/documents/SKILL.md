---
name: documents
description: Create, read, convert or edit Word (.docx), PowerPoint (.pptx), Markdown and HTML documents - reports, memos, slide decks, templates to fill. Use when a task asks for a document or deck, or gives one as input.
---

# Documents and slides

Work in the sandbox with bash and python3. The default sandbox image has `pandoc`,
`python-docx`, `python-pptx` and `matplotlib`. Check with `command -v pandoc` and
`python3 -c "import docx, pptx"`; if one is missing, say so and use what is there.

## Pick the route

| Task | Route |
|---|---|
| Write a report or memo | Write Markdown first, then `pandoc report.md -o report.docx` |
| Match a company template | `pandoc report.md --reference-doc=template.docx -o report.docx` |
| Read a .docx | `pandoc in.docx -t gfm -o in.md`, then read the Markdown |
| Edit text in an existing .docx, keep its layout | python-docx (below) |
| Slide deck | python-pptx (below); one idea per slide |
| HTML page | `pandoc in.md -s -o out.html` |

## Reading

```bash
pandoc in.docx -t gfm --wrap=none -o in.md && wc -l in.md && head -80 in.md
python3 -c "from pptx import Presentation as P; [print(i+1, s.shapes.title.text if s.shapes.title else '') for i,s in enumerate(P('deck.pptx').slides)]"
```

## Editing a .docx in place

```python
from docx import Document
d = Document("in.docx")
for p in d.paragraphs:
    if "{{name}}" in p.text:
        for run in p.runs: run.text = run.text.replace("{{name}}", "Alice")
for table in d.tables:
    for row in table.rows:
        for cell in row.cells: ...
d.save("out.docx")
```

A placeholder split across runs is not seen by a per-run replace: print
`[r.text for r in p.runs]` to check, and join the runs of that paragraph if needed.

## Slides

```python
from pptx import Presentation
from pptx.util import Inches, Pt
prs = Presentation()                           # or Presentation("template.pptx")
s = prs.slides.add_slide(prs.slide_layouts[1]) # title and content
s.shapes.title.text = "Results"
body = s.placeholders[1].text_frame
body.text = "Throughput up 18%"
p = body.add_paragraph(); p.text = "Latency flat"; p.level = 1
s2 = prs.slides.add_slide(prs.slide_layouts[5])
s2.shapes.title.text = "Trend"
s2.shapes.add_picture("chart.png", Inches(1), Inches(1.5), width=Inches(8))
prs.save("deck.pptx")
```

Charts go in as PNG images made with matplotlib (see the charts skill). Keep text short:
a title that states the point, at most five bullets.

## Writing well

- Lead with the answer or the decision; details after.
- Headings that say something ("Costs rose 12% in Q3"), not labels ("Costs").
- Tables for comparisons, numbers with units, dates in ISO form.
- Keep the user's language: write in the language they wrote to you in.

## Finish

Re-open what you wrote (`pandoc out.docx -t plain | head`, slide count and titles) and
check it before saying it is done. Save outputs in the working directory, give their
paths, and if a tool that sends files to the user is available, use it.
