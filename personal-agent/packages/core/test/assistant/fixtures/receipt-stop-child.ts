// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A process that opens the assistant's receipt and follows its turn on the real clock, then on SIGTERM stops as the worker
 * does (`stop`: `Receipts.stop`; `keep`: it leaves the receipts as they are). receipt-stop.test.ts runs it.
 */
import { setTimeout as delay } from "node:timers/promises";

import { TurnFollower } from "../../../src/assistant/follow.js";
import { Receipts } from "../../../src/assistant/receipts.js";
import type { Clock } from "../../../src/ports/clock.js";
import { silentLogger } from "../../../src/ports/logger.js";
import type { SseEvent } from "../../../src/claw/model.js";
import { FakeReceiptStream } from "../receipt-fakes.js";

const clock: Clock = {
  epochMs: () => Date.now(),
  monotonicMs: () => performance.now(),
  sleep: async (ms, signal) => {
    try {
      await delay(ms, undefined, signal ? { signal } : {});
    } catch {
      throw signal?.reason as Error;
    }
  },
};

/** A turn's stream that says nothing until it is closed (an open HTTP request keeps the process up the same way). */
async function* silent(signal: AbortSignal, onOpen: () => void): AsyncIterable<SseEvent> {
  onOpen();
  await delay(3_600_000, undefined, { signal }).catch(() => undefined);
  yield* [];
}

const receipts = new Receipts(clock, silentLogger);
const receipt = await receipts.openIn("c1", "en", () => Promise.resolve(new FakeReceiptStream()));
if (receipt === undefined) throw new Error("no receipt");
const follower = new TurnFollower({
  open: (_after, signal, onOpen) => silent(signal, onOpen),
  receipt,
  lang: "en",
  streamSay: true,
  stepLabel: (tool) => tool,
  clock,
  logger: silentLogger,
});
follower.start();
await follower.waitOpen(2);
process.once("SIGTERM", () => {
  if (process.argv[2] === "stop") receipts.stop();
  process.stdout.write("stopping\n");
});
process.stdout.write("open\n");
