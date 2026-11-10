// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a request's pull requests and reviewer are read (`github_review.py`'s `_bare_pulls`, `_repo_named`, `_read`): a number
 * with two repositories written is asked about; a name GitHub cannot be asked about with several owners is asked about; a
 * repository GitHub named once is not asked again; a model's reading Clawy cannot use is read by the rules instead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntentReader } from "../../src/index.js";
import {
  ALICE,
  BOB,
  CONV,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

async function ask(world: ReviewWorld, text: string, id = "g1"): Promise<void> {
  const message = groupMessage(text, ALICE, [BOB], id);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const targets = (w: ReviewWorld) =>
  w.started.map(
    (s) => `${s.turn.reviewTarget.owner}/${s.turn.reviewTarget.repo}#${String(s.turn.reviewTarget.number)}`,
  );

test("a bare number with two repositories written is asked about", async () => {
  const world = reviewWorld();
  await ask(world, "请 {Bob} 帮我 review 合入 AMD-AGI/Hyperloom#12 AMD-AGI/PrimusClaw#3 和 #245");
  assert.equal(world.started.length, 0);
  assert.ok(
    saidIn(world.surface, CONV).includes(
      "这条消息里有不止一个仓库（AMD-AGI/Hyperloom、AMD-AGI/PrimusClaw），是哪个仓库的 #245？",
    ),
    saidIn(world.surface, CONV),
  );
});

test("a repository name github cannot be asked about with several owners is asked about", async () => {
  const world = reviewWorld(["AMD-AGI", "ROCm"]);
  world.github.reply = { status: 403, body: { message: "API rate limit exceeded" } };
  await ask(world, "请 {Bob} 帮我 review 合入 PrimusClaw PR 245");
  assert.equal(world.started.length, 0);
  assert.ok(
    saidIn(world.surface, CONV).includes("我暂时没能向 GitHub 确认「PrimusClaw」是哪个仓库"),
    saidIn(world.surface, CONV),
  );
});

test("a repository github named once is not asked about again", async () => {
  const world = reviewWorld();
  await ask(world, "请 {Bob} 帮我 review 合入 PrimusClaw PR 245");
  world.started[0]?.ended();
  await Promise.resolve();
  const reads = world.github.reads.filter((p) => p.split("/").length === 4).length;
  await ask(world, "请 {Bob} 帮我 review 合入 PrimusClaw PR 246", "g2");
  assert.deepEqual(targets(world), ["AMD-AGI/PrimusClaw#245", "AMD-AGI/PrimusClaw#246"]);
  assert.equal(world.github.reads.filter((p) => p.split("/").length === 4).length, reads);
});

test("a model reading clawy cannot use is read by the rules instead", async () => {
  const intent: IntentReader = {
    read: () => Promise.resolve({ intent: "maybe" }),
    readMode: () => Promise.resolve(undefined),
    readAnswer: () => Promise.resolve(undefined),
  };
  const world = reviewWorld(["AMD-AGI"], { intent });
  await ask(world, "请 {Bob} 帮我 review 合入 AMD-AGI/Hyperloom#12");
  assert.deepEqual(targets(world), ["AMD-AGI/Hyperloom#12"]);
});

test("a model that gives no reading in time leaves the request to the rules", async () => {
  const intent: IntentReader = {
    read: () => Promise.resolve(undefined),
    readMode: () => Promise.resolve(undefined),
    readAnswer: () => Promise.resolve(undefined),
  };
  const world = reviewWorld(["AMD-AGI"], { intent });
  await ask(world, "请 {Bob} 帮我 review 合入 AMD-AGI/Hyperloom#12");
  assert.deepEqual(targets(world), ["AMD-AGI/Hyperloom#12"]);
});
