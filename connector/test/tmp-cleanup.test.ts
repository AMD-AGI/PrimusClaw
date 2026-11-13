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
import { processStart } from "../src/children.js";
import { tmpdir } from "./support/tmp.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(here, "support", "tmp-fixture.ts");
/** What node and tsx keep in TMPDIR for themselves, reused across runs: not the suite's. */
const TOOL_CACHE = /^(tsx-\d+|node-compile-cache)$/;

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z "); } catch { return false; }
};

/** Whether `pid` is still running `by` ms from now: a process SIGKILLed as its parent exits takes a moment to go. */
const stillAlive = async (pid: number, by = 2_000): Promise<boolean> => {
  for (const end = Date.now() + by; alive(pid) && Date.now() < end;) await new Promise((r) => setTimeout(r, 25));
  return alive(pid);
};

interface Run { status: number | null; signal: NodeJS.Signals | null; made: string[]; adapters: number[]; closed: number[]; started: number[]; left: string[]; out: string }

/** The fixture ending as `end` says; with `closeStdout`, this side closes the pipe the fixture reports into once it has set up, as a runner that has left does. */
async function run(end: string, closeStdout = false, tmp = tmpdir("tmpguard-")): Promise<Run> {
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
  const { dirs: made = [], adapters = [], closed = [], started = [] } = fs.existsSync(report) ? (JSON.parse(fs.readFileSync(report, "utf8")) as { dirs?: string[]; adapters?: number[]; closed?: number[]; started?: number[] }) : {};
  return { status, signal, made, adapters, closed, started, left: fs.readdirSync(tmp).filter((n) => !TOOL_CACHE.test(n)), out };
}

describe("temporary directories", { skip: process.platform !== "linux" && "reads /proc" }, () => {
  for (const [end, status] of [["pass", 0], ["fail", 1], ["exit", 3]] as const) {
    test(`a test file that ends with ${end} leaves no cc-* directory (nor any other) in TMPDIR, and nothing it started running`, async (t) => {
      const r = await run(end);
      assert.equal(r.status, status, r.out);
      const prefixes = new Set(r.made.map((d) => path.basename(d).slice(0, -6)));
      for (const p of ["cc-", "cc-work-", "cc-claude-", "cc-claudecfg-", "cc-fakecli-", "cc-nest-", "cc-wrap-", "w-"]) {
        assert.ok(prefixes.has(p), `the fixture made a ${p}* directory (it made ${[...prefixes].join(", ")})`);
      }
      t.after(() => { for (const pid of [...r.adapters, ...r.started]) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
      assert.equal(r.adapters.length, 2, `the fixture started its two adapters\n${r.out}`);
      for (const pid of r.adapters) assert.equal(alive(pid), false, `adapter ${pid} outlived the file`);
      await assertStartedGone(r);
      assert.deepEqual(r.left, [], `left in TMPDIR: ${r.left.join(", ")}\n${r.out}`);
      for (const d of r.made) assert.equal(fs.existsSync(d), false, d);
    });
  }
  // An interrupted run (`timeout`, Ctrl-C, a closed terminal) used to leave every directory and tmux server behind.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`a test file interrupted by ${sig} cleans up, then ends by that signal`, async (t) => {
      const r = await run(sig);
      // Should this fail, what the fixture left running is not left to outlive the suite as well.
      t.after(() => { for (const pid of [...r.adapters, ...r.closed, ...r.started]) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
      assert.equal(r.status === null ? r.signal : r.status, sig, r.out);
      await assertClean(r);
    });
  }
  // A file SIGKILLed (with its group, by `timeout -s KILL` or an OOM kill) runs no cleanup of its own: it left every
  // directory it had made in TMPDIR, hundreds for a few seconds of the suite, and its adapters running.
  test("a test file SIGKILLed leaves one directory, which the next file in that TMPDIR removes after killing its adapters", async (t) => {
    const killed = await run("SIGKILL");
    t.after(() => { for (const pid of [...killed.adapters, ...killed.started]) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
    assert.equal(killed.signal, "SIGKILL", killed.out);
    assert.equal(killed.adapters.length, 2, `the fixture started its two adapters\n${killed.out}`);
    assert.equal(killed.left.length, 1, `left in TMPDIR: ${killed.left.join(", ")}`);
    assert.match(killed.left[0], /^cc-run-\d+-\d+-[A-Za-z0-9]{6}$/);
    for (const d of killed.made) assert.equal(path.basename(path.dirname(d)), killed.left[0], d);
    const tmp = path.dirname(path.dirname(killed.made[0]));
    // That of a file still running (this one) is not touched; one named with a live pid but another start time is that
    // of an earlier process whose pid was given out again, and goes; one that others may write in is not one mkdtemp
    // made, so not one a test file made: what it records may not be the suite's, and it is left alone.
    const running = path.join(tmp, `cc-run-${process.pid}-${processStart(process.pid)}-AAAAAA`);
    const recycled = path.join(tmp, `cc-run-${process.pid}-1-AAAAAA`);
    const shared = path.join(tmp, `cc-run-${process.pid}-1-BBBBBB`);
    for (const d of [running, recycled, shared]) fs.mkdirSync(path.join(d, "w-AAAAAA"), { recursive: true, mode: 0o700 });
    fs.chmodSync(shared, 0o777);
    const next = await run("pass", false, tmp);
    t.after(() => { for (const pid of [...next.adapters, ...next.started]) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
    assert.equal(next.status, 0, next.out);
    assert.deepEqual(next.left.sort(), [path.basename(running), path.basename(shared)].sort(), `left in TMPDIR: ${next.left.join(", ")}\n${next.out}`);
    for (const d of killed.made) assert.equal(fs.existsSync(d), false, d);
    for (const pid of killed.adapters) assert.equal(await stillAlive(pid), false, `adapter ${pid} of the killed file outlived the next one`);
    // The connector its pid file names; the other two it started are recorded nowhere, which nothing can find.
    assert.equal(await stillAlive(killed.started[2]), false, `the connector ${killed.started[2]} of the killed file outlived the next one`);
  });
  // An interrupted runner leaves before its files: one that reported after that died of the EPIPE (exit code 7) with
  // no hook run, while the signal that came with the interruption was still to be handled.
  test("a test file whose report pipe was closed (its runner left) cleans up, then ends", async (t) => {
    const r = await run("EPIPE", true);
    t.after(() => { for (const pid of [...r.adapters, ...r.closed, ...r.started]) if (alive(pid)) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } });
    assert.equal(r.status === null ? r.signal : r.status, "SIGTERM", r.out);
    await assertClean(r);
  });
});

/** The detached processes and the one that ignores SIGTERM, which the fixture started and left to the file's cleanup. */
async function assertStartedGone(r: Run): Promise<void> {
  assert.equal(r.started.length, 3, `the fixture started its three processes\n${r.out}`);
  for (const pid of r.started) assert.equal(await stillAlive(pid), false, `process ${pid} the file started outlived it`);
}

async function assertClean(r: Run): Promise<void> {
  assert.equal(r.adapters.length, 2, `the fixture started its two adapters\n${r.out}`);
  for (const pid of r.adapters) assert.equal(alive(pid), false, `adapter ${pid} outlived the file`);
  await assertStartedGone(r);
  assert.equal(r.closed.length, 1, r.out);
  for (const pid of r.closed) assert.equal(alive(pid), false, `the process a closer stops (${pid}) outlived the file`);
  assert.deepEqual(r.left, [], `left in TMPDIR: ${r.left.join(", ")}\n${r.out}`);
  for (const d of r.made) assert.equal(fs.existsSync(d), false, d);
}
