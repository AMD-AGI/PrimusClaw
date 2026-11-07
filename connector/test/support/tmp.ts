// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Temporary directories for the tests, removed when the test file ends. Every directory `tmpdir` makes is
 * recorded; the file's `after` hook first runs what `onCleanup` registered (a connector to stop, a stand-in Claw to
 * close), newest first, so nothing is still writing, and then removes the directories. A file that dies before its
 * hooks run (an uncaught error, `process.exit`) still removes them on the process's `exit`, after killing the adapters
 * a connector with its home in one of them recorded in children.json: they run detached and would outlive the file.
 *
 * Only the test files' own processes import this: it registers a hook with node:test, which a helper process a
 * test spawns must not do (support/run-fast.ts imports support/timing.ts, not the harness, for that reason).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { processStart, type ChildRecord } from "../../src/children.js";

const made = new Set<string>();
const closers: Array<() => unknown> = [];

/** A new directory under os.tmpdir() (TMPDIR), its real path, removed when the test file ends. */
export const tmpdir = (prefix = "cc-"): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.add(dir);
  return dir;
};

/** Run `close` when the test file ends, before its temporary directories are removed. */
export const onCleanup = (close: () => unknown): void => { closers.push(close); };

/** The directories made and not yet removed. */
export const liveTmpdirs = (): string[] => [...made].filter((d) => fs.existsSync(d));

/** A test may leave a directory it cannot enter (mode 0): give the owner its bits back, top down, then remove. */
function forceRemove(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return;
  } catch { /* fall through */ }
  const open = (p: string): void => {
    let st: fs.Stats;
    try { st = fs.lstatSync(p); } catch { return; }
    if (!st.isDirectory()) return;
    try { fs.chmodSync(p, 0o700); } catch { /* not ours */ }
    let names: string[] = [];
    try { names = fs.readdirSync(p); } catch { return; }
    for (const n of names) open(path.join(p, n));
  };
  open(dir);
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* reported by liveTmpdirs */ }
}

/** Every children.json at most `depth` levels below `dir` (a connector home is `<dir>/state` or nested a little deeper). */
function childrenFiles(dir: string, depth: number): string[] {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === "children.json") return [p];
    return e.isDirectory() && depth > 0 ? childrenFiles(p, depth - 1) : [];
  });
}

/**
 * SIGKILL the process groups the connectors recorded in children.json under the directories made, those whose
 * start time still matches (the connector's own rule: a recycled pid is never hit). Synchronous, for `exit`.
 */
function killRecordedAdapters(): void {
  for (const dir of made) {
    for (const file of childrenFiles(dir, 3)) {
      let recs: unknown;
      try { recs = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
      for (const r of Array.isArray(recs) ? (recs as ChildRecord[]) : []) {
        if (!r || !Number.isInteger(r.pgid) || r.pgid <= 1 || processStart(r.pid) !== r.start) continue;
        if ([process.pid, process.ppid].includes(r.pgid) || r.pid === process.pid) continue; // never this file or its runner
        try { process.kill(-r.pgid, "SIGKILL"); } catch { /* gone */ }
      }
    }
  }
}

function removeAll(): void {
  for (const dir of made) {
    forceRemove(dir);
    if (!fs.existsSync(dir)) made.delete(dir);
  }
}

/** Close what was registered (newest first), then remove every directory made. Safe to call more than once. */
export async function cleanupTmp(): Promise<void> {
  for (const close of closers.splice(0).reverse()) {
    try { await close(); } catch { /* the directories go regardless */ }
  }
  removeAll();
}

after(cleanupTmp);
// A crash, or a process.exit before the hooks ran; also catches a directory a late writer recreated after `after`.
process.on("exit", () => {
  try { killRecordedAdapters(); } catch { /* the directories go regardless */ }
  removeAll();
});
