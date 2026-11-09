// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Ported from internal #458 teams/tests/test_stop_button.py (head 7c1679d4): the Stop card of a turn a phone starts, and
 * its press, through the router (the card itself is the turn engine's `StopButtons`, used here as it is).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { StopButtons } from "../../src/turn/stop-buttons.js";
import type { OnSent, RemoteTurn } from "../../src/routing/features.js";
import { ALICE, BOB } from "./fixtures.js";
import { clickOf, link, message, said, world, type World } from "./world.js";

const TURN_OVER = "That turn has already ended, so nothing was stopped.";

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function fromPhone(text: string, platform = "iOS", user = ALICE) {
  return { ...message(text, { user }), clientPlatform: platform };
}

/** The Stop cards posted: [message id, token]. */
function stopCards(w: World): [string, string][] {
  return w.surface.outbox.flatMap((r) => {
    if (r.op !== "post" || r.message.body.type !== "view" || r.message.body.view.name !== "turnStop") return [];
    return [[r.id, r.message.body.view.model.token] as [string, string]];
  });
}

function opsOn(w: World, id: string): string[] {
  return w.surface.outbox.flatMap((r) => ("id" in r && r.id === id && r.op !== "post" ? [r.op] : []));
}

function press(token: string, cardId: string, user = ALICE) {
  return clickOf("turn_stop", { primusclaw: "turn_stop", turn: token }, { user, card: cardId });
}

async function cardShows(w: World): Promise<void> {
  await w.clock.advance(4000);
}

function sessionWorld() {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  const running = gate();
  w.turns.hold = running.promise;
  return { w, release: running.open };
}

for (const platform of ["iOS", "Android"]) {
  test(`test_a_turn_from_a_phone_gets_the_card_and_its_press_interrupts_that_turn ${platform}`, async () => {
    const { w, release } = sessionWorld();
    await w.router.handle(fromPhone("do it", platform));
    await cardShows(w);
    const [[cardId, token] = ["", ""]] = stopCards(w);
    await w.router.handle(press(token, cardId));
    assert.deepEqual(
      w.claw.calls.filter((c) => c[0] === "interrupt"),
      [["interrupt", "ak-alice", "sess-ak-alice"]],
    );
    release();
    await w.router.settled();
    await (w.deps.stopCards as StopButtons).drain();
    assert.deepEqual(opsOn(w, cardId), ["delete"]); // (deleted by the press, once; never edited)
    assert.ok(said(w).some((t) => t.includes("Stopping")));
  });
}

for (const platform of ["Windows", "Mac", "Web", ""]) {
  test(`test_a_turn_from_a_desktop_or_the_web_gets_no_card ${platform || "none"}`, async () => {
    const { w, release } = sessionWorld();
    await w.router.handle(fromPhone("do it", platform));
    await cardShows(w);
    release();
    await w.router.settled();
    assert.deepEqual(stopCards(w), []);
  });
}

test("test_a_press_after_the_turn_ended_stops_nothing_and_says_so", async () => {
  const { w, release } = sessionWorld();
  await w.router.handle(fromPhone("do it"));
  await cardShows(w);
  const [[cardId, token] = ["", ""]] = stopCards(w);
  release();
  await w.router.settled();
  await (w.deps.stopCards as StopButtons).drain();
  await w.router.handle(press(token, cardId));
  assert.ok(!w.claw.calls.some((c) => c[0] === "interrupt"));
  assert.equal(said(w).at(-1), TURN_OVER);
  assert.ok(!opsOn(w, cardId).includes("update"));
});

test("test_the_card_of_an_earlier_turn_never_stops_the_next_one", async () => {
  const { w, release } = sessionWorld();
  await w.router.handle(fromPhone("first"));
  await cardShows(w);
  release();
  await w.router.settled();
  const second = gate();
  w.turns.hold = second.promise;
  await w.router.handle(fromPhone("second"));
  await cardShows(w);
  const [[firstCard, first] = ["", ""], [, other] = ["", ""]] = stopCards(w);
  await w.router.handle(press(first, firstCard));
  assert.ok(!w.claw.calls.some((c) => c[0] === "interrupt"));
  assert.equal(said(w).at(-1), TURN_OVER);
  await w.router.handle(press(other, "teams-x", BOB)); // (someone else's press of the live card: not theirs to stop)
  assert.ok(!w.claw.calls.some((c) => c[0] === "interrupt"));
  second.open();
  await w.router.settled();
});

function remoteWorld() {
  let turn: (RemoteTurn & { end: () => void }) | undefined;
  const stops: unknown[] = [];
  const w = world({
    remote: {
      enabled: true,
      attached: () => true,
      windowed: () => false,
      currentTurn: () => turn,
      prompt: () => {
        const ended = gate();
        turn = { ended: ended.promise, end: ended.open };
        return Promise.resolve();
      },
      stop: (_chat, _key, _conv, only) => {
        if (only !== undefined && only !== turn) return Promise.resolve(false);
        stops.push(only);
        turn?.end();
        turn = undefined;
        return Promise.resolve(true);
      },
    },
  });
  link(w, ALICE.id, "ak-alice");
  return { w, stops, current: () => turn };
}

test("test_a_phones_message_to_an_attached_agent_gets_the_card_and_its_press_cancels_that_turn", async () => {
  const r = remoteWorld();
  await r.w.router.handle(fromPhone("run the tests"));
  await cardShows(r.w);
  const [[cardId, token] = ["", ""]] = stopCards(r.w);
  await r.w.router.handle(press(token, cardId));
  assert.equal(r.stops.length, 1);
  assert.ok(!r.w.claw.calls.some((c) => c[0] === "interrupt")); // (the agent's turn, not the chat's own session)
  await r.w.router.handle(press(token, cardId)); // (pressed again: the turn is over)
  assert.equal(r.stops.length, 1);
  assert.equal(said(r.w).at(-1), TURN_OVER);
});

test("test_the_agents_next_turn_is_never_cancelled_by_the_card_of_the_one_before", async () => {
  const r = remoteWorld();
  await r.w.router.handle(fromPhone("one"));
  await cardShows(r.w);
  const [[cardId, token] = ["", ""]] = stopCards(r.w);
  const before = r.current() as RemoteTurn & { end: () => void };
  before.end(); // (the agent's turn ended on its own)
  await r.w.router.handle(fromPhone("two")); // (its next turn runs)
  await r.w.router.handle(press(token, cardId));
  assert.deepEqual(r.stops, []);
  assert.equal(said(r.w).at(-1), TURN_OVER);
});

test("test_an_attached_agents_turn_from_the_desktop_gets_no_card", async () => {
  const r = remoteWorld();
  await r.w.router.handle(fromPhone("hi", "Windows"));
  await cardShows(r.w);
  assert.deepEqual(stopCards(r.w), []);
});

test("test_a_phones_message_to_the_assistant_gets_the_card_and_its_press_interrupts_only_the_turn_answering_it", async () => {
  const stopped: (string | undefined)[] = [];
  let running = "msg-1";
  const w = world({
    assistant: {
      on: () => true,
      route: (request: { onSent?: OnSent }) => {
        request.onSent?.("as-1", "msg-1");
        return Promise.resolve(true);
      },
      stop: (_u, _k, _c, onlyMessage) => {
        if (onlyMessage !== running) return Promise.resolve(false);
        stopped.push(onlyMessage);
        return Promise.resolve(true);
      },
    },
  });
  Object.assign(w.deps.claw.sessions, {
    turn: () => Promise.resolve({ running: running !== "", messageId: running }),
  });
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(fromPhone("hello"));
  await cardShows(w);
  const [[cardId, token] = ["", ""]] = stopCards(w);
  running = "msg-2"; // (another message's turn runs now: the card's turn is over)
  await w.router.handle(press(token, cardId));
  assert.deepEqual(stopped, []);
  assert.equal(said(w).at(-1), TURN_OVER);
});

function assistantWorld() {
  const stopped: (string | undefined)[] = [];
  const claw = { running: "msg-1" };
  const w = world({
    assistant: {
      on: () => true,
      route: (request: { onSent?: OnSent }) => {
        request.onSent?.("as-1", "msg-1");
        return Promise.resolve(true);
      },
      stop: (_u, _k, _c, onlyMessage) => (stopped.push(onlyMessage), Promise.resolve(true)),
    },
  });
  Object.assign(w.deps.claw.sessions, {
    turn: () => Promise.resolve({ running: claw.running !== "", messageId: claw.running }),
  });
  link(w, ALICE.id, "ak-alice");
  return { w, stopped, claw };
}

test("a phone's message to the assistant: the press stops the turn answering it, by its message", async () => {
  const a = assistantWorld();
  await a.w.router.handle(fromPhone("hello"));
  await cardShows(a.w);
  const [[cardId, token] = ["", ""]] = stopCards(a.w);
  await a.w.router.handle(press(token, cardId));
  assert.deepEqual(a.stopped, ["msg-1"]);
  assert.deepEqual(opsOn(a.w, cardId), ["delete"]);
});

test("a phone's message to the assistant: the card goes once Claw says the turn ended", async () => {
  const a = assistantWorld();
  await a.w.router.handle(fromPhone("hello"));
  await cardShows(a.w);
  const [[cardId] = [""]] = stopCards(a.w);
  a.claw.running = "";
  await a.w.clock.advance(3000);
  await (a.w.deps.stopCards as StopButtons).drain();
  assert.deepEqual(opsOn(a.w, cardId), ["delete"]);
  assert.deepEqual(a.stopped, []);
});

test("test_in_an_agents_window_a_card_teams_will_not_delete_is_left_as_it_is_never_edited", async () => {
  const r = remoteWorld();
  Object.assign(r.w.deps.remote, { direct: () => true });
  Object.assign(r.w.surface, { caps: { ...r.w.surface.caps, delete: false } });
  await r.w.router.handle(fromPhone("run the tests"));
  await cardShows(r.w);
  const [[cardId, token] = ["", ""]] = stopCards(r.w);
  await r.w.router.handle(press(token, cardId));
  assert.equal(r.stops.length, 1);
  assert.deepEqual(opsOn(r.w, cardId), []); // (not deleted: Teams would not; not edited: a window is never edited)
});

test("a pressed card the channel will not delete is closed to a line, outside an agent's window", async () => {
  const { w, release } = sessionWorld();
  Object.assign(w.surface, { caps: { ...w.surface.caps, delete: false } });
  await w.router.handle(fromPhone("do it"));
  await cardShows(w);
  const [[cardId, token] = ["", ""]] = stopCards(w);
  await w.router.handle(press(token, cardId));
  release();
  await w.router.settled();
  assert.deepEqual(opsOn(w, cardId), ["update"]);
  assert.ok(said(w).includes("note::Stop was pressed."));
});
