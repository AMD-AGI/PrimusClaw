// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector's own log is a file a supervisor points stdout and stderr at (state/run.log). A write to it that fails
 * (EDQUOT on an NFS share at its quota, 2026-11-07) must not end the process: the line is held in memory, and the log
 * comes back once the file can be written again.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { main, type Ctx } from "../src/commands.js";
import { HELD_LINES, RETRY_PRIMARY_MS, lineSink } from "../src/logsink.js";
import { resolveDirs } from "../src/paths.js";
import { sleep } from "../src/util.js";
import { FakeClaw } from "./support/fake-claw.js";
import { ADAPTER, tmpdir } from "./support/harness.js";

const edquot = () => Object.assign(new Error("Unknown system error -122"), { errno: -122, code: "Unknown system error -122" });

describe("lineSink", () => {
  test("a descriptor that fails holds its lines, is tried again later, and then writes a note and the lines it held", () => {
    let t = 1_000_000;
    let failing = true;
    const written: string[] = [];
    let calls = 0;
    const write = lineSink({
      fd: 1, now: () => t,
      writeFd: (_fd, data) => { calls += 1; if (failing) throw edquot(); written.push(data); },
    });
    assert.doesNotThrow(() => write("one"));
    assert.equal(calls, 1);
    t += 1_000;
    write("two");
    assert.equal(calls, 1, "within the pause the descriptor is not tried again");
    t += RETRY_PRIMARY_MS;
    write("three");
    assert.equal(calls, 2, "tried again after the pause, still failing");
    failing = false;
    t += RETRY_PRIMARY_MS;
    write("four");
    assert.match(written[0]!, /this log could not be written from .* \(EDQUOT\); the last 3 line\(s\) follow, 0 older one\(s\) dropped/);
    assert.deepEqual(written.slice(1), ["one\n", "two\n", "three\n", "four\n"]);
    write("five");
    assert.equal(written.at(-1), "five\n", "back to the descriptor for good");
  });

  test("only the newest lines are held; the older ones are counted", () => {
    let t = 0;
    let failing = true;
    const written: string[] = [];
    const write = lineSink({ fd: 2, now: () => t, writeFd: (_fd, d) => { if (failing) throw edquot(); written.push(d); } });
    for (let i = 0; i < HELD_LINES + 7; i++) write(`l${i}`);
    failing = false;
    t += RETRY_PRIMARY_MS;
    write("after");
    assert.match(written[0]!, new RegExp(`the last ${HELD_LINES} line\\(s\\) follow, 7 older one\\(s\\) dropped`));
    assert.equal(written[1], "l7\n");
    assert.equal(written.length, HELD_LINES + 2);
  });

  test("a failure halfway through writing the held lines keeps the rest for the next try", () => {
    let t = 0;
    let budget = 0;
    const written: string[] = [];
    const write = lineSink({ fd: 1, now: () => t, writeFd: (_fd, d) => { if (budget <= 0) throw edquot(); budget -= 1; written.push(d); } });
    write("a"); write("b"); write("c");
    t += RETRY_PRIMARY_MS;
    budget = 2; // the note and "a", then it fails again
    write("d");
    assert.deepEqual(written.slice(1), ["a\n"]);
    t += RETRY_PRIMARY_MS;
    budget = 100;
    write("e");
    assert.deepEqual(written.slice(3), ["b\n", "c\n", "d\n", "e\n"]);
  });
});

describe("a connector whose stdout and stderr cannot be written", () => {
  test("stays up and online", { skip: !fs.existsSync("/dev/full") && "no /dev/full" }, async () => {
    // /dev/full fails every write with ENOSPC, as a file at its quota fails with EDQUOT; Node writes to both the same
    // way (synchronously). Before, the first line `run` printed ended the process with an unhandled 'error' event.
    const claw = await FakeClaw.start();
    const home = tmpdir();
    const work = tmpdir("w-");
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
      env: { ...process.env, CLAW_CONNECTOR_HOME: home }, stdio: ["ignore", full, full], detached: true,
    });
    fs.closeSync(full);
    let exit: number | null = null;
    child.on("exit", (code) => { exit = code ?? -1; });
    try {
      await claw.until("online", () => exit !== null || (claw.online && claw.heartbeats.length > 0), 20_000);
      assert.equal(exit, null, "the connector did not exit");
      await sleep(1_000);
      assert.equal(exit, null, "still running a second later");
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
      await claw.close();
    }
  });
});
