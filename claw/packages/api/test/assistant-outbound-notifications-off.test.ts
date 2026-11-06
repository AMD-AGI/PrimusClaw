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
  });

  test("the delivery hook is registered only behind both the notifications and the assistant flag", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    assert.match(index, /if \(CLAW_NOTIFICATIONS_ENABLED && CLAW_ASSISTANT_ENABLED\) registerAssistantDeliveryHook\(\)/);
  });
});
