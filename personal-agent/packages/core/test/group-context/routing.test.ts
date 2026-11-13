// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A group chat's recent messages through the router: a message that does not @mention the bot is kept and never
 * answered; an @mention's turn gets them as background before what was quoted; a chat that delivers no such message
 * (the permission to read them not granted) works as before; `/context` turns it off and on for the chat.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { contextInterceptor, DEFAULT_GROUP_CONTEXT, GroupContext, parseContext } from "@primusclaw/personal-agent";

import { openTestStore } from "../../../../test-support/index.js";
import { ALICE, BOB } from "../routing/fixtures.js";
import { groupAsked, link, message, said, silent, world } from "../routing/world.js";
import { BOT_NAME } from "../../src/branding.js";

function gmsg(text: string, options: { user?: typeof ALICE; mentioned?: boolean; targeted?: boolean } = {}) {
  const m = message(text, { kind: "group", conversation: "g-1", ...(options.user ? { user: options.user } : {}) });
  return { ...m, mentioned: options.mentioned ?? true, targeted: options.targeted ?? false };
}

function setup(messages = DEFAULT_GROUP_CONTEXT.messages, granted = true) {
  const testStore = openTestStore();
  const context = new GroupContext({
    settings: { ...DEFAULT_GROUP_CONTEXT, messages, granted },
    clock: testStore.clock,
    mask: (t) => t,
    off: testStore.store.groupContext,
    log: silent,
  });
  const w = world({
    testStore,
    groupHistory: context,
    handlers: { groupInterceptors: [contextInterceptor(context, BOT_NAME)] },
  });
  link(w, ALICE.id, "ak-alice");
  groupAsked(w); // (the group was asked its language before: that card is group-language.test.ts's)
  return { w, context };
}

test("a group message that does not @mention the bot is kept, never answered, and starts nothing", async () => {
  const { w, context } = setup();
  await w.router.handle(gmsg("the deploy failed at step 3", { user: BOB, mentioned: false }));
  await w.router.settled();
  assert.deepEqual(w.surface.outbox, []);
  assert.deepEqual(w.turns.calls, []);
  assert.equal(context.count("g-1"), 1);
});

test("an @mention's turn gets the chat's recent messages as background, before what the person quoted", async () => {
  const { w } = setup();
  await w.router.handle(gmsg("the deploy failed at step 3", { user: BOB, mentioned: false }));
  await w.router.handle(gmsg("why did it fail?"));
  await w.router.settled();
  const [run] = w.turns.runs;
  assert.ok(run !== undefined);
  assert.equal(run.text, "why did it fail?"); // (the words alone: the session's title, the answer's language)
  assert.match(run.quote, /^Background: the recent messages of this group chat/);
  assert.match(run.quote, /\n> \[\d\d:\d\dZ\] Bob: the deploy failed at step 3\n<\/group_chat_history>$/);
});

test("with no message delivered beyond @mentions (no permission to read the chat), a turn is what it was", async () => {
  const { w } = setup();
  await w.router.handle(gmsg("first question"));
  await w.router.settled();
  await w.router.handle(gmsg("second question"));
  await w.router.settled();
  assert.deepEqual(
    w.turns.runs.map((r) => r.quote),
    ["", ""],
  ); // (an @mention is not kept as background: only what the bot would not otherwise see is)
});

test("a private (targeted) message in the group is never kept", async () => {
  const { w, context } = setup();
  await w.router.handle(gmsg("my password is hunter2", { mentioned: false, targeted: true }));
  await w.router.settled();
  assert.equal(context.count("g-1"), 0);
});

test("/context off in the group: said to all, nothing more is kept or sent; /context on brings it back", async () => {
  const { w, context } = setup();
  await w.router.handle(gmsg("note one", { user: BOB, mentioned: false }));
  await w.router.handle(gmsg("/context off", { user: BOB })); // (anybody in the chat: Bob is not even linked)
  assert.equal(context.count("g-1"), 0);
  await w.router.handle(gmsg("note two", { user: BOB, mentioned: false }));
  await w.router.handle(gmsg("/context"));
  await w.router.handle(gmsg("what was said?"));
  await w.router.settled();
  assert.equal(w.turns.runs[0]?.quote, "");
  await w.router.handle(gmsg("/context on"));
  await w.router.handle(gmsg("note three", { user: BOB, mentioned: false }));
  await w.router.handle(gmsg("/context status"));
  await w.router.handle(gmsg("/context maybe"));
  const lines = said(w).filter((l) => l !== "ok"); // (the turn's own answer)
  assert.match(lines[0] ?? "", /^已关闭/);
  assert.match(lines[1] ?? "", /^本群关着/);
  assert.match(lines[2] ?? "", /^已打开/);
  assert.match(lines[3] ?? "", /现在记着 1 条/);
  assert.match(lines[4] ?? "", /^用法：@PrimusClaw Assistant \/context on \| off \| status/);
});

test("/context status says when nothing has reached the bot (the chat may not allow reading)", async () => {
  const { w } = setup();
  await w.router.handle(gmsg("/context 状态"));
  assert.match(said(w)[0] ?? "", /还没有收到未 @ 我的消息/);
});

test("/context in a deployment with the feature off says so and changes nothing", async () => {
  const { w } = setup(0);
  await w.router.handle(gmsg("/context off"));
  assert.match(said(w)[0] ?? "", /没有开启/);
  assert.equal(w.store.groupContext.contextOff("g-1"), false);
});

test("only /context is the command: the bare word is a word, more than one argument is a malformed command", () => {
  assert.equal(parseContext("context off"), undefined);
  assert.equal(parseContext("/Context OFF"), "off");
  assert.equal(parseContext("/context 关"), "off");
  assert.equal(parseContext("/context on now"), "usage");
  assert.equal(parseContext("/context constructor"), "usage");
});

const OLD_SEES_ZH = "我能看到什么：只有你发给我的消息（群里只有 @我 的消息），以及你引用的消息和附上的文件。";
const OLD_SEES_EN =
  "What I see: only the messages you send me (in a group, only those that @mention me), with any message you quote and any file you attach.";
const KEPT_ZH = [
  "- 群里授权我读取聊天消息后，我还会在内存里暂存该群最近 30 条、4 小时内没 @我 的消息。",
  "- 这些消息我不回复，也不单独存库。",
  "- 有人 @我 时，它们可能作为不可信的背景随那条消息进入 TA 的会话，并和会话一起保留。",
  "- 不想让我暂存：在群里 @我 发 /context off。",
].join("\n");
const KEPT_EN = [
  "- In a group that allows me to read its messages, I also keep its newest 30 messages that do not " +
    "@mention me, for up to 4 hours.",
  "- I keep them in memory only: I never answer them, and never store them on their own.",
  "- When someone @mentions me, they may go with that message, as untrusted background, into that person's session, " +
    "and are kept with it.",
  "- To turn this off in a group, @mention me there with /context off.",
].join("\n");

test("where a group's recent messages are kept, help in a group and in a 1:1 chat says what, how long, and how to stop", async () => {
  const { w } = setup();
  await w.router.handle(gmsg("/help"));
  await w.router.handle(message("你能做什么", { id: "h-zh" }));
  const [group = "", zh = ""] = said(w).slice(-2);
  assert.ok(group.includes(KEPT_EN) && !group.includes(OLD_SEES_EN), group);
  assert.ok(
    group.includes("- What I see: the messages you send me, with any message you quote and any file you attach."),
  );
  assert.ok(zh.includes(KEPT_ZH) && !zh.includes(OLD_SEES_ZH), zh);
  assert.ok(zh.includes("- 我能看到什么：你发给我的消息，以及你引用的消息和附上的文件。"));
});

test("where the deployment keeps none (0 messages), help still says a group's @mentions are all it sees", async () => {
  const { w } = setup(0);
  await w.router.handle(gmsg("/help"));
  await w.router.handle(message("你能做什么", { id: "h-zh" }));
  const [group = "", zh = ""] = said(w).slice(-2);
  assert.ok(group.includes(`- ${OLD_SEES_EN}`) && !group.includes("/context off"), group);
  assert.ok(zh.includes(`- ${OLD_SEES_ZH}`) && !zh.includes("/context off"), zh);
});

test("a group that said /context off is told, in its own help, that its @mentions are all I see", async () => {
  const { w } = setup();
  await w.router.handle(gmsg("/context off"));
  await w.router.handle(gmsg("/help"));
  groupAsked(w, "g-2");
  await w.router.handle(message("/help", { id: "h-other", kind: "group", conversation: "g-2" }));
  const [offGroup = "", otherGroup = ""] = said(w).slice(-2);
  assert.ok(offGroup.includes(`- ${OLD_SEES_EN}`) && !offGroup.includes(KEPT_EN), offGroup);
  assert.ok(otherGroup.includes(KEPT_EN) && !otherGroup.includes(OLD_SEES_EN), otherGroup); // (only that group)
});

test("where the chat app is not granted a group's other messages, help says the @mentions are all I see", async () => {
  const { w } = setup(DEFAULT_GROUP_CONTEXT.messages, false);
  await w.router.handle(gmsg("/help"));
  await w.router.handle(message("你能做什么", { id: "h-zh" }));
  const [group = "", zh = ""] = said(w).slice(-2);
  assert.ok(group.includes(`- ${OLD_SEES_EN}`) && !group.includes("/context off"), group);
  assert.ok(zh.includes(`- ${OLD_SEES_ZH}`) && !zh.includes("/context off"), zh);
});
