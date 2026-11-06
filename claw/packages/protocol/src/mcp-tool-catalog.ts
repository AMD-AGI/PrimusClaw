// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every tool of the MCP servers the assistant's plugin and the platform defaults name, as each server's `tools/list` answered,
 * and the reviewed decisions about them: the one closed set both sides read. The API derives from it what a router turn may call
 * and audits approval specs against it (`api/src/assistant/tool-classes.ts`); Brain holds every write it lists for a decision
 * whatever a spec says (`brain/src/agent/approval-policy.ts`). Nothing is listed by hand anywhere else.
 *
 * Per tool, `tools` keeps the two annotations that decide its class, as the server gave them:
 *   R   readOnlyHint: true                          a read
 *   W   readOnlyHint: false                         a write
 *   WD  readOnlyHint: false, destructiveHint: true  a write that destroys
 *   U   neither                                     decided in `reviewed`, by a person, from what the tool does
 * Annotations decide where they say something (a tool that claims both is a write); a review only fills what they leave open.
 * A server that changes an annotation, adds a tool or drops one fails the nightly comparison with its live `tools/list`
 * (`api/test/e2e/tool-classes-live.ts`) until this file says the same; a tool in neither `tools` nor `reviewed` is unclassified,
 * and the tests fail on it.
 */

export type ToolClass = "read" | "write";

/** The two annotations of a tool that decide its class. */
export interface ToolHints { readOnlyHint?: boolean; destructiveHint?: boolean }

export interface ServerCatalog {
  /** The day the server's `tools/list` was last read for this entry. */
  listedAt: string;
  /** Every tool the server lists, with the annotations it gave. */
  tools: Readonly<Record<string, ToolHints>>;
  /** The class of each tool whose annotations do not decide it. */
  reviewed: Readonly<Record<string, ToolClass>>;
  /** Reads a router turn is not offered, each with why. */
  notForRouter?: Readonly<Record<string, string>>;
  /** Writes an approval policy may release (`auto_approve`) without a decision, each with why. */
  releasable?: Readonly<Record<string, string>>;
}

export type ToolCatalog = Readonly<Record<string, ServerCatalog>>;

const R: ToolHints = { readOnlyHint: true };
const W: ToolHints = { readOnlyHint: false };
const WD: ToolHints = { readOnlyHint: false, destructiveHint: true };
const U: ToolHints = {};

/** Reads whose text is a log: it can carry a credential a job printed, and a router turn has no filter for that. */
const LOG = "log text, which can carry a credential a job printed; a worker reads it";

export const TOOL_CATALOG: ToolCatalog = {
  // SaFE: annotates its reads only, so every write is decided below.
  safe: {
    listedAt: "2026-11-06",
    tools: {
      apikey_create: U, apikey_current: R, apikey_delete: U, apikey_list: R, cluster_create: U, cluster_delete: U, cluster_get: R,
      cluster_list: R, cluster_logs: R, cluster_manage_nodes: U, cluster_update: U, flavor_avail: R, flavor_get: R, flavor_list: R,
      node_cordon: U, node_create: U, node_delete: U, node_drain: U, node_export: R, node_get: R, node_list: R, node_pod_logs: R,
      node_reboot: U, node_reboot_logs: R, node_status: R, node_uncordon: U, node_update: U, opsjob_create: U, opsjob_delete: U,
      opsjob_get: R, opsjob_list: R, opsjob_stop: U, secret_list: R, user_self: R, workload_batch_delete: U, workload_batch_stop: U,
      workload_create: U, workload_delete: U, workload_events: R, workload_get: R, workload_list: R, workload_logs: R,
      workload_logs_download: U, workload_pod_containers: R, workload_pod_logs: R, workload_resume: U, workload_stop: U,
      workload_update: U, workspace_create: U, workspace_delete: U, workspace_get: R, workspace_list: R, workspace_manage_nodes: U,
      workspace_scale: U, workspace_update: U,
    },
    reviewed: {
      apikey_create: "write", apikey_delete: "write",
      cluster_create: "write", cluster_delete: "write", cluster_manage_nodes: "write", cluster_update: "write",
      node_cordon: "write", node_create: "write", node_delete: "write", node_drain: "write", node_reboot: "write",
      node_uncordon: "write", node_update: "write",
      opsjob_create: "write", opsjob_delete: "write", opsjob_stop: "write",
      workload_batch_delete: "write", workload_batch_stop: "write", workload_create: "write", workload_delete: "write",
      // Dispatches a stopped workload again: it starts work on the cluster as its owner.
      workload_resume: "write",
      workload_stop: "write", workload_update: "write",
      // Starts a job on the cluster that dumps the logs to object storage, and answers a presigned URL to them.
      workload_logs_download: "write",
      workspace_create: "write", workspace_delete: "write", workspace_manage_nodes: "write", workspace_scale: "write",
      workspace_update: "write",
    },
    notForRouter: {
      apikey_current: "the user's own API keys: a router has no use for them",
      apikey_list: "the user's own API keys: a router has no use for them",
      secret_list: "the user's secrets, by name: nothing a chat answer needs",
      cluster_logs: LOG, node_pod_logs: LOG, node_reboot_logs: LOG, workload_logs: LOG, workload_pod_logs: LOG,
      node_export: "an export of the node list in bulk: node_list answers the questions a chat asks",
      workload_events: "a failure diagnosis, which reads events and logs together: a worker's",
      workload_pod_containers: "a failure diagnosis, which reads events and logs together: a worker's",
      flavor_avail: "a capacity search across clusters, slower than a router turn's budget: a worker's",
    },
  },
  // Autopilot's admin MCP: get_* read; preview_* answer what an apply would do; apply_* change the fleet.
  autopilot: {
    listedAt: "2026-11-06",
    tools: {
      apply_allocation_resolve: WD, apply_allocation_stop: WD, apply_gpupool_create: W, apply_gpupool_delete: WD, apply_gpupool_layout: W,
      apply_gpupool_spec: W, apply_host_exclusion_add: WD, apply_host_exclusion_remove: W, apply_pool_limits: W,
      apply_submit_account_exclusion_add: WD, apply_submit_account_exclusion_remove: W, get_allocation_marker: R, get_audit: R,
      get_events: R, get_gpupools: R, get_host_exclusions: R, get_metrics: R, get_pods: R, get_status: R, get_submit_account_exclusions: R,
      get_whoami: R, preview_allocation_resolve: W, preview_allocation_stop: W, preview_gpupool_delete: W, preview_gpupool_layout: W,
      preview_gpupool_spec: W, preview_host_exclusion_add: W, preview_host_exclusion_remove: W, preview_pool_limits: W,
      preview_submit_account_exclusion_add: W, preview_submit_account_exclusion_remove: W,
    },
    reviewed: {},
    releasable: Object.fromEntries([
      "preview_allocation_resolve", "preview_allocation_stop", "preview_gpupool_delete", "preview_gpupool_layout", "preview_gpupool_spec",
      "preview_host_exclusion_add", "preview_host_exclusion_remove", "preview_pool_limits", "preview_submit_account_exclusion_add",
      "preview_submit_account_exclusion_remove",
    ].map((t) => [t, "writes nothing: it answers the rows before and after and a confirm token that only the held apply_* call spends"])),
  },
  // Dispatron's MCP is its HTTP API under the deployment's profile, one tool per route, named by method.
  dispatron: {
    listedAt: "2026-11-06",
    tools: {
      delete_plans_plan_id_items_config_id: WD, delete_runs_task_id_not_defect: WD, get_alerts: R, get_changes: R, get_configs: R,
      get_configs_config_id: R, get_events: R, get_facade_defaults: R, get_findings: R, get_follow_history: R,
      get_follow_policy_plan_id: R, get_follow_status: R, get_ka_runs_run_artifacts_name: R, get_me: R, get_people: R, get_plans: R,
      get_plans_plan_id: R, get_plans_plan_id_commits: R, get_plans_plan_id_day0: R, get_plans_plan_id_latest: R,
      get_plans_plan_id_stats: R, get_plans_plan_id_trend: R, get_problems_problem_id: R, get_releases: R, get_runs: R,
      get_runs_task_id: R, get_runs_task_id_health: R, get_runs_task_id_issue: R, get_source_commits_sha: R, get_source_versions: R,
      get_sources: R, patch_configs_config_id_params: W, patch_configs_params: W, patch_plans_plan_id_items_config_id: W,
      patch_plans_plan_id_labels: W, post_change_log_change_id_revert: W, post_configs_config_id_copy: W, post_plans: W,
      post_plans_plan_id_items: W, post_plans_plan_id_items_config_id_requeue: W, post_plans_plan_id_recycle: W,
      post_problems_problem_id_diagnosis_mark: W, post_problems_problem_id_reopen: W, post_problems_problem_id_resolve: W,
      post_runs_task_id_cancel: W, post_runs_task_id_issue: W, post_runs_task_id_issue_link: W, post_runs_task_id_issue_unlink: W,
      post_runs_task_id_not_defect: W, post_runs_task_id_owner: W, put_configs: W, put_plans_plan_id_automation: W,
      put_plans_plan_id_overrides: W, put_plans_plan_id_schedule: W, put_plans_plan_id_status: W,
    },
    reviewed: {},
  },
  pulse: {
    listedAt: "2026-11-06",
    tools: {
      cost_overview: R, leaderboard_history: R, leaderboard_list: R, leaderboard_show: R, leaderboard_summary: R, leaderboard_top: R,
      upstream_issue: R, upstream_issues: R, upstream_pr: R, upstream_prs: R,
    },
    reviewed: {},
  },
  // The agent board (Gitea's MCP).
  "agent-board": {
    listedAt: "2026-11-06",
    tools: {
      attachment_read: R, create_repo: W, fork_repo: W, get_me: R, get_repository_tree: R, get_user_orgs: R, issue_read: R,
      issue_write: W, label_read: R, label_write: WD, list_issues: R, list_my_repos: R, list_org_repos: R, milestone_read: R,
      milestone_write: WD, notification_read: R, notification_write: W,
    },
    reviewed: {},
    notForRouter: {
      attachment_read: "an attachment is a file: a worker reads it",
      milestone_read: "not one of the board questions a chat asks yet; add it here with a router case",
      notification_read: "not one of the board questions a chat asks yet; add it here with a router case",
    },
  },
  // The API's own scheduled-task tools (`triggers/mcp.ts`, server `schedules`), listed by the tests from the server itself.
  schedules: {
    listedAt: "2026-11-06",
    tools: { trigger_cancel: U, trigger_create: U, trigger_list: U },
    reviewed: { trigger_cancel: "write", trigger_create: "write", trigger_list: "read" },
    notForRouter: { trigger_list: "the API adds this server to worker turns only" },
  },
};

/** The class a tool's annotations give it, or null when they leave it open. */
export function hintedClass(h: ToolHints | undefined): ToolClass | null {
  if (!h) return null;
  if (h.destructiveHint === true || h.readOnlyHint === false) return "write";
  return h.readOnlyHint === true ? "read" : null;
}

const own = <T>(o: Readonly<Record<string, T>> | undefined, k: string): T | undefined => (o && Object.hasOwn(o, k) ? o[k] : undefined);

/** A catalogued tool's class, or null when the server or the tool is not catalogued, or nothing classifies it. */
export function catalogClassOf(server: string, tool: string, catalog: ToolCatalog = TOOL_CATALOG): ToolClass | null {
  const c = own(catalog, server);
  if (!c || !own(c.tools, tool)) return null;
  return hintedClass(c.tools[tool]) ?? own(c.reviewed, tool) ?? null;
}

/** Whether the catalog knows this server (by its name in `mcpServers`). */
export const isCataloguedServer = (server: string, catalog: ToolCatalog = TOOL_CATALOG): boolean => own(catalog, server) !== undefined;

/** Whether a catalogued write of this server may be released without a decision (`releasable`). */
export const isReleasableWrite = (server: string, tool: string, catalog: ToolCatalog = TOOL_CATALOG): boolean =>
  catalogClassOf(server, tool, catalog) === "write" && own(own(catalog, server)?.releasable, tool) !== undefined;
