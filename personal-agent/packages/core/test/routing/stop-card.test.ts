// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Ported from teams/tests/test_stop_button.py after internal #481: a turn a phone starts gets no Stop card of the worker's
 * own any more (the floating status's Stop is the one wanted; on a phone, saying 停止 or /stop stops the turn), and a press
 * on a card sent before that stops nothing and says so.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { AssistantRouteRequest, RemoteTurn } from "../../src/routing/features.js";
import { ALICE } from "./fixtures.js";
import { clickOf, link, message, said, world, type World } from "./world.js";

const TURN_OVER = "That turn has already ended, so nothing was stopped.";

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function fromPhone(text: string, platform = "iOS") {
  return { ...message(text), clientPlatform: platform };
}

/** The Stop cards posted (the turn engine's card, by its view's name). */
function stopCards(w: World): string[] {
  return w.surface.outbox.flatMap((r) =>
    r.op === "post" && r.message.body.type === "view" && r.message.body.view.name === "turnStop" ? [r.id] : [],
  );
}

/** Long enough for a card to have been offered (StopButtons waits 3 s before it shows one). */
async function cardWouldShow(w: World): Promise<void> {
  await w.clock.advance(4000);
}

function sessionWorld() {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  const running = gate();
  w.turns.hold = running.promise;
  return { w, release: running.open };
}

for (const platform of ["iOS", "Android"]) {
  test(`test_a_turn_from_a_phone_gets_no_stop_card_and_saying_stop_interrupts_it ${platform}`, async () => {
    const { w, release } = sessionWorld();
    await w.router.handle(fromPhone("do it", platform));
    await cardWouldShow(w);
    assert.deepEqual(stopCards(w), []);
    await w.router.handle(fromPhone("停止", platform));
    assert.deepEqual(
      w.claw.calls.filter((c) => c[0] === "interrupt"),
      [["interrupt", "ak-alice", "sess-ak-alice"]],
    );
    release();
    await w.router.settled();
    assert.deepEqual(stopCards(w), []);
  });
}

test("test_a_press_on_a_card_sent_before_stops_nothing_and_says_so", async () => {
  const { w, release } = sessionWorld();
  await w.router.handle(fromPhone("do it"));
  await w.router.handle(
    clickOf("turn_stop", { primusclaw: "turn_stop", turn: "a-token-from-before" }, { card: "teams-old-card" }),
  );
  release();
  await w.router.settled();
  assert.ok(!w.claw.calls.some((c) => c[0] === "interrupt"));
  assert.ok(said(w).includes(TURN_OVER));
  const ops = w.surface.outbox.flatMap((r) => ("id" in r && r.id === "teams-old-card" ? [r.op] : []));
  assert.deepEqual(ops, ["delete"]); // (the old card goes; it is never edited)
});

test("a pressed old card the channel will not delete is closed to a line, and left as it is in an agent's window", async () => {
  for (const direct of [false, true]) {
    const w = world({ remote: { direct: () => direct } });
    link(w, ALICE.id, "ak-alice");
    Object.assign(w.surface, { caps: { ...w.surface.caps, delete: false } });
    await w.router.handle(clickOf("turn_stop", { primusclaw: "turn_stop", turn: "old" }, { card: "old-card" }));
    const ops = w.surface.outbox.flatMap((r) => ("id" in r && r.id === "old-card" ? [r.op] : []));
    assert.deepEqual(ops, direct ? [] : ["update"], String(direct));
    assert.equal(said(w).at(-1), TURN_OVER);
  }
});

test("test_a_phones_message_to_an_attached_agent_gets_no_stop_card_and_saying_stop_cancels_that_turn", async () => {
  let turn: RemoteTurn | undefined;
  const prompts: string[] = [];
  const stops: unknown[] = [];
  const w = world({
    remote: {
      enabled: true,
      attached: () => true,
      windowed: () => false,
      currentTurn: () => turn,
      prompt: (request) => {
        prompts.push(request.prompt);
        turn = { task: { done: new Promise(() => undefined), running: true } };
        return Promise.resolve();
      },
      stop: (_chat, _key, _conversation, only) => {
        stops.push(only);
        turn = undefined;
        return Promise.resolve(true);
      },
    },
  });
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(fromPhone("run everything", "Android"));
  await cardWouldShow(w);
  assert.deepEqual(stopCards(w), []);
  await w.router.handle(fromPhone("停止", "Android"));
  assert.equal(stops.length, 1);
  assert.deepEqual(prompts, ["run everything"], "停止 is not sent to the agent as a message");
  assert.deepEqual(stopCards(w), []);
});

test("test_a_phones_message_to_the_assistant_gets_no_stop_card", async () => {
  const routed: AssistantRouteRequest[] = [];
  const w = world({
    assistant: {
      on: () => true,
      route: (request) => {
        routed.push(request);
        request.onSent?.("as-1", "msg-1"); // (Claw took it; a card would follow if the router had asked for one)
        return Promise.resolve(true);
      },
    },
  });
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(fromPhone("hello"));
  await cardWouldShow(w);
  assert.equal(routed.length, 1);
  assert.equal(routed[0]?.onSent, undefined);
  assert.deepEqual(stopCards(w), []);
});
