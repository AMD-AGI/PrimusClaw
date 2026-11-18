// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The edges of observation that the ported tests do not reach. */
import assert from "node:assert/strict";
import test from "node:test";

import { ClawError, ClawUnreachable } from "@primusclaw/personal-agent";

import {
  CONV,
  USER_A,
  USER_B,
  board,
  groupTexts,
  inGroup,
  link,
  observeWorld,
  overheard,
  personalTexts,
  press,
  record,
  suggestions,
} from "./world.js";

function aliceObserves() {
  const world = observeWorld({ users: ["aad-a"] });
  link(world, USER_A, "ak-alice");
  return world;
}

test("an empty overheard message is not sent, and one Claw does not record is logged", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  await overheard(world, "   ", USER_B);
  assert.deepEqual(world.assistant.observed, []);
  world.assistant.observe = () => Promise.reject(new ClawError(429, JSON.stringify({ error: "observe_backlog" })));
  await overheard(world, "CI is red", USER_B);
  const line = world.log.lines.find((l) => l.message === "observe: a group message was not recorded");
  assert.ok(line && String(line.fields["why"]).includes("429"));
  world.assistant.observe = () => Promise.reject(new TypeError("a bug"));
  await assert.rejects(overheard(world, "again", USER_B), TypeError); // only Claw's failures are a log line
});

test("a claw that cannot be reached when turning it on changes nothing", async () => {
  const world = aliceObserves();
  world.assistant.observeScope = () => Promise.reject(new ClawUnreachable("network", "observe"));
  await inGroup(world, "/observe on", USER_A);
  assert.ok(groupTexts(world).at(-1)?.includes("PrimusClaw —"));
  assert.equal(world.store.observe.groupObserver(CONV), null);
  world.assistant.observeScope = () => Promise.reject(new ClawError(500));
  await inGroup(world, "/observe on", USER_A);
  assert.ok(groupTexts(world).at(-1)?.includes("PrimusClaw 返回 500"));
});

test("a group whose record cannot be read is left out of the board", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  world.assistant.observations = () => Promise.reject(new ClawError(503));
  await board(world);
  assert.deepEqual(suggestions(world), []);
  assert.ok(personalTexts(world).at(-1)?.includes("no suggestions"));
  assert.ok(world.log.lines.some((l) => l.message === "observe: a group's record was not read for the board"));
});

test("a reply whose group is no longer known is dismissed, and stored arguments that do not parse are none", async () => {
  const world = aliceObserves();
  const lost = world.store.observe.addObserveCard({
    userId: USER_A.id,
    conversationId: "19:gone@thread.v2",
    runId: "r",
    seq: 0,
    tool: "say",
    args: "{}",
    message: "m",
  });
  await press(world, lost, "accept");
  assert.equal(
    world.settled.at(-1)?.card,
    "找不到那个群了，没有发出。 / That group chat is not known any more; nothing was posted.",
  );
  const odd = world.store.observe.addObserveCard({
    userId: USER_A.id,
    conversationId: CONV,
    runId: "r2",
    seq: 0,
    tool: "remind",
    args: "not json",
    message: "Bob: ping",
  });
  await press(world, odd, "accept");
  assert.ok(world.assistant.heard[0]?.includes("remind\n{}"));
});

test("an assistant that cannot be found leaves the suggestion to be pressed again", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  record(world, ["Bob: CI is red", [{ tool: "work_create", args: { title: "Fix CI" } }]]);
  await board(world);
  const [card] = suggestions(world);
  assert.ok(card);
  world.assistant.session = () => Promise.reject(new ClawError(404));
  await press(world, card.cardId, "accept");
  assert.equal(
    world.settled.at(-1)?.options.fallback,
    "你的助理现在接不了，可以稍后再按一次。 / Your assistant cannot take it right now; press again in a moment.",
  );
  assert.equal(world.store.observe.getObserveCard(card.cardId)?.state, "open");
});
