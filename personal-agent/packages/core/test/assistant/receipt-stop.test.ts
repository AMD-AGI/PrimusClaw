// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker stops while the assistant's receipt is open: nothing of it keeps the process up (Python's shutdown cancels the
 * receipt's tasks). A real process on the real clock: an open receipt and its followed turn, then SIGTERM.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { Receipts } from "../../src/assistant/receipts.js";
import { silentLogger } from "../../src/ports/logger.js";
import { FakeReceiptStream } from "./receipt-fakes.js";

const CHILD = fileURLToPath(new URL("./fixtures/receipt-stop-child.ts", import.meta.url));

/** Run the child until it says `open`, then SIGTERM it: how long it took to exit after, or undefined still up at `limitMs`. */
async function exitAfterTerm(mode: "stop" | "keep", limitMs: number): Promise<{ ms?: number; code: number | null }> {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", CHILD, mode], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit") as Promise<[number | null]>;
  let out = "";
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("open\n")) resolve();
    });
    void exited.then(() => {
      reject(new Error(`the child exited before its receipt opened: ${out}`));
    });
  });
  const termed = performance.now();
  child.kill("SIGTERM");
  const late = new Promise<"late">((resolve) => {
    setTimeout(() => {
      resolve("late");
    }, limitMs).unref();
  });
  const outcome = await Promise.race([exited, late]);
  if (outcome === "late") {
    child.kill("SIGKILL"); // (our own child, still up: the receipt held it)
    const [code] = await exited;
    return { code };
  }
  return { ms: performance.now() - termed, code: outcome[0] };
}

it("a process with an open receipt exits within a second of SIGTERM once the receipts are stopped", async () => {
  const stopped = await exitAfterTerm("stop", 1000);
  assert.equal(stopped.code, 0);
  assert.ok(stopped.ms !== undefined && stopped.ms < 1000, `still up a second after SIGTERM`);
  // (the separating case: left as they are, the receipt's close timer and its followed turn keep the process up)
  const kept = await exitAfterTerm("keep", 1500);
  assert.equal(kept.ms, undefined);
});

it("a stopped receipt is dropped, not closed: no final, its turn stops, and the conversation can open a new one", async () => {
  const clock = new FakeClock();
  const receipts = new Receipts(clock, silentLogger);
  const stream = new FakeReceiptStream();
  const receipt = await receipts.openIn("c1", "en", () => Promise.resolve(stream));
  assert.ok(receipt);
  let closed = false;
  void receipt.closed().then(() => (closed = true));
  receipts.stop();
  await flushMicrotasks();
  assert.ok(closed);
  assert.equal(receipts.openOf("c1"), undefined);
  assert.equal(receipts.take("c1"), undefined);
  await clock.advance(600_000);
  assert.deepEqual(stream.finals(), []);
  receipt.showStep("ignored once dropped");
  await flushMicrotasks();
  assert.deepEqual(
    stream.ops.map((o) => o.op),
    [],
  );
});

it("a status update on its way when the receipt is dropped is given up at once, not waited for", async () => {
  const receipts = new Receipts(new FakeClock(), silentLogger);
  const stream = new FakeReceiptStream();
  stream.hangUpdates = true;
  const receipt = await receipts.openIn("c1", "en", () => Promise.resolve(stream));
  assert.ok(receipt);
  receipt.showStep("Searching…");
  await flushMicrotasks();
  assert.deepEqual(
    stream.ops.map((o) => o.op),
    ["inform"],
  );
  receipts.stop();
  // (real time: the update ends because it was given up, not because a clock moved)
  const late = new Promise<"late">((resolve) => {
    setTimeout(() => {
      resolve("late");
    }, 1000).unref();
  });
  assert.equal(await Promise.race([receipt.shownWords(), late]), "");
});
