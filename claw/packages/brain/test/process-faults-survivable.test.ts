// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// One promise nobody awaited must not take a pod's other runs with it.
//
// 2026-11-06: a run failed by throwing, the delivery handler logged it, and a
// promise derived from the same run -- `taskPromise.finally(...)` as a bare
// statement in task dispatch -- rejected with the same error and nothing
// handled it. Node's default for that is to exit, and brain had no handler, so
// the pod exited 1 and every run on it stood still for eleven minutes.
//
//   P1 the dispatch bookkeeping leaves no unhandled rejection behind a failed run
//   P2 an unhandled rejection is logged and counted, and the process lives on
//   P3 an uncaught exception still ends the process, through the orderly hand-off
//   P4 the same, in a real Node process with the real default behaviour
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { trackInflight, inflightTasks } from "../src/tasks/dispatch.js";
import { installProcessGuards } from "../src/infra/process-guards.js";

const run = promisify(execFile);
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");

test("P1 a run that fails leaves no unhandled rejection behind it", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    let cleaned = 0;
    const failing = Promise.reject(Object.assign(new Error("TIMEOUT"), { name: "NatsError", code: "TIMEOUT" }));
    trackInflight(failing, () => { cleaned++; });
    assert.ok(inflightTasks().includes(failing), "held for the drain while it runs");
    // The caller's own await, which the delivery handler catches and logs.
    await assert.rejects(failing, /TIMEOUT/);
    // Unhandled rejections are reported after the microtask queue drains.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cleaned, 1, "the cleanup still runs on the way out");
    assert.ok(!inflightTasks().includes(failing));
    assert.deepEqual(unhandled, [], "nothing derived from the run was left unhandled");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

function fakeProcess() {
  const proc = new EventEmitter() as unknown as NodeJS.Process;
  const lines: string[] = [];
  const counted: string[] = [];
  const fatal: unknown[] = [];
  installProcessGuards({
    log: {
      error: (_o, msg) => { lines.push(`error:${msg}`); },
      fatal: (_o, msg) => { lines.push(`fatal:${msg}`); },
    },
    count: (kind) => { counted.push(kind); },
    onFatal: (err) => { fatal.push(err); },
  }, proc);
  return { proc, lines, counted, fatal };
}

test("P2 an unhandled rejection is logged and counted, and the process lives on", () => {
  const { proc, lines, counted, fatal } = fakeProcess();
  (proc as unknown as EventEmitter).emit("unhandledRejection", new Error("forgotten"), Promise.resolve());
  assert.deepEqual(lines, ["error:process.unhandled_rejection"]);
  assert.deepEqual(counted, ["unhandled_rejection"]);
  assert.deepEqual(fatal, [], "no shutdown for a promise somebody forgot");
});

test("P3 an uncaught exception still ends the process, through the orderly hand-off", () => {
  const { proc, lines, counted, fatal } = fakeProcess();
  const err = new Error("half-done");
  (proc as unknown as EventEmitter).emit("uncaughtException", err, "uncaughtException");
  assert.deepEqual(lines, ["fatal:process.uncaught_exception"]);
  assert.deepEqual(counted, ["uncaught_exception"]);
  assert.deepEqual(fatal, [err]);
});

test("P4 in a real process: a stray rejection is survived, an uncaught throw drains and exits 1", { timeout: 60_000 }, async () => {
  const guard = join(PKG, "src", "infra", "process-guards.ts");
  const script = `
    import { installProcessGuards } from ${JSON.stringify(guard)};
    const mode = process.argv.at(-1);
    installProcessGuards({
      log: { error: (_o, m) => console.log(m), fatal: (_o, m) => console.log(m) },
      count: () => {},
      onFatal: () => { console.log("drain"); setTimeout(() => process.exit(1), 10); },
    });
    if (mode === "reject") {
      Promise.reject(new Error("forgotten"));
      setTimeout(() => { console.log("alive"); process.exit(0); }, 100);
    } else {
      setTimeout(() => { throw new Error("half-done"); }, 10);
      setTimeout(() => { console.log("still running"); }, 5000);
    }
  `;
  const tsx = import.meta.resolve("tsx");
  const exec = async (mode: string) => {
    try {
      const { stdout } = await run(process.execPath, ["--import", tsx, "--input-type=module", "-e", script, mode], { cwd: PKG });
      return { code: 0, out: stdout };
    } catch (e) {
      const f = e as { code?: number; stdout?: string };
      return { code: f.code ?? -1, out: f.stdout ?? "" };
    }
  };
  const rejected = await exec("reject");
  assert.equal(rejected.code, 0, rejected.out);
  assert.match(rejected.out, /process\.unhandled_rejection[\s\S]*alive/);

  const thrown = await exec("throw");
  assert.equal(thrown.code, 1, thrown.out);
  assert.match(thrown.out, /process\.uncaught_exception[\s\S]*drain/);
  assert.doesNotMatch(thrown.out, /still running/);
});
