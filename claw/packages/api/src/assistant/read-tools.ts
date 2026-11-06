// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The read-only tools a router turn may call itself, so that a question one or two lookups answer ("how many nodes does
 * autopilot have now?") is answered in the conversation instead of becoming a work item.
 *
 * Read-only is an explicit list per MCP server, by tool name, never a guess from a description: a server that is not
 * listed here gives the router nothing, and a tool of a listed server that no entry names is neither offered nor run
 * (Brain enforces `tools_allowlist` on both). The servers come only from the deployment's assistant plugin
 * (`CLAW_ASSISTANT_PLUGIN_ID`), never from a plugin a message names: a name says nothing about where a server is, so the list
 * holds only for servers the operator chose. Of that plugin only its `mcp` rows, and of them only the servers listed here, so a
 * router turn neither connects to a server it may not call nor is shown the plugin's skills and rules.
 *
 * Besides the plugin's: the reads of the API's own GitHub server (`github-mcp/`), as the user, for a user who keeps a GitHub
 * token, the same entry a worker's turn is given; and Brain's web search and fetch, where the deployment's Brain has them.
 */
import { GITHUB_MCP_SERVER } from "@claw/protocol";
import { CLAW_ASSISTANT_PLUGIN_ID } from "../config.js";
import { githubMcpServers } from "../github-mcp/mcp.js";
import { resolveTaskPlugin } from "../marketplace/plugins.js";

/**
 * Per server, the tools that only read. Each entry is a tool name, or a prefix ending in `*` (Brain's allow-list
 * matches nothing else). Only names whose every tool reads: a prefix that also covers a write is not used.
 */
export const ROUTER_READ_TOOLS: Readonly<Record<string, readonly string[]>> = {
  // Autopilot's MCP names its reads get_* / list_*; everything else (apply_*, preview_*, ...) is left out.
  autopilot: ["get_*", "list_*"],
  // SaFE's MCP mixes reads and writes under one resource prefix, so its reads are named one by one. The apikey_* tools are left
  // out even where they read: a router has no use for the user's keys.
  safe: [
    "cluster_list", "cluster_get", "node_list", "node_get", "node_status", "workload_list", "workload_get",
    "workspace_list", "workspace_get", "opsjob_list", "opsjob_get", "flavor_list", "flavor_get", "user_self",
  ],
  // Dispatron's MCP is its HTTP API, one tool per route, named by method: get_* is every GET.
  dispatron: ["get_*"],
  // Pulse: what its own plugin config lets through without approval, all of them reads.
  pulse: ["leaderboard_*", "upstream_*", "cost_overview"],
  // The agent board (Gitea): the read and list tools; *_write, create_* and fork_* change things.
  "agent-board": ["get_*", "list_*", "issue_read", "label_read"],
};

/** The `tools_allowlist` entries of one server's read tools, as Brain names them. */
export function readToolPatterns(server: string): string[] {
  // Own keys only: a server named `constructor` or `__proto__` is not in the list.
  return Object.hasOwn(ROUTER_READ_TOOLS, server) ? ROUTER_READ_TOOLS[server].map((t) => `mcp__${server}__${t}`) : [];
}

/**
 * The assistant's own tools a router turn may still call after it has read a read tool's result (`ExecuteRequest.read_taint`):
 * the ones that only speak or read. Everything else of the assistant's (starting or redirecting work, reviews, settings, memory
 * writes, a stop, model defaults, and any tool added later) is refused by Brain for the rest of that turn, because the
 * person's message covers what they wrote, not what the model read afterwards. Named by what is allowed, so a new tool is refused
 * until it is listed here.
 */
export const AFTER_READ_TOOLS = ["say", "work_recall", "memory_recall"] as const;

/**
 * The GitHub reads a router turn may call (`github-mcp/tools.ts`): finding and reading pull requests, issues, their checks and
 * reviews, repositories and files. Every one is in that server's READ_TOOLS, which it runs without asking; no write is, and neither
 * a whole diff nor a job's log, which are a worker's to read.
 */
export const ROUTER_GITHUB_READ_TOOLS = [
  "issue_search", "pr_list", "pr_get", "pr_files", "pr_reviews", "review_threads_list", "checks_list",
  "issue_list", "issue_get", "repo_list", "repo_get_file", "code_search",
] as const;

/**
 * Brain's own web tools: a search and a fetch of one public page (Brain refuses private and internal addresses). Brain offers them
 * only where its deployment switched them on (`WEB_SEARCH_PROVIDER`, `WEB_FETCH_ENABLED`); listed here, they are the router's too.
 */
export const ROUTER_WEB_TOOLS = ["web_search", "web_fetch"] as const;

type McpServers = Record<string, Record<string, unknown>>;

/** Everything a router turn may look up, and what that takes on its request. */
export interface RouterLookups {
  /** The assistant plugin's read tools, or null. */
  plugin: RouterReadTools | null;
  /** The turn's `github` server, as a worker's turn gets it; empty for a user who keeps no GitHub token. */
  githubServers: McpServers;
  /** The reads of that server the turn may call: `ROUTER_GITHUB_READ_TOOLS`, or none without the server. */
  githubTools: readonly string[];
  /** Every lookup tool as `tools_allowlist` entries: the turn's `read_taint` sources as well. */
  allowlist: string[];
  /**
   * The lookups whose failures are in Claw's own words (`read_taint.clean_failures`): the reads of the API's GitHub server, which
   * says a read's failure as the status GitHub answered with and never as GitHub's message (`github-mcp/tools.ts`), and Brain's
   * web tools, which say theirs in fixed words and never with what a server or a search backend sent. Not the plugin's servers:
   * what they put in an error is theirs to choose.
   */
  cleanFailures: string[];
}

/** A router turn's lookups: the plugin's read tools, the user's GitHub, and the web. */
export async function routerLookups(userId: string, sessionId: string): Promise<RouterLookups> {
  const plugin = await routerReadTools(userId);
  const githubServers = await githubMcpServers(sessionId);
  const githubTools = Object.hasOwn(githubServers, GITHUB_MCP_SERVER) ? ROUTER_GITHUB_READ_TOOLS : [];
  const cleanFailures = [...githubTools.map((t) => `mcp__${GITHUB_MCP_SERVER}__${t}`), ...ROUTER_WEB_TOOLS];
  return { plugin, githubServers, githubTools, allowlist: [...(plugin?.allowlist ?? []), ...cleanFailures], cleanFailures };
}

export interface RouterReadTools {
  pluginId: number;
  /** The plugin's `mcp` rows, each cut to the servers that have read tools here. */
  pluginTools: unknown[];
  /** The servers the turn connects to, in the order the plugin lists them. */
  servers: string[];
  /** Their read tools, as `tools_allowlist` entries. */
  allowlist: string[];
}

function positiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** The plugin an assistant turn runs with: the one its message named, else the deployment's. Null for none. */
export function assistantPluginId(named: unknown): number | null {
  return positiveInt(named) ?? positiveInt(CLAW_ASSISTANT_PLUGIN_ID);
}

/** Cut a plugin's tools to its MCP servers that have read tools. Pure, for the tests. */
export function readToolsOfPlugin(pluginId: number, tools: readonly unknown[]): RouterReadTools {
  const pluginTools: unknown[] = [];
  const servers: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const row = tool as Record<string, unknown>;
    if (String(row.type ?? "").toLowerCase() !== "mcp") continue;
    const config = row.config && typeof row.config === "object" ? row.config as Record<string, unknown> : {};
    const all = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers as Record<string, unknown> : {};
    const kept = Object.fromEntries(Object.entries(all).filter(([name]) => readToolPatterns(name).length > 0 && !servers.includes(name)));
    if (!Object.keys(kept).length) continue;
    servers.push(...Object.keys(kept));
    // Only the server map: a row's other config (bash approval rules) is about tools this turn does not have.
    pluginTools.push({ ...row, config: { mcpServers: kept } });
  }
  return { pluginId, pluginTools, servers, allowlist: servers.flatMap(readToolPatterns) };
}

/**
 * The read tools of a router turn, or null when it has none: no assistant plugin configured, one the user may not see, or one
 * with no server listed here. Read from the plugin as the user sees it now (`resolveTaskPlugin`), whatever the request carried.
 */
export async function routerReadTools(userId: string): Promise<RouterReadTools | null> {
  const pluginId = positiveInt(CLAW_ASSISTANT_PLUGIN_ID);
  if (pluginId === null) return null;
  const plugin = await resolveTaskPlugin(pluginId, userId, false);
  if (!plugin.tools) return null;
  const read = readToolsOfPlugin(pluginId, plugin.tools);
  return read.servers.length ? read : null;
}
