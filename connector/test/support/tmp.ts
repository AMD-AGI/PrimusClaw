// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Temporary directories for the tests, removed when the test file ends. Every directory `tmpdir` makes is
 * recorded; the file's `after` hook first runs what `onCleanup` registered (a connector to stop, a stand-in Claw to
 * close), newest first, so nothing is still writing, and then removes the directories. A file that dies before its
 * hooks run (an uncaught error, `process.exit`) still removes them on the process's `exit`.
 *
 * Only the test files' own processes import this: it registers a hook with node:test, which a helper process a
 * test spawns must not do (support/run-fast.ts imports support/timing.ts, not the harness, for that reason).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

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
process.on("exit", removeAll);
