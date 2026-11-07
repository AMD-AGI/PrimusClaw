// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A tmux client that exits before reading its input (a server that is gone, a refused command) closes the pipe the
 * runner is still writing to. That write's EPIPE is the run's failure, reported through its promise; it must not be
 * an unhandled 'error' event, which ends the connector process (and failed CI on terminal-input.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmuxRunner } from "../src/terminal-input.js";

test("a client that exits without reading its input fails the run, and nothing is thrown out of band", async () => {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => { uncaught.push(err); };
  process.on("uncaughtException", onUncaught);
  try {
    // `false` reads nothing and exits 1; far more input than a pipe buffer holds, so the write is still pending then.
    const runner = tmuxRunner("false", "/nonexistent.sock");
    await assert.rejects(runner.run(["load-buffer", "-"], "x".repeat(4 * 1024 * 1024)));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
  }
});
