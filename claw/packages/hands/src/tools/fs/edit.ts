// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";
import { replaceLiteralAll, replaceLiteralOnce } from "./literal-replace.js";

const schema = {
  path: z.string().describe("File path"),
  old_string: z.string().describe("Exact text to find (must be unique unless replace_all)"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring exactly one"),
};

export const edit = {
  name: "edit",
  description: "Replace exact text in a file. old_string must match exactly once, or set replace_all to replace every occurrence.",
  zodSchema: schema,
  execute: async (args: { path: string; old_string: string; new_string: string; replace_all?: boolean }) => {
    let safePath: string;
    try { safePath = guardPath(args.path); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
    let content: string;
    try { content = fs.readFileSync(safePath, "utf-8"); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error reading ${args.path}: ${e.message}` }] };
    }
    if (args.old_string === "") return { content: [{ type: "text" as const, text: "Error: old_string is empty" }] };
    const count = content.split(args.old_string).length - 1;
    if (count === 0) return { content: [{ type: "text" as const, text: `Error: old_string not found in file${nearestLineHint(content, args.old_string)}` }] };
    if (count > 1 && !args.replace_all) {
      return { content: [{ type: "text" as const, text: `Error: old_string found ${count} times, must be unique (add surrounding context, or pass replace_all=true to replace all ${count})` }] };
    }
    const next = args.replace_all
      ? replaceLiteralAll(content, args.old_string, args.new_string)
      : replaceLiteralOnce(content, args.old_string, args.new_string);
    fs.writeFileSync(safePath, next, "utf-8");
    return { content: [{ type: "text" as const, text: count > 1 ? `Edited ${args.path} (${count} replacements)` : `Edited ${args.path}` }] };
  },
};

/**
 * Where the first line of a missed `old_string` nearly appears, so the model can
 * copy the real text instead of guessing again. Whitespace is the usual
 * culprit (indentation, tabs, a trailing space), so lines are compared trimmed.
 */
function nearestLineHint(content: string, oldString: string): string {
  const wanted = oldString.split("\n").find((l) => l.trim() !== "")?.trim();
  if (!wanted) return "";
  const lines = content.split("\n");
  const at = lines.findIndex((l) => l.trim() === wanted);
  if (at === -1) return "";
  return `; its first line appears at line ${at + 1} with different surrounding text or whitespace: ${JSON.stringify(lines[at])}`;
}
