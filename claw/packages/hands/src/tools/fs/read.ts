// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";

const schema = {
  path: z.string().describe("File path (relative to workspace)"),
  offset: z.number().optional().describe("Start line (1-based)"),
  limit: z.number().optional().describe("Number of lines to read"),
  notebook_cell_index: z.number().int().nonnegative().optional()
    .describe("For .ipynb files: return only this cell (0-based)"),
};

/** Format a parsed .ipynb notebook for LLM consumption. */
function formatNotebook(
  nb: Record<string, unknown>,
  cellIndexFilter?: number,
): string {
  const rawCells = nb.cells;
  if (!Array.isArray(rawCells)) return "Error: invalid notebook format (cells is not an array)";
  const cells = rawCells as Array<Record<string, unknown>>;
  const kernel = ((nb.metadata as Record<string, unknown>)?.kernelspec as Record<string, unknown>)?.name ?? "unknown";
  const header = `Notebook: ${cells.length} cells (kernel: ${kernel})`;

  if (cellIndexFilter !== undefined) {
    if (cellIndexFilter < 0 || cellIndexFilter >= cells.length) {
      return `${header}\n\nError: cell index ${cellIndexFilter} out of range (0..${cells.length - 1})`;
    }
    return `${header}\n\n${formatCell(cells[cellIndexFilter], cellIndexFilter)}`;
  }

  const parts = [header, ""];
  for (let i = 0; i < cells.length; i++) {
    parts.push(formatCell(cells[i], i));
  }
  return parts.join("\n");
}

function formatCell(cell: Record<string, unknown>, index: number): string {
  const ct = String(cell.cell_type ?? "raw");
  const src = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
  const outputs = (cell.outputs ?? []) as Array<Record<string, unknown>>;
  const outCount = outputs.length;

  let header = `[${index}] ${ct}`;
  if (ct === "code") header += outCount > 0 ? ` (${outCount} outputs):` : " (no outputs):";
  else header += ":";

  const lines = [header, src.trim()];

  for (const out of outputs) {
    if (out.output_type === "stream") {
      const text = Array.isArray(out.text) ? out.text.join("") : String(out.text ?? "");
      lines.push(text.length > 1024 ? text.slice(0, 1024) + "\n[output truncated]" : text);
    } else if (out.output_type === "execute_result" || out.output_type === "display_data") {
      const data = (out.data ?? {}) as Record<string, unknown>;
      if (data["text/plain"]) {
        const plain = Array.isArray(data["text/plain"]) ? data["text/plain"].join("") : String(data["text/plain"]);
        lines.push(plain.length > 1024 ? plain.slice(0, 1024) + "\n[output truncated]" : plain);
      } else if (data["image/png"]) {
        const b64 = String(data["image/png"]);
        lines.push(`<binary output, ${Math.round(b64.length * 0.75)} bytes>`);
      } else {
        lines.push(`<${Object.keys(data).join(", ")} output>`);
      }
    } else if (out.output_type === "error") {
      const tb = Array.isArray(out.traceback) ? out.traceback.join("\n") : String(out.traceback ?? "");
      lines.push(tb.length > 1024 ? tb.slice(0, 1024) + "\n[traceback truncated]" : tb);
    }
  }

  return lines.join("\n");
}

export const read = {
  name: "read",
  description: "Read a file from the workspace. Supports line offset and limit. Automatically detects .ipynb and formats notebook cells.",
  zodSchema: schema,
  execute: async (args: { path: string; offset?: number; limit?: number; notebook_cell_index?: number }) => {
    let safePath: string;
    try { safePath = guardPath(args.path); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }

    // .ipynb dispatch — handled inline rather than as a separate notebook tool
    if (safePath.endsWith(".ipynb")) {
      try {
        const raw = fs.readFileSync(safePath, "utf-8");
        const nb = JSON.parse(raw);
        const text = formatNotebook(nb, args.notebook_cell_index);
        return { content: [{ type: "text" as const, text }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error reading notebook ${args.path}: ${e.message}` }] };
      }
    }

    let content: string;
    try { content = fs.readFileSync(safePath, "utf-8"); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error reading ${args.path}: ${e.message}` }] };
    }
    if (args.offset || args.limit) {
      const lines = content.split("\n");
      const start = Math.max(0, (args.offset ?? 1) - 1);
      const end = args.limit ? start + args.limit : lines.length;
      const sliced = lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`).join("\n");
      return { content: [{ type: "text" as const, text: sliced }] };
    }
    return { content: [{ type: "text" as const, text: content }] };
  },
};
