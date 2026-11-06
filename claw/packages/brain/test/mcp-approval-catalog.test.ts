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
 *   AC4 a server the catalog does not know is untouched; a tool the catalog does not list on a server it knows (one the server
 *       added since) is held, and auto_approve does not release it, until the catalog classifies it
 *   AC5 through the controller a turn uses: with the hand list, workload_resume asks and is denied when nobody answers
 *   AC6 the trigger server is held by name like any catalogued server: its writes and a tool it does not list, wherever it points
 *       (the API's reserved path on another host too)
 *   AC7 the catalog only ever adds: whatever the spec, every call the spec holds is still held, and nothing the spec does not
 *       release is released; a server with no rule of its own runs its catalogued reads exactly as it did before
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { TOOL_CATALOG, TRIGGER_MCP_PATH, TRIGGER_MCP_SERVER, catalogClassOf } from "@claw/protocol";
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

test("AC4 an unknown server is untouched; an unknown tool of a known server waits until the catalog classifies it", () => {
  const p = approvalPolicyFromMcp({ ops: { ...base } });
  assert.equal(p.active, false);
  assert.equal(p.requiresApproval("mcp__ops__workload_resume"), false);
  // SaFE adds workload_restart tomorrow; neither the hand list nor the catalog names it yet.
  for (const spec of [{ ...base, requires_approval: SAFE_HAND_LIST }, { ...base }, { ...base, requires_approval: false }]) {
    const listed = approvalPolicyFromMcp({ safe: spec });
    assert.equal(listed.requiresApproval(S("workload_restart")), true, JSON.stringify(spec.requires_approval ?? "absent"));
  }
  const broad = approvalPolicyFromMcp({ safe: { ...base, requires_approval: true, auto_approve: ["workload_*", "tool_added_tomorrow"] } });
  assert.equal(broad.autoApprovalRule(S("workload_restart"), {}), null, "a prefix in auto_approve does not release it");
  assert.equal(broad.autoApprovalRule(S("tool_added_tomorrow"), {}), null, "nor does its own name");
  assert.notEqual(broad.autoApprovalRule(S("workload_get"), {}), null, "a catalogued read still runs");
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

test("AC6 the trigger server is held by name: its writes and any tool it does not list, wherever it points", () => {
  const T = (bare: string) => `mcp__${TRIGGER_MCP_SERVER}__${bare}`;
  for (const url of [`https://api.example.invalid${TRIGGER_MCP_PATH}`, `https://attacker.example.invalid${TRIGGER_MCP_PATH}`, "https://elsewhere.example.invalid/mcp"]) {
    for (const spec of [{ ...base, url, requires_approval: ["trigger_create", "trigger_cancel"] }, { ...base, url }]) {
      const p = approvalPolicyFromMcp({ [TRIGGER_MCP_SERVER]: spec });
      const label = `${url} ${JSON.stringify(spec.requires_approval ?? "absent")}`;
      assert.equal(p.requiresApproval(T("trigger_create")), true, label);
      assert.equal(p.requiresApproval(T("trigger_cancel")), true, label);
      assert.equal(p.requiresApproval(T("drop_everything")), true, `${label}: a tool the catalog does not list`);
      assert.equal(p.requiresApproval(T("trigger_list")), false, `${label}: a catalogued read is not held by the catalog; the spec decides, as before`);
    }
    const released = approvalPolicyFromMcp({ [TRIGGER_MCP_SERVER]: { ...base, url, requires_approval: true, auto_approve: ["trigger_*", "drop_*"] } });
    assert.equal(released.autoApprovalRule(T("trigger_create"), {}), null, `${url}: not releasable`);
    assert.equal(released.autoApprovalRule(T("drop_everything"), {}), null, `${url}: unlisted, not releasable`);
  }
});

test("AC7 the catalog never makes a call less held than its spec alone", () => {
  const specs: Array<Record<string, unknown>> = [
    {}, { requires_approval: false }, { requires_approval: true }, { requires_approval: ["workload_get", "trigger_list"] },
    { requires_approval: true, auto_approve: ["*_get", "workload_*", "trigger_*", "get_*", "preview_*", "apply_*"] },
    { requires_approval: true, auto_approve: [{ tool: "workload_resume", when: { dry_run: true } }] }, { requires_approval: "malformed" },
  ];
  let compared = 0;
  for (const server of Object.keys(TOOL_CATALOG)) {
    const tools = [...Object.keys(TOOL_CATALOG[server]!.tools), "tool_added_tomorrow"];
    for (const extra of specs) {
      const spec = { ...base, ...extra };
      const alone = approvalPolicyFromMcp({ [server]: spec }, { catalog: null });
      const withCatalog = approvalPolicyFromMcp({ [server]: spec });
      for (const t of tools) {
        const name = `mcp__${server}__${t}`;
        for (const input of [{}, { dry_run: true }]) {
          const label = `${server} ${JSON.stringify(extra)} ${t} ${JSON.stringify(input)}`;
          if (alone.requiresApproval(name)) assert.equal(withCatalog.requiresApproval(name), true, `${label}: held by the spec`);
          if (withCatalog.requiresApproval(name) && withCatalog.autoApprovalRule(name, input) !== null) {
            assert.notEqual(alone.autoApprovalRule(name, input), null, `${label}: released only where the spec alone releases it`);
          }
          // Not held by the spec, and a catalogued read: the catalog leaves it exactly as it was.
          if (!alone.requiresApproval(name) && catalogClassOf(server, t) === "read") assert.equal(withCatalog.requiresApproval(name), false, label);
          compared++;
        }
      }
    }
  }
  assert.ok(compared > 2000, `${compared} comparisons`);
});
