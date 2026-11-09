// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Temporary directories for a test file, removed when the file ends: by the file's `after` hook when it finishes
 * (passing or failing), on the process's `exit` when it dies before its hooks run (an uncaught error,
 * `process.exit`), and on SIGINT/SIGTERM (an interrupted run, a killed runner), after which the signal is raised
 * again so the process still ends the way it was told to. A SIGKILL cannot be caught; nothing here helps there.
 *
 * CLAW_TEST_KEEP_TMP=1 keeps them for debugging, and names each one kept on stderr.
 *
 * Only the test files' own processes import this: it registers a hook with node:test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const made = new Set<string>();

/** Whether the directories are kept, read when they would be removed. */
const keep = (): boolean => process.env.CLAW_TEST_KEEP_TMP === "1";

/** A new directory under os.tmpdir() (TMPDIR), removed when the test file ends. */
export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.add(dir);
  return dir;
}

/** Remove every directory made and not yet removed (or, with CLAW_TEST_KEEP_TMP=1, name them). Safe to call again. */
export function removeTmpDirs(): void {
  if (keep()) {
    for (const dir of made) process.stderr.write(`CLAW_TEST_KEEP_TMP=1: kept ${dir}\n`);
    made.clear();
    return;
  }
  for (const dir of made) {
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); made.delete(dir); } catch { /* left; nothing else to do */ }
  }
}

after(removeTmpDirs);
process.on("exit", removeTmpDirs);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    removeTmpDirs();
    // `once` has removed this listener: unless the file added its own, the default action now ends the process.
    process.kill(process.pid, signal);
  });
}
