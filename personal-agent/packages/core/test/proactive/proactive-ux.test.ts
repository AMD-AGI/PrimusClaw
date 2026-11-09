// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Quiet hours and /pause (teams/tests/test_proactive_ux.py): what is held while a person may not be woken, what is released when
// they can be again, and approvals that run out while held. The commands themselves (/quiet, /pause, /resume) are the router's:
// here the person's preferences are set in the store as those commands set them.
import assert from "node:assert/strict";
import { it } from "node:test";

import { PAUSE_FOREVER } from "../../src/ports/store/policy.js";
import { approvalEvent } from "../../../../test-support/assistant/approval-presses.js";
import { BOB, linkUser, referenceOf, sentViews } from "../../../../test-support/assistant/proactive-chat.js";
import { advanceSeconds } from "../../../../test-support/store.js";
import { ALICE, at, event, link, world } from "../../../../test-support/assistant/proactive-world.js";

const QUIET: readonly [string, string] = ["22:00", "08:00"];

/** Alice and Bob linked, both with the default quiet hours (22:00-08:00) the Python store starts with, at `now`. */
function two(now = at(12)) {
  const w = world({ now });
  link(w.store, "ak-alice");
  linkUser(w.store, BOB, "Bob", "ak-bob");
  w.store.prefs.setQuiet(ALICE, QUIET);
  w.store.prefs.setQuiet(BOB, QUIET);
  return w;
}

type World = ReturnType<typeof two>;

function setNow(w: World, seconds: number): void {
  w.clock.setEpochMs(seconds * 1000);
}

function push(w: World, userId: string, ev: Record<string, unknown>) {
  const reference = w.store.references.getReference(userId) ?? referenceOf(userId);
  return w.proactive.handle(userId, reference, ev as never);
}

const views = (w: World) => sentViews(w.surface.outbox);

it("notices during quiet hours are held and sent as one summary afterwards", async () => {
  const w = two(at(23));
  const outcomes = [];
  for (let i = 0; i < 3; i += 1) {
    const ev = event("run.completed", `e${String(i)}`, { title: `Run completed: job${String(i)}` });
    outcomes.push(await push(w, ALICE, ev));
  }
  assert.deepEqual(outcomes, ["held", "held", "held"]);
  await w.release.releaseDue();
  assert.equal(w.surface.outbox.length, 0); // still quiet: nothing pushed, nothing released
  setNow(w, at(8, 1, 28));
  await w.release.releaseDue();
  const [digest, ...rest] = views(w);
  assert.ok(digest);
  assert.equal(digest.name, "digest");
  assert.equal((digest.model["events"] as unknown[]).length, 3);
  assert.equal(digest.model["expiredApprovals"], 0);
  assert.deepEqual(rest, []);
  assert.deepEqual(
    w.surface.outbox.map((r) => r.conversation),
    [`c-${ALICE}`],
  );
  await w.release.releaseDue();
  assert.equal(w.surface.outbox.length, 1); // released once, not again
});

it("a single held notice is sent as itself not as a summary", async () => {
  const w = two(at(23));
  await push(w, ALICE, event("run.failed", "ev-1", { title: "Run failed: sweep", summary: "OOM" }));
  setNow(w, at(9, 0, 28));
  await w.release.releaseDue();
  const [card, ...rest] = views(w);
  assert.ok(card);
  assert.equal(card.name, "runEvent");
  const shown = card.model["event"] as Record<string, unknown>;
  assert.deepEqual([shown["type"], shown["title"], shown["summary"]], ["run.failed", "Run failed: sweep", "OOM"]);
  assert.deepEqual(rest, []);
});

it("outside quiet hours a notice is sent at once", async () => {
  const w = two();
  assert.equal(await push(w, ALICE, event()), "delivered");
  assert.equal(views(w).length, 1);
});

it("quiet hours are per user in the users own zone", async () => {
  const w = two();
  w.store.prefs.setTimezone(BOB, "America/Los_Angeles");
  setNow(w, at(14)); // 23:00 PDT for Bob; 14:00 for Alice
  assert.equal(await push(w, ALICE, event("run.completed", "a")), "delivered");
  assert.equal(await push(w, BOB, event("run.completed", "b", { user_id: "u-bob" })), "held");
});

it("turning quiet hours off releases what was held right away", async () => {
  // (the /quiet off command releases what was held: the router calls `release` once the store says quiet hours are off)
  const w = two(at(23));
  assert.equal(await push(w, ALICE, event()), "held");
  w.store.prefs.setQuiet(ALICE, null);
  await w.release.release(ALICE);
  assert.equal(views(w).length, 1);
});

it("an approval is not pushed during quiet hours", async () => {
  const w = two(at(23));
  assert.equal(await push(w, ALICE, approvalEvent({ expiresAt: "2026-10-27T15:30:00Z" })), "held"); // 23:30 Shanghai
  assert.equal(w.surface.outbox.length, 0);
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1"), null); // no card exists, so there is nothing to click
});

it("a held approval that ran out is not shown and the summary says so", async () => {
  const w = two(at(23));
  await push(w, ALICE, approvalEvent({ expiresAt: "2026-10-27T15:30:00Z" }));
  setNow(w, at(8, 1, 28));
  await w.release.releaseDue();
  const [digest, ...rest] = views(w);
  assert.ok(digest);
  assert.equal(digest.name, "digest");
  assert.equal(digest.model["expiredApprovals"], 1);
  assert.deepEqual(digest.model["events"], []);
  assert.deepEqual(rest, []); // no live approval card: nothing to press
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1"), null);
});

it("a held approval still valid when quiet ends is pushed as a live card", async () => {
  const w = two(at(7, 50, 28));
  assert.equal(await push(w, ALICE, approvalEvent({ expiresAt: "2026-10-28T00:30:00Z" })), "held"); // 08:30 Shanghai
  setNow(w, at(8, 5, 28));
  await w.release.releaseDue();
  const [card, ...rest] = views(w);
  assert.ok(card);
  assert.equal(card.name, "proactiveApproval");
  assert.deepEqual(rest, []);
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1")?.state, "pending");
});

it("an approval that is already out of time or malformed is dropped", async () => {
  const w = two();
  assert.equal(await push(w, ALICE, approvalEvent({ expiresAt: "2026-10-26T00:00:00Z" })), "dropped");
  assert.equal(await push(w, ALICE, event("approval.requested", "x1")), "dropped");
  assert.equal(w.surface.outbox.length, 0);
});

it("an approval without a usable expiry gets a short life not an open ended one", async () => {
  const w = two();
  assert.equal(await push(w, ALICE, approvalEvent({ expiresAt: "tomorrow-ish" })), "delivered");
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1")?.expiresAt, w.store.now() + 600);
});

it("unlinking removes pending approvals and held notices", async () => {
  const w = two();
  await push(w, ALICE, approvalEvent());
  setNow(w, at(23));
  assert.equal(await push(w, ALICE, event()), "held");
  w.store.links.unlink(ALICE);
  assert.equal(w.store.approvals.getApproval("s-trig", "tu1"), null);
  assert.deepEqual(w.store.held.usersWithHeld(), []);
});

it("pause holds everything and resume delivers one summary immediately", async () => {
  const w = two();
  w.store.prefs.setPausedUntil(ALICE, w.store.now() + 2 * 3600); // /pause 2h
  const held = [await push(w, ALICE, event("run.completed", "p0")), await push(w, ALICE, event("run.completed", "p1"))];
  assert.deepEqual(held, ["held", "held"]);
  assert.equal(await push(w, ALICE, approvalEvent()), "held");
  assert.deepEqual(views(w), []);
  w.store.prefs.setPausedUntil(ALICE, null); // /resume: not muted any more, so what was held goes now
  await w.release.release(ALICE);
  const digests = views(w).filter((v) => v.name === "digest");
  assert.equal(digests.length, 1);
  assert.equal((digests[0]?.model["events"] as unknown[]).length, 2);
  assert.equal(await push(w, ALICE, event("run.completed", "after")), "delivered");
});

it("a timed pause ends by itself", async () => {
  const w = two();
  w.store.prefs.setPausedUntil(ALICE, w.store.now() + 30 * 60); // /pause 30m
  assert.equal(await push(w, ALICE, event()), "held");
  advanceSeconds(w.clock, 29 * 60);
  await w.release.releaseDue();
  assert.deepEqual(views(w), []);
  advanceSeconds(w.clock, 2 * 60);
  await w.release.releaseDue();
  assert.equal(views(w).length, 1);
});

it("pause without a duration lasts until resume", async () => {
  const w = two();
  w.store.prefs.setPausedUntil(ALICE, PAUSE_FOREVER); // /pause
  assert.equal(w.store.prefs.getPrefs(ALICE).pausedUntil, PAUSE_FOREVER);
  advanceSeconds(w.clock, 40 * 24 * 3600);
  assert.equal(await push(w, ALICE, event()), "held");
});

it("resume while quiet keeps holding and says so", async () => {
  const w = two(at(23));
  w.store.prefs.setPausedUntil(ALICE, w.store.now() + 3600); // /pause 1h
  assert.equal(await push(w, ALICE, event()), "held");
  w.store.prefs.setPausedUntil(ALICE, null); // /resume: quiet hours still hold it
  assert.equal(w.proactive.muted(ALICE), "quiet");
  await w.release.releaseDue();
  assert.deepEqual(views(w), []);
});

it("pause is per user", async () => {
  const w = two();
  w.store.prefs.setPausedUntil(ALICE, w.store.now() + 2 * 3600);
  assert.equal(await push(w, BOB, event("run.completed", "ev-1", { user_id: "u-bob" })), "delivered");
});

it("failed release keeps the notices for the next sweep", async () => {
  const w = two(at(23));
  await push(w, ALICE, event());
  setNow(w, at(9, 0, 28));
  const conversation = w.surface.conversation.bind(w.surface);
  w.surface.conversation = () => {
    throw new Error("bus down");
  };
  await w.release.releaseDue();
  assert.deepEqual(w.store.held.usersWithHeld(), [ALICE]);
  w.surface.conversation = conversation;
  await w.release.releaseDue();
  assert.equal(views(w).length, 1);
});

it("held notices are capped per user", async () => {
  const w = two(at(23));
  for (let i = 0; i < 130; i += 1) await push(w, ALICE, event("run.completed", `e${String(i)}`));
  assert.equal(w.store.held.takeHeld(ALICE).length, 100);
});
