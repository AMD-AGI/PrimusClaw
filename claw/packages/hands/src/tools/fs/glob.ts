// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { minimatch } from "minimatch";
import { guardPath } from "../../runtime/path-guard.js";
import { WORKSPACE } from "../../config.js";

function walkDir(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkDir(full));
    else results.push(full);
  }
  return results;
}

const schema = {
  pattern: z.string().describe("Glob pattern (e.g. **/*.ts)"),
  directory: z.string().optional().describe("Subdirectory to search in"),
};

export const glob = {
  name: "glob",
  description: "Find files matching a glob pattern in the workspace",
  zodSchema: schema,
  execute: async (args: { pattern: string; directory?: string }) => {
    let baseDir: string;
    try { baseDir = args.directory ? guardPath(args.directory) : WORKSPACE; } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
    const files = walkDir(baseDir);
    const matched = files
      .map((f) => path.relative(baseDir, f))
      .filter((rel) => minimatch(rel, args.pattern))
      .sort();
    return { content: [{ type: "text" as const, text: matched.join("\n") || "(no matches)" }] };
  },
};
