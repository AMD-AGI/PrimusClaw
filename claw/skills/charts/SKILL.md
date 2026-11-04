---
name: charts
description: Make clear charts and figures (bar, line, scatter, histogram, stacked, small multiples) from data with matplotlib and save them as PNG, SVG or PDF for reports, slides or chat. Use when a task asks to plot, chart, graph or visualise data.
---

# Charts

Work in the sandbox with python3, `matplotlib` and `pandas` (both in the default sandbox
image). Always use the file backend: `import matplotlib; matplotlib.use("Agg")`.

## Choose the chart from the question

| The question | Chart |
|---|---|
| Compare a few categories | Horizontal bar, sorted by value |
| Change over time | Line (bars only for a handful of periods) |
| Parts of a whole | Stacked bar; a pie only for 2-4 parts |
| Relationship of two measures | Scatter |
| Distribution | Histogram or box plot |
| Same chart for many groups | Small multiples (`plt.subplots(rows, cols, sharey=True)`) |

## Template

```python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd

df = pd.read_csv("data.csv").sort_values("revenue")
fig, ax = plt.subplots(figsize=(8, 4.5), dpi=150, layout="constrained")
ax.barh(df["region"], df["revenue"], color="#4C78A8")
ax.set_title("Revenue by region, Q3 2026 (USD millions)", loc="left")
ax.set_xlabel("USD millions")
ax.spines[["top", "right"]].set_visible(False)
ax.bar_label(ax.containers[0], fmt="%.1f", padding=3)
fig.savefig("revenue_by_region.png")      # .svg or .pdf for print
plt.close(fig)
```

## Rules

- The title states what the reader should see; axis labels carry units.
- Start bar axes at zero; do not use 3-D, shadows or a second y-axis unless asked.
- One color for one series; a distinct color only for what the text talks about.
  For several series use a colorblind-friendly set (e.g. `plt.colormaps["tab10"]`).
- Dates: `fig.autofmt_xdate()` or `matplotlib.dates.ConciseDateFormatter`.
- Many points: aggregate first; label at most the few that matter.
- Chinese, Japanese or Korean text: set a CJK font first, or the labels render as boxes:
  `plt.rcParams["font.sans-serif"] = ["WenQuanYi Micro Hei", "DejaVu Sans"]` (check what is
  installed with `fc-list :lang=zh family`).

## Finish

Open the image you saved (or check its size and that it is not blank) and describe in
one sentence what it shows. Save it in the working directory, give its path, and if a
tool that sends files to the user is available, use it.
