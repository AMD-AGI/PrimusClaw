// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";
import { replaceLiteralOnce } from "./literal-replace.js";

const editItem = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
});

const schema = {
  edits: z.array(editItem).describe("Array of {path, old_string, new_string} edits"),
};

export const multiEdit = {
  name: "multi_edit",
  description: "Apply multiple str_replace edits across files in a single call",
  zodSchema: schema,
  execute: async (args: { edits: Array<{ path: string; old_string: string; new_string: string }> }) => {
    const results: string[] = [];
    for (const op of args.edits) {
      let safePath: string;
      try { safePath = guardPath(op.path); } catch (e: any) {
        results.push(`${op.path}: ${e.message}`); continue;
      }
      try {
        const content = fs.readFileSync(safePath, "utf-8");
        const count = content.split(op.old_string).length - 1;
        if (count === 0) { results.push(`${op.path}: old_string not found`); continue; }
        if (count > 1) { results.push(`${op.path}: old_string found ${count} times, must be unique`); continue; }
        fs.writeFileSync(safePath, replaceLiteralOnce(content, op.old_string, op.new_string), "utf-8");
        results.push(`${op.path}: ok`);
      } catch (e: any) {
        results.push(`${op.path}: ${e.message}`);
      }
    }
    return { content: [{ type: "text" as const, text: results.join("\n") }] };
  },
};
