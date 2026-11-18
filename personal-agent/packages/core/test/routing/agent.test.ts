// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_agent.py: the router's part of a 1:1 chat (the turn engine is a recording fake here). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE, BOB } from "./fixtures.js";
import { link, message, PUBLIC, said, world } from "./world.js";

test("test_unlinked_user_is_told_to_get_a_code_on_the_page_and_no_code_is_issued", async () => {
  const w = world();
  await w.router.handle(message("hi"));
  const [text = ""] = said(w);
  assert.equal(said(w).length, 1);
  assert.ok(text.includes(`${PUBLIC}/primus-claw/teams-link`) && text.includes("/link CODE"));
  assert.ok(!text.includes("code=") && !text.includes("?"));
  assert.deepEqual(w.turns.calls, []);
  assert.deepEqual(w.claw.calls, []);
});

test("test_link_command_binds_the_pending_key_to_the_sender", async () => {
  const w = world();
  const code = w.store.links.stashPending("ak-alice");
  await w.router.handle(message(`/link ${code.toLowerCase()}`));
  assert.equal(w.store.links.getKey(ALICE.id), "ak-alice");
  assert.ok(said(w).at(-1)?.includes("Connected"));
  await w.router.handle(message(`/link ${code}`, { user: BOB, id: "b1" })); // (single use)
  assert.equal(w.store.links.getKey(BOB.id), null);
  assert.ok(said(w).at(-1)?.includes("not valid"));
});

test("test_link_with_wrong_or_missing_code_is_one_generic_refusal", async () => {
  const w = world();
  w.store.links.stashPending("ak-alice");
  await w.router.handle(message("/link NOPE1234", { id: "a1" }));
  await w.router.handle(message("/link", { id: "a2" }));
  assert.deepEqual(said(w), Array(2).fill("That code is not valid or has expired. Get a new one on the console page."));
  assert.equal(w.store.links.getKey(ALICE.id), null);
});

test("test_link_attempts_are_rate_limited_per_user", async () => {
  const w = world();
  const code = w.store.links.stashPending("ak-alice");
  for (let i = 0; i < 5; i += 1) await w.router.handle(message("/link WRONG222", { id: `w${String(i)}` }));
  await w.router.handle(message(`/link ${code}`, { id: "right" }));
  assert.equal(w.store.links.getKey(ALICE.id), null);
  assert.ok(said(w).at(-1)?.includes("Too many"));
  await w.router.handle(message(`/link ${code}`, { user: BOB, id: "b1" })); // (another person is not affected)
  assert.equal(w.store.links.getKey(BOB.id), "ak-alice");
});

test("test_message_from_a_never_uses_the_key_of_b", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  await w.router.handle(message("from a", { id: "a1" }));
  await w.router.settled();
  await w.router.handle(message("from b", { user: BOB, id: "b1" }));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [
    ["create", "ak-alice", "from a"],
    ["create", "ak-bob", "from b"],
  ]);
  assert.equal(w.store.sessions.getSession(ALICE.id), "sess-ak-alice");
  assert.equal(w.store.sessions.getSession(BOB.id), "sess-ak-bob");
});

test("test_unlinked_b_cannot_ride_on_the_link_of_a", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(message("hello", { user: BOB, id: "b1" }));
  assert.deepEqual(w.turns.calls, []);
  assert.ok(said(w)[0]?.includes("/link CODE"));
});

test("test_second_message_reuses_the_session_and_new_starts_a_fresh_one", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  for (const [text, id] of [
    ["one", "a1"],
    ["two", "a2"],
    ["/new", "a3"],
  ] as const) {
    await w.router.handle(message(text, { id }));
    await w.router.settled();
  }
  assert.deepEqual(w.turns.calls[1], ["send", "ak-alice", "sess-ak-alice", "two"]);
  assert.equal(w.store.sessions.getSession(ALICE.id), null);
  assert.equal(said(w).at(-1), "Started a new session. What would you like to do?");
});

test("test_same_activity_delivered_twice_is_handled_once", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(message("once", { id: "dup" }));
  await w.router.settled();
  await w.router.handle(message("once", { id: "dup" }));
  await w.router.settled();
  assert.equal(w.turns.calls.filter((c) => c[0] === "create").length, 1);
});

test("test_help_and_group_chat", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(message("/help", { id: "h1" }));
  assert.ok(said(w).at(-1)?.includes("start a new session"));
  await w.router.handle(message("hi", { id: "g1", kind: "channel" }));
  assert.ok(said(w).at(-1)?.includes("one-to-one chat or a group chat"));
  assert.deepEqual(w.turns.calls, []);
});

test("test_stop_interrupts_only_when_a_task_runs", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(message("/stop", { id: "s0" }));
  assert.equal(said(w).at(-1), "Nothing is running.");
  assert.ok(!w.claw.calls.some((c) => c[0] === "interrupt"));
});

test("test_stop_during_a_running_turn (the router's part: the interrupt, and the turn told it was stopped)", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  let release = (): void => undefined;
  w.turns.hold = new Promise((resolve) => {
    release = resolve;
  });
  await w.router.handle(message("long task", { id: "t1" }));
  await w.router.handle(message("/stop", { id: "t2" }));
  release();
  await w.router.settled();
  assert.ok(w.claw.calls.some((c) => c.join() === "interrupt,ak-alice,sess-ak-alice"));
  assert.ok(said(w).includes("Stopping the running task."));
  assert.equal(said(w).at(-1), "Stopped.");
});

test("test_a_stop_claw_refused_leaves_a_failed_turn_said_as_an_error (the refusal is said)", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  w.claw.interruptFails = 500;
  let release = (): void => undefined;
  w.turns.hold = new Promise((resolve) => {
    release = resolve;
  });
  await w.router.handle(message("long task", { id: "t1" }));
  await w.router.handle(message("/stop", { id: "t2" }));
  w.turns.fail = true;
  release();
  await w.router.settled();
  assert.ok(said(w).includes("PrimusClaw could not stop the task (error 500)."));
  assert.ok(said(w).some((t) => t.startsWith("Something went wrong on my side (ref ")));
});

test("test_unlink_removes_the_link", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(message("/unlink"));
  assert.equal(w.store.links.getKey(ALICE.id), null);
  assert.ok(said(w).at(-1)?.includes("deleted"));
  assert.deepEqual(w.revoked, ["ak-alice"]);
});

test("test_link_success_names_the_safe_user_and_offers_unlink", async () => {
  const w = world();
  w.owners.set("ak-alice", { id: "u-a", name: "Alice Safe", email: "alice@example.com", accountType: "sso" });
  await w.router.handle(message(`/link ${w.store.links.stashPending("ak-alice")}`));
  const text = said(w).at(-1) ?? "";
  assert.ok(
    text.includes("SaFE user Alice Safe (alice@example.com)") && text.includes("If this is not you, send /unlink now."),
  );
  assert.equal(w.store.links.clawUserIdOf(ALICE.id), "u-a");
});

test("test_link_success_still_confirms_when_safe_cannot_say_who", async () => {
  const w = world();
  await w.router.handle(message(`/link ${w.store.links.stashPending("ak-alice")}`));
  assert.equal(w.store.links.getKey(ALICE.id), "ak-alice");
  const text = said(w).at(-1) ?? "";
  assert.ok(text.includes("Connected") && text.includes("send /unlink now"));
});

test("test_whoami_and_help_show_the_users_own_account", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  w.owners.set("ak-alice", { id: "u-a", name: "Alice Safe", email: "alice@example.com", accountType: "sso" });
  w.owners.set("ak-bob", { id: "u-b", name: "Bob Safe", email: "", accountType: "sso" });
  await w.router.handle(message("/whoami", { id: "w1" }));
  await w.router.handle(message("/whoami", { user: BOB, id: "w2" }));
  await w.router.handle(message("/help", { id: "h1" }));
  const [a = "", b = "", h = ""] = said(w);
  assert.ok(a.includes("Alice Safe (alice@example.com)") && !a.includes("Bob"));
  assert.ok(b.includes("Bob Safe") && !(b.split("Bob Safe")[1]?.split(".")[0] ?? "").includes("("));
  assert.ok(
    h.includes("Connected to SaFE user Alice Safe (alice@example.com).") &&
      h.includes("which account am I connected to"),
  );
});

test("test_whoami_for_an_unlinked_user_asks_to_connect", async () => {
  const w = world();
  await w.router.handle(message("/whoami"));
  assert.ok(said(w)[0]?.includes("/link CODE"));
});

test("test_memory_command_reports_each_users_own_state_and_links_the_page", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  link(w, BOB.id, "ak-bob");
  w.claw.memory = new Map([
    ["ak-alice", { enabled: true, available: true, items: ["likes tabs", "uses bash"] }],
    ["ak-bob", { enabled: false, available: true, items: [] }],
  ]);
  await w.router.handle(message("/memory", { id: "m1" }));
  await w.router.handle(message("/memory", { user: BOB, id: "m2" }));
  const [a = "", b = ""] = said(w);
  assert.ok(
    a.includes("**on**") &&
      a.includes("likes tabs") &&
      a.includes("uses bash") &&
      a.includes(`${PUBLIC}/primus-claw?memory=1`),
  );
  assert.ok(b.includes("**off**") && !b.includes("likes tabs") && b.includes(`${PUBLIC}/primus-claw?memory=1`));
  assert.deepEqual(
    w.claw.calls.filter((c) => c[0] === "memory"),
    [
      ["memory", "ak-alice"],
      ["memory", "ak-bob"],
    ],
  );
});

test("test_memory_command_survives_a_claw_error_and_an_unlinked_user", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  w.claw.memory = 500;
  await w.router.handle(message("/memory", { id: "m1" }));
  assert.ok(said(w)[0]?.includes("could not read") && said(w)[0]?.includes("/primus-claw?memory=1"));
  await w.router.handle(message("/memory", { user: BOB, id: "m2" }));
  assert.ok(said(w)[1]?.includes("/link CODE"));
});
