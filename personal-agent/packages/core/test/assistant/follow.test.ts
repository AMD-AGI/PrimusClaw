// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { FOLLOW_SECONDS, LIVE_ONLY, SAY_TOOL, TurnFollower, said } from "../../src/assistant/follow.js";
import { Receipts } from "../../src/assistant/receipts.js";
import type { SseEvent } from "../../src/claw/model.js";
import { silentLogger, type Logger } from "../../src/ports/logger.js";
import { FakeReceiptStream } from "./receipt-fakes.js";

/** A live stream the test feeds one event at a time; it ends when the signal aborts. */
class Feed {
  after = "";
  closed = false;
  private queue: SseEvent[] = [];
  private wake: (() => void) | undefined;

  push(name: string, data: Record<string, unknown>): void {
    this.queue.push({ id: "", name, data: data as SseEvent["data"] });
    this.wake?.();
  }

  open = (after: string, signal: AbortSignal): AsyncIterable<SseEvent> => {
    this.after = after;
    return this.events(signal);
  };

  private async *events(signal: AbortSignal): AsyncGenerator<SseEvent> {
    try {
      while (!signal.aborted) {
        const next = this.queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          signal.addEventListener("abort", () => {
            resolve();
          });
        });
      }
    } finally {
      this.closed = true;
    }
  }
}

async function world(options: { streamSay?: boolean; logger?: Logger } = {}) {
  const clock = new FakeClock();
  const receipts = new Receipts(clock, silentLogger);
  const stream = new FakeReceiptStream();
  const receipt = await receipts.openIn("c1", "zh", () => Promise.resolve(stream));
  assert.ok(receipt);
  const feed = new Feed();
  const follower = new TurnFollower({
    open: feed.open,
    receipt,
    lang: "zh",
    streamSay: options.streamSay ?? true,
    stepLabel: (tool) => `label(${tool})`,
    clock,
    logger: options.logger ?? silentLogger,
  });
  follower.start();
  return { clock, stream, receipt, feed, follower };
}

it("the steps then the words of the followed turn show and a say ends following", async () => {
  const { stream, feed, follower } = await world();
  feed.push("toolUsed", { message_id: "m1", tool: "mcp__safe__nodes", status: "start" });
  follower.answers("m1");
  feed.push("toolUsed", { message_id: "m0", tool: "other", status: "start" });
  feed.push("toolUsed", { message_id: "m1", tool: "mcp__safe__nodes", status: "start" });
  feed.push("toolUsed", { message_id: "m1", tool: "mcp__safe__jobs", status: "start" });
  await flushMicrotasks();
  feed.push("toolTextDelta", { turn_message_id: "m1", tool: SAY_TOOL, text: "  节点" });
  await flushMicrotasks();
  feed.push("AssistantSay", { message_id: "m1" });
  await follower.done;
  assert.equal(feed.after, LIVE_ONLY);
  assert.ok(feed.closed);
  const shown = stream.ops.map((o) => (o.op === "inform" || o.op === "emit" ? o.text : o.op));
  assert.equal(shown[0], "label(mcp__safe__nodes)…");
  assert.equal(shown.at(-1), "节点");
  assert.ok(shown.includes("label(mcp__safe__nodes) · label(mcp__safe__jobs)…") || shown.length === 2);
});

it("a refused say voids the words and the turn ending without one ends following", async () => {
  const { receipt, feed, follower } = await world();
  follower.answers("m1");
  feed.push("toolUsed", { message_id: "m1", tool: SAY_TOOL, status: "done", description: '{"ok": false}' });
  await flushMicrotasks();
  assert.equal(receipt.voided, true);
  feed.push("ResultMessage", { message_id: "m1" });
  await follower.done;
  assert.ok(feed.closed);
});

it("with streaming of the words off only the steps show", async () => {
  const { stream, feed, follower } = await world({ streamSay: false });
  follower.answers("m1");
  feed.push("toolTextDelta", { message_id: "m1", tool: SAY_TOOL, text: "words" });
  feed.push("toolTextVoid", { message_id: "m1", tool: SAY_TOOL });
  feed.push("error", { message_id: "m1" });
  await follower.done;
  assert.deepEqual(stream.ops, []);
});

it("no message id stops following and nothing is shown", async () => {
  const { stream, feed, follower } = await world();
  feed.push("toolUsed", { message_id: "m1", tool: "x", status: "start" });
  follower.answers(undefined);
  await follower.done;
  assert.deepEqual(stream.ops, []);
  assert.ok(feed.closed);
});

it("following stops when the receipt closes or after its time", async () => {
  const first = await world();
  first.follower.answers("m1");
  await first.receipt.deliver({ body: { type: "text", text: "reply" } });
  await first.follower.done;
  assert.ok(first.feed.closed);
  const second = await world();
  second.follower.answers("m1");
  await second.clock.advance(FOLLOW_SECONDS * 1000);
  await second.follower.done;
  assert.ok(second.feed.closed);
});

it("a stream that breaks leaves the receipt as it was and is logged by kind", async () => {
  const lines: string[] = [];
  const logger = { ...silentLogger, info: (m: string) => void lines.push(m) } as Logger;
  const clock = new FakeClock();
  const receipts = new Receipts(clock, silentLogger);
  const receipt = await receipts.openIn("c1", "en", () => Promise.resolve(new FakeReceiptStream()));
  assert.ok(receipt);
  const follower = new TurnFollower({
    open: () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("cut")) }),
    }),
    receipt,
    lang: "en",
    streamSay: true,
    stepLabel: (t) => t,
    clock,
    logger,
  });
  follower.start();
  follower.answers("m1");
  await follower.done;
  assert.deepEqual(lines, ["the assistant's turn could not be followed into its receipt"]);
});

it("said reads a say's outcome", () => {
  assert.equal(said({ status: "error" }), false);
  assert.equal(said({ is_error: true }), false);
  assert.equal(said({ description: '{"ok": false, "error": "x"}' }), false);
  assert.equal(said({ description: '{"ok": true}' }), true);
  assert.equal(said({ description: "cut sh" }), true);
  assert.equal(said({}), true);
});
