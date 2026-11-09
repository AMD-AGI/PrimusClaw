// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * tmp-dirs.ts: a test file's temporary directories are gone when it ends, however it ends.
 *
 *   T1 a file whose test passes leaves none
 *   T2 a file whose test fails leaves none
 *   T3 a file that calls process.exit mid-test leaves none
 *   T4 a file stopped by SIGTERM or SIGINT leaves none, and still ends by that signal
 *   T5 CLAW_TEST_KEEP_TMP=1 keeps them
 *   T6 the suites that made sa-eval-* and claw-build-* directories in TMPDIR and left them there leave none
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../../utils/test/tmp-dirs.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(HERE, "..");

interface Run { code: number | null; signal: NodeJS.Signals | null; out: string; err: string; dirs: string[] }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `file` as its own process with TMPDIR set to a directory of this test's, as a person runs one test file. The
 * fixture writes the directory it made to a report file outside TMPDIR; `onDir` is called once that file exists.
 */
async function run(file: string, env: Record<string, string>, tmp: string, onDir?: (child: ChildProcess) => void): Promise<Run> {
  const report = join(tmpDir("tmp-dirs-report-"), "dir");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, FIXTURE_REPORT: report, ...env };
  // This file runs under the test runner; the child is a test file of its own, not a part of this one's report.
  delete childEnv.NODE_TEST_CONTEXT;
  if (!("CLAW_TEST_KEEP_TMP" in env)) delete childEnv.CLAW_TEST_KEEP_TMP;
  const child = spawn(process.execPath, ["--import", "tsx", file], { cwd: API_DIR, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (b) => { out += String(b); });
  child.stderr!.on("data", (b) => { err += String(b); });
  const killer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let exited = false;
  child.on("exit", () => { exited = true; });
  // `close`, not `exit`: it comes after the child's stdout and stderr have ended, so `out` and `err` are whole.
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("close", (code, signal) => { clearTimeout(killer); resolve({ code, signal }); }));
  if (onDir) {
    while (!exited && !existsSync(report)) await sleep(20);
    if (!exited) onDir(child);
  }
  const { code, signal } = await done;
  return { code, signal, out, err, dirs: existsSync(report) ? [readFileSync(report, "utf8")] : [] };
}

const fixture = (mode: string, tmp: string, onDir?: (child: ChildProcess) => void): Promise<Run> =>
  run(join(HERE, "tmp-dirs-fixture.ts"), { FIXTURE_MODE: mode }, tmp, onDir);

/** The fixture made exactly one directory, in `tmp`, and it is gone. */
function gone(r: Run, tmp: string): void {
  assert.equal(r.dirs.length, 1, `the fixture printed its directory\n${r.out}\n${r.err}`);
  assert.equal(dirname(r.dirs[0]!), tmp);
  assert.equal(existsSync(r.dirs[0]!), false, `${r.dirs[0]} is left`);
  assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith("tmp-dirs-fixture-")), []);
}

test("T1 a file whose test passes leaves none", async () => {
  const tmp = tmpDir("tmp-dirs-t1-");
  const r = await fixture("pass", tmp);
  assert.equal(r.code, 0, r.out + r.err);
  gone(r, tmp);
});

test("T2 a file whose test fails leaves none", async () => {
  const tmp = tmpDir("tmp-dirs-t2-");
  const r = await fixture("fail", tmp);
  assert.notEqual(r.code, 0, "the failing test fails the file");
  gone(r, tmp);
});

test("T3 a file that calls process.exit mid-test leaves none", async () => {
  const tmp = tmpDir("tmp-dirs-t3-");
  const r = await fixture("exit", tmp);
  assert.equal(r.code, 3);
  gone(r, tmp);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`T4 a file stopped by ${signal} leaves none, and still ends by it`, async () => {
    const tmp = tmpDir("tmp-dirs-t4-");
    const r = await fixture("signal", tmp, (child) => child.kill(signal));
    // Ended by the signal it was sent, not by the 60 s wait running out or the SIGKILL backstop.
    assert.equal(r.signal, signal, `ended by ${String(r.signal ?? r.code)}\n${r.out}\n${r.err}`);
    gone(r, tmp);
  });
}

test("T5 CLAW_TEST_KEEP_TMP=1 keeps them", async () => {
  const tmp = tmpDir("tmp-dirs-t5-");
  const r = await run(join(HERE, "tmp-dirs-fixture.ts"), { FIXTURE_MODE: "pass", CLAW_TEST_KEEP_TMP: "1" }, tmp);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.dirs.length, 1);
  assert.equal(existsSync(join(r.dirs[0]!, "file")), true, "kept, with what the test wrote");
});

for (const [file, prefix] of [["sa-eval.test.ts", "sa-eval-"], ["assistant-self-status.test.ts", "claw-build-"]] as const) {
  test(`T6 ${file} leaves no ${prefix}* directory in TMPDIR`, async () => {
    const tmp = tmpDir("tmp-dirs-t6-");
    const r = await run(join(HERE, file), {}, tmp);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(readdirSync(tmp).filter((n) => n.startsWith(prefix)), []);
  });
}
