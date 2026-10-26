// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `requires_approval` on an MCP server spec: which tools it holds, and that a
 * held tool never runs without a person saying yes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { approvalPolicyFromMcp } from "../src/agent/approval-policy.js";
import { normalizeMcpConfigs } from "../src/clients/mcp-config.js";
import { HitlController } from "../src/agent/hitl.js";
import type { NatsDecisionMessage } from "../src/delivery/decision-dispatcher.js";

const base = { url: "https://mcp.example.invalid/mcp", type: "http", token: "t" };

test("no rule means no policy", () => {
  const p = approvalPolicyFromMcp({ safe: { ...base } });
  assert.equal(p.active, false);
  assert.equal(p.requiresApproval("mcp__safe__workload_stop"), false);
});

test("a list holds exactly the named tools, of that server only", () => {
  const p = approvalPolicyFromMcp({
    safe: { ...base, requires_approval: ["workload_stop", "node_*"] },
    other: { ...base },
  });
  assert.equal(p.active, true);
  assert.equal(p.requiresApproval("mcp__safe__workload_stop"), true);
  assert.equal(p.requiresApproval("mcp__safe__node_delete"), true);
  assert.equal(p.requiresApproval("mcp__safe__workload_get"), false);
  assert.equal(p.requiresApproval("mcp__other__workload_stop"), false);
  assert.equal(p.requiresApproval("workload_stop"), false);
});

test("true holds every tool of the server; junk values hold nothing", () => {
  const all = approvalPolicyFromMcp({ safe: { ...base, requires_approval: true } });
  assert.equal(all.requiresApproval("mcp__safe__anything"), true);
  for (const bad of ["yes", 1, {}, [], [""], [5], null]) {
    assert.equal(approvalPolicyFromMcp({ safe: { ...base, requires_approval: bad } }).active, false, JSON.stringify(bad));
  }
});

test("the field survives normalizeMcpConfigs", () => {
  const out = normalizeMcpConfigs({ safe: { ...base, requires_approval: ["a"] } });
  assert.deepEqual(out.safe.requires_approval, ["a"]);
});

function fakeDispatcher(answer: Partial<NatsDecisionMessage> | Error) {
  const registered: string[] = [];
  return {
    registered,
    register: async (req: { actionId: string }) => {
      registered.push(req.actionId);
      if (answer instanceof Error) throw answer;
      return { type: "decision", session_id: "s", action_id: req.actionId, ...answer } as NatsDecisionMessage;
    },
  };
}

function controller(d: ReturnType<typeof fakeDispatcher> | null) {
  const events: Array<Record<string, unknown>> = [];
  const c = new HitlController(d as never, async (e) => { events.push(e as never); }, {
    requireApproval: (t) => t === "mcp__safe__workload_stop",
  });
  return { c, events };
}
const req = (tool: string) => ({ sessionId: "s", actionId: "toolu_1", tool, input: { workload_id: "w" } });

test("a held tool asks, and runs only on an explicit allow", async () => {
  const d = fakeDispatcher({ decision: "allow" });
  const { c, events } = controller(d);
  assert.equal(c.willAsk("mcp__safe__workload_stop"), true);
  const r = await c.beforeToolUse(req("mcp__safe__workload_stop"));
  assert.equal(r.action, "allow");
  assert.deepEqual(d.registered, ["toolu_1"]);
  const ask = events.find((e) => e.type === "permissionRequest")!;
  assert.equal(ask.tool_use_id, "toolu_1");
  assert.equal(ask.actionId, "toolu_1");
});

test("deny is a deny, and reaches the model as the reason", async () => {
  const { c, events } = controller(fakeDispatcher({ decision: "deny", feedback: "not now" }));
  const r = await c.beforeToolUse(req("mcp__safe__workload_stop"));
  assert.deepEqual([r.action, (r as { reason: string }).reason], ["deny", "not now"]);
  assert.equal(events.find((e) => e.type === "decisionResult")!.action, "deny");
});

test("a tool the policy does not hold is not asked about", async () => {
  const d = fakeDispatcher({ decision: "deny" });
  const { c } = controller(d);
  assert.equal(c.willAsk("mcp__safe__workload_get"), false);
  assert.equal((await c.beforeToolUse(req("mcp__safe__workload_get"))).action, "allow");
  assert.deepEqual(d.registered, []);
});

test("nobody answering is a deny, never an allow", async () => {
  const { c } = controller(fakeDispatcher(new Error("decision_timeout")));
  assert.equal((await c.beforeToolUse(req("mcp__safe__workload_stop"))).action, "deny");
});

test("no approval channel at all is a deny, not a silent run", async () => {
  const { c } = controller(null);
  const r = await c.beforeToolUse(req("mcp__safe__workload_stop"));
  assert.equal(r.action, "deny");
  assert.equal((await c.beforeToolUse(req("mcp__safe__workload_get"))).action, "allow");
});

test("an unknown decision value is a deny", async () => {
  const { c } = controller(fakeDispatcher({ decision: "maybe" }));
  assert.equal((await c.beforeToolUse(req("mcp__safe__workload_stop"))).action, "deny");
});
