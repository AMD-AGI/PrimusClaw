---
name: spreadsheets
description: Read, clean, analyse, join or create Excel (.xlsx), CSV and TSV data - summaries, pivots, formulas, formatted workbooks, data checks. Use whenever a task involves a spreadsheet or tabular data file.
---

# Spreadsheets and tabular data

Work in the sandbox with python3. The default sandbox image has `pandas`, `openpyxl`,
`xlsxwriter`, `tabulate` and `sqlite3`. If one is missing, say so and use what is there.

## Look before you compute

```python
import pandas as pd
xl = pd.ExcelFile("in.xlsx"); print(xl.sheet_names)
df = pd.read_excel(xl, sheet_name=0)          # header row? use header=N or skiprows
print(df.shape); print(df.dtypes); print(df.head(10).to_markdown())
print(df.isna().sum())
```

CSV: `pd.read_csv(path, sep=None, engine="python")` sniffs the separator; pass
`encoding="utf-8-sig"` or `"gbk"` when the text comes out garbled.

Check what you are given before answering: header rows, merged cells (they read as
NaN below the first cell), numbers stored as text (`pd.to_numeric(..., errors="coerce")`),
dates (`pd.to_datetime`), duplicated keys, totals rows that would be counted twice.

## Analyse

```python
summary = df.groupby("region", as_index=False).agg(orders=("id", "count"), revenue=("amount", "sum"))
pivot = df.pivot_table(index="month", columns="region", values="amount", aggfunc="sum", fill_value=0)
joined = a.merge(b, on="id", how="left", validate="one_to_one", indicator=True)
print(joined["_merge"].value_counts())        # rows that did not match
```

For large files or SQL-shaped questions, load into sqlite3 and query:
`df.to_sql("t", sqlite3.connect("data.db"), index=False)`.

State the numbers you report and how you got them (filters, which column, units).

## Write a workbook people can use

```python
with pd.ExcelWriter("out.xlsx", engine="xlsxwriter") as w:
    summary.to_excel(w, sheet_name="Summary", index=False)
    df.to_excel(w, sheet_name="Data", index=False)
    ws = w.sheets["Summary"]; book = w.book
    ws.set_column(0, len(summary.columns) - 1, 16)
    ws.freeze_panes(1, 0)
    ws.autofilter(0, 0, len(summary), len(summary.columns) - 1)
    money = book.add_format({"num_format": "#,##0.00"}); ws.set_column("C:C", 16, money)
```

Formulas: write them as strings (`ws.write_formula("D2", "=B2*C2")` or with openpyxl
`ws["D2"] = "=B2*C2"`). Neither library calculates them; tell the user the values appear
when the file is opened, or compute the value in pandas as well when it is needed now.

Edit an existing workbook without losing its formatting with openpyxl
(`load_workbook(path)`; `data_only=True` reads cached values instead of formulas, and
saving such a workbook drops its formulas, so never save a workbook opened that way).

## Finish

Re-open the output (`pd.read_excel(out, sheet_name=None)`: sheet names, shapes, a few
rows) before saying it is done. Save outputs in the working directory, give their paths,
and if a tool that sends files to the user is available, use it.
