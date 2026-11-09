// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What waits for a reviewer reaches them (`test_reviewer_reach`, the review service's part): when what waits for the reviewer
 * cannot reach their chat the asker is told so, and why, in the same reply; and when the reviewer's item waits for them, their
 * message carries what it asks (read as them) and the card whose buttons answer it, or the reply that answers it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError, type Conversation, type WorkItem } from "../../src/index.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  settleFollows,
  withItems,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const PR2 = "AMD-AGI/Hyperloom#13";
const NO_CHAT = "no_chat";
const NO_SUBSCRIPTION = "no_subscription";

/** The items world whose host says whether Bob can be reached (`reach_world`). */
function reachWorld(why: string | undefined): { world: ReviewWorld; asked: string[] } {
  const world = reviewWorld();
  withItems(world);
  const asked: string[] = [];
  if (why !== undefined)
    (world.deps.host as { reviewerReach?: (id: string) => Promise<string> }).reviewerReach = (id) => {
      asked.push(id);
      return Promise.resolve(why);
    };
  return { world, asked };
}

async function ask(world: ReviewWorld, text: string): Promise<void> {
  const message = groupMessage(text);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

test("the asker hears in the same reply that bob cannot be reached and why", async () => {
  const { world, asked } = reachWorld(NO_CHAT);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.deepEqual(asked, ["aad-b"]);
  const said = world.surface
    .of(CONV)
    .flatMap((r) => (r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : []));
  const notes = said.filter((t) => t.includes("收不到"));
  assert.equal(notes.length, 1, said.join("\n---\n"));
  const [note = ""] = notes;
  assert.ok(note.includes("Bob 现在收不到") && note.includes("TA 还没在私聊里和我说过话"), note);
  assert.ok(note.includes("打开和我的私聊") && note.includes("以 Bob 的身份"), note); // (the one reply that says it started)
});

test("with several pull requests the note is in the one reply that lists them", async () => {
  const { world } = reachWorld(NO_SUBSCRIPTION);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR} ${PR2}`);
  const replies = saidIn(world.surface, CONV)
    .split("收到")
    .filter((t) => t.includes("同时"));
  assert.equal(replies.length, 1, saidIn(world.surface, CONV));
  const [reply = ""] = replies;
  assert.ok(reply.includes("Bob 现在收不到") && reply.includes("通知订阅还没开通"), reply);
});

test("a reviewer who can be reached brings no note", async () => {
  const { world, asked } = reachWorld("");
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.deepEqual(asked, ["aad-b"]);
  assert.ok(!saidIn(world.surface, CONV).includes("收不到"));
});

test("without a way to tell, nothing is checked and nothing is said", async () => {
  const { world } = reachWorld(undefined);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.ok(!saidIn(world.surface, CONV).includes("收不到"));
});

function bobsItem(itemId: string): WorkItem {
  return {
    itemId,
    seq: 1,
    title: `Review ${PR}`,
    boardState: "needs_you",
    resultVersion: 2,
    canAccept: true,
    lastReportKind: null,
    pendingQuestion: "审完没有问题，合入 AMD-AGI/Hyperloom#12 吗？",
    summary: "",
    outcome: null,
    kind: "review",
    params: {},
    pull: null,
    updatedAt: "",
  };
}

/** Bob's item waits for him, then ends; the work cards the assistant's line would post are recorded. */
function waitingWorld(itemError?: Error) {
  const posted: [string, string, WorkItem, string][] = [];
  const world = reviewWorld(["AMD-AGI"], {
    postWorkCard: (conversation: Conversation, owner, item, text) => {
      posted.push([conversation.ref.id, owner, item, text]);
      return Promise.resolve();
    },
  });
  withItems(world, { seqFrom: 1 });
  world.claw.workItem = (_key, itemId) => {
    if (itemError !== undefined) throw itemError;
    return bobsItem(itemId);
  };
  world.claw.views.set("item-1", [
    { status: "waiting_for_reviewer", waitingFor: "confirm_merge", verdict: "approve" },
    { status: "done", verdict: "approve", merged: true },
  ]);
  return { world, posted };
}

test("bob hears what his item asks with a card whose buttons answer it", async () => {
  const { world, posted } = waitingWorld();
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await settleFollows(world);
  const bob = saidIn(world.surface, "personal:aad-b");
  assert.equal(bob.split("在等你确认").length - 1, 1, bob);
  assert.ok(bob.includes("审完没有问题，合入 AMD-AGI/Hyperloom#12 吗？"), bob);
  const waiting = world.surface
    .of("personal:aad-b")
    .flatMap((r) => (r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : []))
    .filter((t) => t.includes("在等你确认"));
  assert.equal(waiting.length, 1);
  const [one = ""] = waiting;
  assert.ok(one.includes("「批准 #1」") && !one.includes("/board"), one); // (no longer only "send /board")
  // read as Bob, with his own key
  assert.deepEqual(
    world.claw.calls.filter((c) => c[0] === "workItem").map((c) => c.slice(1)),
    [["ak-bob-linked", "item-1"]],
  );
  assert.deepEqual(
    posted.map(([where, owner, item, text]) => [where, owner, item.itemId, text]),
    [["personal:aad-b", "aad-b", "item-1", "审完没有问题，合入 AMD-AGI/Hyperloom#12 吗？"]],
  );
});

test("when bobs item cannot be read as him he still hears how to answer", async () => {
  const { world, posted } = waitingWorld(new ClawError(503));
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await settleFollows(world);
  const bob = saidIn(world.surface, "personal:aad-b");
  assert.equal(bob.split("在等你确认").length - 1, 1, bob);
  assert.ok(bob.includes("直接回复「批准 #1」确认"), bob);
  assert.deepEqual(posted, []);
});
