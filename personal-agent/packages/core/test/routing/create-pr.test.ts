// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_changes_card.py (the Create PR button and a group's turn), as the router handles them. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CREATE_PR_TEXT } from "../../src/locales/sessions.js";
import { ALICE } from "./fixtures.js";
import { clickOf, link, message, said, world } from "./world.js";

const SESSION = "sess-ak-alice";

async function withSession() {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(message("fix the build"));
  await w.router.settled();
  return w;
}

test("test_create_pr_asks_the_agent_in_this_chats_session_and_replaces_the_card", async () => {
  const w = await withSession();
  await w.router.handle(clickOf("create_pr", { session_id: SESSION }, { card: "card-changes" }));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [
    ["create", "ak-alice", "fix the build"],
    ["send", "ak-alice", SESSION, CREATE_PR_TEXT],
  ]);
  const update = w.surface.outbox.find((r) => r.op === "update");
  assert.ok(update?.op === "update" && update.id === "card-changes");
  assert.ok(
    said(w).some((t) => t.includes("Asking the agent to open a pull request") && t.includes("approval request")),
  );
});

for (const sessionId of ["", "sess-someone-else", "sess-ak-alice-2", null, ["sess-ak-alice"]]) {
  test(`test_a_card_for_another_session_starts_nothing ${JSON.stringify(sessionId)}`, async () => {
    const w = await withSession();
    await w.router.handle(clickOf("create_pr", { session_id: sessionId }, { card: "card-changes" }));
    await w.router.settled();
    assert.equal(w.turns.calls.length, 1);
    assert.ok(said(w).at(-1)?.includes("another session"));
  });
}

test("test_create_pr_while_a_task_runs_puts_the_card_back_with_its_button", async () => {
  const w = await withSession();
  let release = (): void => undefined;
  w.turns.hold = new Promise((resolve) => {
    release = resolve;
  });
  await w.router.handle(message("another task"));
  await w.router.handle(clickOf("create_pr", { session_id: SESSION }, { card: "card-changes" }));
  release();
  await w.router.settled();
  assert.ok(
    said(w).includes(
      "note::I am still working on your previous message. Send /stop first, then tap Create PR again. [Create PR]",
    ),
  );
  assert.ok(!w.turns.calls.some((c) => c.includes(CREATE_PR_TEXT)));
});

test("test_a_session_made_before_the_plugin_setting_changed_is_not_continued_by_a_button", async () => {
  const w = world({ config: { pluginId: "2" } });
  link(w, ALICE.id, "ak-alice");
  w.store.sessions.setSession(ALICE.id, { sessionId: SESSION, pluginId: "" });
  await w.router.handle(clickOf("create_pr", { session_id: SESSION }, { card: "card-changes" }));
  assert.deepEqual(w.turns.calls, []);
  assert.ok(said(w).at(-1)?.includes("cannot be continued"));
});

test("test_create_pr_from_a_chat_that_is_not_connected_is_refused_like_any_button", async () => {
  const w = world();
  await w.router.handle(clickOf("create_pr", { session_id: SESSION }, { card: "card-changes" }));
  assert.deepEqual(
    w.surface.outbox.slice(-2).map((r) => r.op),
    ["update", "send"],
  );
  assert.ok(said(w).at(-1)?.includes("not connected"));
});

test("test_a_group_chat_gets_no_changes_card (the group's turn shows no changes)", async () => {
  const w = world();
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(message("fix it", { kind: "group", conversation: "g-1" }));
  await w.router.settled();
  await w.router.handle(message("fix it here"));
  await w.router.settled();
  assert.deepEqual(
    w.turns.runs.map((r) => r.showChanges),
    [false, true],
  );
});
