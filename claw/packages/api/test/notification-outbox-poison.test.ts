// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One notification the receiver can never take must not cost anything else: against a real Postgres and the real delivery
 * path -- the HTTP transport, signed requests, a receiver on a local port -- with events recorded by the outbox's own
 * entry points (`recordRunFinished`, `recordApprovalRequested`).
 *
 *   P1 text the database cannot store (NUL, a lone surrogate) is stored with U+FFFD, not refused
 *   P2 a row the receiver keeps refusing (400, 422) while it takes the rest is quarantined after a bounded number of
 *      failures and an hour of refusals, never before; every later row is delivered, in order, while it fails; the record
 *      stays; the log line has no content
 *   P3 a receiver that is down quarantines nothing, however long, and gets everything on recovery
 *   P4 a receiver that refuses everything (a wrong secret) quarantines nothing
 *   P5 a single 422 quarantines nothing: the row is retried, and delivered when the receiver takes it
 *   P6 the outbox gauges read the table: oldest pending age and rows pending
 *   P7 the personal agent's 503s for an event it cannot take *yet* (a run's end while that chat's turn still answers, a copy
 *      in flight elsewhere, a send that failed) never quarantine it, however long the rest flows; it is delivered after
 *   P8 a NUL or a lone surrogate nested deeper than the sanitiser's walk is stored as U+FFFD too
 *   P9 a receiver behind a load balancer with one bad backend -- still on the old secret (401 bad_signature) or with its clock
 *      off (401 stale_timestamp) -- never quarantines a good row that keeps landing on it while the rest succeed; it is
 *      delivered once the backend is fixed
 *
 * Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } from "../src/notifications/signing.js";

const skip = postgresSkipReason();
const CANARY = "OUTBOX-CANARY-3c9e1f7a-never-log-me";

describe("notification outbox: poison rows", { skip }, () => {
  let h: AdmissionCluster;
  let outbox: typeof import("../src/notifications/outbox.js");
  let crypto: typeof import("../src/crypto/user-env.js");
  let registry: import("prom-client").Registry;
  const q = async (text: string, params: unknown[] = []) => (await h.app.db.db.query(text, params)).rows as any[];

  // The receiver: a real HTTP server that checks the signature and answers per event.
  let server: http.Server;
  let url = "";
  let secret = "";
  let answer: (eventId: string, body: any) => number = () => 200;
  const received: Array<{ eventId: string; body: any; status: number }> = [];
  const deliver = () => outbox.deliverDue({ allowedHosts: new Set(["127.0.0.1"]) });
  const makeDue = () => q("UPDATE claw_notification_outbox SET next_attempt_at = NOW() - interval '1 second' WHERE delivered_at IS NULL AND dropped_at IS NULL");
  /** As if the rows' refusals began longer ago than the quarantine's time bound (`QUARANTINE_AFTER_REFUSING_MINUTES`). */
  const ageRefusals = () => q(
    "UPDATE claw_notification_outbox SET refused_since = refused_since - make_interval(mins => $1::int + 1) WHERE refused_since IS NOT NULL",
    [outbox.QUARANTINE_AFTER_REFUSING_MINUTES],
  );

  async function subscribe(owner = "u1", to = url) {
    secret = `secret-${owner}-${Math.random()}`;
    const id = outbox.newSubscriptionId();
    await q(
      `INSERT INTO claw_notification_subscriptions (subscription_id, owner_user_id, url, secret_enc, event_types)
       VALUES ($1, $2, $3, $4, ARRAY['run.completed','run.failed','approval.requested'])`,
      [id, owner, to, crypto.encryptUserEnvValue(secret)],
    );
    return id;
  }
  /** A trigger-started run that just finished: announced however short. */
  async function finishRun(tid: string, outcome: "completed" | "failed", failureReason?: string) {
    await q(
      "INSERT INTO claw_sessions (session_id, name, user_id, mode, config) VALUES ('s1', 'nightly', 'u1', 'claw', '{\"trigger_id\":\"trg-1\"}'::jsonb) ON CONFLICT DO NOTHING",
    );
    await q(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, started_at, completed_at, metadata)
       VALUES ($1, 's1', 'run', $2, NOW() - interval '5 seconds', NOW(), '{}'::jsonb)`,
      [tid, outcome],
    );
    return outbox.recordRunFinished({ sessionId: "s1", taskIds: [tid], outcome, failureReason });
  }
  const eventIdOf = (tid: string, outcome: "completed" | "failed") =>
    outbox.deterministicEventId(outcome === "failed" ? "run.failed" : "run.completed", "s1", tid);
  const subRow = async (id: string) => (await q(
    "SELECT enabled, consecutive_failures, failing_since FROM claw_notification_subscriptions WHERE subscription_id = $1", [id],
  ))[0];
  const sample = async (name: string, label = "") => {
    const line = (await registry.metrics()).split("\n").find((l) => l.startsWith(name) && (!label || l.includes(label)) && !l.startsWith("#"));
    return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
  };

  before(async () => {
    h = await startAdmissionCluster({ CLAW_NOTIFICATIONS_ENABLED: "true", NOTIFY_MIN_RUN_SECONDS: "60" });
    crypto = await import("../src/crypto/user-env.js");
    crypto.initUserEnvCrypto();
    outbox = await import("../src/notifications/outbox.js");
    ({ registry } = await import("../src/infra/metrics.js"));
    outbox.registerNotificationMetrics();
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        const ok = verifySignature({
          secret, timestamp: String(req.headers[TIMESTAMP_HEADER.toLowerCase()]),
          signature: String(req.headers[SIGNATURE_HEADER.toLowerCase()]), body,
        }) === "ok";
        const eventId = String(req.headers[EVENT_ID_HEADER.toLowerCase()]);
        const parsed = JSON.parse(body);
        const status = ok ? answer(eventId, parsed) : 401;
        received.push({ eventId, body: parsed, status });
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/claw-events/route-1`;
  });
  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await h?.stop();
  });
  beforeEach(async () => {
    received.length = 0;
    answer = () => 200;
    await q("DELETE FROM claw_notification_outbox");
    await q("DELETE FROM claw_notification_subscriptions");
    await q("DELETE FROM claw_tasks");
    await q("DELETE FROM claw_sessions");
  });

  test("P1 a NUL or a lone surrogate in what a run or a request says is stored as U+FFFD, and delivered", async () => {
    await subscribe();
    // The failure text is the run's own output; before, this insert failed with 22P05 (NUL) or 22P02 (lone surrogate) every time.
    assert.equal(await finishRun("t-nul", "failed", `exit 1: \u0000binary\u0000 ${CANARY}`), 1);
    assert.equal(await finishRun("t-sur", "failed", "emoji cut in half: \uD83D end"), 1);
    await q("UPDATE claw_sessions SET config = config || '{\"notify_on_finish\": true}'::jsonb WHERE session_id = 's1'");
    const now = Date.now();
    assert.equal(await outbox.recordApprovalRequested({
      sessionId: "s1",
      event: {
        type: "permissionRequest", tool_use_id: "tu-\u0000-1", tool: "bash", input: { command: "cat \u0000 \uDC00" },
        summary: "reads a file named \uDC00\u0000", timeout_ms: 300_000, ts: now,
      },
    }, () => now), 1);
    const stored = await q("SELECT payload FROM claw_notification_outbox ORDER BY id");
    assert.equal(stored.length, 3);
    for (const { payload } of stored) {
      const text = JSON.stringify(payload);
      assert.doesNotMatch(text, /\\u0000|\\ud[89a-f][0-9a-f]{2}/i, "nothing the database refuses is left");
    }
    assert.match(stored[0].payload.summary, /exit 1: �binary�/);
    assert.match(stored[1].payload.summary, /cut in half: � end/);
    assert.equal(stored[2].payload.approval.tool_use_id, "tu-�-1");
    assert.equal(stored[2].payload.summary, "reads a file named ��");

    assert.deepEqual(await deliver(), { delivered: 3, failed: 0 });
    assert.equal(received.length, 3);
    assert.match(received[0].body.summary, /�binary�/, "the receiver is sent the stored text");
  });

  test("refusedForGood: only an answer about the body, never one that depends on the sender or the backend, a 5xx or a failure to connect", () => {
    for (const s of ["http_400", "http_413", "http_415", "http_422"]) assert.equal(outbox.refusedForGood(s), true, s);
    // 401 is the personal agent's bad_signature and stale_timestamp: a backend on the old secret, a replica's clock. 403 and 404
    // are as often a proxy's.
    for (const s of [
      "http_401", "http_403", "http_404", "http_405", "http_409", "http_418", "http_408", "http_429",
      "http_500", "http_502", "http_503", "error:timeout", "refused:not_allowed", "http_200", "",
    ]) {
      assert.equal(outbox.refusedForGood(s), false, s);
    }
  });

  for (const refusal of [400, 422]) test(`P2 a row the receiver keeps refusing (${refusal}) is quarantined after a bounded number of failures over an hour; everything after it flows, in order`, async () => {
    const sub = await subscribe();
    const poison = eventIdOf("t-poison", "failed");
    // The receiver works, except for this one event, which it refuses as it refuses a body it cannot read (the personal agent's
    // 400 bad_event): the same answer every time it is sent.
    answer = (eventId) => (eventId === poison ? refusal : 200);
    await finishRun("t-poison", "failed", `renders badly ${CANARY}`);
    const goods: string[] = [];
    const before = await sample("claw_notification_quarantined_total", 'reason="isolated_failures"');
    let lines: string[] = [];
    let round = 0;
    for (; round < 20; round++) {
      // Two more events arrive every round, behind the poison row -- but not in the round it is quarantined in, so nothing
      // delivered after its last failure is what ends the subscription's streak.
      for (const n of round <= outbox.QUARANTINE_AFTER_ISOLATED_FAILURES ? [0, 1] : []) {
        const tid = `t-good-${round}-${n}`;
        await finishRun(tid, "completed");
        goods.push(eventIdOf(tid, "completed"));
      }
      await makeDue();
      const captured = await captureLogLines(() => deliver(), "notification.quarantined");
      lines = lines.concat(captured);
      const now = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [poison]))[0];
      if (now.quarantined_at) break;
      if (round === outbox.QUARANTINE_AFTER_ISOLATED_FAILURES) {
        // Enough isolated refusals, but all within minutes -- as long as a rolling deploy of the receiver may last: not yet.
        assert.equal(now.isolated_failures, outbox.QUARANTINE_AFTER_ISOLATED_FAILURES);
        assert.equal(now.dropped_at, null, "not quarantined before it has been refused for an hour");
        // An hour later, it is still refused.
        await ageRefusals();
      }
    }
    const row = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [poison]))[0];
    assert.ok(row.quarantined_at, "quarantined");
    assert.ok(row.dropped_at, "and never claimed again");
    assert.equal(row.isolated_failures, outbox.QUARANTINE_AFTER_ISOLATED_FAILURES + 1);
    // The first failure has no "since"; each later one followed a delivery of another row; then the hour.
    assert.equal(round, outbox.QUARANTINE_AFTER_ISOLATED_FAILURES + 1, "quarantined on the first round it could be, not later");
    assert.equal(received.filter((r) => r.eventId === poison).length, outbox.QUARANTINE_AFTER_ISOLATED_FAILURES + 2);
    assert.equal(row.last_status, `http_${refusal}`);
    assert.match(row.payload.summary, new RegExp(CANARY), "the record keeps what was not delivered");

    // Every other event was delivered, each once, in the order it was recorded.
    const delivered = received.filter((r) => r.status === 200).map((r) => r.eventId);
    assert.deepEqual(delivered, goods);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_notification_outbox WHERE delivered_at IS NULL AND dropped_at IS NULL"))[0].n, 0);

    // Nothing more is sent for it.
    await makeDue();
    received.length = 0;
    await deliver();
    assert.equal(received.length, 0);

    // The failures were the row's, not the receiver's: the subscription carries no streak that could disable it later.
    const s = await subRow(sub);
    assert.equal(s.enabled, true);
    assert.equal(s.consecutive_failures, 0);
    assert.equal(s.failing_since, null);

    // One line, naming the row and why, without what it carries.
    const record = lines.map((l) => JSON.parse(l)).filter((e) => e.msg === "notification.quarantined");
    assert.equal(record.length, 1);
    assert.equal(record[0].eventId, poison);
    assert.equal(record[0].reason, "isolated_failures");
    assert.equal(record[0].type, "run.failed");
    assert.ok(!lines.some((l) => l.includes(CANARY)), "no content in the log");
    assert.equal(await sample("claw_notification_quarantined_total", 'reason="isolated_failures"') - before, 1);
  });

  test("P3 a receiver that is down quarantines nothing, however many times it fails, and gets everything back on recovery", async () => {
    const sub = await subscribe();
    answer = () => 503;
    for (let i = 0; i < 4; i++) await finishRun(`t-${i}`, "completed");
    for (let round = 0; round < 3 * outbox.QUARANTINE_AFTER_ISOLATED_FAILURES; round++) {
      await deliver();
      await makeDue();
    }
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_notification_outbox WHERE quarantined_at IS NOT NULL OR dropped_at IS NOT NULL"))[0].n, 0);
    assert.ok((await subRow(sub)).consecutive_failures >= 3 * outbox.QUARANTINE_AFTER_ISOLATED_FAILURES * 4);
    answer = () => 200;
    received.length = 0;
    await outbox.kickDelivery({ allowedHosts: new Set(["127.0.0.1"]) });
    assert.deepEqual(received.map((r) => r.eventId), [0, 1, 2, 3].map((i) => eventIdOf(`t-${i}`, "completed")));
    assert.equal((await subRow(sub)).consecutive_failures, 0);
  });

  test("P3 a receiver that flaps between its outages does not quarantine a good row", async () => {
    // Down, up for one other row, down again: the row fails across a success every time -- more times than a refusal would
    // need to be quarantined -- but a 503 is never counted as the row's own, and it is delivered the moment the receiver stays up.
    await subscribe();
    await finishRun("t-a", "completed");
    let up = false;
    answer = () => (up ? 200 : 503);
    await deliver();                                                  // a: first failure
    for (let i = 0; i < outbox.QUARANTINE_AFTER_ISOLATED_FAILURES + 2; i++) {
      up = true;
      await finishRun(`t-other-${i}`, "completed");
      await q("UPDATE claw_notification_outbox SET next_attempt_at = NOW() + interval '1 hour' WHERE event_id = $1", [eventIdOf("t-a", "completed")]);
      await deliver();                                                // another row goes through
      up = false;
      await makeDue();
      await deliver();                                                // a fails again, across that success
    }
    const a = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [eventIdOf("t-a", "completed")]))[0];
    assert.equal(a.quarantined_at, null);
    assert.equal(a.isolated_failures, 0);
    up = true;
    await makeDue();
    await deliver();
    assert.ok((await q("SELECT delivered_at FROM claw_notification_outbox WHERE event_id = $1", [eventIdOf("t-a", "completed")]))[0].delivered_at);
  });

  test("P4 a receiver that refuses everything (a wrong secret) quarantines nothing: the retry window is for fixing it", async () => {
    await subscribe();
    answer = () => 401;
    for (let i = 0; i < 3; i++) await finishRun(`t-${i}`, "completed");
    for (let round = 0; round < 3 * outbox.QUARANTINE_AFTER_ISOLATED_FAILURES; round++) {
      await deliver();
      await makeDue();
    }
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_notification_outbox WHERE dropped_at IS NULL AND delivered_at IS NULL"))[0].n, 3);
    answer = () => 200;
    await deliver();
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_notification_outbox WHERE delivered_at IS NOT NULL"))[0].n, 3);
  });

  test("P5 a single 422 quarantines nothing: the row is retried, counted like any refusal, and delivered when the receiver takes it", async () => {
    // One answer from one backend is not proof the event can never be taken: a backend mid-deploy may refuse what the others take.
    const sub = await subscribe();
    const bad = eventIdOf("t-bad", "failed");
    let refusals = 2;
    answer = (eventId) => (eventId === bad && refusals-- > 0 ? 422 : 200);
    await finishRun("t-bad", "failed", "a card the chat refused");
    await finishRun("t-ok", "completed");
    const before = await sample("claw_notification_quarantined_total");
    assert.deepEqual(await deliver(), { delivered: 1, failed: 1 });
    let row = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [bad]))[0];
    assert.equal(row.quarantined_at, null, "not quarantined on one answer");
    assert.equal(row.dropped_at, null);
    assert.equal(row.last_status, "http_422");
    assert.ok(row.refused_since, "but counted as a refusal");
    await finishRun("t-ok-2", "completed");
    await makeDue();
    await deliver();
    row = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [bad]))[0];
    assert.equal(row.isolated_failures, 1, "a refusal across another delivery is the row's own");
    assert.equal(row.dropped_at, null);
    await makeDue();
    await deliver();
    row = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [bad]))[0];
    assert.ok(row.delivered_at, "delivered once the receiver took it");
    assert.equal(row.payload.summary, "a card the chat refused");
    assert.equal(received.filter((r) => r.eventId === bad).length, 3);
    assert.equal((await subRow(sub)).consecutive_failures, 0);
    assert.equal(await sample("claw_notification_quarantined_total"), before);
  });

  test("P6 the gauges read the table: a stalled row's age and the rows pending; 0 once it clears", async () => {
    await subscribe();
    answer = () => 503;
    await finishRun("t-1", "completed");
    await finishRun("t-2", "completed");
    for (let i = 0; i < 3; i++) { await deliver(); await makeDue(); }
    // An outage of an hour, as the table records it.
    await q("UPDATE claw_notification_outbox SET created_at = NOW() - interval '1 hour'");
    // (one read per scrape is shared, for a second)
    await new Promise((r) => setTimeout(r, 1100));
    const age = await sample("claw_notification_outbox_oldest_pending_age_seconds");
    assert.ok(age >= 3599 && age < 3700, `oldest pending age ${age}`);
    assert.equal(await sample("claw_notification_outbox_pending"), 2);
    answer = () => 200;
    await deliver();
    // A quarantined row from a day ago, and one of a deleted subscription waiting for the next: neither is pending delivery.
    await q(
      `INSERT INTO claw_notification_outbox (event_id, subscription_id, payload, created_at, dropped_at, quarantined_at)
       SELECT 'ev-q', subscription_id, '{}'::jsonb, NOW() - interval '1 day', NOW(), NOW() FROM claw_notification_subscriptions`,
    );
    await q("INSERT INTO claw_notification_outbox (event_id, subscription_id, payload, created_at) VALUES ('ev-o', NULL, '{}'::jsonb, NOW() - interval '2 hours')");
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(await sample("claw_notification_outbox_oldest_pending_age_seconds"), 0);
    assert.equal(await sample("claw_notification_outbox_pending"), 0);
    assert.ok(await sample("claw_notification_delivery_total", 'outcome="delivered"') >= 2);
  });

  test("P7 the personal agent's 503s for an event it cannot take yet never quarantine it while the rest flows; it goes after", async () => {
    // The answers of `personal-agent/packages/runtime/src/http/claw-events.ts` for an event it will take on a later try, while it
    // takes every other event: `turn_in_progress` (a run's end while that chat's turn is still answering -- up to the turn's
    // 32-minute deadline), `in_progress` (a copy of the event another worker is sending), `send_failed` (the chat's send threw).
    const sub = await subscribe();
    const busy = eventIdOf("t-busy", "completed");
    let turnAnswering = true;
    const why = ["turn_in_progress", "in_progress", "send_failed"];
    const told: string[] = [];
    answer = (eventId) => {
      if (eventId === busy && turnAnswering) {
        told.push(why[told.length % why.length]);
        return 503;
      }
      return 200;
    };
    await finishRun("t-busy", "completed");
    const goods: string[] = [];
    const rounds = 4 * outbox.QUARANTINE_AFTER_ISOLATED_FAILURES;
    for (let round = 0; round < rounds; round++) {
      // The person's other runs end and are announced while the busy one waits: the receiver takes every one of them.
      const tid = `t-other-${round}`;
      await finishRun(tid, "completed");
      goods.push(eventIdOf(tid, "completed"));
      await makeDue();
      await deliver();
    }
    let row = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [busy]))[0];
    assert.equal(told.length, rounds, "it was asked for, and answered 503, every round");
    assert.equal(row.quarantined_at, null, "a 503 is not a refusal: not quarantined");
    assert.equal(row.dropped_at, null);
    assert.equal(row.isolated_failures, 0);
    assert.equal(row.last_status, "http_503");
    assert.deepEqual(received.filter((r) => r.status === 200).map((r) => r.eventId), goods, "the rest flowed, each once");

    // The turn ends: the next try delivers it.
    turnAnswering = false;
    await makeDue();
    await deliver();
    row = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [busy]))[0];
    assert.ok(row.delivered_at, "delivered once the chat could take it");
    assert.equal(received.filter((r) => r.eventId === busy && r.status === 200).length, 1);
    assert.equal((await subRow(sub)).consecutive_failures, 0);
  });

  test("P8 a NUL or a lone surrogate nested deeper than the sanitiser walks is stored as U+FFFD, and delivered", async () => {
    const sub = await subscribe();
    // A terminal's permission request carries its input whole (`AssistantRemoteAsk.input`): JSON the agent wrote, as deep as it
    // likes. Before, a bad string below 64 levels was left as it was and failed the insert (22P05) every time.
    let input: unknown = { command: `cat \u0000 ${CANARY} \uD83D`, "key\u0000": 1 };
    for (let i = 0; i < 100; i++) input = i % 2 ? [input] : { nested: input };
    const eventId = "say-deep-1";
    const payload = {
      event_id: eventId, type: "assistant.say", occurred_at: new Date().toISOString(), user_id: "u1", text: "Codex asks",
      remote: {
        kind: "needs_you", session_id: "s-remote", machine: "m1", agent: "codex", tool: "codex",
        ask: { action_id: "a1", tool: "Bash", origin: "terminal", kind: "execute", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }], input },
      },
    } as unknown as import("@claw/protocol").OutboundPayload;
    await q("UPDATE claw_notification_subscriptions SET event_types = event_types || ARRAY['assistant.say'] WHERE subscription_id = $1", [sub]);
    assert.equal(await outbox.enqueue(eventId, [{ subscription_id: sub }], payload), 1);
    const stored = (await q("SELECT payload::text AS text FROM claw_notification_outbox WHERE event_id = $1", [eventId]))[0].text;
    assert.doesNotMatch(stored, /\\u0000|\\ud[89a-f][0-9a-f]{2}/i);
    assert.deepEqual(await deliver(), { delivered: 1, failed: 0 });
    let leaf: any = received[0].body.remote.ask.input;
    for (let i = 99; i >= 0; i--) leaf = i % 2 ? leaf[0] : leaf.nested;
    assert.equal(leaf.command, `cat \ufffd ${CANARY} \ufffd`);
    assert.deepEqual(Object.keys(leaf).sort(), ["command", "key\ufffd"]);
  });

  for (const fault of ["bad_signature", "stale_timestamp"] as const) {
    test(`P9 one backend answering 401 ${fault} behind a load balancer never quarantines a good row that keeps landing on it`, async () => {
      // The personal agent behind a load balancer that takes turns between two backends. One is fine; the other is still on the
      // old secret during a rotation (401 bad_signature), or its clock is more than five minutes off (401 stale_timestamp): it
      // answers exactly as `personal-agent/packages/runtime/src/http/claw-events.ts` does. The row first in line lands on that
      // backend on every round while the subscription's other rows land on the good one -- each of its failures is "isolated".
      let fixed = false;
      let turn = 0;
      const answers: Array<{ eventId: string; backend: number; status: number }> = [];
      const lb = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const backend = turn++ % 2;
          const bad = backend === 0 && !fixed;
          const verdict = verifySignature({
            secret: bad && fault === "bad_signature" ? "the-secret-before-the-rotation" : secret,
            timestamp: String(req.headers[TIMESTAMP_HEADER.toLowerCase()]),
            signature: String(req.headers[SIGNATURE_HEADER.toLowerCase()]),
            body,
            nowSeconds: Math.floor(Date.now() / 1000) + (bad && fault === "stale_timestamp" ? 400 : 0),
            toleranceSeconds: 300,
          });
          const status = verdict === "ok" ? 200 : 401;
          answers.push({ eventId: String(req.headers[EVENT_ID_HEADER.toLowerCase()]), backend, status });
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(status === 200 ? { status: "sent" } : { error: verdict }));
        });
      });
      await new Promise<void>((resolve) => lb.listen(0, "127.0.0.1", resolve));
      try {
        const sub = await subscribe("u1", `http://127.0.0.1:${(lb.address() as AddressInfo).port}/claw-events/route-1`);
        const unlucky = eventIdOf("t-unlucky", "completed");
        await finishRun("t-unlucky", "completed");
        const rounds = 4 * outbox.QUARANTINE_AFTER_ISOLATED_FAILURES;
        for (let round = 0; round < rounds; round++) {
          await finishRun(`t-other-${round}`, "completed");
          await makeDue();
          await deliver();
          // Hours of this: past any time bound on refusals.
          await ageRefusals();
        }
        const mine = answers.filter((a) => a.eventId === unlucky);
        assert.equal(mine.length, rounds);
        assert.ok(mine.every((a) => a.backend === 0 && a.status === 401), "it landed on the bad backend every time");
        assert.equal(answers.filter((a) => a.eventId !== unlucky && a.status === 200).length, rounds, "while every other row went through");
        let row = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [unlucky]))[0];
        assert.equal(row.quarantined_at, null, "a 401 is the sender's or the backend's, not the event's: never quarantined");
        assert.equal(row.dropped_at, null);
        assert.equal(row.isolated_failures, 0);
        assert.equal(row.last_status, "http_401");

        // The rotation completes (or the clock is fixed): the next try delivers it.
        fixed = true;
        await makeDue();
        await deliver();
        row = (await q("SELECT * FROM claw_notification_outbox WHERE event_id = $1", [unlucky]))[0];
        assert.ok(row.delivered_at, "delivered once the backend could take it");
        assert.equal((await subRow(sub)).consecutive_failures, 0);
      } finally {
        await new Promise((resolve) => lb.close(resolve));
      }
    });
  }
});

/**
 * What the outbox's own pino logger emitted while `run` ran: pino writes to fd 1 through `fs.write`, which is borrowed for the
 * call (the shape of `sweeper-lost-lease-gate.test.ts`).
 */
async function captureLogLines(run: () => Promise<unknown>, waitFor: string): Promise<string[]> {
  const lines: string[] = [];
  const realWrite = fs.write as unknown as (...args: unknown[]) => unknown;
  const realWriteSync = fs.writeSync as unknown as (...args: unknown[]) => unknown;
  const take = (chunk: unknown) => {
    for (const line of String(chunk).split("\n")) if (line) lines.push(line);
  };
  fs.write = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWrite(fd, chunk, ...rest);
    take(chunk);
    const done = rest[rest.length - 1];
    if (typeof done === "function") done(null, Buffer.byteLength(String(chunk)), chunk);
    return undefined;
  }) as unknown as typeof fs.write;
  fs.writeSync = ((fd: number, chunk: unknown, ...rest: unknown[]) => {
    if (fd !== 1) return realWriteSync(fd, chunk, ...rest);
    take(chunk);
    return Buffer.byteLength(String(chunk));
  }) as unknown as typeof fs.writeSync;
  try {
    await run();
    const wanted = `"msg":${JSON.stringify(waitFor)}`;
    for (let i = 0; i < 50 && !lines.some((line) => line.includes(wanted)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } finally {
    fs.write = realWrite as unknown as typeof fs.write;
    fs.writeSync = realWriteSync as unknown as typeof fs.writeSync;
  }
  return lines.filter((l) => l.startsWith("{"));
}
