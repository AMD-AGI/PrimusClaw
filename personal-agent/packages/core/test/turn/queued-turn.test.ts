// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message Claw queues behind a turn it is still running does not say "Thinking…" while it waits, and is told it is queued.
 * On 11-11 a
 * message queued behind a question that waited ten minutes had a floating status of its own for nine of them, and no word
 * that it waited (Claw gave it an id, `claw-pending-4691`, and the notice only went out for a message with none).
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { turnText } from "../../src/locales/turn.js";
import { play } from "./play.js";
import { result, type Script, textOf, type World } from "./world.js";

const QUEUED_ID = "claw-pending-4691";

/** The queued message runs once the turn in front ends, ten minutes on. */
const QUEUED_ANSWER: Script = [[600, result("明天吃火锅", QUEUED_ID)]];

/** Claw queues the message (it answers the send with a queued message's id); `busy`: what the worker sees before it sends. */
function queued(busy: boolean, lang: "en" | "zh" = "en") {
  return play(QUEUED_ANSWER, {
    request: { key: "ak", text: "火锅", streamReplyTo: "user-msg-1", lang },
    sessionId: "s1",
    setUp: (w: World) => {
      w.claw.busy = busy;
      w.claw.gate = "m-front";
      w.claw.sendMessage = (key, sessionId, text, options) => {
        w.claw.calls.push(["send", key, sessionId, text, options ?? {}]);
        return Promise.resolve(QUEUED_ID);
      };
    },
  });
}

const notices = (run: Awaited<ReturnType<typeof queued>>, lang: "en" | "zh"): string[] =>
  run.bus.sent.map((s) => textOf(s.message)).filter((t) => t === turnText.in(lang).queuedNotice);

it("a message Claw queues closes its stream with the queued notice at once: no Thinking… for the wait, the answer comes after", async () => {
  // (what the worker may have seen before the send does not matter: only Claw's answer to the send says it is queued)
  for (const [busy, lang] of [
    [true, "en"],
    [false, "en"],
    [true, "zh"],
  ] as const) {
    const run = await queued(busy, lang);
    const ops = run.bus.streamOps;
    assert.equal(ops[0]?.op, "open");
    const finishes = ops.filter((o) => o.op === "finish");
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0]?.text, turnText.in(lang).queuedNotice);
    assert.ok(finishes[0].at < 5, "closed at once, not when the wait is over");
    assert.ok(!ops.some((o) => o.op === "inform" && o.at > 5), "nothing more is streamed while it waits");
    assert.deepEqual(notices(run, lang), []); // (said in the bubble, not twice)
    assert.ok(run.final.includes("明天吃火锅"));
  }
});

it("a queued message without a stream gets the queued notice as a message", async () => {
  const run = await play(QUEUED_ANSWER, {
    request: { key: "ak", text: "火锅", lang: "zh" },
    sessionId: "s1",
    setUp: (w: World) => {
      w.claw.sendMessage = () => Promise.resolve(QUEUED_ID);
    },
  });
  assert.deepEqual(run.bus.streamOps, []);
  assert.equal(notices(run, "zh").length, 1);
  assert.ok(run.final.includes("明天吃火锅"));
});

it("a message Claw takes at once streams its status and is not told it is queued", async () => {
  const run = await play([[1, result("done", "m2")]], {
    request: { key: "ak", text: "hi", streamReplyTo: "user-msg-1" },
    sessionId: "s1",
  });
  assert.equal(run.bus.streamOps[0]?.op, "open");
  assert.ok(!run.bus.everything().includes(turnText.in("en").queuedNotice));
});
