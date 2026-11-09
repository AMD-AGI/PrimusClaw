// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// An approval card that was recorded and never sent is not lost when its worker dies in between (teams/tests/
// test_approval_resend.py): the record carries the card, and the worker that starts next sends it. A restart is a second store
// on the same database file: it has none of the first process's memory (which cards that process is sending right now).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { it } from "node:test";

import type { JsonObject } from "../../src/json.js";
import { approvalEvent } from "../../../../test-support/assistant/approval-presses.js";
import {
  Gate,
  approvalCards,
  gateApprovalCards,
  sentMessages,
  turnShowsApproval,
} from "../../../../test-support/assistant/proactive-chat.js";
import { FakeClock } from "../../../../test-support/clock.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { advanceSeconds, openFileTestStore, openTestStore, tempDir } from "../../../../test-support/store.js";
import { ALICE, at, link, world } from "../proactive/world.js";

const SESSION = "sess-ak-alice";
const ENVELOPE = {
  operation: "send",
  reference: { conversation: { id: "c1" } },
  activity: { type: "message", text: "card" },
};

function row(raw: DatabaseSync, sessionId = "s1", toolUseId = "tu1") {
  const found = raw
    .prepare("SELECT card_sent, card_json, state FROM approvals WHERE session_id = ? AND tool_use_id = ?")
    .get(sessionId, toolUseId) as { card_sent: number; card_json: string | null; state: string } | undefined;
  if (found === undefined) return undefined;
  return [found.card_sent, found.card_json === null ? null : (JSON.parse(found.card_json) as JsonObject), found.state];
}

/** A store on a file (the first worker), and how to start the next one on it. */
function first(t: { after: (fn: () => void) => void }) {
  const clock = new FakeClock(at(12) * 1000);
  const file = openFileTestStore({ clock });
  t.after(() => {
    file.close();
  });
  const save = (envelope: JsonObject | null = ENVELOPE) =>
    file.store.approvals.saveApproval({
      userId: ALICE,
      sessionId: "s1",
      toolUseId: "tu1",
      tool: "bash",
      expiresAt: file.store.now() + 600,
      envelope,
    });
  const restart = () => file.reopen({ random: new SeededRandom(99) });
  return { ...file, save, restart };
}

it("a recorded card is kept with its approval until it is sent", (t) => {
  const f = first(t);
  assert.equal(f.save(), true);
  assert.deepEqual(row(f.raw), [0, ENVELOPE, "pending"]);
  f.store.approvals.approvalSent("s1", "tu1");
  assert.deepEqual(row(f.raw), [1, null, "pending"]); // nothing left to send, and the card is not kept
});

it("a card nobody recorded with an envelope cannot be sent again so it is not claimed", (t) => {
  const f = first(t);
  f.save(null);
  const reborn = f.restart(); // (not this process's own: that one is in flight)
  assert.deepEqual(reborn.approvals.claimUnsentApprovals(), []);
  assert.deepEqual(row(f.raw), [0, null, "pending"]); // left as it was
});

it("a new process finds the card the old one recorded and never sent", (t) => {
  const f = first(t);
  f.save();
  assert.deepEqual(f.store.approvals.claimUnsentApprovals(), []); // this process is sending it: in flight, not lost
  const reborn = f.restart();
  const claimed = reborn.approvals.claimUnsentApprovals();
  assert.deepEqual(
    claimed.map((c) => [c.sessionId, c.toolUseId, c.userId, c.envelope]),
    [["s1", "tu1", ALICE, ENVELOPE]],
  );
  assert.equal(reborn.approvals.approvalInFlight("s1", "tu1"), true);
  assert.deepEqual(reborn.approvals.claimUnsentApprovals(), []); // claimed once, until it ends
});

it("a card that could not be sent again is claimed again by the next sweep", (t) => {
  const f = first(t);
  f.save();
  const reborn = f.restart();
  assert.equal(reborn.approvals.claimUnsentApprovals().length, 1);
  reborn.approvals.approvalSendFailed("s1", "tu1");
  assert.equal(reborn.approvals.approvalInFlight("s1", "tu1"), false);
  assert.equal(row(f.raw)?.[0], 0); // still recorded, still unsent
  assert.equal(reborn.approvals.claimUnsentApprovals().length, 1);
});

it("a card whose time is up is closed not claimed", (t) => {
  const f = first(t);
  f.save();
  const reborn = f.restart();
  advanceSeconds(f.clock, 601);
  assert.deepEqual(reborn.approvals.claimUnsentApprovals(), []);
  assert.deepEqual(row(f.raw), [1, null, "expired"]);
});

it("an unreadable card is closed not claimed", (t) => {
  const f = first(t);
  f.save();
  f.raw.prepare("UPDATE approvals SET card_json = '{not json'").run();
  const reborn = f.restart(); // (the Python test cleared the process's in-flight set: a new process has none)
  assert.deepEqual(reborn.approvals.claimUnsentApprovals(), []);
  assert.equal(row(f.raw)?.[2], "expired");
});

it("an answered approval is never claimed", (t) => {
  const f = first(t);
  f.save();
  f.store.approvals.closeApproval("s1", "tu1", "decided");
  assert.deepEqual(f.restart().approvals.claimUnsentApprovals(), []);
});

it("a database from before the cards were kept opens and its approvals count as shown", (t) => {
  const dir = tempDir();
  t.after(dir.remove);
  const path = join(dir.path, "old.db");
  const clock = new FakeClock(at(12) * 1000);
  const old = new DatabaseSync(path);
  old.exec(
    "CREATE TABLE approvals (session_id TEXT NOT NULL, tool_use_id TEXT NOT NULL, aad_id TEXT NOT NULL, " +
      "tool TEXT NOT NULL, expires_at REAL NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at REAL NOT NULL, " +
      "PRIMARY KEY (session_id, tool_use_id))",
  );
  old.prepare("INSERT INTO approvals VALUES ('s1', 'tu1', 'aad-a', 'bash', ?, 'pending', 1)").run(at(12) + 600);
  old.close();
  const { store } = openTestStore({ clock, path });
  const raw = new DatabaseSync(path);
  t.after(() => {
    store.close();
    raw.close();
  });
  assert.deepEqual(row(raw), [1, null, "pending"]);
  assert.equal(store.approvals.getApproval("s1", "tu1")?.userId, "aad-a");
  assert.deepEqual(store.approvals.claimUnsentApprovals(), []);
  const saved = store.approvals.saveApproval({
    userId: "aad-a",
    sessionId: "s1",
    toolUseId: "tu2",
    tool: "bash",
    expiresAt: store.now() + 600,
    envelope: ENVELOPE,
  });
  assert.equal(saved, true);
  assert.equal(row(raw, "s1", "tu2")?.[0], 0);
});

/** The first worker: Alice linked, her chat turn recording its approval card and dying inside the send (never sent). */
async function turnDiesInItsSend(t: { after: (fn: () => void) => void }) {
  const f = first(t);
  const w = world({ on: { store: f.store, clock: f.clock } });
  link(w.store, "ak-alice");
  const conversation = w.deps.conversationFor(w.reference);
  await turnShowsApproval(w.store, conversation, { userId: ALICE, sessionId: SESSION, toolUseId: "tu1", send: false });
  assert.equal(w.store.approvals.approvalInFlight(SESSION, "tu1"), true);
  assert.deepEqual(approvalCards(w.surface.outbox), []);
  const card = conversation.outgoing({ body: { type: "text", text: "turn approval tu1" } });
  return { f, card, next: () => world({ on: { store: f.restart(), clock: f.clock } }) };
}

it("a worker that dies after recording the turns card and before sending it sends it when it restarts", async (t) => {
  const { f, card, next } = await turnDiesInItsSend(t);
  const reborn = next();
  assert.equal(reborn.store.approvals.getApproval(SESSION, "tu1")?.userId, ALICE);
  assert.equal(reborn.store.approvals.approvalInFlight(SESSION, "tu1"), false);
  assert.equal(await reborn.release.resendUnsentApprovals(), 1);
  assert.deepEqual(approvalCards(reborn.surface.outbox), ["tu1"]);
  assert.deepEqual(sentMessages(reborn.surface.outbox), [card["message"]]); // the very card the turn was about to send
  assert.deepEqual(row(f.raw, SESSION), [1, null, "pending"]); // and it is answerable: Approve still has its record
  assert.equal(await reborn.release.resendUnsentApprovals(), 0); // once, not on every sweep
  assert.equal(approvalCards(reborn.surface.outbox).length, 1);
});

it("the notification retried after the restart is dropped and the owner still gets the one card", async (t) => {
  const { next } = await turnDiesInItsSend(t);
  const reborn = next();
  const notification = approvalEvent({ sessionId: SESSION, toolUseId: "tu1" });
  assert.equal(await reborn.proactive.handle(ALICE, reborn.reference, notification), "dropped");
  assert.deepEqual(approvalCards(reborn.surface.outbox), []); // the handler shows nothing: the recorded card is the one
  assert.equal(await reborn.release.resendUnsentApprovals(), 1);
  assert.equal(await reborn.proactive.handle(ALICE, reborn.reference, notification), "dropped");
  assert.equal(approvalCards(reborn.surface.outbox).length, 1);
});

it("a card a live worker is sending is not sent a second time by the sweep", async () => {
  const w = world({ now: at(12) });
  link(w.store, "ak-alice");
  const gate = new Gate();
  gateApprovalCards(w.surface, gate.pass);
  const conversation = w.deps.conversationFor(w.reference);
  const turn = turnShowsApproval(w.store, conversation, { userId: ALICE, sessionId: SESSION, toolUseId: "tu1" });
  assert.equal(w.store.approvals.approvalInFlight(SESSION, "tu1"), true);
  const swept = await w.release.resendUnsentApprovals(); // the timer fires while the turn's send is under way
  gate.open();
  await turn;
  assert.deepEqual([swept, await w.release.resendUnsentApprovals()], [0, 0]);
  assert.equal(approvalCards(w.surface.outbox).length, 1);
});

it("a card that was sent is never sent again", async (t) => {
  const f = first(t);
  const w = world({ on: { store: f.store, clock: f.clock } });
  const conversation = w.deps.conversationFor(w.reference);
  await turnShowsApproval(w.store, conversation, { userId: ALICE, sessionId: SESSION, toolUseId: "tu1" });
  assert.equal(approvalCards(w.surface.outbox).length, 1);
  assert.deepEqual(row(f.raw, SESSION), [1, null, "pending"]);
  assert.equal(await w.release.resendUnsentApprovals(), 0);
  assert.equal(approvalCards(w.surface.outbox).length, 1);
});

it("a worker that dies after recording the notifications card and before sending it sends it when it restarts", async (t) => {
  const f = first(t);
  const w = world({ on: { store: f.store, clock: f.clock } });
  link(w.store, "ak-alice");
  const gate = new Gate();
  gateApprovalCards(w.surface, gate.pass);
  const pending = w.proactive.handle(ALICE, w.reference, approvalEvent({ sessionId: SESSION, toolUseId: "tu1" }));
  await f.clock.advance(0);
  assert.equal(w.store.approvals.approvalInFlight(SESSION, "tu1"), true);
  assert.deepEqual(approvalCards(w.surface.outbox), []);
  const reborn = world({ on: { store: f.restart(), clock: f.clock } }); // ... and the process dies here
  assert.equal(await reborn.release.resendUnsentApprovals(), 1);
  assert.deepEqual(approvalCards(reborn.surface.outbox), ["tu1"]);
  gate.open(); // (lets the first process's own send end)
  assert.equal(await pending, "delivered");
  assert.deepEqual(sentMessages(reborn.surface.outbox), sentMessages(w.surface.outbox)); // the same card, to the same chat
  assert.deepEqual(
    reborn.surface.outbox.map((r) => r.conversation),
    w.surface.outbox.map((r) => r.conversation),
  );
  assert.equal(await reborn.release.resendUnsentApprovals(), 0);
});

it("a failed second send leaves the card recorded and the next sweep sends it", async (t) => {
  const { f, next } = await turnDiesInItsSend(t);
  const reborn = next();
  let refusals = 1;
  gateApprovalCards(reborn.surface, () => {
    if (refusals === 0) return Promise.resolve();
    refusals -= 1;
    return Promise.reject(new Error("the queue is down"));
  });
  assert.equal(await reborn.release.resendUnsentApprovals(), 0); // the queue is down: nothing went out, nothing is lost
  assert.equal(row(f.raw, SESSION)?.[0], 0);
  assert.equal(reborn.store.approvals.approvalInFlight(SESSION, "tu1"), false);
  assert.deepEqual(approvalCards(reborn.surface.outbox), []);
  assert.equal(await reborn.release.resendUnsentApprovals(), 1); // the next sweep
  assert.equal(approvalCards(reborn.surface.outbox).length, 1);
  assert.equal(await reborn.release.resendUnsentApprovals(), 0);
});

it("a card whose time ran out before the worker came back is not sent", async (t) => {
  const { f, next } = await turnDiesInItsSend(t);
  const reborn = next();
  advanceSeconds(f.clock, 3600); // Brain stopped waiting long ago: a card now would be a trap
  assert.equal(await reborn.release.resendUnsentApprovals(), 0);
  assert.equal(reborn.surface.outbox.length, 0);
  assert.equal(reborn.store.approvals.getApproval(SESSION, "tu1")?.state, "expired");
});

it("an outbox that is cancelled mid send gives the card back and the sweep goes on", async (t) => {
  const { f, next } = await turnDiesInItsSend(t);
  const reborn = next();
  const gate = new Gate();
  gateApprovalCards(reborn.surface, gate.pass);
  const sweep = reborn.release.resendUnsentApprovals();
  await f.clock.advance(0);
  assert.equal(reborn.store.approvals.approvalInFlight(SESSION, "tu1"), true); // the send is under way
  const abort = new Error("the worker is shutting down");
  abort.name = "AbortError";
  gate.fail(abort);
  await assert.rejects(sweep, (error: Error) => error.name === "AbortError"); // the shutdown is not swallowed by the retry
  assert.equal(reborn.store.approvals.approvalInFlight(SESSION, "tu1"), false);
  assert.equal(row(f.raw, SESSION)?.[0], 0); // recorded, unsent: for the next process
});

it("a group chats card is sent again to that group and still hides the tool input", async (t) => {
  // (masking credential shapes in a group's envelope is the channel's `outgoing`; here: the stored envelope goes out as built)
  const f = first(t);
  const group = "19:group@thread.v2";
  const w = world({ on: { store: f.store, clock: f.clock } });
  link(w.store, "ak-alice"); // (Alice, as the world has her; Carol below is only in the group: no 1:1 chat with the bot)
  const carol = "aad-c";
  w.store.links.redeemPending(carol, "Carol", w.store.links.stashPending("ak-carol"));
  const conversation = w.deps.conversationFor({ conversation: { id: group } });
  await turnShowsApproval(w.store, conversation, { userId: carol, sessionId: SESSION, toolUseId: "tu9", send: false });
  const stored = conversation.outgoing({ body: { type: "text", text: "turn approval tu9" } });
  assert.equal(w.store.references.getReference(carol), null);
  const reborn = world({ on: { store: f.restart(), clock: f.clock } });
  assert.equal(await reborn.release.resendUnsentApprovals(), 1);
  assert.deepEqual(
    reborn.surface.outbox.map((r) => r.conversation),
    [group],
  );
  assert.deepEqual(sentMessages(reborn.surface.outbox), [stored["message"]]);
  assert.ok(!JSON.stringify(reborn.surface.outbox).includes("SECRET"));
  assert.deepEqual(row(f.raw, SESSION, "tu9"), [1, null, "pending"]);
});
