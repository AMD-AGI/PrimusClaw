// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Claw's push of a request a task handed to a seat waits on: its card names the seat and the item, and the one reminder of a
 * request the agent keeps waiting on past its first wait (parked) brings the card back until the longer wait ends.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { advanceSeconds } from "../../../../test-support/store.js";
import { ALICE, world } from "../../../../test-support/assistant/proactive-world.js";
import type { JsonObject } from "../../src/json.js";
import type { RemoteAskRequest } from "../../src/proactive/deps.js";

function anAsk(actionId: string, expiresAt: string): JsonObject {
  return {
    action_id: actionId,
    tool: "Bash",
    title: "Run make test",
    options: [{ optionId: "allow-once" }, { optionId: "reject" }],
    expires_at: expiresAt,
  };
}

/** Claw's push of a seat's request: no work item of the person's own, its number and the seat's name instead. */
function seatSay(eventId: string, ask: JsonObject): JsonObject {
  return {
    type: "assistant.say",
    event_id: eventId,
    text: "x",
    remote: {
      kind: "needs_you",
      session_id: "rs-1",
      machine: "devbox",
      agent: "claude",
      ask,
      item_seq: 12,
      seat: { seat_id: "s1", alias: "发布台" },
    },
  };
}

it("a seat's request names the seat and its parked reminder brings the card back until the longer wait ends", async () => {
  const asked: RemoteAskRequest[] = [];
  const w = world({
    remote: {
      options: (raw): readonly unknown[] => (Array.isArray(raw) ? (raw as unknown[]) : []),
      askCard: (request) => {
        asked.push(request);
        return { body: { type: "text", text: `ask ${request.sessionId} ${String(request.ask["action_id"])}` } };
      },
      saidParts: (label, text) => [`${label}: ${text}`],
    },
  });
  const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
  const first = anAsk("act-1", iso(w.store.now() + 600));
  assert.equal(await w.proactive.handle(ALICE, w.reference, seatSay("say-1", first)), "delivered");
  assert.deepEqual(
    asked.map((r) => [r.about, r.seat, r.parked]),
    [["#12", "发布台", undefined]],
  );
  // The first wait ran out here: a press on the card now was refused, but the agent keeps waiting.
  advanceSeconds(w.clock, 700);
  w.store.remotePermissions.closeRemotePermission("rs-1", "act-1", "expired");
  const end = w.store.now() + 23 * 3600;
  const parked = { ...anAsk("act-1", iso(end)), parked: true };
  assert.equal(await w.proactive.handle(ALICE, w.reference, seatSay("say-2", parked)), "delivered");
  assert.deepEqual(asked.at(-1)?.parked, true);
  const kept = w.store.remotePermissions.getRemotePermission("rs-1", "act-1");
  assert.equal(kept?.state, "pending", "its card answers the agent again");
  assert.equal(Math.round(kept.expiresAt), Math.round(end), "until the longer wait ends, past the usual hour");
  // Never longer than a day, whatever the push says.
  const far = { ...anAsk("act-3", iso(w.store.now() + 5 * 86_400)), parked: true };
  assert.equal(await w.proactive.handle(ALICE, w.reference, seatSay("say-6", far)), "delivered");
  assert.ok((w.store.remotePermissions.getRemotePermission("rs-1", "act-3")?.expiresAt ?? 0) <= w.store.now() + 86_400);
  // Answered already: the reminder brings no card back.
  w.store.remotePermissions.closeRemotePermission("rs-1", "act-1", "decided");
  assert.equal(await w.proactive.handle(ALICE, w.reference, seatSay("say-3", parked)), "dropped");
  // A reminder without the request's first card is a card like any other; one that is not parked is still one card per request.
  assert.equal(
    await w.proactive.handle(ALICE, w.reference, seatSay("say-4", { ...anAsk("act-2", iso(end)), parked: true })),
    "delivered",
  );
  assert.equal(await w.proactive.handle(ALICE, w.reference, seatSay("say-5", anAsk("act-2", iso(end)))), "dropped");
  assert.equal(asked.length, 4);
});
