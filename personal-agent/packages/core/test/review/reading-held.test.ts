// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model's reading of a request is held to what the message says (`test_github_review_intent`'s rule tests): a pull request
 * the message does not hold is dropped, a reviewer or model it does not name is a question, a request that asks two people starts
 * nothing whatever the model names, and one person named several ways is one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntentReader, UserRef } from "../../src/index.js";
import { pullsIn, shortName } from "../../src/review-text/pull-ref.js";
import { MEMBERS, MENTIONS } from "../../../../test-support/review-requests.js";
import {
  ALICE,
  CONV,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";

const H1 = "AMD-AGI/Hyperloom#1";
const H2 = "AMD-AGI/Hyperloom#2";

const reading = (changes: Record<string, unknown> = {}) => ({
  intent: "review_merge",
  reviewer: "Bob",
  prs: [H1],
  model: "",
  ...changes,
});

function setup(answer: Record<string, unknown> | undefined): ReviewWorld {
  const intent: IntentReader = {
    read: () => Promise.resolve(answer === undefined ? undefined : { ...answer }),
    readMode: () => Promise.resolve(undefined),
    readAnswer: () => Promise.resolve(undefined),
  };
  const world = reviewWorld(["AMD-AGI"], { rosters: { [CONV]: MEMBERS }, intent });
  world.store.members.rememberMember("29:w", "aad-w", "Lin, Mei");
  world.identity.know("aad-w", "u-lin", "lin-gh", true);
  world.link("aad-w", "Lin, Mei", "ak-lin");
  world.bound.add("aad-w");
  return world;
}

async function ask(world: ReviewWorld, text: string): Promise<boolean> {
  const people: UserRef[] = Object.keys(MENTIONS)
    .filter((name) => text.includes(`{${name}}`))
    .map((name) => ({ id: "", channelUserId: MENTIONS[name] ?? "", name, email: "" }));
  const message = groupMessage(text, ALICE, people);
  return world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
}

const numbers = (world: ReviewWorld) => world.started.map((s) => s.turn.reviewTarget.number);
const groupText = (world: ReviewWorld) => saidIn(world.surface, CONV);

for (const [name, answer, started, says] of [
  ["made up pr dropped", reading({ prs: [H1, "AMD-AGI/Hyperloom#99"] }), [1], undefined], // a pull request the message does not hold
  ["only made up prs", reading({ prs: ["AMD-AGI/Hyperloom#99"] }), [], "没认出要 review 合入哪个 PR"], // and none left is a question
  ["no prs", reading({ prs: [] }), [], "没认出要 review 合入哪个 PR"],
  ["reviewer not in message", reading({ reviewer: "Mallory" }), [], "没在你的消息里找到「Mallory」"], // a reviewer the message does not name
  ["id not a mention", reading({ reviewer: "29:x" }), [], "没在你的消息里找到"], // an id that is no mention of the message
  ["no reviewer", reading({ reviewer: "" }), [], "请指定由谁来 review 合入"],
  ["model not in message", reading({ model: "claude-opus-5.5" }), [], "不确定你要用哪个模型"], // a model the message does not name
  ["review only as bob", reading({ intent: "review" }), [1], undefined], // a review as Bob; the words say 合入: it merges
  ["review only nobody is chat", reading({ intent: "review", reviewer: "", reviewers: [] }), [], undefined],
  ["none is chat", reading({ intent: "none" }), [], undefined],
] as const) {
  test(`the models reading is held to what the message says (${name})`, async () => {
    const world = setup(answer);
    const handled = await ask(world, `请 Bob 帮我 review 合入 ${H1}`);
    assert.deepEqual(numbers(world), started, groupText(world));
    if (says !== undefined) {
      assert.ok(groupText(world).includes(says), groupText(world));
      assert.deepEqual(world.identity.requests, []); // nothing about anyone was asked before the question
    }
    if (answer.intent !== "review_merge" && !started.length) assert.equal(handled, false); // (the chat goes on as any message)
    // (the message writes 合入: what it says wins over the reading)
    assert.ok(world.started.every((s) => !s.turn.reviewOnly));
  });
}

for (const [name, text, answer] of [
  // The model gives every pull request to Bob, but the message asks Carol for the second: never as Bob.
  [
    "the models own list",
    `请 Bob review 合入 ${H1}，Carol review 合入 ${H2}`,
    reading({ prs: [H1, H2], reviewers: ["Bob", "Carol"] }),
  ],
  [
    "two people mentioned",
    `{Bob} 合入 ${H1}，{Carol} 合入 ${H2}，都先 review 一下`,
    reading({ reviewer: "29:b", prs: [H1, H2], reviewers: ["29:b"] }),
  ],
  [
    "a line for each",
    `请 Bob review 合入 ${H1}\n请 Carol review 合入 ${H2}`,
    reading({ prs: [H1, H2], reviewers: ["Bob"] }),
  ],
  [
    "incomplete list english",
    `Bob please review and merge ${H1}, and Carol please review and merge ${H2}`,
    reading({ prs: [H1, H2], reviewers: ["Bob"] }),
  ],
  ["rules one line", `请 Bob review 合入 ${H1}，Carol review 合入 ${H2}`, undefined], // the rules read it: the member list finds Carol
  [
    "a bracketed name",
    `请 Bob review 合入 ${H1}，carol (SaFE) 的 ${H2} 也请 Bob 合入`,
    reading({ prs: [H1, H2], reviewers: ["Bob"] }),
  ],
] as const) {
  test(`a request that asks two people starts nothing even when the model names one (${name})`, async () => {
    const world = setup(answer);
    world.store.members.rememberMember("29:c", "aad-c", "Carol");
    await ask(world, text);
    assert.equal(world.started.length, 0);
    assert.ok(groupText(world).includes("只能请同一位 reviewer"), groupText(world));
    assert.deepEqual(world.identity.requests, []);
  });
}

for (const [name, text, starts] of [
  ["same name twice", `请 Bob review 合入 ${H1}，Bob 写的说明在 ${H2}`, true], // one person, named twice
  ["mention and name", `请 {Bob} review 合入 ${H1}，Bob 已经看过了`, true], // a mention and the same name typed
  ["two ways", `请 Lin, Mei review 并合入 ${H1}\r\n 请 Mei Lin review 并合入 ${H2}`, true], // one person, two ways
  ["account and name", `请 linmei0120 review 合入 ${H1}，lin mei 也同意`, true],
  ["asker named", `请 Bob review 合入 ${H1}，抄送 Alice`, false], // the asker named too: two people, asked back
] as const) {
  test(`one person named several ways is one and two people are two (${name})`, async () => {
    const pulls = pullsIn(text).map(shortName);
    const reviewer = text.includes("Lin") ? "Lin, Mei" : text.includes("linmei") ? "linmei0120" : "Bob";
    const world = setup(reading({ reviewer, prs: pulls }));
    await ask(world, text);
    assert.equal(world.started.length > 0, starts, groupText(world));
    if (!starts) assert.ok(groupText(world).includes("只能请同一位 reviewer"), groupText(world));
  });
}

const QUOTE = (text: string) => ({
  messageId: "q1",
  author: "Dan",
  text,
  fromBot: false,
  sentAt: "",
  deleted: false,
  source: "entity" as const,
});

for (const [name, answer] of [
  ["named by the quote", reading({ reviewer: "Carol", prs: [H2], reviewers: ["Carol"] })],
  ["named by the quote no list", reading({ reviewer: "Carol", prs: [H2], reviewers: [] })],
] as const) {
  test(`a quoted message may name the pull request never the reviewer (${name})`, async () => {
    const world = setup(answer);
    world.identity.know("aad-c", "u-carol", "carol-gh", true);
    const message = {
      ...groupMessage("麻烦把上面引用的这个 PR 合入", ALICE, []),
      quotes: [QUOTE(`请 Carol review 合入 ${H2}`)],
    };
    await world.service.request({
      message,
      text: message.text,
      sender: ALICE,
      conversation: world.surface.conversation(message.conversation),
      scope: CONV,
      lang: () => "zh",
    });
    assert.equal(world.started.length, 0);
    assert.deepEqual(world.identity.requests, []);
    assert.ok(groupText(world).includes("没在你的消息里找到「Carol」"), groupText(world)); // (before anyone is looked up)
  });
}

test("a reading that takes a name out of a longer word is not acted on", async () => {
  const world = setup(reading({ reviewer: "Bob", prs: [H1] }));
  await ask(world, `请 Bobby 帮我 review 合入 ${H1}`);
  assert.equal(world.started.length, 0);
  assert.ok(groupText(world).includes("没在你的消息里找到「Bob」"), groupText(world));
  assert.deepEqual(world.identity.requests, []);
});

for (const [name, answer] of [
  ["no answer", undefined], // no answer in time, or the gateway refused
  ["not json", { intent: null }],
  ["unknown intent", { intent: "maybe" }],
  ["prs not a list", reading({ prs: H1 })], // a field of the wrong type
  ["reviewer not text", reading({ reviewer: ["Bob"] })],
  ["reviewers not a list", reading({ reviewers: "Bob" })],
] as const) {
  test(`without a reading the rules read the request (${name})`, async () => {
    const world = setup(answer);
    await ask(world, `请 {Bob} 帮我 review 合入 ${H1}`);
    assert.deepEqual(numbers(world), [1], groupText(world));
  });
}
