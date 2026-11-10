// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn's own lines are said in the person's language, whatever its text is written in (test_reply_language.py, the
 * turn's side: which language that is, and how it is learned, is the router's).
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import { turnText } from "../../src/locales/turn.js";
import { LIVE_HEADERS } from "../../src/turn/live-view.js";
import { play } from "./play.js";
import { end, ev, said, textOf } from "./world.js";

const ZH_QUEUED = turnText.in("zh").queuedNotice;
const EN_QUEUED = turnText.in("en").queuedNotice;

it("test_a_turn_says_its_own_lines_in_the_preference", async () => {
  // nothing in "PR #228" says the language: the person's (zh); "看一下 #228" said in a chat that is "en": English
  const zh = await play(
    [
      [0.2, said("ok")],
      [0.3, end()],
    ],
    { request: { text: "PR #228", lang: "zh" } },
  );
  const en = await play(
    [
      [0.2, said("ok")],
      [0.3, end()],
    ],
    { request: { text: "看一下 #228", lang: "en" } },
  );
  assert.equal(
    textOf(zh.bus.sent.find((s) => s.operation === "send" && s.kind === "message")?.message),
    LIVE_HEADERS.zh,
  );
  assert.equal(
    textOf(en.bus.sent.find((s) => s.operation === "send" && s.kind === "message")?.message),
    LIVE_HEADERS.en,
  );
  // and without a preference, the language of what was written
  const written = await play(
    [
      [0.2, said("ok")],
      [0.3, end()],
    ],
    { request: { text: "看一下 #228" } },
  );
  assert.equal(
    textOf(written.bus.sent.find((s) => s.operation === "send" && s.kind === "message")?.message),
    LIVE_HEADERS.zh,
  );
});

it("test_the_queued_notice_is_said_in_the_preference", async () => {
  const run = await play(
    [
      [0.1, ev("historyComplete", null, { type: "historyComplete", count: 0, has_more: false })],
      [0.2, said("done", "claw-pending-1")],
      [0.3, end("claw-pending-1")],
    ],
    {
      request: { text: "do the next thing", lang: "zh" },
      sessionId: "s1",
      setUp: (w) => {
        w.claw.queueSends = true;
        w.claw.busy = true;
      },
    },
  );
  const texts = run.bus.sent.map((s) => textOf(s.message));
  assert.ok(texts.includes(ZH_QUEUED) && !texts.includes(EN_QUEUED));
});
