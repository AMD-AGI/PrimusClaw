// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { type Conversation, type OutMessage, type Logger } from "@primusclaw/personal-agent";

import { FakeSurface } from "../../../../test-support/surface.js";
import { openTestStore } from "../../../../test-support/store.js";
import { Chat, helpLang, langOf, learnLang, settleClick } from "../../src/routing/chat.js";
import { ALICE, click, note, personal } from "./fixtures.js";

const quiet: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

/** `conversation` with some of its operations replaced. */
function wrap(conversation: Conversation, overrides: Partial<Pick<Conversation, "send" | "update">>): Conversation {
  return {
    ref: conversation.ref,
    caps: conversation.caps,
    replyTo: conversation.replyTo,
    edited: conversation.edited,
    markSettled: (id) => {
      conversation.markSettled(id);
    },
    typing: () => conversation.typing(),
    send: overrides.send ?? ((m) => conversation.send(m)),
    post: (m) => conversation.post(m),
    update: overrides.update ?? ((id, m) => conversation.update(id, m)),
    delete: (id) => conversation.delete(id),
    outgoing: (m) => conversation.outgoing(m),
    deliver: (e) => conversation.deliver(e),
    openStream: (to, status) => conversation.openStream(to, status),
  };
}

function text(message: OutMessage): string {
  return message.body.type === "text" ? message.body.text : message.body.type;
}

test("a person is answered in what they chose, else what they last wrote, else their client's language", () => {
  const { store } = openTestStore();
  assert.equal(langOf(store, ALICE.id, "zh-CN"), "zh");
  assert.equal(langOf(store, ALICE.id, ""), "en");
  learnLang(store, ALICE.id, "/help");
  learnLang(store, ALICE.id, "LGTM");
  assert.equal(langOf(store, ALICE.id, "zh-CN"), "zh"); // (a command or a word says nothing)
  learnLang(store, ALICE.id, "please fix the failing test");
  assert.equal(langOf(store, ALICE.id, "zh-CN"), "en");
  assert.equal(helpLang(store, ALICE.id, "", "你能做什么"), "zh"); // (asked in Chinese: help in Chinese)
  assert.equal(helpLang(store, ALICE.id, "", undefined), "en");
  store.prefs.setLang(ALICE.id, "en");
  assert.equal(helpLang(store, ALICE.id, "", "你能做什么"), "en"); // (they chose: whatever the words are in)
  assert.equal(langOf(store, "", "zh"), "zh");
});

test("a chat says text, rich text and messages in its conversation, in the person's language", async () => {
  const { store } = openTestStore();
  const surface = new FakeSurface();
  const chat = new Chat(store, ALICE, surface.conversation(personal()), "", "zh-CN");
  assert.ok(chat.zh() && chat.lang() === "zh");
  await chat.say("hi");
  await chat.sayRich("**hi**");
  await chat.send(note("n"));
  assert.deepEqual(
    surface.outbox.map((r) => r.op),
    ["send", "send", "send"],
  );
});

test("a settled click replaces the card and says the outcome; a failed edit still says it", async () => {
  const surface = new FakeSurface();
  const conversation = surface.conversation(personal());
  assert.equal(await settleClick({ action: click("repo"), conversation, note }, quiet, "Done."), true);
  assert.deepEqual(
    surface.outbox.map((r) => (r.op === "update" || r.op === "send" ? `${r.op}:${text(r.message)}` : r.op)),
    ["update:note::Done.", "send:Done."],
  );
  // a card that is more than a note: no line unless one is given; announce false: not said again
  assert.equal(await settleClick({ action: click("x"), conversation, note }, quiet, note("card")), true);
  await settleClick({ action: click("x"), conversation, note }, quiet, note("card"), {
    fallback: "f",
    announce: false,
  });
  assert.equal(surface.outbox.filter((r) => r.op === "send").length, 1);
  // no card to edit (the click came as a message): the line is said
  assert.equal(await settleClick({ action: click("x", {}, ""), conversation, note }, quiet, "Gone."), false);
  const broken = wrap(conversation, { update: () => Promise.reject(new Error("edit refused")) });
  assert.equal(await settleClick({ action: click("x"), conversation: broken, note }, quiet, "Still said."), false);
  assert.equal(text((surface.outbox.at(-1) as { message: OutMessage }).message), "Still said.");
  const mute = wrap(conversation, { send: () => Promise.reject(new Error("send refused")) });
  assert.equal(await settleClick({ action: click("x"), conversation: mute, note }, quiet, "Lost line."), true);
  const dead = wrap(broken, { send: () => Promise.reject(new Error("send refused")) });
  await assert.rejects(settleClick({ action: click("x"), conversation: dead, note }, quiet, "Nothing."));
});
