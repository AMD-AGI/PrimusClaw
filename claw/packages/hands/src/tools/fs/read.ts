// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";
import { readImage } from "./read-image.js";

/** Lines one call returns when no limit is given; the rest is paged with offset. */
export const READ_DEFAULT_LINES = 2000;

const schema = {
  path: z.string().describe("File path (relative to workspace)"),
  offset: z.number().optional().describe("Start line (1-based)"),
  limit: z.number().optional().describe(`Number of lines to read (default ${READ_DEFAULT_LINES})`),
  line_numbers: z.boolean().optional().describe("Prefix each line with its number (default true); false returns the raw text"),
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
  description: `Read a file from the workspace. Lines come numbered as N|text; at most ${READ_DEFAULT_LINES} lines per call, page with offset and limit. Automatically detects .ipynb and formats notebook cells. A PNG, JPEG, GIF or WebP image is returned as the image itself, so you can look at it.`,
  zodSchema: schema,
  execute: async (args: { path: string; offset?: number; limit?: number; line_numbers?: boolean; notebook_cell_index?: number }) => {
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

    const image = readImage(safePath, args.path);
    if (image) return image;

    let content: string;
    try { content = fs.readFileSync(safePath, "utf-8"); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error reading ${args.path}: ${e.message}` }] };
    }
    // Raw text is for Brain's own reads of files it wrote (sync metadata), which parse the content.
    if (args.line_numbers === false && !args.offset && !args.limit) {
      return { content: [{ type: "text" as const, text: content }] };
    }
    // A newline ends a line, it does not start one: "a\nb\n" is two lines, not two and an empty third.
    const lines = content.split("\n");
    const endsWithNewline = lines.length > 1 && lines[lines.length - 1] === "";
    if (endsWithNewline) lines.pop();
    const start = Math.max(0, (args.offset ?? 1) - 1);
    const end = Math.min(lines.length, start + (args.limit && args.limit > 0 ? args.limit : READ_DEFAULT_LINES));
    const page = lines.slice(start, end);
    // Raw text keeps the file's own final newline when the page reaches the end.
    const body = args.line_numbers === false
      ? page.join("\n") + (endsWithNewline && end === lines.length && page.length > 0 ? "\n" : "")
      : page.map((l, i) => `${start + i + 1}|${l}`).join("\n");
    const more = end < lines.length
      ? `\n[lines ${start + 1}-${end} of ${lines.length}; call read with offset=${end + 1} for more]`
      : "";
    return { content: [{ type: "text" as const, text: body + more }] };
  },
};
