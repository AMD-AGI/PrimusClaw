// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message Claw queues behind a turn it is still running opens no "Thinking…" stream and is told it is queued. On 11-11 a
 * message queued behind a question that waited ten minutes had a floating status of its own for nine of them, and no word
 * that it waited.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { turnText } from "../../src/locales/turn.js";
import { play } from "./play.js";
import { result, type Script, textOf } from "./world.js";

/** The queued message runs once the turn in front ends (ten minutes on); its id is the one Claw gave it ("m2" here). */
const QUEUED_ANSWER: Script = [[600, result("明天吃火锅", "m2")]];

function queued(busy: boolean, lang: "en" | "zh" = "en") {
  return play(QUEUED_ANSWER, {
    request: { key: "ak", text: "火锅", streamReplyTo: "user-msg-1", lang },
    sessionId: "s1",
    setUp: (w) => {
      w.claw.busy = busy;
      w.claw.gate = "m-front";
      w.claw.queueSends = false; // (Claw gives a queued message its id, `claw-pending-<n>` in production)
    },
  });
}

it("a message queued behind a running turn opens no live stream: the queued notice says it waits, then the answer comes", async () => {
  for (const lang of ["en", "zh"] as const) {
    const run = await queued(true, lang);
    assert.deepEqual(run.bus.streamOps, []); // no "Thinking…" for the whole wait
    const notice = turnText.in(lang).queuedNotice;
    const texts = run.bus.sent.map((s) => textOf(s.message));
    assert.equal(texts.filter((t) => t === notice).length, 1, `${lang}: the queued notice, once`);
    assert.ok(run.final.includes("明天吃火锅"));
  }
});

it("a message Claw takes at once still streams its status", async () => {
  const run = await queued(false);
  assert.equal(run.bus.streamOps[0]?.op, "open");
  assert.ok(!run.bus.sent.some((s) => textOf(s.message) === turnText.in("en").queuedNotice));
});
