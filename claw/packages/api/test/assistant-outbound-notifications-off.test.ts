// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An assistant that runs where `CLAW_NOTIFICATIONS_ENABLED` is unset still stores
 * what it says and still shows it to a web client; there is just nobody to push it
 * to, and no outbox to look in.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("assistant outbound without notifications", { skip }, () => {
  let h: AdmissionCluster;
  let outbound: typeof import("../src/assistant/outbound.js");
  before(async () => {
    delete process.env.CLAW_NOTIFICATIONS_ENABLED;
    h = await startAdmissionCluster({ CLAW_ASSISTANT_ENABLED: "true" });
    outbound = await import("../src/assistant/outbound.js");
  });
  after(async () => { await h?.stop(); });

  test("a say is stored and published to the session, reports no subscribers, and starts no delivery", async () => {
    const events: unknown[] = [];
    let kicked = false;
    const out = await outbound.recordAssistantSay(
      { userId: "u1", sessionId: "assistant-u1", text: "hello" },
      { publishSessionEvent: async (_s, e) => { events.push(e); }, kick: async () => { kicked = true; } },
    );
    assert.equal(out.subscribers, 0);
    assert.equal(kicked, false);
    assert.equal(events.length, 1);
    assert.equal((await h.app.db.db.query("SELECT COUNT(*)::int AS n FROM claw_assistant_says")).rows[0].n, 1);
    assert.equal((await h.app.db.db.query("SELECT to_regclass('claw_notification_outbox') AS t")).rows[0].t, null);
  });

  test("a say after a start notice, and the end of a turn, touch no outbox when there is none (#344, say-hold.ts)", async () => {
    const hold = await import("../src/assistant/say-hold.js");
    const q = (t: string, p?: unknown[]) => h.app.db.db.query(t, p);
    assert.equal(await hold.turnAnnouncedStart(q as never, "u1", new Date(0), "m1"), null);
    assert.deepEqual(await hold.releaseHeldSays(q as never, "m1"), []);
    assert.deepEqual(await hold.dropHeldSays(q as never, "m1"), []);
    const out = await outbound.recordAssistantSay(
      { userId: "u1", sessionId: "assistant-u1", text: "顺便：用中文写。", turnMessageId: "m1", turnBegan: new Date(0), amendNotice: true },
      { publishSessionEvent: async () => {}, kick: async () => {} },
    );
    assert.equal(out.subscribers, 0, "stored as a message of its own");
    // With a start notice told in the turn, the turn's unsaid final text (no amendNotice) is refused all the same.
    await h.app.db.db.query(
      `INSERT INTO claw_assistant_says (say_id, user_id, item_id, text, fallback) VALUES (gen_random_uuid(), 'u1', 'kwi_x', '已开始：#1 x。', TRUE)`,
    );
    await assert.rejects(outbound.recordAssistantSay(
      { userId: "u1", sessionId: "assistant-u1", text: "任务已建好。", turnMessageId: "m1", turnBegan: new Date(0) },
      { publishSessionEvent: async () => {}, kick: async () => {} },
    ), (err: any) => err.code === "already_announced");
  });

  test("an answer the assistant said in the session is not said again by the silent sweep (2026-11-06: #121 said twice)", async () => {
    const q = (t: string, p: unknown[] = []) => h.app.db.db.query(t, p);
    await q(
      `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, outcome, last_report_kind, worker_session_id, closed_at, updated_at)
       VALUES ('kwi_offanswered', 'u-off', 1, '后台运行 slow_job.sh', 'done', 'answered', 'answer', 'worker-off-answered', NOW(), NOW() - interval '1 hour')`,
    );
    await q("INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary) VALUES ('kwi_offanswered', 'answer', 'worker', 1, 'RESULT=86972')");
    const events: unknown[] = [];
    const { sessionId } = await (await import("../src/assistant/assistant.js")).getOrCreateAssistant("u-off");
    await outbound.recordAssistantSay(
      { userId: "u-off", sessionId, text: "✅ RESULT=86972", itemId: "kwi_offanswered" },
      { publishSessionEvent: async (_s, e) => { events.push(e); }, kick: async () => {} },
    );
    const silent = await import("../src/assistant/silent-sweep.js");
    const ports = { ...silent.silentSweepPorts };
    silent.silentSweepPorts.recordNeedsYouFallback = (i) => outbound.recordNeedsYouFallback(i, { publishSessionEvent: async (_s, e) => { events.push(e); }, kick: async () => {} });
    try {
      assert.equal(await silent.tellSilentItems(300, false), 0, "shown in the session, which is all a user has here");
    } finally { Object.assign(silent.silentSweepPorts, ports); }
    assert.equal(events.length, 1);
    assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_assistant_says WHERE fallback AND item_id = 'kwi_offanswered'")).rows[0].n, 0);
  });

  test("the system's own message whose publish failed is shown again, once it can be", async () => {
    const q = (t: string, p: unknown[] = []) => h.app.db.db.query(t, p);
    const { sessionId } = await (await import("../src/assistant/assistant.js")).getOrCreateAssistant("u-off2");
    await q(
      `INSERT INTO claw_work_items (item_id, user_id, seq, title, board_state, outcome, last_report_kind, worker_session_id, closed_at, updated_at)
       VALUES ('kwi_offunshown', 'u-off2', 1, 'jobs.csv 汇总', 'done', 'answered', 'answer', 'worker-off-unshown', NOW(), NOW() - interval '1 hour')`,
    );
    await q("INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary) VALUES ('kwi_offunshown', 'answer', 'worker', 1, '39,144.2')");
    const shown: Array<{ s: string; e: any }> = [];
    const silent = await import("../src/assistant/silent-sweep.js");
    const ports = { ...silent.silentSweepPorts };
    const use = (fail: boolean) => {
      const d = { publishSessionEvent: async (s: string, e: unknown) => { if (fail) throw new Error("nats is down"); shown.push({ s, e }); }, kick: async () => {} };
      silent.silentSweepPorts.recordNeedsYouFallback = (i) => outbound.recordNeedsYouFallback(i, d);
      silent.silentSweepPorts.reshowFallback = (i) => outbound.reshowFallback(i, d);
    };
    try {
      use(true);
      assert.equal(await silent.tellSilentItems(300, false), 1, "stored");
      assert.equal(await silent.tellSilentItems(300, false), 0, "still down");
      use(false);
      assert.equal(await silent.tellSilentItems(300, false), 1, "shown now");
      assert.equal(await silent.tellSilentItems(300, false), 0, "once");
    } finally { Object.assign(silent.silentSweepPorts, ports); }
    assert.deepEqual(shown.map((x) => x.s), [sessionId]);
    assert.match(shown[0].e.text, /39,144\.2/);
  });

  test("the delivery hook is registered only behind both the notifications and the assistant flag", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(index, /if \(CLAW_NOTIFICATIONS_ENABLED && CLAW_ASSISTANT_ENABLED\) registerAssistantDeliveryHook\(\)/);
  });
});
