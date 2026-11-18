// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the approval hook reads about a Codex session (approval-hook.ts): whether it is the interactive TUI, which terminal it
 * runs in, and when someone last typed there. Nothing here imports the rest of the connector: the hook stays small.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** How much of a Codex transcript is read to find its `session_meta` line's originator. */
const META_BYTES = 64 * 1024;

/**
 * Whether the Codex conversation is the interactive TUI: the first line of its transcript is a `session_meta` from
 * `codex-tui` (measured on 0.153.4, where `codex exec` writes `codex_exec`). Anything else, codex-acp included, is left alone.
 */
export function codexTuiTranscript(file: unknown): boolean {
  if (typeof file !== "string" || file === "") return false;
  let head = "";
  try {
    const fd = fs.openSync(file, "r");
    try {
      const b = Buffer.alloc(META_BYTES);
      head = b.subarray(0, fs.readSync(fd, b, 0, META_BYTES, 0)).toString("utf8");
    } finally { fs.closeSync(fd); }
  } catch { return false; }
  const first = head.split("\n")[0] ?? "";
  // Both as JSON keys: inside a string value a quote is escaped, so neither can come from a folder name or the instructions.
  return first.includes('"type":"session_meta"') && first.includes('"originator":"codex-tui"');
}

const TTY_RE = /^\/dev\/(?:pts\/\d+|tty[A-Za-z0-9]+)$/;

/**
 * The terminal device of `pid` (the hook's parent: Codex) or of its parent (a shell Codex ran the hook through), or null
 * (Linux: /proc; elsewhere: ps). No further: a terminal further up is not the session's.
 */
export function terminalOf(pid: number): string | null {
  for (let p = pid, depth = 0; p > 1 && depth < 2; depth++) {
    if (fs.existsSync("/proc/self/fd")) {
      for (const fd of [0, 1, 2]) {
        try { const t = fs.readlinkSync(`/proc/${p}/fd/${fd}`); if (TTY_RE.test(t)) return t; } catch { /* not ours to read, or gone */ }
      }
      try {
        const stat = fs.readFileSync(`/proc/${p}/stat`, "utf8");
        p = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      } catch { return null; }
    } else {
      try {
        const [tty, ppid] = execFileSync("ps", ["-o", "tty=,ppid=", "-p", String(p)], { encoding: "utf8", timeout: 1000 }).trim().split(/\s+/);
        if (tty && tty !== "??" && tty !== "?" && TTY_RE.test(`/dev/${tty}`)) return `/dev/${tty}`;
        p = Number(ppid);
      } catch { return null; }
    }
    if (!Number.isSafeInteger(p)) return null;
  }
  return null;
}

/** When the terminal last had input (ms since the epoch), or null when it cannot be read. */
export function lastInputMs(tty: string): number | null {
  try { return fs.statSync(tty).atimeMs; } catch { return null; }
}
