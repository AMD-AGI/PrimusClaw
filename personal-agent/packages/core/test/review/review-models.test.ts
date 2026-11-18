// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model of a review Claw makes as an item (`test_review_items`' model tests): a Claw that chooses a review's model is sent
 * only what the request named, and what it says runs is what the card and the receipt show; a Claw without that choice is asked
 * for the deployment's review model, as before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ReviewsRefused, type UserRef } from "../../src/index.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  withItems,
  type ItemOptions,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const OPUS = "claude-opus-5.5";
const SONNET = "claude-sonnet-5.5";
const HAIKU = "claude-haiku-5.5";
const GLM = "glm-5-3-with-fallback";
const PR2 = "AMD-AGI/Hyperloom#13";
const PR3 = "AMD-AGI/Hyperloom#14";

function itemsWorld(model?: ItemOptions["model"], chooses = true): ReviewWorld {
  const world = reviewWorld();
  (world.deps as { defaultModel: string }).defaultModel = OPUS;
  withItems(world, model === undefined ? {} : { model });
  if (chooses) world.claw.modelChoice = { models: [{ name: OPUS }, { name: SONNET }] };
  return world;
}

async function ask(world: ReviewWorld, text: string, id = "g1", people?: readonly UserRef[]): Promise<void> {
  const sender = ALICE;
  const message = groupMessage(text, sender, people, id);
  await world.service.request({
    message,
    text: message.text,
    sender,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const bodies = (world: ReviewWorld) =>
  world.claw.calls.filter((c) => c[0] === "startReviews").map((c) => c[2] as Record<string, unknown>);
const cardModels = (world: ReviewWorld) =>
  world.surface
    .of("personal:aad-a")
    .flatMap((r) =>
      r.op === "post" && r.message.body.type === "view" && r.message.body.view.name === "reviewItem"
        ? [r.message.body.view.model.model]
        : [],
    );
const groupText = (world: ReviewWorld) => saidIn(world.surface, CONV);

test("a claw that chooses models is asked for none by default and its model is on the card and receipt", async () => {
  const world = itemsWorld({ model: SONNET });
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  const [body] = bodies(world);
  assert.equal(body?.model, ""); // (the deployment's review model would read there as the asker's own choice)
  assert.deepEqual(cardModels(world), [SONNET]);
  assert.ok(groupText(world).includes(`（模型：${SONNET}）`), groupText(world));
  assert.ok(!groupText(world).includes(OPUS) && !cardModels(world).includes(OPUS));
});

test("a claw that chooses still gets the model the request named", async () => {
  const world = itemsWorld({ model: OPUS });
  await ask(world, `请 {Bob} 用 claude-opus-5.5 帮我 review ${PR}`);
  assert.equal(bodies(world)[0]?.model, OPUS);
});

test("a claw without model choice is asked for the default and shows it as before", async () => {
  const world = itemsWorld(undefined, false);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  assert.equal(bodies(world)[0]?.model, OPUS);
  assert.deepEqual(cardModels(world), [OPUS]);
});

test("a fallback is said with both models", async () => {
  const world = itemsWorld({ model: GLM, fellBackFrom: OPUS });
  await ask(world, `请 {Bob} 用 claude-opus-5.5 帮我 review ${PR}`);
  const said = groupText(world);
  assert.ok(said.includes(`用不了 ${OPUS}`) && said.includes(`改用 ${GLM}`), said);
  assert.deepEqual(cardModels(world), [GLM]);
});

test("a model named for someone elses review is said to be set aside", async () => {
  const world = itemsWorld({ model: HAIKU, ignored: ["model"] });
  await ask(world, `请 {Bob} 用 claude-opus-5.5 帮我 review ${PR}`);
  const said = groupText(world);
  assert.ok(said.includes(`按 TA 自己的模型设置用 ${HAIKU}`) && said.includes(`没有用你指定的 ${OPUS}`), said);
  assert.deepEqual(cardModels(world), [HAIKU]);
});

test("a model the reviewers key cannot use does not stop a review a claw that chooses takes", async () => {
  const world = itemsWorld({ model: HAIKU, ignored: ["model"] });
  world.claw.models = [SONNET]; // (Bob's key cannot use opus)
  await ask(world, `请 {Bob} 用 claude-opus-5.5 帮我 review ${PR}`);
  assert.deepEqual(
    world.claw.calls.filter((c) => c[0] === "models"),
    [],
    "not checked against Bob's key",
  );
  assert.equal(bodies(world)[0]?.model, OPUS);
  assert.ok(groupText(world).includes(`没有用你指定的 ${OPUS}`));
});

test("claws refusal of a model off its list says so with the list", async () => {
  const world = itemsWorld({ model: SONNET });
  world.claw.refuseAll = new ReviewsRefused(400, "model_not_allowed", "x", {
    models: [
      { name: OPUS, label: "最强" },
      { name: SONNET, label: "默认" },
    ],
  });
  world.store.members.rememberMember("29:a", "aad-a", "Alice");
  world.identity.know("aad-a", "u-alice", "alice-gh", true);
  world.github.defaultAuthor = "carol-gh";
  await ask(world, `请 {Alice} 用 gpt-6-luna 帮我 review ${PR}`, "g1", [ALICE]);
  const said = groupText(world);
  assert.ok(said.includes("不在 PrimusClaw 允许的模型里") && said.includes(`${OPUS}、${SONNET}`), said);
});

test("whether claw chooses is asked once in a while and a failed ask keeps the old behaviour", async () => {
  const world = itemsWorld({ model: SONNET });
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR}`);
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR2}`, "g2");
  assert.equal(world.claw.calls.filter((c) => c[0] === "assistantSettings").length, 1);
  const fresh = itemsWorld(undefined, false);
  fresh.claw.modelChoice = new (await import("../../src/index.js")).ClawError(503);
  await ask(fresh, `请 {Bob} 帮我 review 合入 ${PR3}`, "g3");
  assert.equal(bodies(fresh)[0]?.model, OPUS);
});
