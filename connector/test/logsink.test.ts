// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector's own log is a file a supervisor points stdout and stderr at (state/run.log). A write to it that fails
 * (EDQUOT on an NFS share at its quota, 2026-11-07) must not end the process: the line goes elsewhere, and the log
 * comes back once the file can be written again.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { main, type Ctx } from "../src/commands.js";
import { FALLBACK_MAX_BYTES, RETRY_PRIMARY_MS, lineSink } from "../src/logsink.js";
import { resolveDirs } from "../src/paths.js";
import { sleep } from "../src/util.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

const edquot = () => Object.assign(new Error("Unknown system error -122"), { errno: -122, code: "Unknown system error -122" });

describe("lineSink", () => {
  test("a descriptor that fails sends its lines to the fallback, is tried again later, and says what happened meanwhile", () => {
    const dir = tmpdir();
    const fallback = path.join(dir, "sub", "fallback.log");
    let t = 1_000_000;
    let failing = true;
    const written: string[] = [];
    let calls = 0;
    const write = lineSink({
      fd: 1, fallback, now: () => t,
      writeFd: (_fd, data) => { calls += 1; if (failing) throw edquot(); written.push(data); },
    });
    assert.doesNotThrow(() => write("one"));
    assert.equal(calls, 1);
    t += 1_000;
    write("two");
    assert.equal(calls, 1, "within the pause the descriptor is not tried again");
    const fb = fs.readFileSync(fallback, "utf8");
    assert.match(fb, /fd 1 cannot be written \(EDQUOT\)/);
    assert.match(fb, /\none\ntwo\n$/);
    t += RETRY_PRIMARY_MS;
    write("three");
    assert.equal(calls, 2, "tried again after the pause, still failing");
    failing = false;
    t += RETRY_PRIMARY_MS;
    write("four");
    assert.equal(written.length, 2);
    assert.match(written[0]!, /this log could not be written from .* \(EDQUOT\): 3 line\(s\) went to .*fallback\.log, 0 dropped/);
    assert.equal(written[1], "four\n");
    write("five");
    assert.equal(written[2], "five\n", "back to the descriptor for good");
  });

  test("with no fallback, or one that cannot be written, lines are dropped and counted, never thrown", () => {
    const dir = tmpdir();
    let t = 0;
    let failing = true;
    const written: string[] = [];
    const blocked = path.join(dir, "file");
    fs.writeFileSync(blocked, "");
    for (const fallback of [null, path.join(blocked, "under-a-file.log")]) {
      written.length = 0;
      failing = true;
      const write = lineSink({ fd: 2, fallback, now: () => t, writeFd: (_fd, d) => { if (failing) throw edquot(); written.push(d); } });
      assert.doesNotThrow(() => { write("a"); write("b"); });
      failing = false;
      t += RETRY_PRIMARY_MS;
      write("c");
      assert.match(written[0]!, /0 line\(s\) went to .*, 2 dropped/);
      assert.equal(written[1], "c\n");
    }
  });

  test("the fallback stops growing at its cap", () => {
    const dir = tmpdir();
    const fallback = path.join(dir, "fallback.log");
    fs.writeFileSync(fallback, Buffer.alloc(FALLBACK_MAX_BYTES - 10));
    const write = lineSink({ fd: 1, fallback, now: () => 0, writeFd: () => { throw edquot(); } });
    write("this line is longer than ten bytes");
    assert.ok(fs.statSync(fallback).size <= FALLBACK_MAX_BYTES + 200, "only the one-line note past the cap");
    assert.doesNotMatch(fs.readFileSync(fallback, "utf8").slice(-200), /longer than ten bytes/);
  });
});

describe("a connector whose stdout and stderr cannot be written", () => {
  test("stays up and online; its lines go to the fallback file", { skip: !fs.existsSync("/dev/full") && "no /dev/full" }, async () => {
    // /dev/full fails every write with ENOSPC, as a file at its quota fails with EDQUOT; Node writes to both the same
    // way (synchronously). Before, the first line `run` printed ended the process with an unhandled 'error' event.
    const claw = await FakeClaw.start();
    const home = tmpdir();
    const work = tmpdir("w-");
    const temp = tmpdir("t-");
    fs.mkdirSync(path.join(home, "config"), { recursive: true });
    fs.writeFileSync(path.join(home, "config", "agents.toml"), `
[[agents]]
id = "fake"
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(ADAPTER)}]
ask_mode = "default"
roots = [${JSON.stringify(work)}]
`);
    const out: string[] = [];
    const c: Ctx = { dirs: resolveDirs({ CLAW_CONNECTOR_HOME: home } as NodeJS.ProcessEnv), env: {}, out: (l) => out.push(l), err: (l) => out.push(l), hostname: "box" };
    await main(["login", "--server", claw.url, "--key", "good-token"], c);
    const here = path.dirname(new URL(import.meta.url).pathname);
    const full = fs.openSync("/dev/full", "w");
    const child = spawn(path.join(here, "..", "node_modules", ".bin", "tsx"), [path.join(here, "..", "src", "cli.ts"), "run"], {
      env: { ...process.env, CLAW_CONNECTOR_HOME: home, TMPDIR: temp }, stdio: ["ignore", full, full], detached: true,
    });
    fs.closeSync(full);
    let exit: number | null = null;
    child.on("exit", (code) => { exit = code ?? -1; });
    try {
      await claw.until("online", () => exit !== null || (claw.online && claw.heartbeats.length > 0), 20_000);
      assert.equal(exit, null, "the connector did not exit");
      await sleep(1_000);
      assert.equal(exit, null, "still running a second later");
      const uid = typeof process.getuid === "function" ? String(process.getuid()) : "user";
      const fb = fs.readFileSync(path.join(temp, `claw-connector-${uid}`, "fallback.log"), "utf8");
      assert.match(fb, /cannot be written \(ENOSPC\)/);
      assert.match(fb, /connecting fake/);
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
      await claw.close();
    }
  });
});
