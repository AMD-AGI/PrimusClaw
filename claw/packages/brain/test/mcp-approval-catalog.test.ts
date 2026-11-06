// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The MCP tool catalog (`@claw/protocol` mcp-tool-catalog.ts) over every approval spec: for a server it knows, a write it lists
 * waits for a person whatever the spec says, and is released only where the catalog calls it releasable. A spec is a hand-kept
 * list; SaFE's left workload_resume out and it ran without asking.
 *
 *   AC1 SaFE's 27-name hand list: workload_resume and workload_logs_download are held as well; the reads still run
 *   AC2 `false`, no field at all: every catalogued write is held, no read is, and the hold turns nothing else on (operatorActive)
 *   AC3 auto_approve cannot release a write the catalog does not call releasable (an apply_*), can release one it does (a
 *       preview_*), and releases reads as before
 *   AC4 a server the catalog does not know is untouched; a tool the catalog does not list follows the spec alone
 *   AC5 through the controller a turn uses: with the hand list, workload_resume asks and is denied when nobody answers
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_CATALOG, catalogClassOf } from "@claw/protocol";
import { approvalPolicyFromMcp } from "../src/agent/approval-policy.js";
import { HitlController } from "../src/agent/hitl.js";

const base = { url: "https://mcp.example.invalid/mcp", type: "http", token: "t" };
const S = (bare: string) => `mcp__safe__${bare}`;
const A = (bare: string) => `mcp__autopilot__${bare}`;

/** What the site's plugin and platform defaults held for SaFE until 2026-11-06: 27 names, written by hand. */
const SAFE_HAND_LIST = [
  "apikey_create", "apikey_delete", "cluster_create", "cluster_delete", "cluster_manage_nodes", "cluster_update", "node_cordon",
  "node_create", "node_delete", "node_drain", "node_reboot", "node_uncordon", "node_update", "opsjob_create", "opsjob_delete",
  "opsjob_stop", "workload_batch_delete", "workload_batch_stop", "workload_create", "workload_delete", "workload_stop",
  "workload_update", "workspace_create", "workspace_delete", "workspace_manage_nodes", "workspace_scale", "workspace_update",
];
const safeWrites = Object.keys(TOOL_CATALOG.safe!.tools).filter((t) => catalogClassOf("safe", t) === "write");
const safeReads = Object.keys(TOOL_CATALOG.safe!.tools).filter((t) => catalogClassOf("safe", t) === "read");

test("AC1 the hand list's missing writes are held all the same", () => {
  const p = approvalPolicyFromMcp({ safe: { ...base, requires_approval: SAFE_HAND_LIST } });
  assert.equal(p.requiresApproval(S("workload_resume")), true);
  assert.equal(p.requiresApproval(S("workload_logs_download")), true);
  for (const w of safeWrites) assert.equal(p.requiresApproval(S(w)), true, w);
  for (const r of safeReads) assert.equal(p.requiresApproval(S(r)), false, r);
  assert.equal(p.operatorActive, true, "the spec's own rule is still the operator's");
});

test("AC2 with no rule of its own, a catalogued server's writes are held, and nothing else is turned on", () => {
  for (const spec of [{ ...base }, { ...base, requires_approval: false }, { ...base, requires_approval: null }]) {
    const p = approvalPolicyFromMcp({ safe: spec });
    const label = JSON.stringify(spec.requires_approval ?? "absent");
    assert.equal(p.active, true, label);
    assert.equal(p.operatorActive, false, `${label}: the catalog's hold is the platform's`);
    for (const w of safeWrites) assert.equal(p.requiresApproval(S(w)), true, `${label} ${w}`);
    for (const r of safeReads) assert.equal(p.requiresApproval(S(r)), false, `${label} ${r}`);
  }
  // `false` was the way to say "hold nothing"; it no longer lets a write the catalog lists run.
  assert.equal(approvalPolicyFromMcp({ "agent-board": { ...base, requires_approval: false } }).requiresApproval("mcp__agent-board__issue_write"), true);
});

test("AC3 auto_approve releases a catalogued write only where the catalog says it may", () => {
  const p = approvalPolicyFromMcp({ autopilot: { ...base, requires_approval: true, auto_approve: ["get_*", "preview_*", "apply_pool_limits"] } });
  assert.notEqual(p.autoApprovalRule(A("get_status"), {}), null, "a read");
  assert.notEqual(p.autoApprovalRule(A("preview_pool_limits"), {}), null, "a releasable write: it writes nothing");
  assert.equal(p.autoApprovalRule(A("apply_pool_limits"), {}), null, "an apply is never released, whatever the list says");
  assert.equal(p.requiresApproval(A("apply_pool_limits")), true);
  const safe = approvalPolicyFromMcp({ safe: { ...base, requires_approval: true, auto_approve: ["workload_*"] } });
  assert.notEqual(safe.autoApprovalRule(S("workload_get"), {}), null);
  for (const w of ["workload_resume", "workload_delete", "workload_logs_download"]) assert.equal(safe.autoApprovalRule(S(w), {}), null, w);
});

test("AC4 a server the catalog does not know, and a tool it does not list, follow the spec alone", () => {
  const p = approvalPolicyFromMcp({ ops: { ...base } });
  assert.equal(p.active, false);
  assert.equal(p.requiresApproval("mcp__ops__workload_resume"), false);
  const listed = approvalPolicyFromMcp({ safe: { ...base, requires_approval: ["workload_stop"], auto_approve: ["tool_added_tomorrow"] } });
  assert.equal(listed.requiresApproval(S("tool_added_tomorrow")), false, "not in the catalog: the spec does not hold it");
  const all = approvalPolicyFromMcp({ safe: { ...base, requires_approval: true, auto_approve: ["tool_added_tomorrow"] } });
  assert.notEqual(all.autoApprovalRule(S("tool_added_tomorrow"), {}), null, "not in the catalog: the spec releases it");
});

test("AC5 a turn's controller asks before workload_resume under the hand list, and denies it when nobody can answer", async () => {
  const p = approvalPolicyFromMcp({ safe: { ...base, requires_approval: SAFE_HAND_LIST } });
  const make = (dispatcher: unknown) => new HitlController(dispatcher as never, async () => {}, {
    requireApproval: (t) => p.requiresApproval(t),
    autoApprovalRule: (t, input) => p.autoApprovalRule(t, input),
    onlyHeld: !p.operatorActive,
  });
  const asked: string[] = [];
  const watched = make({ register: async (req: { actionId: string }) => { asked.push(req.actionId); return { type: "decision", session_id: "s", action_id: req.actionId, decision: "deny" }; } });
  assert.equal(watched.willAsk(S("workload_resume")), true);
  const r = await watched.beforeToolUse({ sessionId: "s", actionId: "toolu_1", tool: S("workload_resume"), input: { workload_id: "w" } });
  assert.deepEqual([r.action, asked], ["deny", ["toolu_1"]], "the person was asked, and said no");
  const nobody = make(null);
  const r2 = await nobody.beforeToolUse({ sessionId: "s", actionId: "toolu_2", tool: S("workload_resume"), input: { workload_id: "w" } });
  assert.equal(r2.action, "deny", "no approval channel: a held write does not run");
  assert.equal((await nobody.beforeToolUse({ sessionId: "s", actionId: "toolu_3", tool: S("workload_get"), input: {} })).action, "allow");
});
