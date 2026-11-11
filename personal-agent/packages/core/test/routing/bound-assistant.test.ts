// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A person bound at the identity service with no linked key (chats on exchanged tokens, TEAMS_EXCHANGE_FOR_CHAT) talks
 * to the assistant in their 1:1 chat, as a linked person does. The assistant reaches only a person whose Claw user id
 * and subscription the worker knows, and both used to be made only from a link's key: such a person's every message
 * started a plain Claw session instead, with none of the assistant's tools.
 *
 * The router here is the real one, with the assistant's real chat and subscription keeper on one store.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { AssistantWorld } from "../../../../test-support/assistant/assistant-world.js";
import { ALICE } from "./fixtures.js";
import { link, message, said, world } from "./world.js";

const TOKEN = "tok-alice";

function boundWorld(options: { bound?: boolean; linkedKey?: string } = {}) {
  const aw = new AssistantWorld();
  const w = world({
    testStore: { store: aw.store, clock: aw.clock, encryptionKeys: [] },
    config: { exchangeForChat: true },
    assistantChat: aw.chat,
    ...(aw.subs ? { subscriptions: aw.subs } : {}),
  });
  if (options.bound ?? true) w.exchange.tokens.set(ALICE.id, TOKEN);
  w.owners.set(TOKEN, { id: "u-alice", name: "Liu, Alice", email: "alice@example.com", accountType: "" });
  if (options.linkedKey !== undefined) link(w, ALICE.id, options.linkedKey);
  return { aw, w };
}

test("a person bound with no link: their first 1:1 message goes to their assistant on their token, not to a new session", async () => {
  const { aw, w } = boundWorld();
  assert.equal(w.store.links.getKey(ALICE.id), null, "(no link)");

  await w.router.handle(message("connect my dev environment"));

  assert.equal(w.store.links.clawUserIdOf(ALICE.id), "u-alice", "the Claw user id is read with the token");
  assert.deepEqual(
    aw.subsClaw.calls.filter((c) => c.startsWith("create ")),
    [`create ${TOKEN}`],
  );
  assert.ok(aw.subs?.hasAssistantTypes(ALICE.id), "the subscription asks for the assistant's events");
  assert.deepEqual(
    aw.claw.heard.map((h) => [h.key, h.sessionId, h.text]),
    [[TOKEN, `asst-${TOKEN}`, "connect my dev environment"]],
    "the assistant heard it, in the session of the token's owner",
  );
  assert.deepEqual(w.turns.runs, [], "no plain Claw session was started");
  assert.ok(!said(w).includes("<view:binding>"), "a bound person is not asked to bind again");

  await w.router.handle(message("连接我的开发环境"));
  assert.deepEqual(
    aw.claw.heard.map((h) => h.text),
    ["connect my dev environment", "连接我的开发环境"],
  );
  assert.equal(aw.subsClaw.calls.filter((c) => c.startsWith("create ")).length, 1, "the subscription is made once");
  assert.deepEqual(w.turns.runs, []);
});

test("a person neither bound nor linked gets the card that binds them: no subscription, nothing to the assistant", async () => {
  const { aw, w } = boundWorld({ bound: false });

  await w.router.handle(message("connect my dev environment"));

  assert.deepEqual(said(w), ["<view:binding>"]);
  assert.equal(w.store.links.clawUserIdOf(ALICE.id), null);
  assert.deepEqual(aw.subsClaw.calls, []);
  assert.deepEqual(aw.claw.heard, []);
  assert.deepEqual(w.turns.runs, []);
});

test("a bound person whose Claw user id cannot be read yet: the message is a turn as before, and the next one reaches the assistant", async () => {
  const { aw, w } = boundWorld();
  w.owners.delete(TOKEN);

  await w.router.handle(message("hello"));
  assert.equal(w.store.links.clawUserIdOf(ALICE.id), null);
  assert.equal(aw.claw.heard.length, 0);
  assert.equal(w.turns.runs.length, 1, "a turn of Claw's, on the token");
  assert.equal(w.turns.runs[0]?.credential, TOKEN);

  w.owners.set(TOKEN, { id: "u-alice", name: "Liu, Alice", email: "", accountType: "" });
  await w.router.handle(message("again"));
  assert.equal(w.store.links.clawUserIdOf(ALICE.id), "u-alice");
  assert.deepEqual(
    aw.claw.heard.map((h) => [h.key, h.text]),
    [[TOKEN, "again"]],
  );
});

test("a linked person is unchanged: the subscription and the id come from the link's key, even while also bound", async () => {
  const { aw, w } = boundWorld({ linkedKey: "ak-alice" });
  w.owners.set("ak-alice", { id: "u-alice", name: "Liu, Alice", email: "", accountType: "" });

  await w.router.handle(message("hi"));

  assert.equal(w.store.links.clawUserIdOf(ALICE.id), "u-alice");
  assert.deepEqual(
    aw.subsClaw.calls.filter((c) => c.startsWith("create ")),
    ["create ak-alice"],
    "made with the key, as before",
  );
  assert.deepEqual(
    aw.claw.heard.map((h) => [h.key, h.text]),
    [[TOKEN, "hi"]],
    "(the chat itself runs on the token, as before)",
  );
});
