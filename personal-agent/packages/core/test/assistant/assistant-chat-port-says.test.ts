// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the assistant says reaches the person (tests/test_assistant.py, "what the assistant says"): an ordinary new message, let
 * through quiet hours and a pause when the person has just written, and otherwise held and released one message at a time.
 * Through the real `Proactive` on a real store.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { modelOf, viewsOf } from "../../../../test-support/assistant/view-of.js";
import type { JsonObject } from "../../src/json.js";
import { PAUSE_FOREVER } from "../../src/ports/store/policy.js";
import { ALICE, at, event, shown, world } from "../proactive/world.js";

const MINUTE = 60;
const WINDOW = 30 * MINUTE;
const SAY = (id: string, text: string, extra: JsonObject = {}): JsonObject => ({
  type: "assistant.say",
  event_id: id,
  user_id: "u-alice",
  text,
  ...extra,
});
const ITEM = {
  item_id: "it-1",
  seq: 1,
  title: "Report",
  board_state: "needs_you",
  result_version: 1,
  can_accept: true,
  last_report_kind: "ready",
};

it("a say is an ordinary new message never an edit", async () => {
  const w = world();
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, SAY("s1", "I started **task #1**: the flaky test.")),
    "delivered",
  );
  const [sent, ...more] = w.surface.outbox;
  assert.deepEqual(more, []);
  assert.ok(sent?.op === "post");
  assert.ok(
    sent.message.body.type === "rich" && sent.message.body.markdown.includes("task #1"),
    "no card: a chat message",
  );
  assert.deepEqual(
    [sent.message.aiGenerated, sent.message.feedback],
    [true, true],
    "an AI answer with the thumbs under it",
  );
});

it("the systems notice that a task needs you is a new message with claws words", async () => {
  const w = world();
  const said = '#1 "Fix the flaky test" failed and needs your attention.';
  const notice = {
    type: "work_item.needs_you",
    event_id: "n1",
    user_id: "u-alice",
    text: said,
    item: { ...ITEM, title: "Fix the flaky test", can_accept: false, last_report_kind: "failed" },
  };
  assert.equal(await w.proactive.handle(ALICE, w.reference, notice), "delivered");
  assert.deepEqual(shown(w.surface.outbox), [`post ${said}`]);
});

const CASES: readonly [why: "quiet" | "paused" | undefined, wroteAgo: number | undefined, delivered: boolean][] = [
  ["quiet", 5 * MINUTE, true],
  ["quiet", WINDOW - 1, true],
  ["quiet", WINDOW + 1, false],
  ["quiet", undefined, false],
  ["paused", 5 * MINUTE, true],
  ["paused", WINDOW + 1, false],
  ["paused", undefined, false],
  [undefined, 3 * 3600, true],
  [undefined, undefined, true],
];

/** A world at `now` in which the person last wrote `wroteAgo` seconds before (undefined: long ago). */
function wroteAt(now: number, wroteAgo: number | undefined, replyWindowSeconds = WINDOW) {
  const w = world({ now: now - (wroteAgo ?? 30 * 86400), replyWindowSeconds });
  w.clock.setEpochMs(now * 1000);
  w.store.prefs.setQuiet(ALICE, ["22:00", "08:00"]);
  return w;
}

for (const [why, wroteAgo, delivered] of CASES) {
  it(`the reply window lets an answer through quiet hours and a pause (${String(why)} ${String(wroteAgo)} ${String(delivered)})`, async () => {
    const w = wroteAt(why === "quiet" ? at(23, 30) : at(12), wroteAgo);
    if (why === "paused") w.store.prefs.setPausedUntil(ALICE, PAUSE_FOREVER);
    const outcome = await w.proactive.handle(ALICE, w.reference, SAY("s1", "done"));
    assert.equal(outcome, delivered ? "delivered" : "held");
    assert.equal(w.surface.outbox.length > 0, delivered);
  });
}

it("the window is a setting", async () => {
  const late = wroteAt(at(23, 30), 6 * MINUTE, 5 * MINUTE);
  assert.equal(await late.proactive.handle(ALICE, late.reference, SAY("s1", "late answer")), "held");
  const near = wroteAt(at(23, 30), 4 * MINUTE, 5 * MINUTE);
  assert.equal(await near.proactive.handle(ALICE, near.reference, SAY("s2", "answer")), "delivered");
});

it("what was held comes one message at a time when the user can be reached", async () => {
  const w = wroteAt(at(23, 30), undefined);
  for (const e of [SAY("s1", "first thing"), SAY("s2", "report is ready", { item: ITEM })])
    assert.equal(await w.proactive.handle(ALICE, w.reference, e), "held");
  assert.equal(w.surface.outbox.length, 0);
  w.clock.setEpochMs(at(8, 5, 28) * 1000);
  await w.release.releaseDue();
  const out = w.surface.outbox.flatMap((r) => (r.op === "send" || r.op === "post" ? [r.message] : []));
  const said = out.map((m) =>
    m.body.type === "view" ? JSON.stringify(m.body.view.model) : m.body.type === "rich" ? m.body.markdown : m.body.text,
  );
  assert.ok(said[0]?.startsWith("first thing"));
  assert.ok(said[1]?.includes("report is ready"), "in the order they came, each as itself, no digest");
  assert.ok(!out.some((m) => m.body.type === "view" && m.body.view.name === "digest"));
  const card = modelOf(viewsOf(out).at(-1), "workCard");
  assert.deepEqual([card.item.resultVersion, card.item.canAccept], [1, true]);
});

it("the assistants other notices still use the digest", async () => {
  const w = wroteAt(at(23, 30), undefined);
  for (const n of [1, 2])
    await w.proactive.handle(
      ALICE,
      w.reference,
      event("run.completed", `r${String(n)}`, { title: `Run ${String(n)} done` }),
    );
  await w.proactive.handle(ALICE, w.reference, SAY("s1", "a say"));
  w.clock.setEpochMs(at(8, 5, 28) * 1000);
  await w.release.releaseDue();
  const out = shown(w.surface.outbox);
  assert.ok(
    out.some((l) => l.endsWith("view:digest")),
    out.join("|"),
  );
  assert.ok(out.at(-1)?.includes("a say"), out.join("|"));
});
