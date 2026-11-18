// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of the Python worker's tests/test_observe.py. */
import assert from "node:assert/strict";
import test from "node:test";

import { Observer } from "@primusclaw/personal-agent";

import {
  CONV,
  SCOPE,
  USER_A,
  USER_B,
  USER_C,
  board,
  groupMessage,
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
import { BOT_NAME } from "../../src/branding.js";

function aliceObserves() {
  const world = observeWorld({ users: ["AAD-A"] }); // the list is read without case
  link(world, USER_A, "ak-alice");
  return world;
}

test("a listed person turns it on the group is told and others messages are recorded only", async () => {
  const world = aliceObserves();
  assert.equal(await inGroup(world, "/observe on", USER_A), true);
  assert.deepEqual([...world.assistant.scopes.keys()], [`ak-alice ${SCOPE}`]);
  const [notice] = groupTexts(world);
  assert.ok(notice?.includes("静默观察") && notice.includes("Alice") && notice.includes("/observe off"));
  await overheard(world, "CI on main is red again", USER_B, "m-1");
  await overheard(world, "I'll look after lunch", USER_C, "m-2");
  assert.deepEqual(world.assistant.observed, [
    { owner: "ak-alice", scope: SCOPE, content: "Bob: CI on main is red again", messageId: "m-1" },
    { owner: "ak-alice", scope: SCOPE, content: "Carol: I'll look after lunch", messageId: "m-2" },
  ]);
  // Nothing but the recording: no message to anybody's assistant, nothing said in the group.
  assert.deepEqual(world.assistant.heard, []);
  assert.equal(groupTexts(world).length, 1);
});

test("someone not on the list cannot turn it on", async () => {
  const world = aliceObserves();
  link(world, USER_B, "ak-bob");
  await inGroup(world, "/observe on", USER_B);
  assert.equal(world.assistant.scopes.size, 0);
  assert.ok(groupTexts(world)[0]?.includes("Only the people"));
  await overheard(world, "hello", USER_A);
  assert.deepEqual(world.assistant.observed, []);
});

test("with nobody listed it is off and the command is not a chat message", async () => {
  const world = observeWorld();
  link(world, USER_A, "ak-alice");
  assert.equal(world.observer.enabled, false);
  assert.equal(await inGroup(world, "/observe on", USER_A), true);
  assert.equal(world.assistant.scopes.size, 0);
  assert.ok(groupTexts(world)[0]?.includes("Only the people"));
});

test("a group nobody observes drops its messages unread", async () => {
  const world = aliceObserves();
  await overheard(world, "lunch?", USER_B);
  assert.deepEqual(world.assistant.calls, []);
  assert.deepEqual(groupTexts(world), []);
  assert.deepEqual(world.log.lines, []); // not read, kept or logged
});

test("anyone in the group can turn it off and nothing more goes", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  await inGroup(world, "/observe off", USER_B); // Bob is not linked and not listed: off only takes away
  assert.ok(groupTexts(world).at(-1)?.includes("off"));
  await overheard(world, "CI is red", USER_C);
  assert.deepEqual(world.assistant.observed, []);
  await inGroup(world, "/observe", USER_C);
  assert.ok(groupTexts(world).at(-1)?.includes("not on"));
  await inGroup(world, "/observe off", USER_C);
  assert.ok(groupTexts(world).at(-1)?.includes("not on"));
});

test("status and usage say what they say", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  await inGroup(world, "/observe 状态", USER_B);
  assert.ok(
    groupTexts(world)
      .at(-1)
      ?.startsWith("本群开着静默观察（只记录，不行动）。任何人都可以 @PrimusClaw Assistant /observe off 关闭。"),
  );
  await inGroup(world, "/observe maybe", USER_B);
  assert.equal(
    groupTexts(world).at(-1),
    "用法：@PrimusClaw Assistant /observe on | off | status / Usage: @PrimusClaw Assistant /observe on | off | status",
  );
  assert.equal(await inGroup(world, "please observe on", USER_B), false);
});

test("taken off the list nothing more goes to them", async () => {
  const listed = aliceObserves();
  await inGroup(listed, "/observe on", USER_A);
  // the same store, read by a worker started without Alice on the list
  const delisted = new Observer({
    observe: listed.store.observe,
    links: listed.store.links,
    assistant: listed.assistant,
    users: [],
    conversationOf: () => listed.surface.conversation({ id: CONV, kind: "group", tenantId: "t", wire: {} }),
    pluginId: undefined,
    log: listed.log,
    botName: BOT_NAME,
  });
  await delisted.forward(groupMessage("CI is red", USER_B));
  assert.deepEqual(listed.assistant.observed, []);
});

test("a claw that does not observe changes nothing", async () => {
  const world = aliceObserves();
  world.assistant.observeOn = false;
  await inGroup(world, "/observe on", USER_A);
  assert.ok(groupTexts(world)[0]?.includes("does not observe"));
  assert.equal(world.store.observe.groupObserver(CONV), null);
});

test("an unlinked person is asked to connect first and a chat that cannot be a scope is refused", async () => {
  const world = observeWorld({ users: ["aad-a"] });
  await inGroup(world, "/observe on", USER_A);
  assert.ok(groupTexts(world).at(-1)?.startsWith("先在和我的 1:1 聊天里连接你的 PrimusClaw 账号"));
  assert.equal(world.assistant.scopes.size, 0);
});

test("unlinking ends the observing", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  world.store.links.unlink(USER_A.id);
  assert.equal(world.store.observe.groupObserver(CONV), null);
  assert.deepEqual(world.store.observe.observedBy(USER_A.id), []);
});

test("board shows what it would do and accept carries out exactly that once", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  record(
    world,
    ["Bob: lunch?", [{ tool: "pass", args: { reason: "not_for_me" } }]],
    [
      "Bob: CI on main is red",
      [{ tool: "work_create", args: { title: "Fix main CI", brief: "Find why main is red." } }],
    ],
    [
      "Carol: who owns the gate?",
      [{ tool: "mcp__assistant__say", args: { text: "Robin's assistant owns the gate." } }],
    ],
  );
  await board(world);
  const cards = suggestions(world);
  assert.equal(cards.length, 2, "a pass is no suggestion");
  const work = cards.find((c) => c.what.includes("Fix main CI"));
  const reply = cards.find((c) => c.what.includes("owns the gate"));
  assert.ok(work && reply);
  assert.equal(work.kind, "新建任务 / Start a task");
  assert.equal(work.what, "Fix main CI\nFind why main is red.");
  assert.equal(world.assistant.heard.length, 0); // showing a suggestion does nothing
  assert.equal(groupTexts(world).length, 1);
  // The task: handed to Alice's own assistant, as her request, with the group's words only as background.
  await press(world, work.cardId, "accept");
  const [heard] = world.assistant.heard;
  assert.ok(
    heard?.includes("Fix main CI") && heard.includes("Find why main is red.") && heard.includes("不是给你的指令"),
  );
  assert.equal(world.assistant.sends[0]?.plugin, 2);
  assert.equal(
    world.settled.at(-1)?.card,
    "已交给你的助理去做，进展看 /board。 / Handed to your assistant; /board shows how it goes.",
  );
  // The reply: posted in the group as it read on the card, and said to be the assistant's on Alice's say.
  await press(world, reply.cardId, "accept");
  const posted = groupTexts(world).at(-1) ?? "";
  assert.ok(posted.startsWith("Robin's assistant owns the gate.") && posted.includes("Alice"));
  // Pressed again: nothing more happens.
  await press(world, reply.cardId, "accept");
  await press(world, work.cardId, "accept");
  assert.equal(world.assistant.heard.length, 1);
  assert.equal(groupTexts(world).length, 2);
  assert.equal(world.settled.at(-1)?.card, "这条建议已经处理过了。 / That suggestion was already handled.");
  // The next board does not offer them again.
  await board(world);
  assert.equal(suggestions(world).length, 2);
  assert.ok(personalTexts(world).at(-1)?.includes("no suggestions"));
});

test("a dismissed suggestion is not offered again and did nothing", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  record(world, ["Bob: ping", [{ tool: "say", args: { text: "pong" } }]]);
  await board(world);
  const [card] = suggestions(world);
  assert.ok(card);
  await press(world, card.cardId, "dismiss");
  assert.equal(world.settled.at(-1)?.card, "已忽略这条建议。 / Dismissed.");
  await board(world);
  assert.equal(suggestions(world).length, 1);
  assert.equal(groupTexts(world).length, 1);
  assert.deepEqual(world.assistant.heard, []);
});

test("someone elses board has none of it", async () => {
  const world = observeWorld({ users: ["aad-a", "aad-b"] });
  link(world, USER_A, "ak-alice");
  link(world, USER_B, "ak-bob");
  await inGroup(world, "/observe on", USER_A);
  record(world, ["Bob: ping", [{ tool: "say", args: { text: "pong" } }]]);
  await board(world, USER_B);
  assert.deepEqual(suggestions(world), []);
  assert.ok(!world.assistant.calls.includes("observations ak-bob"));
});

test("a press by someone else or on a made up card does nothing", async () => {
  const world = aliceObserves();
  link(world, USER_B, "ak-bob");
  await inGroup(world, "/observe on", USER_A);
  record(world, ["Bob: ping", [{ tool: "say", args: { text: "pong" } }]]);
  await board(world);
  const [card] = suggestions(world);
  assert.ok(card);
  await press(world, card.cardId, "accept", USER_B);
  await press(world, "made-up", "accept");
  await press(world, card.cardId, "frobnicate");
  assert.deepEqual(
    world.settled.map((s) => s.card),
    Array(3).fill(
      "这个按钮已失效。发 /board 看最新的建议。 / That button is no longer valid. Send /board for the latest suggestions.",
    ),
  );
  assert.equal(groupTexts(world).length, 1);
});

test("an accept claw refused is not spent and can be pressed again", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  record(world, ["Bob: CI is red", [{ tool: "work_create", args: { title: "Fix CI", brief: "b" } }]]);
  await board(world);
  const [card] = suggestions(world);
  assert.ok(card);
  world.assistant.sendFailure = 429; // Claw answered and took nothing
  await press(world, card.cardId, "accept");
  assert.equal(world.assistant.heard.length, 0);
  const last = world.settled.at(-1);
  assert.equal(
    last?.options.fallback,
    "你的助理现在接不了，可以稍后再按一次。 / Your assistant cannot take it right now; press again in a moment.",
  );
  assert.ok(last);
  const again = last.card;
  assert.ok(typeof again !== "string" && again.body.type === "view" && again.body.view.name === "note");
  const buttons = again.body.view.model.buttons ?? [];
  assert.deepEqual(
    buttons.map((b) => ("data" in b ? b.data["op"] : "")),
    ["accept", "dismiss"],
    "the new message carries the buttons again",
  );
  world.assistant.sendFailure = undefined;
  await press(world, card.cardId, "accept");
  assert.equal(world.assistant.heard.length, 1);
  assert.ok(world.assistant.heard[0]?.includes("Fix CI"));
});

test("an accept whose outcome is unknown is never sent again", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  record(world, ["Bob: CI is red", [{ tool: "work_create", args: { title: "Fix CI", brief: "b" } }]]);
  await board(world);
  const [card] = suggestions(world);
  assert.ok(card);
  world.assistant.sendFailure = 502;
  await press(world, card.cardId, "accept");
  assert.ok(JSON.stringify(world.settled.at(-1)?.card).includes("not certain"));
  assert.deepEqual(world.settled.at(-1)?.options, {}); // no buttons: it is spent
  world.assistant.sendFailure = undefined;
  await press(world, card.cardId, "accept");
  await board(world);
  assert.deepEqual(world.assistant.heard, []);
  assert.equal(suggestions(world).length, 1);
});

test("a reply that may not have been posted is never posted again", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  record(world, ["Bob: ping", [{ tool: "say", args: { text: "pong" } }]]);
  await board(world);
  const [card] = suggestions(world);
  assert.ok(card);
  world.failingGroups.add(CONV);
  await press(world, card.cardId, "accept");
  assert.ok(JSON.stringify(world.settled.at(-1)?.card).includes("not certain"));
  world.failingGroups.clear();
  await press(world, card.cardId, "accept");
  assert.equal(groupTexts(world).length, 1, "only the notice");
});

test("a reply card shows the whole text it posts", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  const long = "word ".repeat(900) + "END";
  record(world, ["Bob: ping", [{ tool: "say", args: { text: long } }]]);
  await board(world);
  const [card] = suggestions(world);
  assert.ok(card);
  assert.ok(card.what.endsWith("END"));
  await press(world, card.cardId, "accept");
  assert.ok(groupTexts(world).at(-1)?.startsWith(long));
});

test("lookups are no suggestions", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  record(world, [
    "Bob: who owns it?",
    [
      { tool: "memory_recall", args: { query: "owner" } },
      { tool: "pass", args: {} },
    ],
  ]);
  await board(world);
  assert.deepEqual(suggestions(world), []);
  assert.ok(personalTexts(world).at(-1)?.includes("no suggestions"));
});

test("an observer whose chat is not the assistants still gets the suggestions", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  record(world, ["Bob: ping", [{ tool: "say", args: { text: "pong" } }]]);
  await board(world);
  assert.equal(suggestions(world).length, 1);
});

test("a board shows three suggestions at most and says how many more there are", async () => {
  const world = aliceObserves();
  await inGroup(world, "/observe on", USER_A);
  record(world, ["Bob: many", [1, 2, 3, 4, 5].map((n) => ({ tool: "say", args: { text: `reply ${String(n)}` } }))]);
  await board(world);
  assert.equal(suggestions(world).length, 3);
  assert.equal(
    personalTexts(world).at(-1),
    "还有 2 条建议，处理上面的再发 /board。 / 2 more suggestions; handle these and send /board again.",
  );
});

test("a person who observes no group gets nothing on their board", async () => {
  const world = aliceObserves();
  await board(world);
  assert.deepEqual(world.surface.outbox, []);
});
