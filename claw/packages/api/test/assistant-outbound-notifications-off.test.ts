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
    h = await startAdmissionCluster({});
    await h.app.db.db.query(`
      CREATE TABLE claw_work_items (
        item_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, seq INT NOT NULL, title TEXT NOT NULL,
        board_state TEXT NOT NULL, last_report_kind TEXT, pending_question TEXT,
        worker_session_id TEXT NOT NULL UNIQUE, result_version INT NOT NULL DEFAULT 0,
        attention_seq INT NOT NULL DEFAULT 0, UNIQUE (user_id, seq));
      CREATE TABLE claw_assistants (user_id TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE);
      CREATE TABLE claw_assistant_says (
        say_id UUID PRIMARY KEY, user_id TEXT NOT NULL, item_id TEXT, item_attention_seq INT, text TEXT NOT NULL,
        fallback BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), delivered_at TIMESTAMPTZ);
    `);
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

  test("the delivery hook is registered only behind the notifications flag", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(index, /if \(CLAW_NOTIFICATIONS_ENABLED\) registerAssistantDeliveryHook\(\)/);
  });
});
