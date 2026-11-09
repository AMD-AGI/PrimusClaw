// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant for some people only (ASSISTANT_USERS), a result that needs no acceptance said as a plain message (`needs_accept`),
 * and the plugin named on a message to the assistant (tests/test_assistant_users.py).
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, AssistantWorld, BOB } from "../../../../test-support/assistant/assistant-world.js";
import { workItem } from "../../../../test-support/assistant/work-items.js";
import { modelOf, viewsOf } from "../../../../test-support/assistant/view-of.js";
import { openTestStore } from "../../../../test-support/store.js";
import { SayPlanner, type SayStore } from "../../src/assistant/say.js";
import { APPROVALS_TYPES_VERSION } from "../../src/subscriptions/event-types.js";
import { clicksWorld } from "./clicks-world.js";

const APPROVAL_SUBSCRIPTION_TYPES = [
  "run.completed",
  "run.failed",
  "assistant.say",
  "work_item.needs_you",
  "approval.requested",
];

function typesOf(w: AssistantWorld): Record<string, string[]> {
  return Object.fromEntries([...w.subsClaw.rows.values()].map((r) => [r.owner, r.event_types]));
}

it("with a list only the people listed talk to the assistant and the others keep their sessions", async () => {
  const w = await AssistantWorld.start({ users: ["AAD-A".toLowerCase()] }); // (the ids are matched without regard to case)
  await w.link(BOB);
  await w.say("from alice", ALICE);
  await w.say("from bob", BOB);
  await w.say("/board", BOB);
  assert.deepEqual([w.heard(), w.started], [["from alice"], ["from bob", "/board"]]);
  assert.deepEqual(
    w.claw.heard.map((h) => h.key),
    ["ak-alice"],
  );
  assert.equal(w.claw.calls.filter((c) => c === "session").length, 1);
  assert.deepEqual(typesOf(w), { "ak-alice": APPROVAL_SUBSCRIPTION_TYPES, "ak-bob": ["run.completed", "run.failed"] });
  assert.deepEqual(
    [w.store.notifySubs.notifyTypesVersion(ALICE), w.store.notifySubs.notifyTypesVersion(BOB)],
    [APPROVALS_TYPES_VERSION, 0],
  );
  assert.deepEqual([w.chat.on(ALICE), w.chat.on(BOB)], [true, false]);
});

it("someone taken off the list goes back to sessions though their subscription still has the types", async () => {
  const w = await AssistantWorld.start({ users: ["aad-a"] });
  await w.link(BOB);
  w.store.notifySubs.setNotifyTypesVersion(BOB, APPROVALS_TYPES_VERSION); // (as it was left when the assistant was on for him)
  await w.say("from bob", BOB);
  assert.deepEqual([w.heard(), w.started, w.chat.on(BOB)], [[], ["from bob"], false]);
});

it("a subscription of someone not listed is not mended for the assistant", async () => {
  const w = await AssistantWorld.start({ assistant: false, users: ["aad-a"], link: false });
  await w.link(BOB); // made before, with the base types
  w.turn(true);
  w.advance(3600);
  await w.subs?.ensure(BOB);
  assert.deepEqual(typesOf(w), { "ak-bob": ["run.completed", "run.failed"] });
  assert.equal(w.store.notifySubs.notifyTypesVersion(BOB), 0);
});

it("an empty list is everybody as before", async () => {
  const w = await AssistantWorld.start({ users: [] });
  await w.link(BOB);
  await w.say("from alice", ALICE);
  await w.say("from bob", BOB);
  assert.deepEqual(w.heard(), ["from alice", "from bob"]);
});

it("a person the assistant is not on for is never understood by it", async () => {
  const w = await AssistantWorld.start({ understanding: ["aad-a", "aad-b"], users: ["aad-a"] });
  assert.deepEqual([w.chat.understands(ALICE), w.chat.understands(BOB)], [true, false]);
});

/** A planner on a real store, recording the work cards it records. */
function planner() {
  const { store } = openTestStore();
  const recorded: string[] = [];
  const cards = store.assistantCards;
  const assistantCards = new Proxy(cards, {
    get(target, prop, receiver) {
      if (prop === "addAssistantCard") {
        return (...args: Parameters<typeof cards.addAssistantCard>) => {
          recorded.push(args[1]);
          return target.addAssistantCard(...args);
        };
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
  const sayStore: SayStore = { prefs: store.prefs, assistantCards, assistantButtons: store.assistantButtons };
  const say = new SayPlanner({
    store: sayStore,
    exactCommand: () => false,
    style: () => ({ citations: true, suggestedReplies: true }),
  });
  return { say, recorded };
}

function item(title: string, needsAccept: boolean | undefined) {
  return {
    item_id: `it-${title}`,
    seq: 1,
    title,
    board_state: "needs_you",
    result_version: 1,
    can_accept: true,
    last_report_kind: "ready",
    ...(needsAccept === undefined ? {} : { needs_accept: needsAccept }),
  };
}

it("a result that needs no acceptance is a plain message with nothing to press", () => {
  const { say, recorded } = planner();
  const out = say.messages(ALICE, {
    type: "assistant.say",
    text: "FleetPilot has 12 nodes, 11 of them ready.",
    item: item("How many nodes", false),
  });
  assert.deepEqual(viewsOf(out), []);
  assert.equal(out.length, 1);
  assert.ok(out[0]?.body.type === "rich" && out[0].body.markdown.includes("12 nodes"));
  assert.deepEqual(recorded, [], "nothing recorded to press");
});

it("a result that needs acceptance or says nothing about it is the card with accept", () => {
  for (const needs of [true, undefined]) {
    const { say, recorded } = planner();
    const out = say.messages(ALICE, {
      type: "assistant.say",
      text: "PR #12 is open.",
      item: item(`Open the PR ${String(needs)}`, needs),
    });
    const model = modelOf(viewsOf(out)[0], "workCard");
    assert.deepEqual([model.item.canAccept, model.item.resultVersion], [true, 1]);
    assert.deepEqual(recorded, [`it-Open the PR ${String(needs)}`]);
  }
});

it("on the board a result that needs no acceptance has no accept", async () => {
  const w = clicksWorld();
  // (Claw's `needs_accept` false, as the board reads it: the item cannot be accepted)
  w.claw.add(workItem({ itemId: "n1", title: "How many nodes", canAccept: false, lastReportKind: "ready" }));
  w.claw.add(workItem({ itemId: "n2", title: "And workloads", canAccept: false, lastReportKind: "ready" }));
  await w.board.show(ALICE, "ak", w.conversation);
  const shown = w.surface.outbox.flatMap((r) =>
    r.op === "send" && r.message.body.type === "view" ? [r.message.body.view] : [],
  );
  assert.deepEqual(
    shown.map((v) => v.name),
    ["board", "workCard", "workCard"],
  );
  assert.deepEqual(modelOf(shown[0], "board").accept, []);
  for (const card of shown.slice(1)) assert.equal(modelOf(card, "workCard").item.canAccept, false);
});

it("a message the assistant understands carries the plugin too", async () => {
  const w = await AssistantWorld.start({ pluginId: 9, understanding: ["aad-a"] });
  const taken = await w.chat.understand({
    userId: ALICE,
    credential: "ak-alice",
    modelKey: "",
    prompt: "fleetpilot现在有几台节点",
    context: { channel_message_id: "m-1" },
    lang: "zh",
    conversation: w.conversation(),
    files: [],
  });
  assert.equal(taken, true);
  const [heard] = w.claw.heard;
  assert.equal(heard?.plugin, 9);
  assert.deepEqual(heard.context, { channel_message_id: "m-1" });
});
