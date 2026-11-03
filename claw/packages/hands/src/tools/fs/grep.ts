// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { minimatch } from "minimatch";
import { guardPath } from "../../runtime/path-guard.js";
import { WORKSPACE } from "../../config.js";
import { WORKSPACE_EXCLUDES } from "@claw/protocol";

/**
 * What a recursive search does not enter: version-control internals, the
 * Python venv convention, and everything a workspace snapshot leaves behind
 * (dependency trees, caches, uploads, transcripts, kept tool results), which is
 * large and never what was meant. Other dot-directories (.github, .claude,
 * .vscode) hold real project files and are searched. A path given explicitly is
 * searched whatever its name.
 */
export const GREP_SKIP = [".git", ".venv", ...WORKSPACE_EXCLUDES] as const;

/** A file bigger than this is not read: a dataset or a binary, and one read would hold Hands past every deadline. */
export const GREP_MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * A file's text, or why it is not read. The path is opened once and everything is
 * asked of that descriptor, so a link swapped between a check and the read cannot
 * hand the read a FIFO or a device; nonblocking, so opening a FIFO does not wait
 * for a writer. Only a regular file is read, and never past its size when checked.
 */
function readCapped(file: string): { text: string } | "not-a-file" | "too-large" {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return "not-a-file";
    if (st.size > GREP_MAX_FILE_BYTES) return "too-large";
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = fs.readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return { text: buf.toString("utf-8", 0, off) };
  } finally {
    fs.closeSync(fd);
  }
}

const skipped = (name: string) => GREP_SKIP.some((p) => minimatch(name, p, { dot: true }));

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipped(entry.name)) continue;
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
  case_sensitive: z.boolean().optional().describe("Match case exactly (default false: case-insensitive)"),
  glob: z.string().optional().describe("Only search files whose path matches this glob, e.g. *.ts or src/**/*.py"),
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
  description: "Search file contents with a regex (case-insensitive unless case_sensitive). Searches dot-directories such as .github; skips .git, node_modules, caches, uploads and files over 8 MB.",
  zodSchema: schema,
  execute: async (args: { pattern: string; path?: string; context?: number; case_sensitive?: boolean; glob?: string }) => {
    if (args.pattern.length > PATTERN_MAX_LEN) {
      return { content: [{ type: "text" as const, text: `Pattern too long (${args.pattern.length} > ${PATTERN_MAX_LEN})` }] };
    }
    let target: string;
    try { target = args.path ? guardPath(args.path) : WORKSPACE; } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }] };
    }
    const ctx = args.context ?? 2;
    let regex: RegExp;
    try { regex = new RegExp(args.pattern, args.case_sensitive ? "" : "i"); } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Invalid regex: ${e.message}` }] };
    }
    const results: string[] = [];
    const isDir = fs.statSync(target).isDirectory();
    const walked = isDir ? walkFiles(target) : [target];
    // A pattern without a slash names a file, at any depth; with one it is a path under the searched directory.
    const files = args.glob && isDir
      ? walked.filter((f) => minimatch(path.relative(target, f), args.glob!, { matchBase: true, dot: true }))
      : walked;
    const totalDeadline = Date.now() + TOTAL_TIMEOUT_MS;
    let timedOutFiles = 0;
    let tooLarge = 0;
    for (const file of files) {
      if (Date.now() > totalDeadline) {
        results.push(`[grep aborted: total timeout ${TOTAL_TIMEOUT_MS}ms hit, ${files.length - results.length} files unscanned]`);
        break;
      }
      try {
        const read = readCapped(file);
        if (read === "not-a-file") continue;
        if (read === "too-large") { tooLarge++; continue; }
        const lines = read.text.split("\n");
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
    if (tooLarge > 0) {
      results.unshift(`[note] ${tooLarge} file(s) over ${GREP_MAX_FILE_BYTES / (1024 * 1024)} MB not searched.`);
    }
    if (timedOutFiles > 0) {
      results.unshift(`[note] ${timedOutFiles} file(s) hit the per-file ${PER_FILE_TIMEOUT_MS}ms scan timeout (possible ReDoS pattern).`);
    }
    return { content: [{ type: "text" as const, text: results.join("\n") || "(no matches)" }] };
  },
};
