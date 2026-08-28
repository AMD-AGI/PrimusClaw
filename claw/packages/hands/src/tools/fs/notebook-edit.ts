// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";
import { replaceLiteralOnce } from "./literal-replace.js";

const schema = {
  path: z.string().describe("Notebook file path (.ipynb)"),
  cell_index: z.number().int().nonnegative().describe("Cell index (0-based)"),
  old_string: z.string().optional().describe("Exact text to replace in the cell"),
  new_string: z.string().describe("Replacement text (or full cell content if no old_string)"),
};

export const notebookEdit = {
  name: "notebook_edit",
  description: "Edit a Jupyter notebook cell by index",
  zodSchema: schema,
  execute: async (args: { path: string; cell_index: number; old_string?: string; new_string: string }) => {
    let safePath: string;
    try { safePath = guardPath(args.path); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
    let nb: any;
    try { nb = JSON.parse(fs.readFileSync(safePath, "utf-8")); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error reading notebook: ${e.message}` }] };
    }
    const cells = nb.cells;
    if (!Array.isArray(cells)) {
      return { content: [{ type: "text" as const, text: "Error: invalid notebook format (cells is not an array)" }] };
    }
    if (!Number.isInteger(args.cell_index)) {
      return { content: [{ type: "text" as const, text: `Error: cell_index must be an integer (got ${args.cell_index})` }] };
    }
    if (args.cell_index < 0 || args.cell_index >= cells.length) {
      return { content: [{ type: "text" as const, text: `Error: cell_index ${args.cell_index} out of range (${cells.length} cells)` }] };
    }
    const cell = cells[args.cell_index];
    const source = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
    if (args.old_string) {
      // Uniqueness is required for the same reason as in `edit`: cell_index
      // disambiguates between cells, so old_string is the only lever the caller
      // has inside a cell. Editing an ambiguous match would silently pick the
      // first one.
      const count = source.split(args.old_string).length - 1;
      if (count === 0) {
        return { content: [{ type: "text" as const, text: "Error: old_string not found in cell" }] };
      }
      if (count > 1) {
        return { content: [{ type: "text" as const, text: `Error: old_string found ${count} times in cell ${args.cell_index}, must be unique` }] };
      }
      cell.source = replaceLiteralOnce(source, args.old_string, args.new_string).split(/(?<=\n)/);
    } else {
      cell.source = args.new_string.split(/(?<=\n)/);
    }
    fs.writeFileSync(safePath, JSON.stringify(nb, null, 1), "utf-8");
    return { content: [{ type: "text" as const, text: `Edited cell ${args.cell_index} in ${args.path}` }] };
  },
};
