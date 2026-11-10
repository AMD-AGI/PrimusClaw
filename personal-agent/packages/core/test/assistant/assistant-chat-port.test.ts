// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A 1:1 chat that talks to the person's assistant (tests/test_assistant.py, the chat half): the message goes and the chat is free
 * again, and the chat goes to the assistant only where the assistant can answer. Driven as the router drives the assistant's chat.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, AssistantWorld, BOB } from "../../../../test-support/assistant/assistant-world.js";
import { parseWorkItem } from "../../src/assistant/item-of.js";
import { ClawError } from "../../src/claw/errors.js";
import type { WorkItem } from "../../src/claw/model.js";
import {
  APPROVALS_TYPES_VERSION,
  ASSISTANT_SUBSCRIPTION_TYPES,
  ASSISTANT_TYPES_VERSION,
} from "../../src/subscriptions/event-types.js";
import { UPGRADE_RETRY_SECONDS } from "../../src/subscriptions/subscriptions.js";

const UNAVAILABLE = "I cannot reach your assistant just now";

it("two tasks and three interjections are all taken and the chat is never locked", async () => {
  const w = await AssistantWorld.start();
  const said = [
    "do task A: two steps of 45 seconds",
    "now task B, the same",
    "how far is A?",
    "tell me when B is done",
    "how many things are you doing?",
  ];
  for (const text of said) assert.equal(await w.say(text), true);
  assert.deepEqual(w.heard(), said);
  assert.ok(!w.texts().some((t) => t.includes("still working")));
  assert.deepEqual(w.started, []);
  // (no session was made for any of them: only the assistant's own is read, for the turn in front of each message)
  assert.deepEqual(new Set(w.claw.turnsAsked), new Set([w.claw.sessionOf("ak-alice")]));
});

it("a message the assistant queues is taken all the same", async () => {
  const w = await AssistantWorld.start({ progress: false });
  w.claw.queue = true;
  assert.equal(await w.say("one more thing"), true);
  assert.deepEqual(w.heard(), ["one more thing"]);
  assert.deepEqual(
    w.texts().filter((t) => t),
    [],
  );
});

it("no reply style rides on the message and no plugin without claw plugin id", async () => {
  const w = await AssistantWorld.start();
  await w.say("hello");
  const [heard] = w.claw.heard;
  assert.deepEqual([heard?.text, heard?.context, heard?.plugin, heard?.modelKey], ["hello", undefined, undefined, ""]);
});

it("each user talks to their own assistant with their own key", async () => {
  const w = await AssistantWorld.start();
  await w.link(BOB);
  await w.say("from alice", ALICE);
  await w.say("from bob", BOB);
  assert.deepEqual(
    w.claw.heard.map((h) => [h.key, h.text]),
    [
      ["ak-alice", "from alice"],
      ["ak-bob", "from bob"],
    ],
  );
  assert.notEqual(w.claw.heard[0]?.sessionId, w.claw.heard[1]?.sessionId);
  assert.deepEqual(
    w.claw.heard.map((h) => h.sessionId),
    [w.claw.sessionOf("ak-alice"), w.claw.sessionOf("ak-bob")],
  );
});

it("the assistant is asked for before each message so a deleted session is replaced", async () => {
  const w = await AssistantWorld.start();
  await w.say("first");
  const old = w.claw.sessionOf("ak-alice");
  w.claw.sessionOf = () => "asst-new"; // (the person deleted the assistant's session in the web console: Claw made another)
  await w.say("second");
  assert.deepEqual(
    w.claw.heard.map((h) => h.sessionId),
    [old, "asst-new"],
  );
});

it("a claw without the assistant keeps the old path and is not asked again for a minute", async () => {
  const w = await AssistantWorld.start();
  w.claw.fail.set("session", new ClawError(404, '{"error":"not_found"}'));
  await w.say("first");
  await w.say("second");
  assert.deepEqual(w.started, ["first", "second"]);
  assert.equal(w.claw.calls.filter((c) => c === "session").length, 1, "the second was not even asked about");
  w.advance(61);
  w.claw.fail.clear();
  await w.say("third");
  assert.deepEqual(w.started, ["first", "second"]);
  assert.deepEqual(w.heard(), ["third"]);
});

for (const [name, failure] of [
  ["500", new ClawError(500)],
  ["503", new ClawError(503)],
  ["502 bad gateway", new ClawError(502, '{"error":"bad_gateway"}')],
] as const) {
  it(`any other failure tells the user and does not fall back to a session (${name})`, async () => {
    const w = await AssistantWorld.start();
    w.claw.fail.set("session", failure);
    await w.say("hello");
    assert.deepEqual([w.started, w.heard()], [[], []]);
    assert.ok(w.texts().at(-1)?.startsWith(UNAVAILABLE));
    w.claw.fail.delete("session");
    w.claw.fail.set("send", new ClawError(500)); // the assistant exists, but the message is refused
    await w.say("again");
    assert.deepEqual(w.started, []);
    assert.ok(w.texts().at(-1)?.startsWith(UNAVAILABLE));
  });
}

it("only a user whose subscription has the assistants events talks to it", async () => {
  const w = await AssistantWorld.start({ oldClaw: true });
  assert.equal(
    w.store.notifySubs.notifyTypesVersion(ALICE),
    0,
    "Claw did not know the types: the subscription it always made",
  );
  await w.say("hello");
  assert.deepEqual([w.started, w.heard()], [["hello"], []]);
  w.subsClaw.knownTypes.add("assistant.say"); // Claw is deployed with the assistant
  w.subsClaw.knownTypes.add("work_item.needs_you");
  w.advance(UPGRADE_RETRY_SECONDS + 1);
  await w.say("hello again");
  assert.equal(w.store.notifySubs.notifyTypesVersion(ALICE), ASSISTANT_TYPES_VERSION);
  assert.deepEqual(w.heard(), ["hello again"]);
  assert.deepEqual(new Set(w.subsClaw.of("ak-alice")[0]?.event_types), new Set(ASSISTANT_SUBSCRIPTION_TYPES));
});

it("a user whose platform id is not known stays on sessions until it is", async () => {
  const w = await AssistantWorld.start({ link: false });
  w.clawIds.delete("ak-alice"); // linked, and SaFE could not say who they are
  await w.link(ALICE);
  await w.say("first");
  await w.say("second");
  assert.deepEqual([w.started, w.heard()], [["first", "second"], []]);
  assert.equal(w.store.links.needsClawUserId(ALICE), true);
  assert.equal(
    w.store.notifySubs.notifyTypesVersion(ALICE),
    APPROVALS_TYPES_VERSION,
    "(the subscription alone is not enough)",
  );
  w.clawIds.set("ak-alice", "u-alice"); // SaFE answers: the next message fills the id in, and goes to the assistant
  await w.say("third");
  assert.equal(w.store.links.clawUserIdOf(ALICE), "u-alice");
  assert.deepEqual([w.started, w.heard()], [["first", "second"], ["third"]]);
});

it("without notifications the assistant could not reach the user so there is no assistant chat", async () => {
  const w = await AssistantWorld.start({ notifications: false });
  await w.say("hello");
  assert.deepEqual([w.started, w.heard()], [["hello"], []]);
});

for (const [command, mentions] of [
  ["/new", "no sessions to start or switch"],
  ["/sessions", "no sessions to start or switch"],
  ["/repo AMD-AGI/PrimusClaw main", "which repository you mean"],
] as const) {
  it(`new sessions and repo are not commands with the assistant and do nothing (${command})`, async () => {
    const w = await AssistantWorld.start();
    w.store.sessions.setSession(ALICE, { sessionId: "sess-old" });
    const before = w.claw.calls.length;
    assert.ok(w.chat.on(ALICE));
    assert.ok(w.chat.hiddenCommand(command, "en")?.includes(mentions));
    assert.equal(w.store.sessions.getSession(ALICE), "sess-old", "nothing was done");
    assert.equal(w.claw.calls.length, before);
    assert.deepEqual(w.heard(), []);
  });
}

it("stop interrupts what the assistant is doing and says how to stop a task", async () => {
  const w = await AssistantWorld.start();
  await w.say("hello"); // the assistant exists now
  const sid = w.claw.sessionOf("ak-alice");
  w.claw.running.add(sid);
  await w.chat.stop(ALICE, "ak-alice", w.conversation());
  assert.equal(w.claw.calls.filter((c) => c === "interrupt").length, 1);
  assert.equal(w.claw.running.has(sid), false);
  assert.ok(w.texts().at(-1)?.startsWith("Stopped what I was doing."));
  assert.ok(w.texts().at(-1)?.includes("stop #2"));
  await w.chat.stop(ALICE, "ak-alice", w.conversation()); // it is idle now
  assert.equal(w.claw.calls.filter((c) => c === "interrupt").length, 1);
  assert.ok(w.texts().at(-1)?.startsWith("I am not busy right now."));
});

const ITEM_DEFAULTS = { kind: "task", params: {}, pull: null, updatedAt: "" };
const READ: readonly [string, unknown, WorkItem | undefined][] = [
  [
    "a whole row",
    {
      item_id: "wi-1",
      seq: 3,
      title: "T",
      board_state: "needs_you",
      result_version: 2,
      can_accept: true,
      last_report_kind: "ready",
      pending_question: null,
      summary: "S",
      outcome: null,
    },
    {
      itemId: "wi-1",
      seq: 3,
      title: "T",
      boardState: "needs_you",
      resultVersion: 2,
      canAccept: true,
      lastReportKind: "ready",
      pendingQuestion: null,
      summary: "S",
      outcome: null,
      ...ITEM_DEFAULTS,
    },
  ],
  [
    "an event's item",
    { item_id: "wi-2" },
    {
      itemId: "wi-2",
      seq: 0,
      title: "",
      boardState: "in_progress",
      resultVersion: 0,
      canAccept: false,
      lastReportKind: null,
      pendingQuestion: null,
      summary: "",
      outcome: null,
      ...ITEM_DEFAULTS,
    },
  ],
  [
    "ill-typed fields",
    { item_id: "wi-3", seq: "3", result_version: "2", can_accept: "yes", title: 5 },
    {
      itemId: "wi-3",
      seq: 0,
      title: "",
      boardState: "in_progress",
      resultVersion: 0,
      canAccept: false,
      lastReportKind: null,
      pendingQuestion: null,
      summary: "",
      outcome: null,
      ...ITEM_DEFAULTS,
    },
  ],
  ["an empty id", { item_id: "" }, undefined],
  ["a number id", { item_id: 7 }, undefined],
  ["no id", {}, undefined],
  ["null", null, undefined],
  ["a string", "wi-1", undefined],
  ["a list", [], undefined],
];

for (const [name, raw, expected] of READ) {
  it(`a work item is read as far as it is well formed and only a true can accept counts (${name})`, () => {
    assert.deepEqual(parseWorkItem(raw), expected);
  });
}
