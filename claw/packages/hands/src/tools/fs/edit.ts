// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";
import { replaceLiteralOnce } from "./literal-replace.js";

const schema = {
  path: z.string().describe("File path"),
  old_string: z.string().describe("Exact text to find (must be unique)"),
  new_string: z.string().describe("Replacement text"),
};

export const edit = {
  name: "edit",
  description: "Replace exact text in a file. old_string must match exactly once.",
  zodSchema: schema,
  execute: async (args: { path: string; old_string: string; new_string: string }) => {
    let safePath: string;
    try { safePath = guardPath(args.path); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
    let content: string;
    try { content = fs.readFileSync(safePath, "utf-8"); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error reading ${args.path}: ${e.message}` }] };
    }
    const count = content.split(args.old_string).length - 1;
    if (count === 0) return { content: [{ type: "text" as const, text: "Error: old_string not found in file" }] };
    if (count > 1) return { content: [{ type: "text" as const, text: `Error: old_string found ${count} times, must be unique` }] };
    fs.writeFileSync(safePath, replaceLiteralOnce(content, args.old_string, args.new_string), "utf-8");
    return { content: [{ type: "text" as const, text: `Edited ${args.path}` }] };
  },
};
