// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the asker and the committer are told after a review made as the committer (`test_github_review_notice`): the asker is
 * answered where they asked; the committer is told in their own chat whenever something was left on GitHub as them, and not when
 * nothing was; a notice that cannot be delivered is recorded and the asker is told so.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Wrote } from "../../src/review/review-turn.js";
import { githubWrite } from "../../src/turn/github-outcome.js";
import {
  ALICE,
  BOB,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";
import { confirmation } from "./held-world.js";

const DM_A = "personal:aad-a";
const DM_B = "personal:aad-b";

/** What the turn engine keeps of one tool answer (`githubWrite`, `test_github_review.wrote`). */
function wrote(status: string, event = ""): Wrote[] {
  const tool = event ? "mcp__github-review__gh_review_submit" : "mcp__github-review__gh_pr_merge";
  const found = githubWrite(tool, JSON.stringify({ status, ...(event ? { detail: { event } } : {}) }));
  return found === undefined ? [] : [[...found]];
}

const OUTCOMES: Record<string, [Wrote[], string | undefined]> = {
  merged: [[...wrote("submitted", "APPROVE"), ...wrote("merged")], "批准、合入"],
  "comment-only": [wrote("submitted", "COMMENT"), "提交了评论"],
  held: [wrote("confirmation_required"), undefined], // held for Bob: no write, the card is the message
  "not-reviewed": [[], undefined],
};

/** Alice (or `sender`) asks Bob, in the group or in her own chat; the turn ends with `wrote` left on GitHub and `answer`. */
async function askAndEnd(
  world: ReviewWorld,
  origin: "group" | "1:1",
  wrote: readonly Wrote[],
  answer: string,
  sender = ALICE,
): Promise<void> {
  const text = `请 ${origin === "group" ? "{Bob}" : "Bob"} 帮我 review 合入 ${PR}`;
  const message = groupMessage(
    text,
    sender,
    origin === "group" ? [BOB] : [],
    "g1",
    origin === "group" ? "group" : "personal",
  );
  const conversation = world.surface.conversation(message.conversation);
  await world.service.request({
    message,
    text: message.text,
    sender,
    conversation,
    scope: origin === "group" ? CONV : "",
    lang: () => "zh",
  });
  const [turn] = world.started;
  assert.ok(turn, saidIn(world.surface, message.conversation.id));
  turn.review.sessionId = "sess-1";
  await world.service.afterTurn(
    turn.review,
    answer,
    { moved: false, refusal: null, ranModel: "", wrote: [...wrote], prSummary: "" },
    conversation,
  );
}

function breakBobsChat(world: ReviewWorld, how: string): void {
  if (how === "no-reference") {
    // Bob never wrote to the bot in a 1:1 chat, and no chat can be opened
    (world.surface as unknown as { reachable: Set<string> }).reachable = new Set(["aad-a", "aad-c"]);
  } else if (how === "send-fails") {
    const surface = world.surface;
    const open = surface.conversation.bind(surface);
    surface.conversation = (ref) => {
      const conversation = open(ref);
      if (ref.id !== DM_B) return conversation;
      const send = conversation.send.bind(conversation);
      conversation.send = (message) =>
        message.body.type === "text" ? Promise.reject(new Error("Teams refused it")) : send(message);
      return conversation;
    };
  }
}

const notices = (world: ReviewWorld) =>
  world.surface
    .of(DM_B)
    .flatMap((r) => (r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : []))
    .filter((t) => t.includes("请我以你的名义"));

for (const origin of ["group", "1:1"] as const) {
  for (const [outcome, [wrote, done]] of Object.entries(OUTCOMES)) {
    for (const delivery of ["ok", "no-reference", "send-fails"]) {
      test(`the committer hears of what was left on github as them and a notice that fails is said (${origin}, ${outcome}, ${delivery})`, async () => {
        const world = reviewWorld();
        if (outcome === "held") world.claw.confirmations = [confirmation({ actor_user_id: "u-bob" })];
        breakBobsChat(world, delivery);
        const answer =
          outcome === "not-reviewed"
            ? "没能读取这个 PR。\nVERDICT: NOT_REVIEWED"
            : "结论：没有必须修改的问题。\nVERDICT: CLEAN";
        await askAndEnd(world, origin, wrote, answer);
        const askerChat = origin === "group" ? CONV : DM_A;
        const audit = world.store.reviewDelegation.reviewNotices();
        if (done === undefined) {
          assert.deepEqual(notices(world), []);
          assert.deepEqual(audit, []);
          return;
        }
        assert.deepEqual(
          audit.map((a) => a.delivered),
          [delivery === "ok"],
        );
        if (delivery === "ok") {
          const [notice = "", ...more] = notices(world);
          assert.equal(more.length, 0);
          for (const expected of [
            PR,
            "https://github.com/AMD-AGI/Hyperloom/pull/12",
            "Alice",
            done,
            "结论",
            "没有必须修改的问题",
            "（模型：默认模型）",
            "你的确认方式：高风险人工再确认一次（默认）",
            origin === "group" ? "Primus 运维群" : "私聊",
          ]) {
            assert.ok(notice.includes(expected), `${expected} in ${notice}`);
          }
          assert.ok(!saidIn(world.surface, askerChat).includes("未能通知到"));
        } else {
          assert.deepEqual(notices(world), []);
          const why = delivery === "no-reference" ? "TA 还没和 Clawy 私聊过" : "私聊发送失败";
          assert.ok(
            saidIn(world.surface, askerChat).includes(`${PR}：未能通知到 Bob（${why}）`),
            saidIn(world.surface, askerChat),
          );
          assert.equal(audit[0]?.reason, why);
        }
      });
    }
  }
}

for (const [origin, notified] of [
  ["1:1", false],
  ["group", true],
] as const) {
  test(`an asker who is the committer is told once (${origin})`, async () => {
    const world = reviewWorld();
    world.github.defaultAuthor = "carol-gh";
    await askAndEnd(world, origin, wrote("merged"), "没有问题，已合入。\nVERDICT: CLEAN", BOB);
    assert.deepEqual(
      world.started.map((s) => s.turn.actingAs),
      ["u-bob"],
    ); // (the review ran, as Bob)
    const told = notices(world);
    assert.equal(told.length, notified ? 1 : 0, told.join("\n"));
    if (notified) assert.ok(told[0]?.startsWith("你在Primus 运维群请我"), told[0] ?? "");
  });
}

test("a write seen before the stream dropped still brings the notice", async () => {
  const world = reviewWorld();
  await askAndEnd(world, "group", wrote("merged"), "");
  const [notice = "", ...more] = notices(world);
  assert.equal(more.length, 0);
  assert.ok(notice.includes("合入") && notice.includes("没有拿到这次 review 的结论"), notice);
  assert.deepEqual(
    world.store.reviewDelegation.reviewNotices().map((n) => n.delivered),
    [true],
  );
});

for (const origin of ["group", "1:1"] as const) {
  test(`the asker is answered where they asked and only they are mentioned (${origin})`, async () => {
    const world = reviewWorld();
    await askAndEnd(world, origin, wrote("merged"), "没有问题，已合入。\nVERDICT: CLEAN");
    const [turn] = world.started;
    // (the review's one message @mentions the asker in a group, nobody in a 1:1 chat; the reviewer never)
    assert.deepEqual(turn?.turn.mention?.channelUserId, origin === "group" ? "29:a" : undefined);
    const mentioned = world.surface.outbox.flatMap((r) => ("message" in r ? (r.message.mentions ?? []) : []));
    assert.ok(mentioned.every((m) => m.channelUserId !== "29:b"));
  });
}
