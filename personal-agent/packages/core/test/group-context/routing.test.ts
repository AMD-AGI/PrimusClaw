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
import { link, message, said, silent, world } from "../routing/world.js";

function gmsg(text: string, options: { user?: typeof ALICE; mentioned?: boolean; targeted?: boolean } = {}) {
  const m = message(text, { kind: "group", conversation: "g-1", ...(options.user ? { user: options.user } : {}) });
  return { ...m, mentioned: options.mentioned ?? true, targeted: options.targeted ?? false };
}

function setup(messages = DEFAULT_GROUP_CONTEXT.messages) {
  const testStore = openTestStore();
  const context = new GroupContext({
    settings: { ...DEFAULT_GROUP_CONTEXT, messages },
    clock: testStore.clock,
    mask: (t) => t,
    off: testStore.store.groupContext,
    log: silent,
  });
  const w = world({ testStore, groupHistory: context, handlers: { groupInterceptors: [contextInterceptor(context)] } });
  link(w, ALICE.id, "ak-alice");
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
  assert.match(lines[4] ?? "", /^用法：@Clawy \/context on \| off \| status/);
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
