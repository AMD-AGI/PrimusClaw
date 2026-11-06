// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The consumer's part in a quick router turn (`assistant/router-speed.ts`; the rule itself is `assistant-router-speed-rule.test.ts`).
 *
 *   S2 the consumer keeps no row of a streaming say's text (`toolTextDelta`), and still stores the call itself
 *
 * Over a real Postgres: skipped without DATABASE_URL, and a skip is not a pass. The module is imported in the test, after the world has
 * set the environment `config.ts` reads.
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

describe("assistant router speed: the consumer", { skip: postgresSkipReason() }, () => {
  let w: World;
  before(async () => { w = await startWorld(); });
  after(async () => { await w?.stop(); });

  test("S2 a streaming say's text is not stored; the call is", async () => {
    const { STREAMED_SAY_TOOL } = await import("../src/assistant/router-speed.js");
    const alice = await w.user("alice");
    const { consumeEventDelivery, tombstoneReader } = w.mod.consumer;
    const { sc } = await import("../src/infra/nats.js");
    const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
    const originalTombstone = { ...tombstoneReader };
    Object.assign(tombstoneReader, { has: async () => false });
    resetDeletedSessionCache();
    const acked: string[] = [];
    const deliver = (seq: number, event: Record<string, unknown>) => consumeEventDelivery({
      subject: `events.${alice.routerSid}`,
      data: sc.encode(JSON.stringify(event)),
      seq,
      ack: () => { acked.push(`ack ${seq}`); },
      nak: (ms?: number) => { acked.push(`nak ${seq} ${ms}`); },
    });
    try {
      await deliver(901, { type: "toolTextDelta", tool: STREAMED_SAY_TOOL, actionId: "toolu_1", text: "Twelve nodes", message_id: "m1" });
      await deliver(902, { type: "toolUsed", tool: STREAMED_SAY_TOOL, actionId: "toolu_1", status: "start", message_id: "m1" });
    } finally {
      Object.assign(tombstoneReader, originalTombstone);
      resetDeletedSessionCache();
    }
    assert.deepEqual(acked, ["ack 901", "ack 902"]);
    const rows = await w.q("SELECT event FROM claw_session_events WHERE session_id = $1 ORDER BY id", [alice.routerSid]);
    assert.deepEqual(rows.map((r: { event: string }) => r.event), ["toolUsed"]);
  });
});
