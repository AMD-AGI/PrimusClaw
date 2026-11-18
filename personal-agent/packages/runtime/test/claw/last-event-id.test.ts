// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ReplayRefused } from "@primusclaw/personal-agent";
import { json, Wire } from "./wire.js";

describe("the newest stored event", () => {
  it("last event id asks for the newest event alone", async () => {
    const wire = new Wire(() =>
      json(200, {
        ok: true,
        has_more: true,
        data: [{ event_id: "claw-41", event_type: "toolUsed", data: { type: "toolUsed" }, created_at: null }],
      }),
    );
    assert.equal(
      await wire.client({ baseUrl: "https://claw.test/claw-api" }).sessions.lastEventId("ak-alice", "s1"),
      "claw-41",
    );
    assert.deepEqual(
      wire.sent.map((s) => s.url.href),
      ["https://claw.test/claw-api/v1/chat/sessions/s1/messages?mode=replay&tail=1"],
    );
  });

  it("last event id of an empty session is none", async () => {
    const wire = new Wire(() => json(200, { ok: true, has_more: false, data: [] }));
    assert.equal(await wire.client().sessions.lastEventId("ak-alice", "s1"), null);
  });

  it("an older claw that sends the whole history is refused unread", async () => {
    const rows = Array.from({ length: 1000 }, (_, n) => ({
      event_id: `claw-${String(n)}`,
      event_type: "toolUsed",
      data: { type: "toolUsed", pad: "x".repeat(500) },
    }));
    const body = JSON.stringify({ ok: true, data: rows });
    assert.ok(body.length > 262_144);
    const wire = new Wire(() => new Response(body));
    await assert.rejects(wire.client().sessions.lastEventId("ak-alice", "s1"), ReplayRefused);
  });
});
