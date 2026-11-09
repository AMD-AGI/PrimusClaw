// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a review Claw makes as an item is followed here (`test_review_items`, continued): one of the asker's own is followed in its
 * session with or without the id of its first turn and its card ends with that turn; one asked of someone else never starts a
 * turn here and its conclusion @mentions the asker in a group only; an answer that cannot be followed starts nothing; a turn that
 * cannot be followed is said once per item; a request refused whole with an internal message says only a reference.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PublicErrorLog, ReviewsRefused, type ReviewTurn } from "../../src/index.js";
import { parseStartedReviews } from "../../src/claw/started-review.js";
import { renderHelp } from "../../src/capabilities/help.js";
import { ownItemEndText } from "../../src/review/progress.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { SeededRandom } from "../../../../test-support/random.js";
import {
  ALICE,
  ALICE_DM,
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
const DONE = {
  status: "done",
  prUrl: "https://github.com/AMD-AGI/Hyperloom/pull/12",
  verdict: "approve",
  merged: true,
};
const TARGET = { owner: "AMD-AGI", repo: "Hyperloom", number: 12 };

function itemsWorld(): ReviewWorld {
  const world = reviewWorld();
  withItems(world, { seqFrom: 1 });
  return world;
}

async function ask(world: ReviewWorld, text: string, kind: "group" | "personal" = "group", id = "g1"): Promise<void> {
  const message = groupMessage(text, ALICE, undefined, id, kind);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: kind === "group" ? CONV : "",
    lang: () => "zh",
  });
}

/** Alice asks a review of herself (her own account, her own key). */
async function askSelf(world: ReviewWorld, text: string): Promise<void> {
  world.store.members.rememberMember("29:a", "aad-a", "Alice");
  world.identity.know("aad-a", "u-alice", "alice-gh", true);
  world.github.defaultAuthor = "carol-gh"; // (pull requests Alice did not write)
  const message = groupMessage(text, ALICE, [ALICE]);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const groupText = (world: ReviewWorld) => saidIn(world.surface, CONV);
const bodies = (world: ReviewWorld) => world.claw.calls.filter((c) => c[0] === "startReviews");
const itemCards = (world: ReviewWorld) =>
  world.surface
    .of(ALICE_DM)
    .filter((r) => r.op === "post" && r.message.body.type === "view" && r.message.body.view.name === "reviewItem");
/** The messages in that chat whose text holds `words`, with whom each @mentions. */
const linesWith = (world: ReviewWorld, conversation: string, words: string) =>
  world.surface
    .of(conversation)
    .flatMap((r) =>
      "message" in r && r.message.body.type === "text" && r.message.body.text.includes(words)
        ? [{ text: r.message.body.text, mentions: (r.message.mentions ?? []).map((m) => m.id) }]
        : [],
    );

for (const [name, messageId] of [
  ["without the id of its first turn", ""],
  ["with the id of its first turn", "claw-pending-7"],
] as const) {
  test(`a review of oneself is followed ${name}`, async () => {
    const world = reviewWorld();
    withItems(world, { seqFrom: 1 });
    const starts = world.claw.starts;
    world.claw.starts = (token, request) => (starts?.(token, request) ?? []).map((s) => ({ ...s, messageId }));
    await askSelf(world, `请 {Alice} 帮我 review 合入 ${PR}`);
    const [turn] = world.started;
    assert.ok(turn !== undefined);
    // (followed in the item's own session, from its first turn or from the turn Claw named)
    assert.deepEqual([turn.turn.attach, turn.turn.attachMessageId, turn.review.sessionId], [true, messageId, "s-1"]);
    const answer = turn.turn.shapeAnswer("没有发现必须修改的问题。\nVERDICT: CLEAN", "", "", [], 0, "");
    assert.ok(answer.includes("没有发现必须修改的问题") && !answer.includes("QUEUED"), answer);
  });
}

test("in a one to one chat the card comes in that chat", async () => {
  const world = itemsWorld();
  await ask(world, `请 Bob 帮我 review 合入 ${PR}`, "personal", "d1");
  assert.equal(bodies(world).length, 1);
  assert.equal(itemCards(world).length, 1);
  assert.ok(saidIn(world.surface, ALICE_DM).includes("点下面卡片上的「停止」"), saidIn(world.surface, ALICE_DM));
});

test("this workers memory no longer decides whether claw is asked", async () => {
  // (a pull request this worker already followed once: with review items, only Claw says whether it is under review)
  const world = itemsWorld();
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`, "group", "g2");
  assert.equal(bodies(world).length, 2);
  assert.ok(!groupText(world).includes("已经在 review 中"), groupText(world));
});

for (const [name, raw] of [
  ["no-pull", { item_id: "item-1" }],
  ["no-item", { pr: TARGET }],
] as const) {
  test(`an answer the client cannot follow starts nothing here (${name})`, async () => {
    const world = itemsWorld();
    world.claw.starts = (_token, request) => parseStartedReviews({ items: [raw] }, !request.actingToken);
    await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
    assert.deepEqual(world.started, []);
    assert.ok(groupText(world).includes("不确定 review 是否已经开始"), groupText(world));
  });
}

test("a review of oneself without its session is not followed blind", async () => {
  const world = itemsWorld();
  world.claw.starts = (_token, request) =>
    parseStartedReviews({ items: [{ item_id: "item-1", pr: TARGET }] }, !request.actingToken);
  await askSelf(world, `请 {Alice} 帮我 review 合入 ${PR}`);
  assert.deepEqual(world.started, []);
  assert.ok(groupText(world).includes("不确定 review 是否已经开始"), groupText(world));
});

test("a review alice asks of herself closes its card when its turn ends", async () => {
  const world = itemsWorld();
  await askSelf(world, `请 {Alice} 帮我 review 合入 ${PR}`);
  const [turn] = world.started;
  assert.ok(turn !== undefined);
  const [cardId] = world.surface.of(ALICE_DM).flatMap((r) => (r.op === "post" ? [r.id] : []));
  assert.ok(cardId !== undefined);
  assert.deepEqual(
    world.surface.of(ALICE_DM).filter((r) => r.op === "update"),
    [],
  );
  turn.ended();
  await world.service.idle();
  const edits = world.surface
    .of(ALICE_DM)
    .flatMap((r) =>
      r.op === "update" && r.message.body.type === "view" ? [{ id: r.id, view: r.message.body.view }] : [],
    );
  assert.equal(edits.length, 1);
  const [edit] = edits;
  assert.ok(edit !== undefined);
  assert.equal(edit.id, cardId); // (the card it was, edited where it was posted)
  assert.equal(edit.view.name, "endedItem"); // (no Stop left on it)
  assert.ok((edit.view.model as { ended: string }).ended.includes("已结束"));
  // (a late Stop finds the card ended: nothing open is left for that item)
  assert.equal(world.store.assistantCards.placedAssistantCards({ itemId: "item-1" }).length, 0);
});

test("the conclusion in the group mentions the asker and nobody else", async () => {
  const world = itemsWorld();
  world.claw.views.set("item-1", DONE);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await settleFollows(world);
  const [line, ...more] = linesWith(world, CONV, "代审）：");
  assert.equal(more.length, 0);
  assert.ok(line !== undefined);
  assert.ok(line.text.includes("（Bob 代审）：结论：批准，已合入"), line.text);
  assert.deepEqual(line.mentions, [ALICE.id]);
});

test("the conclusion in a one to one chat mentions nobody", async () => {
  const world = itemsWorld();
  world.claw.views.set("item-1", DONE);
  await ask(world, `请 Bob 帮我 review 合入 ${PR}`, "personal", "d1");
  await settleFollows(world);
  const [line, ...more] = linesWith(world, ALICE_DM, "代审）：");
  assert.equal(more.length, 0);
  assert.ok(line !== undefined);
  assert.ok(!line.text.includes("<at>"), line.text);
  assert.deepEqual(line.mentions, []);
});

test("own item end text reads what the turn left on github", () => {
  const of = (wrote: ReviewTurn["wrote"]) => ownItemEndText({ wrote } as ReviewTurn);
  assert.equal(
    of([
      ["gh_review_submit", "submitted", "APPROVE"],
      ["gh_pr_merge", "merged", ""],
    ]),
    "已结束：结论：批准，已合入",
  );
  assert.equal(of([["gh_review_submit", "submitted", "REQUEST_CHANGES"]]), "已结束：结论：要求修改，没有合入");
  assert.equal(of([]), "已结束，结果见回答");
});

test("help says how a review is stopped", () => {
  for (const group of [false, true]) {
    const text = renderHelp("zh", { group, parts: new Set(["github"] as const) });
    assert.ok(text.includes("点「停止」随时停下"), text);
  }
});

test("an item that cannot be followed is said once", async () => {
  const world = itemsWorld();
  (world.deps.host as { startTurn: typeof world.deps.host.startTurn }).startTurn = () =>
    Promise.reject(new Error("no"));
  await askSelf(world, `请 {Alice} 帮我 review 合入 ${PR} ${PR2}`);
  assert.equal(groupText(world).split("已经开始，但我这边没能跟进").length - 1, 2, groupText(world)); // one per item
});

test("a review asked of someone else never starts a followed turn", async () => {
  const world = itemsWorld();
  world.claw.views.set("item-1", DONE);
  (world.deps.host as { startTurn: typeof world.deps.host.startTurn }).startTurn = () =>
    Promise.reject(new Error("a turn was started for Bob's item"));
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await settleFollows(world);
  assert.ok(groupText(world).includes("代审）：结论：批准"), groupText(world));
});

const INTERNAL = "upstream http://litellm-proxy.primus-safe.svc.cluster.local:4000 (10.42.7.19) refused";

test("a request refused as a whole with an internal message says only a reference", async () => {
  const world = itemsWorld();
  const logger = new RecordingLogger();
  (world.deps as { errors: unknown }).errors = new PublicErrorLog(logger, new SeededRandom(1));
  world.claw.refuseAll = new ReviewsRefused(400, "invalid_request", INTERNAL, {});
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR} ${PR2}`);
  const text = groupText(world);
  assert.match(text, /PrimusClaw 没有接受这次 review 请求（an internal error \(?ref [0-9a-f]{8}/);
  assert.ok(!text.includes("svc.cluster.local") && !text.includes("10.42.7.19"), text);
  assert.ok(logger.dump().includes("10.42.7.19")); // (kept in the log under the reference)
});
