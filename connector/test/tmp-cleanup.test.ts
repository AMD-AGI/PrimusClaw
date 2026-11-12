// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The suite leaves nothing in TMPDIR: every directory a test makes through support/tmp.ts (the harness's home, work
 * and Claude directories among them) is gone when its file ends, whether the file passed, failed or exited in the
 * middle of a test or was interrupted by a signal, and no adapter a harness's session started outlives it. support/tmp-fixture.ts runs as a test file in a process of its own, under a TMPDIR of its own.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { tmpdir } from "./support/tmp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "support", "tmp-fixture.ts");
/** What node and tsx keep in TMPDIR for themselves, reused across runs: not the suite's. */
const TOOL_CACHE = /^(tsx-\d+|node-compile-cache)$/;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z "); } catch { return false; }
};

interface Run { status: number | null; signal: NodeJS.Signals | null; made: string[]; adapters: number[]; closed: number[]; left: string[]; out: string }

/** The fixture ending as `end` says; with `closeStdout`, this side closes the pipe the fixture reports into once it has set up, as a runner that has left does. */
async function run(end: string, closeStdout = false): Promise<Run> {
  const tmp = tmpdir("tmpguard-");
  const report = path.join(tmpdir("tmpguard-report-"), "made.json");
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TMP_FIXTURE_END: end, TMP_FIXTURE_REPORT: report };
  delete env.NODE_TEST_CONTEXT; // its own run, not a subtest reporting to this one
  const child = spawn(process.execPath, ["--import", "tsx", "--test-reporter=tap", FIXTURE], {
    // SIGKILL: a fixture that hangs must not be cleaned up by the very handlers under test.
    cwd: path.dirname(here), env, stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGKILL",
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>((r) => child.once("exit", (code, sig) => r([code, sig])));
  if (closeStdout) {
    for (let by = Date.now() + 60_000; !fs.existsSync(report) && Date.now() < by;) await new Promise((r) => setTimeout(r, 25));
    child.stdout.destroy();
  }
  const [status, signal] = await exited;
  const { dirs: made = [], adapters = [], closed = [] } = fs.existsSync(report) ? (JSON.parse(fs.readFileSync(report, "utf8")) as { dirs?: string[]; adapters?: number[]; closed?: number[] }) : {};
  return { status, signal, made, adapters, closed, left: fs.readdirSync(tmp).filter((n) => !TOOL_CACHE.test(n)), out };
}

describe("temporary directories", { skip: process.platform !== "linux" && "reads /proc" }, () => {
  for (const [end, status] of [["pass", 0], ["fail", 1], ["exit", 3]] as const) {
    test(`a test file that ends with ${end} leaves no cc-* directory (nor any other) in TMPDIR`, async () => {
      const r = await run(end);
      assert.equal(r.status, status, r.out);
      const prefixes = new Set(r.made.map((d) => path.basename(d).slice(0, -6)));
      for (const p of ["cc-", "cc-work-", "cc-claude-", "cc-claudecfg-", "cc-fakecli-", "cc-nest-", "cc-wrap-", "w-"]) {
        assert.ok(prefixes.has(p), `the fixture made a ${p}* directory (it made ${[...prefixes].join(", ")})`);
      }
      assert.equal(r.adapters.length, 2, `the fixture started its two adapters\n${r.out}`);
      for (const pid of r.adapters) assert.equal(alive(pid), false, `adapter ${pid} outlived the file`);
      assert.deepEqual(r.left, [], `left in TMPDIR: ${r.left.join(", ")}\n${r.out}`);
      for (const d of r.made) assert.equal(fs.existsSync(d), false, d);
    });
  }
  // An interrupted run (`timeout`, Ctrl-C, a closed terminal) used to leave every directory and tmux server behind.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`a test file interrupted by ${sig} cleans up, then ends by that signal`, async (t) => {
      const r = await run(sig);
      // Should this fail, what the fixture left running is not left to outlive the suite as well.
      t.after(() => { for (const pid of [...r.adapters, ...r.closed]) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
      assert.equal(r.status === null ? r.signal : r.status, sig, r.out);
      assertClean(r);
    });
  }
  // An interrupted runner leaves before its files: one that reported after that died of the EPIPE (exit code 7) with
  // no hook run, while the signal that came with the interruption was still to be handled.
  test("a test file whose report pipe was closed (its runner left) cleans up, then ends", async (t) => {
    const r = await run("EPIPE", true);
    t.after(() => { for (const pid of [...r.adapters, ...r.closed]) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
    assert.equal(r.status === null ? r.signal : r.status, "SIGTERM", r.out);
    assertClean(r);
  });
});

function assertClean(r: Run): void {
  assert.equal(r.adapters.length, 2, `the fixture started its two adapters\n${r.out}`);
  for (const pid of r.adapters) assert.equal(alive(pid), false, `adapter ${pid} outlived the file`);
  assert.equal(r.closed.length, 1, r.out);
  for (const pid of r.closed) assert.equal(alive(pid), false, `the process a closer stops (${pid}) outlived the file`);
  assert.deepEqual(r.left, [], `left in TMPDIR: ${r.left.join(", ")}\n${r.out}`);
  for (const d of r.made) assert.equal(fs.existsSync(d), false, d);
}
