---
name: pdf
description: Read, search, split, merge, rotate, fill or create PDF files, extract their text and tables (to CSV or Excel), turn pages into images, and OCR scanned pages. Use whenever a task involves a .pdf file.
---

# PDF

Work in the sandbox with bash and python3. The default sandbox image has poppler
(`pdftotext`, `pdfinfo`, `pdftoppm`, `pdfimages`), `pypdf`, `pdfplumber`, `tesseract`
and `matplotlib`. If a command is missing (`command -v pdftotext`), say so and fall back
to the python libraries, or install with `pip install --user <package>`.

## First look

```bash
pdfinfo in.pdf                      # pages, page size, encrypted?, producer
pdftotext -layout -f 1 -l 3 in.pdf - | head -100   # text of the first pages, columns kept
```

No text out of a page that clearly has words means it is a scan: OCR it (below).
Never print a whole long PDF into the conversation; read it in page ranges, or write
the text to a file and `rg` it.

## Text and search

```bash
pdftotext -layout in.pdf in.txt && rg -n -i "invoice total" in.txt
```

For a question about one part, find the page first (`pdftotext -f N -l N`), then read
that page only. Quote page numbers in the answer.

## Tables

```python
import pdfplumber, pandas as pd
frames = []
with pdfplumber.open("in.pdf") as pdf:
    for n, page in enumerate(pdf.pages, 1):
        for t in page.extract_tables():
            if t and len(t) > 1:
                df = pd.DataFrame(t[1:], columns=t[0]); df["page"] = n; frames.append(df)
pd.concat(frames).to_excel("tables.xlsx", index=False)   # or .to_csv
```

Check the result: print the shape and the first rows, and compare one row with the
page text. Tables that span pages often repeat the header; drop those rows.

## Split, merge, rotate, encrypt

```python
from pypdf import PdfReader, PdfWriter
r = PdfReader("in.pdf")
w = PdfWriter()
for i in range(0, 5): w.add_page(r.pages[i])          # pages 1-5
w.write("part1.pdf")

m = PdfWriter()
for f in ["a.pdf", "b.pdf"]: m.append(f)               # merge in order
m.write("merged.pdf")

page = r.pages[0]; page.rotate(90)                     # rotate one page
```

Fill a form: `w = PdfWriter(clone_from="form.pdf")`, read field names with
`PdfReader("form.pdf").get_fields()`, then `w.update_page_form_field_values(w.pages[0], {...}, auto_regenerate=False)`.

## Pages to images, OCR

```bash
pdftoppm -png -r 150 -f 1 -l 1 in.pdf page          # page-1.png
tesseract page-1.png - -l eng                      # text of a scanned page
```

`tesseract --list-langs` shows the installed languages; only English is guaranteed.

## Create a PDF

- From Markdown or Word: `pandoc report.md -o report.docx`, then convert if a PDF is
  required and a converter exists; otherwise deliver the .docx and say why.
- A chart or a page of figures: matplotlib `fig.savefig("out.pdf")`; several pages with
  `matplotlib.backends.backend_pdf.PdfPages`.

## Finish

Re-open every PDF you wrote (`pdfinfo`, page count, a `pdftotext` sample) before saying
it is done. Save outputs in the working directory, give their paths, and if a tool that
sends files to the user is available, use it.
