// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model of a request for several pull requests, and requests written a line per pull request (`test_github_review_many`):
 * a named model is the model of every review of the request, checked once against the key that pays; a model it cannot use
 * starts nothing and never falls back; the result and the card say the model the review ran on, as a model id and nothing else;
 * ten lines that each ask the same person are one request.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError, ClawUnreachable, type InboundMention } from "../../src/index.js";
import { cpLength } from "../../src/text/py-text.js";
import {
  ALICE,
  CONV,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";
import { cards, confirmation } from "./held-world.js";

const PR1 = "AMD-AGI/Hyperloom#1";
const PR2 = "AMD-AGI/Hyperloom#2";

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

const acks = (w: ReviewWorld) =>
  [
    ...w.surface
      .of(CONV)
      .flatMap((r) => (r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : [])),
    ...w.started.map((s) => s.turn.lead),
  ].filter((t) => t.startsWith("收到"));
const modelCalls = (w: ReviewWorld) => w.claw.calls.filter((c) => c[0] === "models").map((c) => c[1]);

for (const [name, text, models, said] of [
  [
    "named several",
    `请 {Bob} 用 claude-opus-5.5 帮我 review 合入 ${PR1} ${PR2}`,
    ["claude-opus-5.5", "claude-opus-5.5"],
    "（模型：claude-opus-5.5）",
  ],
  [
    "named one any case",
    `请 {Bob} 帮我 review 合入 ${PR1} model: CLAUDE-OPUS-5.5`,
    ["claude-opus-5.5"],
    "（模型：claude-opus-5.5）",
  ], // as the key lists it
  ["default several", `请 {Bob} 帮我 review 合入 ${PR1} ${PR2}`, ["", ""], "（模型：默认模型）"],
  ["default one", `请 {Bob} 帮我 review 合入 ${PR1}`, [""], undefined], // one pull request on the default: no acknowledgement
] as const) {
  test(`a named model is the model of every session of the request (${name})`, async () => {
    const world = reviewWorld();
    await ask(world, text);
    assert.deepEqual(
      world.started.map((s) => s.turn.reviewModel),
      models,
    );
    assert.deepEqual(modelCalls(world), models[0] ? ["ak-bob-linked"] : []); // checked once, with the key that pays: Bob's
    const found = acks(world);
    if (said === undefined) assert.deepEqual(found, []);
    else
      assert.deepEqual(
        found.map((a) => a.includes(said)),
        [true],
      );
  });
}

for (const [name, answer, said] of [
  [
    "not on the list",
    ["claude-sonnet-5.5", "gpt-6-luna"],
    "Bob 的 key 用不了模型 gpt-9，所以没有开始 review。可以用的模型：claude-sonnet-5.5、gpt-6-luna。",
  ],
  ["empty list", [], "Bob 的 key 目前没有可用的模型"],
  [
    "claw cannot say",
    new ClawError(503, '{"error":"llm_key_unavailable"}'),
    "暂时没法向 PrimusClaw 确认Bob 的 key 能用哪些模型",
  ],
  ["claw unreachable", new ClawUnreachable("connect", "models"), "暂时没法向 PrimusClaw 确认Bob 的 key 能用哪些模型"],
] as const) {
  test(`a model the askers key cannot use starts nothing and never falls back to the default (${name})`, async () => {
    const world = reviewWorld();
    world.claw.models = (Array.isArray(answer) ? [...answer] : answer) as never;
    await ask(world, `请 {Bob} 用 gpt-9 帮我 review 合入 ${PR1} ${PR2}`);
    assert.equal(world.started.length, 0);
    assert.ok(saidIn(world.surface, CONV).includes(said), saidIn(world.surface, CONV));
  });
}

for (const [name, routed, answer, note, notNote] of [
  ["session model", "claude-opus-5.5", "没有发现必须修改的问题。", "（模型：claude-opus-5.5）", "默认模型"],
  ["default", "", "没有发现必须修改的问题。", "（模型：默认模型）", "（模型：claude"],
  ["english", "claude-haiku-4-5", "Nothing must be fixed.", "(model: claude-haiku-4-5)", "（模型"],
] as const) {
  test(`the result says which model the review ran on (${name})`, async () => {
    const world = reviewWorld();
    await ask(world, `请 {Bob} 帮我 review 合入 ${PR1}`);
    const [turn] = world.started;
    assert.ok(turn);
    const shown = turn.turn.shapeAnswer(`${answer}\nVERDICT: CLEAN`, "", routed, [], 0, "");
    assert.ok(shown.includes(note) && !shown.includes(notNote), shown);
    turn.review.sessionId = "sess-1";
    await world.service.afterTurn(
      turn.review,
      `${answer}\nVERDICT: CLEAN`,
      { moved: false, refusal: null, ranModel: routed, wrote: [["gh_pr_merge", "merged", ""]], prSummary: "" },
      world.surface.conversation(groupMessage("x").conversation),
    );
    assert.ok(saidIn(world.surface, "personal:aad-b").includes(note), saidIn(world.surface, "personal:aad-b"));
  });
}

test("the confirmation card says which model the review ran on", async () => {
  const world = reviewWorld();
  world.claw.confirmations = [confirmation({ pr: 1 })];
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR1}`);
  const [turn] = world.started;
  assert.ok(turn);
  turn.review.sessionId = "sess-1";
  await world.service.afterTurn(
    turn.review,
    "这是高风险变更，需要 Bob 确认。\nVERDICT: CLEAN",
    { moved: false, refusal: null, ranModel: "claude-haiku-4-5", wrote: [], prSummary: "" },
    world.surface.conversation(groupMessage("x").conversation),
  );
  assert.equal(cards(world, "personal:aad-b")[0]?.model, "claude-haiku-4-5");
});

test("a model name from outside reaches the group as a model id and nothing else", async () => {
  const world = reviewWorld();
  await ask(world, `请 {Bob} 帮我 review 合入 ${PR1}`);
  const shown =
    world.started[0]?.turn.shapeAnswer(
      "没有发现必须修改的问题。\nVERDICT: CLEAN",
      "",
      "evil<at>x</at>`[link](https://e.test)`\nmodel",
      [],
      0,
      "",
    ) ?? "";
  const note = shown.split("（模型：").at(-1)?.split("）")[0] ?? "";
  assert.ok(!/[<[`(]/u.test(note) && cpLength(note) > 0, note);
});

const LINES = Array.from({ length: 10 }, (_, i) => `https://github.com/AMD-AGI/Primus/pull/${String(101 + i)}`);
const LIN = { channelUserId: "29:w", userId: "aad-w", name: "Lin, Mei" };

/** The ten-line request as sent: each line names the reviewer, with a mention on every line or only the first. */
function linesMessage(mentionPerLine: boolean, names: Readonly<Record<number, typeof LIN>> = {}) {
  let text = "";
  const mentions: InboundMention[] = [];
  LINES.forEach((link, i) => {
    const person = names[i] ?? LIN;
    if (i) text += "\r\n ";
    text += "请 ";
    if (i === 0 || mentionPerLine) mentions.push({ ...person, shown: person.name, offset: Array.from(text).length });
    text += `${person.name} review 并合入 ${link}`;
  });
  return { ...groupMessage("x"), text, mentions };
}

function linesWorld(): ReviewWorld {
  const world = reviewWorld();
  world.github.repos.set("amd-agi/primus", "AMD-AGI/Primus");
  world.store.members.rememberMember("29:w", "aad-w", "Lin, Mei");
  world.identity.know("aad-w", "u-lin", "lin-gh", true);
  world.link("aad-w", "Lin, Mei", "ak-lin");
  world.bound.add("aad-w");
  return world;
}

for (const [name, perLine] of [
  ["a mention per line", true],
  ["only the first line mentions", false],
] as const) {
  test(`ten lines that each ask the same person are one request for ten pull requests (${name})`, async () => {
    const world = linesWorld();
    const message = linesMessage(perLine);
    await world.service.request({
      message,
      text: message.text,
      sender: ALICE,
      conversation: world.surface.conversation(message.conversation),
      scope: CONV,
      lang: () => "zh",
    });
    assert.deepEqual(
      world.started.map((s) => s.turn.reviewTarget.number),
      LINES.map((_, i) => 101 + i),
    );
    assert.deepEqual(new Set(world.started.map((s) => s.turn.actingAs)), new Set(["u-lin"]));
    const [ack = ""] = acks(world);
    assert.ok(
      ack.includes("以 Lin, Mei 的身份") && LINES.every((_, i) => ack.includes(`AMD-AGI/Primus#${String(101 + i)}`)),
      ack,
    );
  });
}

test("lines that ask different people start nothing and say why", async () => {
  const world = linesWorld();
  const message = linesMessage(true, { 3: { channelUserId: "29:c", userId: "", name: "Carol" } });
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
  const said = saidIn(world.surface, CONV);
  assert.ok(said.includes("只能请同一位 reviewer") && said.includes("Carol"), said);
});
