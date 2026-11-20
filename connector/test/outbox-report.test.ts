// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The outbox report every heartbeat carries (`outbox`, `RemoteOutboxReport`): what Claw tells a person whose replies are stuck,
 * and alerts its operators, from. The connector is the real one against a stand-in Claw whose event route fails on demand.
 *
 *   R1  while posts fail, the heartbeat says how many events wait, for how long, which sessions, and how the posts fail
 *   R2  once a post succeeds the report is clean again: nothing pending, no failures, no error
 *   R3  the backlog counts from when an event was queued, not from the time its agent gave it
 *   R4  Claw reads the report the connector sends (`parseOutboxReport`), and ignores a malformed one rather than refusing it
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Outbox } from "../src/outbox.js";
import { parseHeartbeat } from "../../claw/packages/protocol/src/remote-agents.js";
import { Harness, tmpdir } from "./support/harness.js";

describe("outbox report", () => {
  test("R1+R2 a failing event route is reported with every heartbeat, and the report clears once posts succeed", async () => {
    const h = await Harness.create();
    await h.online();
    h.claw.failPosts = 1_000_000;
    const sid = h.claw.newSession("fake", h.work);
    const stuck = await h.claw.until("a heartbeat reporting the stuck session", () => h.claw.heartbeats.find((hb) =>
      hb.outbox?.pending > 0 && hb.outbox.failures >= 2 && hb.outbox.sessions.some((s: { session_id: string }) => s.session_id === sid)));
    assert.equal(stuck.outbox.last_error, "http_503");
    assert.ok(stuck.outbox.failing_ms > 0, "how long the posts have failed");
    assert.ok(stuck.outbox.oldest_age_ms > 0, "how long the oldest event has waited");
    const mine = stuck.outbox.sessions.find((s: { session_id: string }) => s.session_id === sid);
    assert.ok(mine.pending >= 1 && mine.oldest_age_ms > 0);
    // What Claw makes of it: the same numbers, nothing dropped.
    const parsed = parseHeartbeat(stuck);
    assert.ok(parsed.ok);
    assert.equal(parsed.value.outbox?.failures, stuck.outbox.failures);
    assert.equal(parsed.value.outbox?.lastError, "http_503");
    assert.deepEqual(parsed.value.outbox?.sessions.map((s) => s.sessionId), stuck.outbox.sessions.map((s: { session_id: string }) => s.session_id));

    // Claw answers again: the events arrive, and the next report is clean.
    h.claw.failPosts = 0;
    await h.claw.until("session_started to arrive", () => h.claw.eventsOf(sid).some((e) => e.type === "session_started"));
    const from = h.claw.heartbeats.length;
    const clean = await h.claw.until("a clean report", () => h.claw.heartbeats.slice(from).find((hb) =>
      hb.outbox?.pending === 0 && hb.outbox.failures === 0));
    assert.deepEqual(clean.outbox, { pending: 0, oldest_age_ms: 0, failures: 0, failing_ms: 0, last_error: null, sessions: [] });
  });

  test("R3 the backlog counts from when an event was queued, longest waiting session first", () => {
    let now = 1_000_000;
    const box = new Outbox({ dir: tmpdir("cc-outbox-"), now: () => now });
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    // Said by its agent an hour ago (a transcript entry), queued now: it has waited nothing yet.
    box.append(a, "agent_message_chunk", { text: "x" }, now - 3_600_000);
    now += 5_000;
    box.append(b, "turn_end", {});
    box.append(b, "turn_end", {});
    now += 1_000;
    assert.deepEqual(box.backlog(20), {
      pending: 3, oldestAgeMs: 6_000,
      sessions: [{ sessionId: a, pending: 1, oldestAgeMs: 6_000 }, { sessionId: b, pending: 2, oldestAgeMs: 1_000 }],
    });
    assert.deepEqual(box.backlog(1).sessions.map((s) => s.sessionId), [a]);
    box.ack({ [a]: 1 });
    assert.deepEqual(box.backlog(20), { pending: 2, oldestAgeMs: 1_000, sessions: [{ sessionId: b, pending: 2, oldestAgeMs: 1_000 }] });
    box.ack({ [b]: 2 });
    assert.deepEqual(box.backlog(20), { pending: 0, oldestAgeMs: 0, sessions: [] });
  });

  test("R4 a malformed report is ignored, never a refused heartbeat", () => {
    const base = { version: "0.2.3", agents: [], cmd_cursor: null };
    for (const outbox of [undefined, null, "x", { pending: -1, oldest_age_ms: 0, failures: 0, failing_ms: 0 }, { pending: 1 }]) {
      const hb = parseHeartbeat({ ...base, outbox });
      assert.ok(hb.ok, JSON.stringify(outbox));
      assert.equal(hb.value.outbox, null);
    }
    const hb = parseHeartbeat({ ...base, outbox: {
      pending: 2, oldest_age_ms: 9e15, failures: 3, failing_ms: 5, last_error: "<b>",
      sessions: [{ session_id: "not-an-id", pending: 1, oldest_age_ms: 1 }, { session_id: "11111111-1111-4111-8111-111111111111", pending: 1, oldest_age_ms: 7 }],
    } });
    assert.ok(hb.ok);
    assert.deepEqual(hb.value.outbox, {
      pending: 2, oldestAgeMs: 86_400_000, failures: 3, failingMs: 5, lastError: null,
      sessions: [{ sessionId: "11111111-1111-4111-8111-111111111111", pending: 1, oldestAgeMs: 7 }],
    });
  });
});
