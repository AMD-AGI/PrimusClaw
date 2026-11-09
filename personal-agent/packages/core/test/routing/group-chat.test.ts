// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_group_chat.py: mention-only, per-sender identity, per-sender sessions, group commands. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE, BOB } from "./fixtures.js";
import { link, message, said, world } from "./world.js";

const CONV = "g-1";

function gmsg(text: string, options: { user?: typeof ALICE; id?: string; mentioned?: boolean } = {}) {
  const m = message(text, {
    kind: "group",
    conversation: CONV,
    ...(options.user ? { user: options.user } : {}),
    ...(options.id ? { id: options.id } : {}),
  });
  return { ...m, mentioned: options.mentioned ?? true };
}

test("test_group_message_without_a_mention_is_ignored", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(gmsg("lunch?", { mentioned: false }));
  await w.router.handle(gmsg("hi", { mentioned: false, id: "g2" }));
  assert.deepEqual(w.turns.calls, []);
  assert.deepEqual(w.surface.outbox, []);
});

test("test_group_message_from_b_never_uses_the_key_of_a", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  await w.router.handle(gmsg("from a", { id: "g1" }));
  await w.router.settled();
  await w.router.handle(gmsg("from b", { user: BOB, id: "g2" }));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [
    ["create", "ak-alice", "from a"],
    ["create", "ak-bob", "from b"],
  ]);
  assert.deepEqual(
    w.turns.runs.map((r) => r.group),
    [true, true],
  ); // (a group's session is created shared: it never carries the requester's memory)
  assert.ok(w.store.sessions.getSessionShared(ALICE.id, CONV) && w.store.sessions.getSessionShared(BOB.id, CONV));
});

test("test_a_one_to_one_session_keeps_memory", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(message("from a", { id: "p1" }));
  await w.router.settled();
  assert.deepEqual(
    w.turns.runs.map((r) => r.group),
    [false],
  );
  assert.equal(w.store.sessions.getSessionShared(ALICE.id), false);
});

test("test_a_group_session_made_before_it_could_be_shared_is_replaced", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  w.store.sessions.setSession(ALICE.id, { sessionId: "sess-old" }, CONV);
  await w.router.handle(gmsg("first", { id: "g1" }));
  await w.router.settled();
  await w.router.handle(gmsg("second", { id: "g2" }));
  await w.router.settled();
  assert.ok(!w.turns.calls.some((c) => c[0] === "send" && c[2] === "sess-old"));
  assert.deepEqual(w.turns.calls, [
    ["create", "ak-alice", "first"],
    ["send", "ak-alice", "sess-ak-alice", "second"],
  ]);
  assert.equal(w.store.sessions.getSession(ALICE.id, CONV), "sess-ak-alice");
  assert.ok(w.store.sessions.getSessionShared(ALICE.id, CONV));
});

test("test_unlinked_sender_gets_a_chat_reply_and_no_credential_is_used", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(gmsg("review the PR", { user: BOB }));
  assert.deepEqual(w.turns.calls, []);
  assert.deepEqual(said(w), ["<view:onboarding>"]);
  const [sent] = w.surface.outbox;
  assert.ok(sent?.op === "send" && sent.conversation === CONV); // (answered in the group)
  assert.ok(sent.message.body.type === "view" && sent.message.body.view.name === "onboarding");
  assert.equal(sent.message.body.view.model.name, "Bob");
  assert.equal(w.store.sessions.getSession(BOB.id, CONV), null);
});

test("test_group_traffic_saves_no_proactive_reference", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(gmsg("hello"));
  await w.router.settled();
  assert.equal(w.store.references.getReference(ALICE.id), null);
});

test("test_group_turn_creates_one_session_per_sender_and_reuses_it", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  for (const [text, user, id] of [
    ["one", ALICE, "g1"],
    ["two", BOB, "g2"],
    ["three", ALICE, "g3"],
  ] as const) {
    await w.router.handle(gmsg(text, { user, id }));
    await w.router.settled();
  }
  assert.equal(w.store.sessions.getSession(ALICE.id, CONV), "sess-ak-alice");
  assert.equal(w.store.sessions.getSession(BOB.id, CONV), "sess-ak-bob");
  assert.deepEqual(w.turns.calls.at(-1), ["send", "ak-alice", "sess-ak-alice", "three"]);
  assert.equal(w.store.sessions.getSession(ALICE.id), null); // (the 1:1 session is a different one)
});

test("test_group_commands_are_limited", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  const code = w.store.links.stashPending("ak-other");
  const texts = [
    `/link ${code}`,
    "/unlink",
    "/timezone Asia/Shanghai",
    "/pause 2h",
    "/quiet off",
    "/brief on 08:30",
    "/resume",
  ];
  for (const [i, text] of texts.entries()) {
    await w.router.handle(gmsg(text, { id: `c${String(i)}` }));
    assert.ok(said(w).at(-1)?.includes("1:1 chat"), text);
  }
  assert.deepEqual(w.turns.calls, []);
  assert.equal(w.store.links.getKey(ALICE.id), "ak-alice"); // (nothing executed)
  assert.equal(w.store.links.redeemPending(BOB.id, "Bob", code), "ok"); // (the code was not redeemed)
});

test("test_help_works_unlinked_and_mentions_the_review_flow_and_approval", async () => {
  const w = world();
  await w.router.handle(gmsg("/help"));
  const text = said(w).at(-1) ?? "";
  assert.ok(text.includes("connect it once in a 1:1 chat") && text.includes("approve or deny"));
  assert.deepEqual(w.turns.calls, []);
});

test("test_new_and_stop_only_touch_the_senders_own_group_session", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  w.store.sessions.setSession(ALICE.id, { sessionId: "s-a" }, CONV);
  w.store.sessions.setSession(BOB.id, { sessionId: "s-b" }, CONV);
  await w.router.handle(gmsg("/new", { user: BOB }));
  assert.equal(w.store.sessions.getSession(BOB.id, CONV), null);
  assert.equal(w.store.sessions.getSession(ALICE.id, CONV), "s-a");
});

test("test_whoami_in_a_group_does_not_print_the_email", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  w.owners.set("ak-alice", { id: "u", name: "alice", email: "alice@example.com", accountType: "sso" });
  await w.router.handle(gmsg("/whoami"));
  const text = said(w).at(-1) ?? "";
  assert.ok(text.includes("alice") && !text.includes("@example.com"));
  assert.equal(text, "Alice are connected to SaFE user alice.");
});
