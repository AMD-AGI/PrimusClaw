// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of tests/test_report_button_card.py and the Report a problem tests of tests/test_feedback_discoverable.py. */
import assert from "node:assert/strict";
import test from "node:test";

import type { OutMessage } from "@primusclaw/personal-agent";

import {
  CONV,
  USER_A,
  USER_B,
  advance,
  clickRoute,
  link,
  linkedWorld,
  makeWorld,
  offerOf,
  say,
  texts,
  type World,
} from "./world.js";

async function press(world: World, promptId: string, user = USER_A, scope = ""): Promise<void> {
  const click = clickRoute(world, { primusclaw: "report", prompt: promptId }, user, scope, "card-5");
  if (scope) await world.flow.clicks.inGroup?.(click);
  else await world.flow.clicks.beforeCredential?.(click);
}

function promptOf(world: World, scope = "", user = USER_A.id): string {
  return world.service.reportView(user, scope).promptId;
}

test("pressing report a problem in a 1to1 chat asks what went wrong and the next message is the report", async () => {
  const world = linkedWorld();
  await press(world, promptOf(world));
  assert.equal(texts(world).at(-1), "What went wrong?");
  assert.ok(world.store.feedback.hasFeedbackAsk(USER_A.id, ""));
  assert.equal(await say(world, "the card never changed"), true); // a report, not a question for Claw
  const [issue] = world.issues.issues;
  assert.ok(issue?.body.includes("the card never changed") && issue.body.includes("Chat: 1:1"));
  assert.ok(texts(world).some((t) => t.startsWith("Thanks. I filed")));
});

test("the asker pressing the button gets the ring replaced by a note without a button", async () => {
  const world = linkedWorld();
  await press(world, promptOf(world));
  assert.equal(texts(world).at(-1), "What went wrong?"); // the question is still asked
  assert.deepEqual(world.settled, [
    { card: "Reporting a problem: your next message to me is the report.", options: { announce: false } },
  ]);
  assert.ok(world.store.feedback.hasFeedbackAsk(USER_A.id, ""));
  const line = world.log.lines.find((l) => l.message === "feedback report button");
  assert.deepEqual(line?.fields, { outcome: "asked", chat: "1:1", card: "replaced" }); // and not the person's words
});

test("the button works for a user who has not linked", async () => {
  const world = makeWorld();
  await press(world, promptOf(world));
  assert.equal(texts(world).at(-1), "What went wrong?");
  assert.equal(world.settled.length, 1);
});

test("in a group only the asker can use the button", async () => {
  const world = linkedWorld();
  link(world, USER_B, "ak-bob");
  const prompt = promptOf(world, CONV);
  await press(world, prompt, USER_B, CONV);
  assert.ok(texts(world).at(-1)?.includes("Only the person who asked can use that button"));
  assert.ok(
    !world.store.feedback.hasFeedbackAsk(USER_B.id, CONV) && !world.store.feedback.hasFeedbackAsk(USER_A.id, CONV),
  );
  // the asker's button is put back as it was, with the group wording
  const back = world.settled.at(-1);
  assert.ok(back);
  assert.deepEqual(back.options, { announce: false });
  const card = back.card as OutMessage;
  assert.ok(card.body.type === "view");
  assert.deepEqual(card.body.view, { name: "feedbackReport", model: { promptId: prompt, group: true } });
  await press(world, prompt, USER_A, CONV);
  assert.ok(texts(world).at(-1)?.startsWith("What went wrong? Reply with @Clawy"));
  assert.ok(
    world.store.feedback.hasFeedbackAsk(USER_A.id, CONV) && !world.store.feedback.hasFeedbackAsk(USER_B.id, CONV),
  );
  assert.equal(world.settled.at(-1)?.card, "Reporting a problem: your next message to me is the report.");
  await say(world, "it summarised the wrong thread", USER_A, CONV);
  assert.ok(world.issues.issues[0]?.body.includes("Chat: group"));
  assert.equal(offerOf(world), undefined);
});

test("a button that is no longer active closes its card", async () => {
  for (const how of ["made-up", "other-chat", "expired"]) {
    const world = linkedWorld();
    const prompt = how === "made-up" ? "made-up" : promptOf(world, how === "other-chat" ? CONV : "");
    if (how === "expired") advance(world, 7 * 24 * 3600 + 1);
    await press(world, prompt);
    assert.equal(texts(world).at(-1), "That button is no longer active. Send /feedback to report a problem.", how);
    assert.deepEqual(world.settled, [{ card: "This button is no longer active.", options: { announce: false } }], how);
    assert.ok(!world.store.feedback.hasFeedbackAsk(USER_A.id, ""), how);
  }
});

test("a report click that is not the report button is left to the next handler", async () => {
  const world = linkedWorld();
  const click = clickRoute(world, { primusclaw: "feedback", offer: "x", include: true });
  assert.equal(await world.flow.clicks.beforeCredential?.(click), false);
  assert.equal(await world.flow.clicks.inGroup?.(click), false);
  assert.equal(world.settled.length, 0);
});
