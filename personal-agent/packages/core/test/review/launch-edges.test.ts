// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Starting the turns of a request when one cannot be started (`github_review.py`'s `_start_admitted`): one of several that
 * does not start is said and the others go on; an item of one's own that started in Claw but cannot be followed here says
 * where its result is; an asker whose own chat cannot be opened gets no item card, and the reviews go on.
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

const PR2 = "AMD-AGI/Hyperloom#13";

async function ask(world: ReviewWorld, text: string): Promise<void> {
  const message = groupMessage(text, ALICE, [ALICE, { id: "aad-b", channelUserId: "29:b", name: "Bob", email: "" }]);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

function failingTurns(world: ReviewWorld, fails: (n: number) => boolean): void {
  const host = world.deps.host as { startTurn: ReviewWorld["deps"]["host"]["startTurn"] };
  const real = host.startTurn.bind(host);
  let n = 0;
  host.startTurn = (request) => {
    n += 1;
    return fails(n) ? Promise.reject(new RangeError("boom")) : real(request);
  };
}

test("one of several that does not start is said and the others go on", async () => {
  const world = reviewWorld();
  failingTurns(world, (n) => n === 2);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR} ${PR2}`);
  assert.equal(world.started.length, 1);
  assert.ok(
    saidIn(world.surface, CONV).includes(`${PR2} 没有开始：我这边出了问题。需要的话请单独再发一次。`),
    saidIn(world.surface, CONV),
  );
});

test("an item of ones own that cannot be followed here says where its result is", async () => {
  const world = reviewWorld();
  withItems(world);
  world.store.members.rememberMember("29:a", "aad-a", "Alice");
  world.identity.know("aad-a", "u-alice", "alice-gh", true);
  world.github.defaultAuthor = "carol-gh";
  failingTurns(world, () => true);
  await ask(world, `请 {Alice} 帮我 review 合入 ${PR}`);
  assert.ok(
    saidIn(world.surface, CONV).includes(`${PR} 已经开始，但我这边没能跟进它的进展；结果在任务卡片上看。`),
    saidIn(world.surface, CONV),
  );
});

test("an asker whose own chat cannot be opened gets no item card and the review goes on", async () => {
  const world = reviewWorld();
  withItems(world);
  (world.surface as unknown as { reachable: Set<string> }).reachable = new Set(["aad-b"]);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.deepEqual(world.surface.of("personal:aad-a"), []);
  assert.equal(world.claw.calls.filter((c) => c[0] === "startReviews").length, 1);
  assert.ok(saidIn(world.surface, CONV).includes("收到"));
});
