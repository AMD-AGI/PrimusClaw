// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { ASSISTANT_RELEASE_MAX, REMOTE_RELEASE_MAX } from "../../src/proactive/release.js";
import { FakeClock } from "../../../../test-support/clock.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { advanceSeconds, openFileTestStore } from "../../../../test-support/store.js";
import { DirectChat } from "../../src/direct-chat/direct-chat.js";
import { ALICE, at, event, link, shown, world } from "./world.js";

const APPROVAL = (id = "tu-1", extra: Record<string, unknown> = {}) =>
  event("approval.requested", `ap-${id}`, {
    approval: { tool: "bash", tool_use_id: id, target: "make clean", expires_at: "2026-10-27T05:00:00Z" },
    ...extra,
  });
const SAY = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant.say",
  event_id: id,
  text,
  ...extra,
});

it("outside quiet hours a notice is sent at once", async () => {
  const w = world();
  link(w.store);
  assert.equal(await w.proactive.handle(ALICE, w.reference, event()), "delivered");
  assert.deepEqual(shown(w.surface.outbox), ["send view:runEvent"]);
  assert.deepEqual(w.runs.changes, ["s1"]);
});

it("notices during quiet hours are held and sent as one summary afterwards", async () => {
  const w = world({ now: at(23) });
  w.store.prefs.setQuiet(ALICE, ["22:00", "08:00"]);
  assert.equal(await w.proactive.handle(ALICE, w.reference, event("run.completed", "e1")), "held");
  assert.equal(await w.proactive.handle(ALICE, w.reference, event("run.failed", "e2")), "held");
  await w.release.releaseDue();
  assert.deepEqual(shown(w.surface.outbox), []);
  advanceSeconds(w.clock, 10 * 3600);
  await w.release.releaseDue();
  assert.deepEqual(shown(w.surface.outbox), ["send view:digest"]);
});

it("a single held notice is sent as itself not as a summary", async () => {
  const w = world({ now: at(23) });
  w.store.prefs.setQuiet(ALICE, ["22:00", "08:00"]);
  await w.proactive.handle(ALICE, w.reference, event());
  advanceSeconds(w.clock, 10 * 3600);
  await w.release.release(ALICE);
  assert.deepEqual(shown(w.surface.outbox), ["send view:runEvent"]);
});

it("an approval is not pushed during quiet hours and one that ran out is counted in the summary", async () => {
  const w = world({ now: at(12, 50) });
  w.store.prefs.setPausedUntil(ALICE, at(14));
  assert.equal(await w.proactive.handle(ALICE, w.reference, APPROVAL()), "held");
  advanceSeconds(w.clock, 3600);
  w.store.prefs.setPausedUntil(ALICE, null);
  await w.release.release(ALICE);
  assert.deepEqual(shown(w.surface.outbox), ["send view:digest"]);
});

it("a held approval still valid is pushed as a live card recorded with its envelope", async () => {
  const w = world({ now: at(12) });
  w.store.prefs.setPausedUntil(ALICE, at(12, 30));
  await w.proactive.handle(ALICE, w.reference, APPROVAL());
  advanceSeconds(w.clock, 1800);
  w.store.prefs.setPausedUntil(ALICE, null);
  await w.release.release(ALICE);
  assert.deepEqual(shown(w.surface.outbox), ["send view:proactiveApproval"]);
  assert.equal(w.store.approvals.getApproval("s1", "tu-1")?.userId, ALICE);
  assert.equal(await w.proactive.handle(ALICE, w.reference, APPROVAL()), "dropped");
});

it("an approval out of time or malformed is dropped and a work items question is its card", async () => {
  const w = world({ now: at(14) });
  assert.equal(await w.proactive.handle(ALICE, w.reference, APPROVAL()), "dropped");
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, event("approval.requested", "x", { approval: {} })),
    "dropped",
  );
  const question = APPROVAL("tu-q", {
    source: "assistant_item",
    approval: { tool: "ask_user_question", tool_use_id: "tu-q", expires_at: "2026-10-27T07:00:00Z" },
  });
  assert.equal(await w.proactive.handle(ALICE, w.reference, question), "delivered");
  const item = APPROVAL("tu-i", {
    source: "assistant_item",
    approval: { tool: "git_push", tool_use_id: "tu-i", expires_at: "2026-10-27T07:00:00Z" },
  });
  assert.equal(await w.proactive.handle(ALICE, w.reference, item), "delivered");
  assert.deepEqual(shown(w.surface.outbox), ["send view:itemQuestion", "send view:itemApproval"]);
});

it("the assistants words reach the person in the reply window even in quiet hours and are held outside it", async () => {
  const w = world({ now: at(23) });
  w.store.prefs.setQuiet(ALICE, ["22:00", "08:00"]);
  w.store.references.saveReference(ALICE, w.reference);
  assert.equal(await w.proactive.handle(ALICE, w.reference, SAY("s1", "节点都好。")), "delivered");
  advanceSeconds(w.clock, 31 * 60);
  assert.equal(await w.proactive.handle(ALICE, w.reference, SAY("s2", "又一件事。")), "held");
  w.store.prefs.setPausedUntil(ALICE, w.store.now() + 60);
  assert.equal(w.proactive.reachable(ALICE), false);
});

it("what was held comes one message at a time and a long absence sends the latest with one line for the rest", async () => {
  const w = world({ now: at(23) });
  w.store.prefs.setQuiet(ALICE, ["22:00", "08:00"]);
  advanceSeconds(w.clock, 3600);
  for (let i = 0; i < ASSISTANT_RELEASE_MAX + 2; i += 1)
    await w.proactive.handle(ALICE, w.reference, SAY(`s${String(i)}`, `msg ${String(i)}`));
  for (let i = 0; i < REMOTE_RELEASE_MAX + 1; i += 1)
    w.proactive.holdRemote(ALICE, "Claude Code", `said ${String(i)}`, `r${String(i)}`);
  advanceSeconds(w.clock, 9 * 3600);
  await w.release.release(ALICE);
  const out = shown(w.surface.outbox);
  assert.equal(
    out[0],
    "send 2 earlier messages from your assistant are not shown here. Send /board to see where your tasks stand.",
  );
  assert.equal(out.filter((l) => l.includes("msg ")).length, ASSISTANT_RELEASE_MAX);
  assert.ok(
    out.includes(
      "send 1 earlier messages from your remote agent are not shown here: `/agent sessions` takes you back to the session.",
    ),
  );
  assert.equal(out.filter((l) => l.includes("Claude Code: said")).length, REMOTE_RELEASE_MAX);
});

it("a failed release keeps everything for the next sweep", async () => {
  const w = world({ now: at(23) });
  w.store.prefs.setQuiet(ALICE, ["22:00", "08:00"]);
  advanceSeconds(w.clock, 3600);
  await w.proactive.handle(ALICE, w.reference, SAY("s1", "x"));
  advanceSeconds(w.clock, 9 * 3600);
  w.surface.conversation = () => {
    throw new Error("down");
  };
  await w.release.releaseDue();
  assert.equal(w.store.held.usersWithHeld().length, 1);
});

it("a say that amends or replaces an earlier one edits it", async () => {
  const w = world();
  await w.proactive.handle(ALICE, w.reference, SAY("e1", "已开始：#3 修测试"));
  await w.proactive.handle(ALICE, w.reference, SAY("e2", "我会在 PR 里说明。", { amends: "e1" }));
  await w.proactive.handle(ALICE, w.reference, SAY("e3", "查好了：都正常。", { replaces: "e1" }));
  await w.proactive.handle(ALICE, w.reference, SAY("e4", "unknown amends", { amends: "nope" }));
  assert.deepEqual(shown(w.surface.outbox), [
    "post 已开始：#3 修测试",
    "update 已开始：#3 修测试\n\n我会在 PR 里说明。",
    "update 查好了：都正常。",
    "post unknown amends",
  ]);
});

it("without message ids a say is sent and not remembered", async () => {
  const w = world({ messageIds: false });
  await w.proactive.handle(ALICE, w.reference, SAY("e1", "one"));
  await w.proactive.handle(ALICE, w.reference, SAY("e2", "two", { amends: "e1" }));
  assert.deepEqual(shown(w.surface.outbox), ["send one", "send two"]);
});

it("a say with no words and no files says nothing", async () => {
  const w = world();
  assert.equal(await w.proactive.handle(ALICE, w.reference, SAY("e1", "  ")), "dropped");
});

it("a pushed permission request is its card once and one that ran out shows nothing", async () => {
  const w = world();
  const ask = (actionId: string, expires = "2026-10-27T04:30:00Z") =>
    SAY(`p-${actionId}`, "needs you", {
      remote: {
        kind: "needs_you",
        session_id: "rs-1",
        ask: { action_id: actionId, tool: "Bash", options: [{ optionId: "allow" }], expires_at: expires },
      },
    });
  assert.equal(await w.proactive.handle(ALICE, w.reference, ask("a1")), "delivered");
  assert.equal(await w.proactive.handle(ALICE, w.reference, ask("a1")), "dropped");
  assert.equal(await w.proactive.handle(ALICE, w.reference, ask("a2", "2026-10-27T03:00:00Z")), "dropped");
  assert.deepEqual(shown(w.surface.outbox), ["send ask rs-1 a1"]);
  assert.equal(w.store.remotePermissions.getRemotePermission("rs-1", "a1")?.userId, ALICE);
});

it("a run answered in the chat is dropped and a lost turns answer is sent with one line", async () => {
  const w = world();
  w.store.turns.turnStarted("s1", { prompt: "看看构建为什么挂了" });
  w.store.turns.turnDelivered("s1");
  const done = event("run.completed", "e1", { occurred_at: new Date(w.store.now() * 1000).toISOString() });
  assert.equal(await w.proactive.handle(ALICE, w.reference, done), "dropped");
  const clock = new FakeClock(at(12) * 1000);
  const file = openFileTestStore({ clock });
  try {
    file.store.turns.turnStarted("s1", { prompt: "看看构建为什么挂了" });
    const next = file.reopen({ random: new SeededRandom(99) }); // (a later worker: the turn died with the one before)
    const lost = world({ on: { store: next, clock } });
    link(next);
    lost.runs.answers.set("s1", ["构建挂在 lint。"]);
    advanceSeconds(clock, 60);
    const finished = event("run.completed", "e2", { occurred_at: new Date(next.now() * 1000).toISOString() });
    assert.equal(await lost.proactive.handle(ALICE, lost.reference, finished), "delivered");
    const out = shown(lost.surface.outbox);
    assert.ok(
      out[0]?.startsWith("send Clawy 重启打断了上一轮，这是你问的「看看构建为什么挂了」的回答："),
      String(out[0]),
    );
    assert.deepEqual(lost.runs.changes, ["s1"]);
  } finally {
    file.close();
  }
});

it("approval cards recorded and never sent are sent again by the next worker", async () => {
  const clock = new FakeClock(at(12) * 1000);
  const file = openFileTestStore({ clock });
  try {
    const first = file.store;
    first.references.saveReference(ALICE, { conversation: { id: `c-${ALICE}` } });
    first.approvals.saveApproval({
      userId: ALICE,
      sessionId: "s1",
      toolUseId: "tu-9",
      tool: "bash",
      expiresAt: first.now() + 600,
      envelope: {
        operation: "send",
        conversation: `c-${ALICE}`,
        message: { body: { type: "text", text: "approve?" } },
      },
    });
    const w = world({ on: { store: file.reopen({ random: new SeededRandom(99) }), clock } });
    assert.equal(await w.release.resendUnsentApprovals(), 1);
    assert.equal(await w.release.resendUnsentApprovals(), 0);
    assert.deepEqual(shown(w.surface.outbox), ["send approve?"]);
  } finally {
    file.close();
  }
});

it("with direct chat on but the chat not attached an amending say still edits the message", async () => {
  const w = world({ direct: new DirectChat(true, [ALICE]) });
  await w.proactive.handle(ALICE, w.reference, SAY("e1", "收到，我查一下"));
  await w.proactive.handle(ALICE, w.reference, SAY("e2", "查好了：都正常。", { replaces: "e1" }));
  assert.deepEqual(shown(w.surface.outbox), ["post 收到，我查一下", "update 查好了：都正常。"]);
});

it("with direct chat on and the chat attached to a session an amending say is a message of its own", async () => {
  const w = world({ direct: new DirectChat(true, [ALICE]) });
  w.store.remoteState.attachRemote(ALICE, {
    sessionId: "rs-1",
    connectorId: "c1",
    agentId: "claude",
    agentLabel: "\u{1F7E0} Claude Code",
    host: "robin-dev",
    cwd: "/repo",
  });
  await w.proactive.handle(ALICE, w.reference, SAY("e1", "收到，我查一下"));
  await w.proactive.handle(ALICE, w.reference, SAY("e2", "查好了：都正常。", { replaces: "e1" }));
  const out = shown(w.surface.outbox);
  assert.equal(out.length, 2);
  assert.ok(
    out.every((line) => line.startsWith("post 💬 **Clawy**")),
    out.join("\n"),
  );
});
