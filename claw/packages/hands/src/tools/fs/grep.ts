// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { guardPath } from "../../runtime/path-guard.js";
import { WORKSPACE } from "../../config.js";

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else results.push(full);
  }
  return results;
}

const schema = {
  pattern: z.string().describe("Regex pattern to search for"),
  path: z.string().optional().describe("File or directory to search"),
  context: z.number().optional().describe("Lines of context around matches (default: 2)"),
};

// Defenses against ReDoS / runaway scans:
//  - PATTERN_MAX_LEN bounds the regex source length (catastrophic patterns
//    are usually short anyway, this is to reject pathological copy-paste).
//  - PER_FILE_TIMEOUT_MS aborts a single file's regex scan if it exceeds
//    the budget, then moves on to the next file.
//  - TOTAL_TIMEOUT_MS bounds the whole grep call.
const PATTERN_MAX_LEN = 1024;
const PER_FILE_TIMEOUT_MS = 2_000;
const TOTAL_TIMEOUT_MS = 30_000;

export const grep = {
  name: "grep",
  description: "Search file contents using regex pattern",
  zodSchema: schema,
  execute: async (args: { pattern: string; path?: string; context?: number }) => {
    if (args.pattern.length > PATTERN_MAX_LEN) {
      return { content: [{ type: "text" as const, text: `Pattern too long (${args.pattern.length} > ${PATTERN_MAX_LEN})` }] };
    }
    let target: string;
    try { target = args.path ? guardPath(args.path) : WORKSPACE; } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
    const ctx = args.context ?? 2;
    let regex: RegExp;
    try { regex = new RegExp(args.pattern, "i"); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Invalid regex: ${e.message}` }] };
    }
    const results: string[] = [];
    const files = fs.statSync(target).isDirectory() ? walkFiles(target) : [target];
    const totalDeadline = Date.now() + TOTAL_TIMEOUT_MS;
    let timedOutFiles = 0;
    for (const file of files) {
      if (Date.now() > totalDeadline) {
        results.push(`[grep aborted: total timeout ${TOTAL_TIMEOUT_MS}ms hit, ${files.length - results.length} files unscanned]`);
        break;
      }
      try {
        const lines = fs.readFileSync(file, "utf-8").split("\n");
        const rel = path.relative(WORKSPACE, file);
        const fileDeadline = Date.now() + PER_FILE_TIMEOUT_MS;
        let aborted = false;
        for (let i = 0; i < lines.length; i++) {
          // Bail if this single file's regex work blew the per-file budget —
          // protects against catastrophic backtracking on a hostile line.
          if (i % 256 === 0 && Date.now() > fileDeadline) { aborted = true; break; }
          if (regex.test(lines[i])) {
            const start = Math.max(0, i - ctx);
            const end = Math.min(lines.length, i + ctx + 1);
            results.push(`${rel}:`);
            for (let j = start; j < end; j++) {
              results.push(`  ${j + 1}${j === i ? ":" : "-"}${lines[j]}`);
            }
            results.push("");
          }
        }
        if (aborted) { timedOutFiles++; results.push(`${rel}: [scan aborted at ${PER_FILE_TIMEOUT_MS}ms]`); }
      } catch { /* skip binary/unreadable */ }
    }
    if (timedOutFiles > 0) {
      results.unshift(`[note] ${timedOutFiles} file(s) hit the per-file ${PER_FILE_TIMEOUT_MS}ms scan timeout (possible ReDoS pattern).`);
    }
    return { content: [{ type: "text" as const, text: results.join("\n") || "(no matches)" }] };
  },
};
