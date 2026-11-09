// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A held write answered by typing in the reviewer's 1:1 chat (`test_typed_answer`, the review flow): it decides exactly as a
 * press does, only for the person it waits for, several at once each its own, a question back when it cannot tell which, and a
 * model's reading says whether a message is an answer at all while the rules say what it answers.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntentReader, UserRef } from "../../src/index.js";
import {
  ALICE,
  BOB,
  CONV,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";
import { ClawError, ask, cards, confirmation, decisions, groupText, held, row } from "./held-world.js";

async function says(world: ReviewWorld, text: string, who: UserRef = BOB): Promise<boolean> {
  const dm = world.surface.conversation({
    id: `personal:${who.id}`,
    kind: "personal",
    tenantId: "tenant-1",
    wire: { conversation: { id: `personal:${who.id}` } },
  });
  const handled = await world.service.routeHandlers().personalInterceptors[0]?.intercept({
    message: groupMessage(text, who, [], "t1", "personal"),
    text,
    sender: who,
    conversation: dm,
    scope: "",
    lang: () => "zh",
  });
  return handled === true;
}

const bobDm = (world: ReviewWorld) => saidIn(world.surface, "personal:aad-b");

function second(world: ReviewWorld): void {
  world.store.githubConfirmations.addGithubConfirmation({
    confirmationId: "cf-2",
    sessionId: "sess-1",
    actorId: "aad-b",
    requesterId: "aad-a",
    repo: "AMD-AGI/Hyperloom",
    pr: 13,
    reference: { conversation: { id: CONV } },
    expiresAt: world.store.now() + 3600,
    kind: "merge",
    event: "",
  });
}

test("the reviewer types confirm and the merge is made with their own credential", async () => {
  const world = await held();
  assert.equal(await says(world, "确认 #12"), true);
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-1", "allow"]]);
  assert.ok(bobDm(world).includes("Merged AMD-AGI/Hyperloom#12 (01234567)"), bobDm(world));
  assert.ok(groupText(world).includes("已确认") && groupText(world).includes("已合入"));
  assert.equal(row(world)?.state, "done");
  await says(world, "确认 #12"); // again: nothing waits now, and Claw is not asked twice
  assert.equal(decisions(world).length, 1);
});

test("a refusal typed is a do not merge", async () => {
  const world = await held();
  world.claw.decision = { status: "denied" };
  await says(world, "拒绝 #12");
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-1", "deny"]]);
  assert.ok(groupText(world).includes("选择不合入"));
});

test("only the reviewer can answer by typing", async () => {
  const world = await held();
  await says(world, "确认 #12", ALICE);
  assert.deepEqual(decisions(world), []);
  assert.equal(row(world)?.state, "pending");
});

test("several at once each its own answer", async () => {
  const world = await held();
  second(world);
  await says(world, "#12 可以合，#13 先别合");
  assert.deepEqual(decisions(world).sort(), [
    ["tok-aad-b", "cf-1", "allow"],
    ["tok-aad-b", "cf-2", "deny"],
  ]);
  const text = bobDm(world);
  assert.ok(text.includes("AMD-AGI/Hyperloom#12: Merged") && text.includes("AMD-AGI/Hyperloom#13:"), text);
});

test("several waiting and no number is asked back", async () => {
  const world = await held();
  second(world);
  assert.equal(await says(world, "确认"), true);
  assert.deepEqual(decisions(world), []);
  assert.ok(bobDm(world).includes("在等你确认的有") && bobDm(world).includes("#13"), bobDm(world));
});

test("a typed answer that ran out is not sent to claw", async () => {
  const world = await held();
  world.clock.setEpochMs(Date.UTC(2026, 10, 12, 0, 0, 1));
  await says(world, "确认 #12");
  assert.deepEqual(decisions(world), []);
  assert.ok(bobDm(world).includes("ran out"), bobDm(world));
});

test("when claw cannot be asked it stays open and replying again works", async () => {
  const world = await held();
  world.claw.decision = new ClawError(503);
  await says(world, "确认 #12");
  assert.equal(row(world)?.state, "pending");
  assert.ok(bobDm(world).includes("Reply again in a moment"), bobDm(world));
  world.claw.decision = { status: "merged", merge_sha: "abcdef0123" };
  await says(world, "确认 #12");
  assert.deepEqual(
    decisions(world).map((d) => d[2]),
    ["allow", "allow"],
  );
  assert.ok(bobDm(world).includes("Merged"));
});

function answerReading(intent: string | undefined, asked: unknown[][]): IntentReader {
  return {
    read: () => Promise.resolve(undefined),
    readMode: () => Promise.resolve(undefined),
    readAnswer: (key, text, pending) => {
      asked.push([key, text, pending]);
      return Promise.resolve(intent === undefined ? undefined : { intent });
    },
  };
}

test("the model says whether it is an answer and the rules say what", async () => {
  const asked: unknown[][] = [];
  const none = reviewWorld(["AMD-AGI"], { intent: answerReading("none", asked) });
  await held({}, none);
  assert.equal(await says(none, "确认 #12"), false);
  assert.deepEqual(decisions(none), []);
  assert.deepEqual(asked[0], ["ak-bob-linked", "确认 #12", [{ pull_request: "AMD-AGI/Hyperloom#12", waits: "merge" }]]);
  const answer = reviewWorld(["AMD-AGI"], { intent: answerReading("answer", []) });
  await held({}, answer);
  await says(answer, "我看过了，#12 那个没问题，合吧");
  assert.deepEqual(decisions(answer), [["tok-aad-b", "cf-1", "allow"]]);
});

test("without a reading a message that is not only an answer answers nothing", async () => {
  const world = await held();
  assert.equal(await says(world, "我看过了 #12 那个代码没问题，合吧"), false);
  assert.equal(await says(world, "帮我 review 合入 #12"), false); // (a request to review and merge is never an answer)
  assert.equal(await says(world, "x".repeat(301)), false);
  assert.deepEqual(decisions(world), []);
});

test("the setting is chosen by typing as by a click", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice", "alice-gh");
  assert.equal(await says(world, "确认全自动", ALICE), true);
  assert.deepEqual(
    world.claw.calls.filter((c) => c[0] === "setReviewMode"),
    [["setReviewMode", "tok-aad-a", "fully_auto"]],
  );
  assert.ok(
    saidIn(world.surface, "personal:aad-a").includes("已改为：全自动合入"),
    saidIn(world.surface, "personal:aad-a"),
  );
});

test("a typed choice before github is connected says how", async () => {
  const world = reviewWorld();
  world.identity.know("aad-a", "u-alice"); // no GitHub binding
  assert.equal(await says(world, "确认全自动", ALICE), true);
  assert.deepEqual(
    world.claw.calls.filter((c) => c[0] === "setReviewMode"),
    [],
  );
  assert.ok(saidIn(world.surface, "personal:aad-a").includes("/github bind"), saidIn(world.surface, "personal:aad-a"));
});

test("until a click has arrived the card says how to answer by typing", async () => {
  const world = await held();
  const [card] = cards(world, "personal:aad-b");
  assert.equal(card?.hint, true); // ("直接回复「确认 #12」或「拒绝 #12」即可" on the card)
  assert.equal(card.installUrl, ""); // (no Add button: no link configured)
  assert.equal(world.store.members.clickedPersonally("aad-b"), false);
  world.store.members.notePersonalClick("aad-b"); // (any click from the 1:1 chat proves it can click)
  world.claw.confirmations = [confirmation({ id: "cf-2" })]; // (a second hold on the same pull request, from a second review)
  await ask(world, "g2");
  const later = cards(world, "personal:aad-b").at(-1);
  assert.equal(later?.hint, false);
});

test("with an install link the card carries the add button", async () => {
  const world = reviewWorld();
  (world.deps as { installUrl: string }).installUrl =
    "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-0000000000a1";
  await held({}, world);
  assert.equal(cards(world, "personal:aad-b")[0]?.installUrl, world.deps.installUrl);
});

test("a pull request held for a merge and a review is asked which", async () => {
  const world = await held();
  world.store.githubConfirmations.addGithubConfirmation({
    confirmationId: "cf-r",
    sessionId: "sess-1",
    actorId: "aad-b",
    requesterId: "aad-a",
    repo: "AMD-AGI/Hyperloom",
    pr: 12,
    reference: { conversation: { id: CONV } },
    expiresAt: world.store.now() + 3600,
    kind: "review",
    event: "REQUEST_CHANGES",
  });
  await says(world, "确认 #12");
  assert.deepEqual(decisions(world), []);
  assert.ok(bobDm(world).includes("有两项在等你确认"), bobDm(world));
  await says(world, "确认 #12 review");
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-r", "allow"]]);
  assert.equal(row(world)?.state, "pending");
});

test("a pull request held twice for a merge is answered for the newest", async () => {
  const world = await held();
  await world.clock.advance(5000);
  world.clock.setEpochMs(world.clock.epochMs() + 5000);
  world.store.githubConfirmations.addGithubConfirmation({
    confirmationId: "cf-new",
    sessionId: "sess-1",
    actorId: "aad-b",
    requesterId: "aad-a",
    repo: "AMD-AGI/Hyperloom",
    pr: 12,
    reference: { conversation: { id: CONV } },
    expiresAt: world.store.now() + 3600,
    kind: "merge",
    event: "",
  });
  await says(world, "确认 #12");
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-new", "allow"]]);
  assert.equal(row(world)?.state, "pending");
});

const REVIEW_AND_MERGE = [
  "请linmei帮我review合入AMD-AGI/Hyperloom#12",
  "请 linmei 帮我 review 合入 AMD-AGI/Hyperloom#12",
  "请linmei帮我review合并AMD-AGI/Hyperloom#12",
  "请 linmei 帮我 review 合并 AMD-AGI/Hyperloom#12",
  "请linmei帮我评审并合并AMD-AGI/Hyperloom#12",
  "Bob，麻烦 review 后合并 AMD-AGI/Hyperloom#12",
  "Please review and merge AMD-AGI/Hyperloom#12",
  "please review & merge AMD-AGI/Hyperloom#12",
  "Bob, review, merge AMD-AGI/Hyperloom#12",
  "Bob please review+merge AMD-AGI/Hyperloom#12",
  "merge AMD-AGI/Hyperloom#12 after Bob reviews it, ok",
  "Bob 帮我 review 一下 AMD-AGI/Hyperloom#12，没问题就合了吧",
];

REVIEW_AND_MERGE.forEach((text, i) => {
  test(`a request to review and merge is never an answer even with a reading that says so (ask ${String(i)})`, async () => {
    const world = reviewWorld(["AMD-AGI"], { intent: answerReading("answer", []) });
    await held({}, world);
    assert.equal(await says(world, text), false);
    assert.deepEqual(decisions(world), []);
    assert.equal(row(world)?.state, "pending");
  });
});
