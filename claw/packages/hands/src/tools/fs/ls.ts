// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";
import { WORKSPACE } from "../../config.js";

const schema = {
  path: z.string().optional().describe("Directory path (default: workspace root)"),
};

export const ls = {
  name: "ls",
  description: "List directory contents with file type and size",
  zodSchema: schema,
  execute: async (args: { path?: string }) => {
    let dir: string;
    try { dir = args.path ? guardPath(args.path) : WORKSPACE; } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error listing ${args.path || "/"}: ${e.message}` }] };
    }
    const lines = entries.map((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return `${e.name}/`;
      const stat = fs.statSync(full);
      return `${e.name}  (${stat.size} bytes)`;
    });
    return { content: [{ type: "text" as const, text: lines.join("\n") || "(empty directory)" }] };
  },
};
