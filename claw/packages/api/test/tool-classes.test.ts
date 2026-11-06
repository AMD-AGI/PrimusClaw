// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The closed set of MCP tool classes (`mcp-tool-catalog.ts` of `@claw/protocol`, `src/assistant/tool-classes.ts`): every tool of every
 * catalogued server has exactly one class, the router's reads and every approval policy are derived from it, and a spec that
 * lets a write run without a decision is found. Approval is read by Brain's own policy (`approvalPolicyFromMcp`), the code
 * that holds a call in a turn.
 *
 *   TC1 every catalogued tool is classified, by its annotations or by a review that does not contradict them
 *   TC2 the router's reads are the catalog's reads it does not keep back: no write among them, no prefix, and today's router set
 *   TC3 approvalSpec, read by Brain, holds every write (SaFE's workload_resume among them) and lets through only reads and
 *       releasable writes
 *   TC4 specProblems finds what a hand-kept list misses: SaFE's 27-name list without workload_resume, a `false`, a released write;
 *       and passes the method-prefix and hold-everything forms that do hold every write
 *   TC5 listProblems finds a new tool, a changed annotation, a lost annotation and a dropped tool in a live `tools/list`
 *   TC6 the API's own schedules server: every tool it lists is catalogued, and the hold it is given covers its writes
 *   TC7 the guard refuses: a tool added to a catalog without a class, a review against an annotation, a reason left empty
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const classes = await import("../src/assistant/tool-classes.js");
const { TOOL_CATALOG } = await import("@claw/protocol");
const { ROUTER_READ_TOOLS, readToolPatterns } = await import("../src/assistant/read-tools.js");
const { approvalPolicyFromMcp } = await import("../../brain/src/agent/approval-policy.js");
const { createTriggerMcpServer } = await import("../src/triggers/mcp.js");
const { TRIGGER_MCP_SERVER } = await import("@claw/protocol");

const { approvalSpec, catalogProblems, classOf, listProblems, routerReadsByServer, specProblems, toolsOfClass } = classes;
type Catalog = import("../src/assistant/tool-classes.js").Catalog;

/**
 * Whether the spec alone, as Brain reads a spec, holds `tool` of `server`, and whether it then lets a call with no arguments through
 * unasked. Alone: without the catalog Brain lays over every spec at run time (brain/test/mcp-approval-catalog.test.ts), which
 * would hold every catalogued write whatever the spec says and so hide the spec's own gaps this audits.
 */
function brain(server: string, spec: Record<string, unknown>) {
  const policy = approvalPolicyFromMcp({ [server]: spec }, { catalog: null });
  const name = (tool: string) => `mcp__${server}__${tool}`;
  return {
    held: (tool: string) => policy.requiresApproval(name(tool)),
    released: (tool: string) => policy.autoApprovalRule(name(tool), {}) !== null,
  };
}

/** Brain's allow-list matching (`tools/allowlist.ts`): an exact name, or a prefix before a trailing `*`. */
const allows = (list: readonly string[], name: string) => list.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

/** What the site's plugin and platform defaults held on 2026-11-06 for SaFE: 27 names, written by hand. */
const SAFE_HAND_LIST = [
  "apikey_create", "apikey_delete", "cluster_create", "cluster_delete", "cluster_manage_nodes", "cluster_update", "node_cordon",
  "node_create", "node_delete", "node_drain", "node_reboot", "node_uncordon", "node_update", "opsjob_create", "opsjob_delete",
  "opsjob_stop", "workload_batch_delete", "workload_batch_stop", "workload_create", "workload_delete", "workload_stop",
  "workload_update", "workspace_create", "workspace_delete", "workspace_manage_nodes", "workspace_scale", "workspace_update",
];

describe("MCP tool classes", () => {
  test("TC1 every catalogued tool has exactly one class", () => {
    assert.deepEqual(catalogProblems(), []);
    for (const [server, c] of Object.entries(TOOL_CATALOG)) {
      const tools = Object.keys(c.tools);
      assert.ok(tools.length > 0, `${server} lists tools`);
      assert.deepEqual([...toolsOfClass(server, "read"), ...toolsOfClass(server, "write")].sort(), [...tools].sort(), `${server}: read + write is every tool`);
    }
    // Only a server whose tools are this repository's code may leave its unlisted tools to the spec (TC6 lists them from the code).
    assert.deepEqual(Object.entries(TOOL_CATALOG).filter(([, c]) => c.unlisted !== undefined).map(([s, c]) => `${s}:${c.unlisted}`), ["schedules:spec"]);
    // The ones a person decided, where the server's annotations say nothing.
    assert.equal(classOf("safe", "workload_resume"), "write");
    assert.equal(classOf("safe", "workload_logs_download"), "write", "it starts a log-dump job and answers a presigned URL");
    assert.equal(classOf("safe", "workload_get"), "read");
    // Annotated by the server: a preview says readOnlyHint false, so it is a write, released by name below.
    assert.equal(classOf("autopilot", "preview_pool_limits"), "write");
    assert.equal(classOf("agent-board", "label_write"), "write");
    assert.equal(classOf("safe", "no_such_tool"), null);
    assert.equal(classOf("no-such-server", "get_x"), null);
  });

  test("TC2 the router's reads are derived: reads only, by name, and the set the router had", () => {
    assert.deepEqual(ROUTER_READ_TOOLS, routerReadsByServer());
    for (const [server, tools] of Object.entries(ROUTER_READ_TOOLS)) {
      for (const t of tools) {
        assert.equal(classOf(server, t), "read", `${server}: ${t}`);
        assert.ok(!t.includes("*"), `${server}: ${t} is a name, not a prefix`);
        assert.equal(TOOL_CATALOG[server]!.notForRouter?.[t], undefined, `${server}: ${t} is not kept back`);
      }
      for (const w of toolsOfClass(server, "write")) assert.ok(!allows(readToolPatterns(server), `mcp__${server}__${w}`), `${server}: ${w}`);
    }
    // What the hand-written list (main before this change) offered, applied to each server's tools/list as the live servers
    // answered it on 2026-11-06: written out here, not computed from the catalog, so a tool the catalog dropped would show.
    const before: Record<string, string[]> = {
      autopilot: ["get_allocation_marker", "get_audit", "get_events", "get_gpupools", "get_host_exclusions", "get_metrics", "get_pods", "get_status",
        "get_submit_account_exclusions", "get_whoami"],
      safe: ["cluster_get", "cluster_list", "flavor_get", "flavor_list", "node_get", "node_list", "node_status", "opsjob_get", "opsjob_list", "user_self",
        "workload_get", "workload_list", "workspace_get", "workspace_list"],
      dispatron: ["get_alerts", "get_changes", "get_configs", "get_configs_config_id", "get_events", "get_facade_defaults", "get_findings", "get_follow_history",
        "get_follow_policy_plan_id", "get_follow_status", "get_ka_runs_run_artifacts_name", "get_me", "get_people", "get_plans", "get_plans_plan_id",
        "get_plans_plan_id_commits", "get_plans_plan_id_day0", "get_plans_plan_id_latest", "get_plans_plan_id_stats", "get_plans_plan_id_trend",
        "get_problems_problem_id", "get_releases", "get_runs", "get_runs_task_id", "get_runs_task_id_health", "get_runs_task_id_issue",
        "get_source_commits_sha", "get_source_versions", "get_sources"],
      pulse: ["cost_overview", "leaderboard_history", "leaderboard_list", "leaderboard_show", "leaderboard_summary", "leaderboard_top", "upstream_issue",
        "upstream_issues", "upstream_pr", "upstream_prs"],
      "agent-board": ["get_me", "get_repository_tree", "get_user_orgs", "issue_read", "label_read", "list_issues", "list_my_repos", "list_org_repos"],
    };
    assert.deepEqual(ROUTER_READ_TOOLS, before, "the router is offered exactly what it was offered before, server by server");
    // Kept back, each for a reason the catalog states.
    for (const t of ["apikey_list", "secret_list", "workload_logs", "workload_pod_logs"]) {
      assert.ok(!allows(readToolPatterns("safe"), `mcp__safe__${t}`), t);
      assert.ok(TOOL_CATALOG.safe!.notForRouter?.[t], t);
    }
  });

  test("TC3 the derived approval spec, read by Brain, holds every write and runs every read", () => {
    for (const server of Object.keys(TOOL_CATALOG)) {
      const spec = approvalSpec(server);
      const b = brain(server, spec);
      const releasable = new Set(Object.keys(TOOL_CATALOG[server]!.releasable ?? {}));
      for (const w of toolsOfClass(server, "write")) {
        assert.ok(b.held(w), `${server}: ${w} is held`);
        assert.equal(b.released(w), releasable.has(w), `${server}: ${w} is released only when releasable`);
      }
      for (const r of toolsOfClass(server, "read")) assert.ok(b.released(r), `${server}: ${r} runs without a decision`);
      // A tool the server adds later is held until it is classified.
      assert.ok(b.held("tool_added_tomorrow") && !b.released("tool_added_tomorrow"), server);
      assert.deepEqual(specProblems(server, spec, b.held), [], server);
    }
    const safe = brain("safe", approvalSpec("safe"));
    assert.ok(safe.held("workload_resume") && !safe.released("workload_resume"), "workload_resume waits for the person");
    assert.ok(safe.released("workload_get"));
    assert.throws(() => approvalSpec("no-such-server"), /no catalog/);
  });

  test("TC4 specProblems finds a write a spec lets run, and passes specs that hold every write", () => {
    const check = (server: string, spec: Record<string, unknown>) => specProblems(server, spec, brain(server, spec).held);
    // The site's hand list: everything SaFE annotates as a read runs, and so do workload_resume and workload_logs_download.
    assert.deepEqual(check("safe", { requires_approval: SAFE_HAND_LIST }), [
      { server: "safe", tool: "workload_logs_download", problem: "a write the spec does not hold for approval" },
      { server: "safe", tool: "workload_resume", problem: "a write the spec does not hold for approval" },
    ]);
    assert.deepEqual(check("safe", { requires_approval: [...SAFE_HAND_LIST, "workload_resume", "workload_logs_download"] }), [],
      "the same list with both is whole");
    // `false` holds nothing: every write is reported.
    assert.deepEqual(check("pulse", { requires_approval: false }), [], "pulse has no write");
    assert.equal(check("agent-board", { requires_approval: false }).length, toolsOfClass("agent-board", "write").length);
    // Dispatron's method prefixes hold every write it lists.
    assert.deepEqual(check("dispatron", { requires_approval: ["post_*", "put_*", "patch_*", "delete_*"] }), []);
    assert.deepEqual(check("dispatron", { requires_approval: ["post_*", "put_*", "patch_*"] }).map((p) => p.tool),
      ["delete_plans_plan_id_items_config_id", "delete_runs_task_id_not_defect"]);
    // Autopilot holds everything and releases the reads and its previews: the previews are releasable, an apply is not.
    assert.deepEqual(check("autopilot", { requires_approval: true, auto_approve: ["get_*", "preview_*"] }), []);
    assert.deepEqual(check("autopilot", { requires_approval: true, auto_approve: ["get_*", "preview_*", "apply_pool_limits"] }), [
      { server: "autopilot", tool: "apply_pool_limits", problem: "a write the spec releases without a decision" },
    ]);
    // A `when` releases some calls of a write: still reported. A malformed auto_approve releases nothing, as in Brain.
    assert.deepEqual(check("safe", { requires_approval: true, auto_approve: [{ tool: "workload_stop", when: { dry_run: true } }] }).map((p) => p.tool), ["workload_stop"]);
    assert.deepEqual(check("safe", { requires_approval: true, auto_approve: ["workload_stop", { tool: "x", whn: {} }] }), []);
    // Both spellings must release a call for Brain to let it through.
    assert.deepEqual(check("safe", { requires_approval: true, auto_approve: ["workload_stop"], autoApprove: ["workload_get"] }), []);
    // A server the catalog does not know: nothing of it is classified.
    assert.equal(check("scratchpad", { requires_approval: true })[0]!.problem, "the catalog does not know this server: none of its tools is classified");
  });

  test("TC5 listProblems compares a live tools/list with the catalog", () => {
    const listed = Object.entries(TOOL_CATALOG.safe!.tools).map(([name, annotations]) => ({ name, annotations }));
    assert.deepEqual(listProblems("safe", listed), []);
    const changed = [
      ...listed.filter((t) => t.name !== "node_status" && t.name !== "workload_get"),
      { name: "workload_get", annotations: {} },                                    // lost its annotations
      { name: "workload_restart", annotations: {} },                                // new, unannotated
      { name: "workload_peek", annotations: { readOnlyHint: true } },               // new, annotated
    ].map((t) => (t.name === "workload_list" ? { ...t, annotations: { readOnlyHint: false } } : t));
    assert.deepEqual(listProblems("safe", changed).map((p) => `${p.tool}: ${p.problem}`).sort(), [
      "node_status: catalogued, but the server no longer lists it",
      "workload_get: lost its annotations: review its class",
      "workload_list: now annotated as write, catalogued as read",
      "workload_peek: not in the catalog (annotated read): classify it",
      "workload_restart: not in the catalog (annotated neither way): classify it",
    ]);
    assert.equal(listProblems("unknown", listed).length, 1);
  });

  test("TC6 the API's own schedules server lists only catalogued tools, and its hold covers every write", async () => {
    const server = createTriggerMcpServer({ sid: "s", mid: "m", task_id: "t", exp: Math.floor(Date.now() / 1000) + 60 } as never);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(b);
    try {
      const listed = (await client.listTools()).tools.map((t) => ({ name: t.name, annotations: t.annotations }));
      assert.deepEqual(listProblems(TRIGGER_MCP_SERVER, listed), []);
    } finally { await client.close(); await server.close(); }
    // The spec the API gives a turn holds the catalog's writes by name (`triggers/mcp.ts`).
    const spec = { requires_approval: toolsOfClass(TRIGGER_MCP_SERVER, "write") };
    assert.deepEqual(spec.requires_approval, ["trigger_cancel", "trigger_create"]);
    assert.deepEqual(specProblems(TRIGGER_MCP_SERVER, spec, brain(TRIGGER_MCP_SERVER, spec).held), []);
  });

  test("TC7 the checks refuse what a careless edit would bring", () => {
    const base = TOOL_CATALOG.safe!;
    const edited = (over: Partial<typeof base>): Catalog => ({ safe: { ...base, ...over } });
    assert.deepEqual(catalogProblems(edited({ tools: { ...base.tools, workload_restart: {} } })), [
      { server: "safe", tool: "workload_restart", problem: "unclassified: no annotation decides it and it is not reviewed" },
    ]);
    assert.deepEqual(catalogProblems(edited({ reviewed: { ...base.reviewed, workload_get: "write" } })), [
      { server: "safe", tool: "workload_get", problem: "reviewed as write, annotated as read" },
    ]);
    assert.deepEqual(catalogProblems(edited({ reviewed: { ...base.reviewed, gone_tool: "read" } })), [
      { server: "safe", tool: "gone_tool", problem: "reviewed, but the server does not list it" },
    ]);
    assert.deepEqual(catalogProblems(edited({ notForRouter: { ...base.notForRouter, workload_get: " " } })), [
      { server: "safe", tool: "workload_get", problem: "kept from the router without a reason" },
    ]);
    assert.deepEqual(catalogProblems(edited({ notForRouter: { ...base.notForRouter, workload_stop: "x" } })), [
      { server: "safe", tool: "workload_stop", problem: "kept from the router, but not a listed read" },
    ]);
    assert.deepEqual(catalogProblems(edited({ releasable: { workload_get: "x" } })), [
      { server: "safe", tool: "workload_get", problem: "releasable, but not a listed write" },
    ]);
    // A tool that is unclassified is offered to nobody and held by the derived spec.
    const cat = edited({ tools: { ...base.tools, workload_restart: {} } });
    assert.ok(!routerReadsByServer(cat).safe!.includes("workload_restart"));
    assert.ok(!approvalSpec("safe", cat).auto_approve.includes("workload_restart"));
  });
});
