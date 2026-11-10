// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A review asked for in a 1:1 chat (`test_github_review_direct`): the same path as in a group, the results in that chat. With no
 * group to list, a name means one of the people the worker has seen write to it; naming nobody means the asker's own account.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntentReader } from "../../src/index.js";
import { tokens, writtenIn } from "../../src/review-text/names.js";
import { ALICE, groupMessage, reviewWorld, saidIn, type ReviewWorld } from "../../../../test-support/review-world.js";

const H1 = "AMD-AGI/Hyperloom#1";
const H2 = "AMD-AGI/Hyperloom#2";
const H3 = "AMD-AGI/Primus#3";
const DM = "personal:aad-a";

function world(intent?: IntentReader): ReviewWorld {
  const w = reviewWorld(["AMD-AGI"], intent === undefined ? {} : { intent });
  w.github.defaultAuthor = "carol-gh"; // (written by someone else than either reviewer)
  w.github.repos.set("amd-agi/primus", "AMD-AGI/Primus");
  return w;
}

function known(w: ReviewWorld, ...people: [string, string, string][]): void {
  for (const [channelId, userId, name] of people) w.store.members.rememberMember(channelId, userId, name);
}

async function say(w: ReviewWorld, text: string): Promise<boolean> {
  const message = groupMessage(text, ALICE, [], "d1", "personal");
  return w.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: w.surface.conversation(message.conversation),
    scope: "",
    lang: () => "zh",
  });
}

const reviews = (w: ReviewWorld) => w.started.filter((s) => s.turn.actingAs);
const actors = (w: ReviewWorld) => new Set(reviews(w).map((s) => s.turn.actingAs));
const said = (w: ReviewWorld) => [saidIn(w.surface, DM), ...w.started.map((s) => s.turn.lead)].join(" ");

for (const [name, text, acting, prs] of [
  ["a name", `请 Bob 帮我 review 合入 ${H1}`, "u-bob", [1]],
  ["several pull requests", `请 bob review 并合入 ${H1}、${H2}\n${H3}`, "u-bob", [1, 2, 3]],
  ["nobody named is my own account", `帮我 review 合入 ${H1} ${H2}`, "u-alice", [1, 2]], // nobody named: Alice's own account
] as const) {
  test(`a request in a 1:1 chat starts the reviews and answers there (${name})`, async () => {
    const w = world();
    w.identity.know("aad-a", "u-alice", "alice-gh", true);
    await say(w, text);
    assert.deepEqual(
      reviews(w).map((s) => s.turn.reviewTarget.number),
      prs,
      said(w),
    );
    assert.deepEqual(actors(w), new Set([acting]));
    assert.ok(reviews(w).every((s) => s.turn.mention === undefined)); // (answered in this chat, mentioning nobody)
    if (prs.length > 1) assert.ok(said(w).includes("同时 review 合入"), said(w));
  });
}

test("naming nobody needs my own github connected", async () => {
  const w = world();
  w.identity.know("aad-a", "u-alice", null);
  await say(w, `帮我 review 合入 ${H1}`);
  assert.equal(reviews(w).length, 0);
  assert.ok(saidIn(w.surface, DM).includes("还没有绑定 GitHub"), saidIn(w.surface, DM));
});

for (const [name, people, typed, says] of [
  [
    "ambiguous",
    [
      ["29:c", "aad-c", "Carol"],
      ["29:c2", "aad-c2", "Carol (SaFE)"],
    ],
    "Carol",
    "我认识的人里有不止一位叫「Carol」的成员：Carol、Carol SaFE",
  ],
  [
    "only close",
    [["29:w", "aad-w", "Lin, Mei"]],
    "Lin",
    "我认识的人里（和我说过话的同事）没有找到「Lin」（相近的有：Lin, Mei）",
  ],
  ["unknown", [], "Zed", "我认识的人里（和我说过话的同事）没有找到「Zed」"],
] as const) {
  test(`a name in a 1:1 chat is one of the people the worker knows or a question (${name})`, async () => {
    const w = world();
    known(w, ...people.map((p) => [...p] as [string, string, string]));
    await say(w, `请 ${typed} 帮我 review 合入 ${H1}`);
    assert.equal(reviews(w).length, 0);
    assert.ok(saidIn(w.surface, DM).includes(says), saidIn(w.surface, DM));
    assert.deepEqual(w.identity.askedAbout(), []);
  });
}

test("a known name in a 1:1 chat may be written another way", async () => {
  const w = world();
  known(w, ["29:w", "aad-w", "Lin, Mei"]);
  w.identity.know("aad-w", "u-lin", "lin-gh", true);
  w.link("aad-w", "Lin, Mei", "ak-lin");
  w.bound.add("aad-w");
  await say(w, `请 Mei Lin review 合入 ${H1}`);
  assert.deepEqual(actors(w), new Set(["u-lin"]), said(w));
});

test("two people named in a 1:1 chat start nothing", async () => {
  const w = world();
  known(w, ["29:c", "aad-c", "Carol"]);
  await say(w, `请 Bob review 合入 ${H1}，Carol review 合入 ${H2}`);
  assert.equal(reviews(w).length, 0);
  assert.ok(saidIn(w.surface, DM).includes("只能请同一位 reviewer"), saidIn(w.surface, DM));
});

test("a 1:1 chat that only mentions review is still the chat", async () => {
  const w = world();
  assert.equal(await say(w, `review ${H1}`), false); // (not a request: the chat goes on as chat)
  assert.equal(reviews(w).length, 0);
});

for (const [name, text] of [
  ["run into the words", `请林梅帮我 review 合入 ${H1}`],
  ["spaced", `请 林梅 review 并合入 ${H1}`],
  ["run into latin", `请林梅review并合入${H1}`],
] as const) {
  test(`a two letter chinese name is a name (${name})`, async () => {
    const w = world();
    known(w, ["29:wl", "aad-wl", "林梅"]);
    w.identity.know("aad-wl", "u-linmei", "linmei-gh", true);
    w.link("aad-wl", "林梅", "ak-wl");
    w.bound.add("aad-wl");
    await say(w, text);
    assert.deepEqual(actors(w), new Set(["u-linmei"]), said(w));
  });
}

function reading(answer: Record<string, unknown> | undefined): IntentReader {
  return {
    read: () => Promise.resolve(answer),
    readMode: () => Promise.resolve(undefined),
    readAnswer: () => Promise.resolve(undefined),
  };
}

for (const [name, answer] of [
  ["the reading lists bob", { intent: "review_merge", reviewer: "", reviewers: ["Bob"], prs: [H1], model: "" }],
  ["the rules", undefined], // the rules read it: nobody after 请, but the message names Bob
] as const) {
  test(`a 1:1 request that names someone is never the askers own (${name})`, async () => {
    const w = world(reading(answer));
    await say(w, `帮我 review 合入 ${H1}，让 Bob 来`);
    assert.equal(reviews(w).length, 0);
    assert.ok(saidIn(w.surface, DM).includes("我不确定你请的是谁"), saidIn(w.surface, DM));
  });
}

test("a reading that lists someone the worker does not know is still no request of the askers own", async () => {
  const w = world(reading({ intent: "review_merge", reviewer: "", reviewers: ["Bob"], prs: [H1], model: "" }));
  w.store.members.rememberMember("29:b", "aad-x", "Someone else"); // (Bob is not one the worker knows any more)
  await say(w, `帮我 review 合入 ${H1}，让 Bob 来`);
  assert.equal(reviews(w).length, 0);
  assert.ok(saidIn(w.surface, DM).includes("我不确定你请的是谁"), saidIn(w.surface, DM));
});

test("a reading that drops the name the rules read is a question", async () => {
  const w = world(reading({ intent: "review_merge", reviewer: "", reviewers: [], prs: [H1], model: "" }));
  await say(w, `请 Zed review 合入 ${H1}`);
  assert.equal(reviews(w).length, 0);
  assert.ok(saidIn(w.surface, DM).includes("我不确定你请的是谁"), saidIn(w.surface, DM));
});

test("a reading that names another person than the rules is a question (1:1)", async () => {
  const w = world(reading({ intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: [H1], model: "" }));
  await say(w, `请 Zed review 合入 ${H1}，Bob 写的`);
  assert.equal(reviews(w).length, 0);
  assert.ok(saidIn(w.surface, DM).includes("我不确定你请的是谁"), saidIn(w.surface, DM));
  assert.deepEqual(w.identity.requests, []);
});

test("a reading that names the same person another way goes on", async () => {
  const w = world(
    reading({ intent: "review_merge", reviewer: "Mei Lin", reviewers: ["Mei Lin"], prs: [H1], model: "" }),
  );
  known(w, ["29:w", "aad-w", "Lin, Mei"]);
  w.identity.know("aad-w", "u-lin", "lin-gh", true);
  w.link("aad-w", "Lin, Mei", "ak-lin");
  w.bound.add("aad-w");
  await say(w, `请 Lin, Mei review 合入 ${H1}`);
  assert.equal(reviews(w).length, 1, said(w));
});

for (const [name, text] of [
  ["rang", `请让 Bob review 合入 ${H1}`],
  ["jiao bangmang", `请叫 Bob 帮忙 review 合入 ${H1}`],
  ["words around", `请 Bob 老师 review 合入 ${H1}`], // words around the name in what the rules read
] as const) {
  test(`a reading of a name inside what the rules read goes on (${name})`, async () => {
    const w = world(reading({ intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: [H1], model: "" }));
    await say(w, text);
    assert.deepEqual(actors(w), new Set(["u-bob"]), said(w));
  });
}

for (const [name, text] of [
  ["rang", `请让 Bob review 合入 ${H1}`],
  ["jiao", `请叫 Bob review 合入 ${H1}`],
  ["bangmang", `请 Bob 帮忙 review 并合入 ${H1}`],
  ["bangwo yixia", `请 Bob 帮我一下 review 合入 ${H1}`],
] as const) {
  test(`the rules alone read these wordings too (${name})`, async () => {
    const w = world();
    await say(w, text);
    assert.deepEqual(actors(w), new Set(["u-bob"]), said(w));
  });
}

for (const [name, text] of [
  ["bob named too", `请让 Bobby review 合入 ${H1}；Bob 不是 reviewer`],
  ["only bobby", `请 Bobby review 合入 ${H1}`],
] as const) {
  test(`a name inside a longer word is not that person (${name})`, async () => {
    const w = world(reading({ intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: [H1], model: "" }));
    await say(w, text);
    assert.equal(reviews(w).length, 0);
    assert.deepEqual(w.identity.requests, []);
  });
}

for (const [name, readingSays, actsAs] of [
  ["a shorter name inside", "林梅", undefined],
  ["the name asked", "林梅芳", "u-linmeifang"],
  ["the rules alone", undefined, "u-linmeifang"],
] as const) {
  test(`a chinese name inside a longer one is not that person (${name})`, async () => {
    const w = world(
      readingSays === undefined
        ? reading(undefined)
        : reading({ intent: "review_merge", reviewer: readingSays, reviewers: [readingSays], prs: [H1], model: "" }),
    );
    known(w, ["29:lw", "aad-lw", "林梅"], ["29:lwq", "aad-lwq", "林梅芳"]);
    for (const [aad, user, key] of [
      ["aad-lw", "u-linmei", "ak-lw"],
      ["aad-lwq", "u-linmeifang", "ak-lwq"],
    ] as const) {
      w.identity.know(aad, user, `${user}-gh`, true);
      w.link(aad, "x", key);
      w.bound.add(aad);
    }
    await say(w, `请林梅芳帮我 review 合入 ${H1}`);
    assert.deepEqual(
      reviews(w).map((s) => s.turn.actingAs),
      actsAs === undefined ? [] : [actsAs],
      said(w),
    );
    assert.ok(!w.identity.askedAbout().includes("external:teams.microsoft.com|aad-lw"));
  });
}

const GLUED = "帮我请linmei review并合入PrimusClaw PR 249";

for (const [name, text, answer] of [
  [
    "the message as sent, read by the model",
    GLUED,
    { intent: "review_merge", reviewer: "linmei", reviewers: ["linmei"], prs: ["PrimusClaw PR 249"], model: "" },
  ],
  ["rules", "请linmei帮我review并合入PrimusClaw PR 249", undefined], // (the rules read only a request that starts with 请)
] as const) {
  test(`a latin name run into chinese in a 1:1 chat is that person (${name})`, async () => {
    const w = world(answer === undefined ? undefined : reading(answer));
    known(w, ["29:w", "aad-w", "Lin, Mei"], ["29:c", "aad-c", "Carol"]);
    w.identity.know("aad-w", "u-lin", "lin-gh", true);
    w.link("aad-w", "Lin, Mei", "ak-lin");
    w.bound.add("aad-w");
    await say(w, text);
    const text2 = said(w);
    assert.ok(!text2.includes("我没在你的消息里找到"), text2);
    assert.deepEqual(
      reviews(w).map((s) => [s.turn.reviewTarget.repo, s.turn.reviewTarget.number]),
      [["PrimusClaw", 249]],
      text2,
    );
    assert.deepEqual(actors(w), new Set(["u-lin"]));
  });
}

for (const [name, text] of [
  ["glued both sides", `请linmei帮我review合入${H1}`],
  ["two words glued", `请Lin Mei帮忙review并合入${H1}`],
] as const) {
  test(`a latin name glued on both sides is that person (${name})`, async () => {
    const w = world();
    known(w, ["29:w", "aad-w", "Lin, Mei"]);
    w.identity.know("aad-w", "u-lin", "lin-gh", true);
    w.link("aad-w", "Lin, Mei", "ak-lin");
    w.bound.add("aad-w");
    await say(w, text);
    assert.deepEqual(actors(w), new Set(["u-lin"]), said(w));
  });
}

test("a latin name glued to chinese is still a whole word", async () => {
  const w = world(reading({ intent: "review_merge", reviewer: "Bob", reviewers: ["Bob"], prs: [H1], model: "" }));
  await say(w, `请Bobby帮我review合入${H1}`);
  assert.equal(reviews(w).length, 0);
  assert.deepEqual(w.identity.requests, []);
});

for (const [name, text, written] of [
  ["linmei", GLUED, true],
  ["Lin, Mei", "请Lin, Mei帮我review合入PR249", true],
  ["Mei Lin", "请Lin Mei帮忙", true],
  ["林梅", "请林梅帮我review", true],
  ["Bob", "请Bobby帮我", false],
  ["Bob", "请Bob的同事帮我", true],
] as const) {
  test(`where a name is written next to chinese: ${name} in ${text}`, () => {
    assert.equal(writtenIn(name, text), written);
  });
}

test("a word ends where chinese meets a letter or a digit", () => {
  assert.deepEqual(tokens("合入PR249，model:claude-opus-5.5帮我"), [
    "合入",
    "pr249",
    "model",
    "claude",
    "opus",
    "5",
    "5",
    "帮我",
  ]);
  assert.deepEqual(tokens("请林梅帮我"), ["请林梅帮我"]); // (Chinese run together stays one word: a Chinese name is found inside it)
});
