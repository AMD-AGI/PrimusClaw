// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A rule-held shell command, the approvals' half (teams/tests/test_bash_approval_flow.py): the card a turn shows is recorded for
 * Alice for as long as Brain waits, Claw's notification of the same approval shows no second card, Deny and Approve reach Claw
 * with her own key and replace the card, nobody else answers it, a double tap answers once, and a card works for as long as Brain
 * waits and not longer. The turn's own half (the stream that holds and goes on, the live progress, the Report a problem button)
 * is the turn's (W4b); what the card shows is teams/test/assistant-cards-render-approvals.test.ts.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ApprovalFlow, settledView } from "../../../../test-support/assistant/approval-flow.js";
import { ALICE, world } from "../../../../test-support/assistant/proactive-world.js";
import { advanceSeconds } from "../../../../test-support/store.js";
import type { JsonObject } from "../../src/json.js";
import { waitSeconds } from "../../src/turn/engine/consume.js";

const BOB = "aad-b";
const SESSION = "sess-ak-alice";
const COMMAND = "git push -u origin fix/parser";
const LABEL = "git push (publishes commits to a remote)";

function flowWorld() {
  const w = world();
  for (const [user, key] of [
    [ALICE, "ak-alice"],
    [BOB, "ak-bob"],
  ] as const) {
    w.store.links.redeemPending(user, user, w.store.links.stashPending(key));
  }
  const flow = new ApprovalFlow(w.store);
  const conversation = w.surface.conversation({
    id: `c-${ALICE}`,
    kind: "personal",
    tenantId: "",
    wire: { conversation: { id: `c-${ALICE}` } },
  });
  /** Brain holds `toolUseId` (a permissionRequest that waits `timeoutMs`): the turn shows its card. */
  const held = (toolUseId: string, timeoutMs: unknown = 1_800_000) =>
    flow.show(
      conversation,
      { userId: ALICE, sessionId: SESSION, toolUseId, tool: "bash", waitSeconds: waitSeconds(timeoutMs) },
      {
        name: "approval",
        model: {
          tool: "bash",
          input: { command: COMMAND },
          sessionId: SESSION,
          toolUseId,
          group: false,
          ownerName: "",
          event: { approval_label: LABEL },
          lang: null,
        },
      },
    );
  return { ...w, flow, held };
}

function decision(toolUseId: string, action: string): JsonObject {
  return { primusclaw: "decision", session_id: SESSION, tool: "bash", tool_use_id: toolUseId, action };
}

function approvalEvent(toolUseId: string): JsonObject {
  return {
    event_id: "ap-1",
    type: "approval.requested",
    occurred_at: "2026-10-27T00:00:00Z",
    user_id: "u-alice",
    session_id: SESSION,
    task_id: "t1",
    trigger_id: null,
    title: "Approval needed",
    summary: "",
    link: "/primus-claw/sessions/s1",
    approval: {
      tool_use_id: toolUseId,
      tool: "workload_stop",
      target: "llama-70b-ft",
      expires_at: "2026-10-27T04:30:00Z",
    },
  };
}

it("held then denied then asked again and approved", async () => {
  const w = flowWorld();
  assert.equal(await w.held("tu1"), true);
  // the run is waiting on the user: one card, recorded for Alice; nothing decided yet
  assert.deepEqual(w.flow.claw.calls, []);
  // Claw's notification for the same approval arrives while the turn is open: no second card
  assert.equal(await w.proactive.handle(ALICE, w.reference, approvalEvent("tu1")), "dropped");
  assert.equal(w.surface.outbox.filter((r) => r.op === "send").length, 1);
  // Alice presses Deny: it reaches Claw with her own key and replaces the card
  const denied = await w.flow.press(ALICE, decision("tu1", "deny"));
  assert.deepEqual(w.flow.claw.calls, [["decide", "ak-alice", SESSION, "tu1", "deny"]]);
  const shown = settledView(denied[0]);
  assert.ok(shown?.name === "approvalDecided");
  assert.equal(shown.model.action, "deny");
  assert.equal(w.store.approvals.getApproval(SESSION, "tu1")?.state, "decided");
  assert.deepEqual(w.flow.denied, [[ALICE, ""]]); // (a denied tool offers the report button: the turn's)
  // asked again: Bob cannot answer Alice's approval, with his key or hers
  assert.equal(await w.held("tu2"), true);
  await w.flow.press(BOB, decision("tu2", "allow"));
  assert.deepEqual(
    w.flow.claw.of("decide").filter((c) => c[1] === "ak-bob" || c[3] === "tu2"),
    [],
  );
  await w.flow.press(ALICE, decision("tu2", "allow"));
  const again = await w.flow.press(ALICE, decision("tu2", "allow")); // a double tap
  assert.deepEqual(
    w.flow.claw.of("decide").filter((c) => c[3] === "tu2"),
    [["decide", "ak-alice", SESSION, "tu2", "allow"]],
  );
  assert.ok(typeof again[0]?.card === "string" && again[0].card !== "");
  assert.equal(w.store.approvals.getApproval(SESSION, "tu2")?.state, "decided");
  assert.equal(w.surface.outbox.filter((r) => r.op === "send").length, 2); // one card per approval, all told
});

it("an approval card works for as long as brain waits and not longer", async () => {
  const cases: [unknown, number, boolean][] = [
    [300_000, 299, true],
    [300_000, 301, false], // Brain's own wait (the default, 5 minutes) is how long the card works
    [1_800_000, 1799, true],
    [1_800_000, 1801, false], // and 30 minutes when it waits that long
    [undefined, 1799, true],
    [undefined, 1801, false], // a Brain that does not say: as long as the turn is followed
    [0, 1799, true],
    [-1, 1799, true],
    [-1, 1801, false],
    ["300", 1801, false],
    [true, 1799, true],
    [true, 1801, false], // not a sane wait
    [10 ** 12, 24 * 3600 - 1, true],
    [10 ** 12, 24 * 3600 + 1, false], // nor a wait of more than a day
  ];
  for (const [timeoutMs, clickAfter, accepted] of cases) {
    const w = flowWorld();
    await w.held("tu1", timeoutMs);
    advanceSeconds(w.clock, clickAfter);
    const settled = await w.flow.press(ALICE, decision("tu1", "allow"));
    const label = `${String(timeoutMs)} after ${String(clickAfter)}`;
    assert.equal(
      w.flow.claw.calls.some(
        (c) => JSON.stringify(c) === JSON.stringify(["decide", "ak-alice", SESSION, "tu1", "allow"]),
      ),
      accepted,
      label,
    );
    const shown = settledView(settled[0]);
    if (accepted) assert.ok(shown?.name === "approvalDecided" && shown.model.action === "allow", label);
    else assert.equal(shown?.name, "approvalExpired", label);
    assert.equal(w.store.approvals.getApproval(SESSION, "tu1")?.state, accepted ? "decided" : "expired", label);
  }
});
