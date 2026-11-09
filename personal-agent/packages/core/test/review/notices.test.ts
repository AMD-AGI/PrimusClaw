// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the people a review needs are told (`github_review.py`'s notices): the reviewer that a review only was asked of them;
 * a reviewer without GitHub, once a day, and the asker where they asked, also when no 1:1 chat can be opened; an asker
 * without a key of their own, in a 1:1 chat, that the steps are right above.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  withItems,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

async function ask(world: ReviewWorld, text: string, kind: "group" | "personal" = "group"): Promise<void> {
  const message = groupMessage(text, ALICE, kind === "group" ? undefined : [], "g1", kind);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: kind === "group" ? CONV : "",
    lang: () => "zh",
  });
}

test("the reviewer hears that only a review was asked of them", async () => {
  const world = reviewWorld();
  withItems(world, { seqFrom: 4 });
  await ask(world, `请 {Bob} 帮我 review ${PR}`);
  const bob = saidIn(world.surface, "personal:aad-b");
  assert.ok(
    bob.includes(`Alice在Primus 运维群请你代 review（只 review，不合入） ${PR}，已作为你看板上的事项开始（事项 #4）`),
    bob,
  );
  assert.ok(!bob.includes("合入前会先请你确认"));
});

test("a reviewer without github who cannot be reached is asked for where the request was made", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", null);
  (world.surface as unknown as { reachable: Set<string> }).reachable = new Set(["aad-a"]);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  const said = saidIn(world.surface, CONV);
  assert.ok(
    said.includes("Bob 还没有绑定 GitHub，我没能私信 Bob；请 Bob 在 1:1 里给我发 `/github bind`，之后你再 @ 我一次。"),
    said,
  );
  assert.equal(world.started.length, 0);
});

test("in a 1:1 chat a reviewer without github is asked for with send it again", async () => {
  const world = reviewWorld();
  world.identity.know("aad-b", "u-bob", null);
  await ask(world, `请 Bob 帮我 review 合入 ${PR}`, "personal");
  const said = saidIn(world.surface, "personal:aad-a");
  assert.ok(said.includes("Bob 还没有绑定 GitHub，我已私信 TA 说明绑定方式；绑定后请再发一次。"), said);
  const bob = saidIn(world.surface, "personal:aad-b");
  assert.ok(bob.includes("Alice asked me to review and merge") && !bob.includes("in a group chat"), bob);
});

test("in a 1:1 chat an asker without a key is told the steps are right above", async () => {
  const world = reviewWorld();
  world.store.links.unlink("aad-a");
  world.store.references.saveReference("aad-a", { conversation: { id: "personal:aad-a" } });
  await ask(world, `请 Bob 帮我 review 合入 ${PR}`, "personal");
  const said = saidIn(world.surface, "personal:aad-a");
  assert.ok(said.includes("连接方式见上；完成后请再发一次。"), said);
  assert.ok(world.said.askLink.some((s) => s.startsWith("aad-a:You asked me to have a colleague review and merge")));
});

test("a reviewer whose chat refuses the notice does not stop the review", async () => {
  const world = reviewWorld();
  withItems(world);
  const surface = world.surface;
  const open = surface.conversation.bind(surface);
  surface.conversation = (ref) => {
    const conversation = open(ref);
    if (ref.id === "personal:aad-b") conversation.send = () => Promise.reject(new Error("Teams refused it"));
    return conversation;
  };
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.equal(world.claw.calls.filter((c) => c[0] === "startReviews").length, 1);
  assert.ok(saidIn(world.surface, CONV).includes("收到"), saidIn(world.surface, CONV));
});
