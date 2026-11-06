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
 * router turn neither connects to a server it may not call nor is shown the plugin's skills; of its rules, only ROUTER_RULES.
 *
 * Besides the plugin's: the reads of the API's own GitHub server (`github-mcp/`), as the user, for a user who keeps a GitHub
 * token, the same entry a worker's turn is given; the user's scheduled tasks (`trigger_list` of the API's own `schedules` server,
 * where the turn was given it); and Brain's web search and fetch, where the deployment's Brain has them.
 *
 * Of the plugin's reads, the ones that return a log (ROUTER_LOG_READS) are bounded and filtered by Brain (`ExecuteRequest.log_reads`):
 * a router turn asks for the last ROUTER_LOG_LINES lines or entries, and credential-shaped text in the answer is masked before the
 * model sees it. And of the plugin's rules, the ones named in ROUTER_RULES are the router's too: how a reply is written.
 */
import { GITHUB_MCP_SERVER, TRIGGER_MCP_PATH, TRIGGER_MCP_SERVER } from "@claw/protocol";
import { CLAW_ASSISTANT_PLUGIN_ID, INTERNAL_BACKEND_URL } from "../config.js";
import { githubMcpServers } from "../github-mcp/mcp.js";
import { resolveTaskPlugin } from "../marketplace/plugins.js";
import { verifyTriggerToken } from "../triggers/token.js";
import { routerReadsByServer } from "./tool-classes.js";

/**
 * Per server, the tools that only read and that a router turn is offered, by name: every read of the server's catalogued
 * `tools/list` that the catalog does not keep from the router (`mcp-tool-catalog.ts` of `@claw/protocol`, derived in `tool-classes.ts`). A tool the
 * catalog does not classify is offered nowhere, and the tests fail on it; there is no prefix, so a write a server adds under a
 * read's prefix is never offered.
 */
export const ROUTER_READ_TOOLS: Readonly<Record<string, readonly string[]>> = routerReadsByServer();

/**
 * Of the reads above, the ones whose answer is a log, each with the argument that counts its lines or entries. Brain asks for at
 * most ROUTER_LOG_LINES of them and masks credential-shaped text in what they answer before the model reads it (`log_reads`): a
 * job prints its environment, and what a router turn reads it may say to the person. A read with an empty argument counts nothing
 * but may carry a log's end, and is masked only: a pod's containers, whose termination message Kubernetes fills from the last
 * lines of the log (`terminationMessagePolicy: FallbackToLogsOnError`).
 */
export const ROUTER_LOG_READS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  safe: {
    workload_logs: "limit", workload_events: "limit", workload_pod_logs: "tail_lines", node_pod_logs: "tail_lines",
    node_reboot_logs: "limit", cluster_logs: "tail_lines", workload_pod_containers: "",
  },
};
/** The lines or entries a router turn's log read asks for: the end of a log, where a failure is. */
export const ROUTER_LOG_LINES = 40;
/** What of a plain-text log answer a router turn keeps, from its end. */
export const ROUTER_LOG_CHARS = 6000;

/** The plugin's rules a router turn is given, by name: how a reply is written, which is the router's to do. */
export const ROUTER_RULES: readonly string[] = ["teams-reply-style"];

/**
 * The heading a router turn reads such a rule under (Brain puts a rule's description before its text). The rule is written for a Teams
 * chat's own sessions, where what the model writes between tool calls is shown as progress ("Between tool calls, say in one short line
 * what you are doing next"); a router did that with `say`, each call a message of the turn (2026-11-06). So the heading keeps the rule
 * to how a say's text looks, and leaves when to say to the router's own prompt.
 */
export const ROUTER_RULE_HEADING =
  "Reply style for the text of your say (formatting only, facts unchanged). When to say, and how often, is your instructions' to "
  + "decide, not this rule's: its line about what you do between tool calls is not for you";

/** The reads of the API's own `schedules` server a router turn may call: the user's scheduled tasks. */
export const ROUTER_TRIGGER_READ_TOOLS = ["trigger_list"] as const;

/** The `tools_allowlist` entries of one server's read tools, as Brain names them. */
export function readToolPatterns(server: string): string[] {
  // Own keys only: a server named `constructor` or `__proto__` is not in the list.
  return Object.hasOwn(ROUTER_READ_TOOLS, server) ? ROUTER_READ_TOOLS[server].map((t) => `mcp__${server}__${t}`) : [];
}

/**
 * The assistant's own tools a router turn may still call after it has read a read tool's result (`ExecuteRequest.read_taint`):
 * the ones that only speak or read (the brief, the user's scheduled tasks and watched jobs included: a weekly report asked for
 * together with a lookup is read after it). Everything else of the assistant's (starting or redirecting work, reviews, settings, memory
 * writes, a stop, model defaults, and any tool added later) is refused by Brain for the rest of that turn, because the
 * person's message covers what they wrote, not what the model read afterwards. Named by what is allowed, so a new tool is refused
 * until it is listed here.
 * `deliver_text` speaks as `say` does, with a file only the user gets (`text-delivery.ts`). `github_comment` writes nothing: it shows
 * the user the exact comment on a card, and only their press posts it (`schedules.ts`); a draft is written from what was read, so it
 * must come after the reads.
 */
export const AFTER_READ_TOOLS = ["say", "work_recall", "memory_recall", "devenv_list", "claw_self_status", "deliver_text", "github_comment", "brief", "trigger_list", "job_watch_list"] as const;

/** The tool a router turn speaks with (`router-turn-end.ts`, `saidOnlyBeforeLookups`). */
export const ROUTER_SPEAK_TOOL = "say";

/**
 * The assistant's own tools that only read: what a say written before it cannot have answered from (`saidOnlyBeforeLookups`). Named,
 * not derived from AFTER_READ_TOOLS, which also holds what speaks or drafts after a read (`deliver_text`, `github_comment`).
 */
export const ROUTER_ASSISTANT_READS: readonly string[] = [
  "work_recall", "memory_recall", "devenv_list", "claw_self_status", "brief", "trigger_list", "job_watch_list",
];

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
  /** Every MCP server the turn connects to besides the plugin's: `githubServers`, and its own `schedules` server when it has one. */
  servers: McpServers;
  /** The turn's `log_reads`, or null when it has no log read. */
  logReads: { tools: Record<string, string>; lines: number; chars: number } | null;
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

/**
 * The turn's own `schedules` server, as `applyTriggerToolsToTask` (`triggers/mcp.ts`) gave it, or nothing: kept only when it is
 * at the API's own address and its bearer is one this API minted for this turn (this session, this message, this run). A request's own
 * `mcp_servers` is caller input, and any other entry by that name is not the user's scheduled tasks.
 */
export function ownTriggerServer(carried: unknown, sessionId: string, messageId: string, taskId: string, key: string): McpServers {
  if (!carried || typeof carried !== "object" || !Object.hasOwn(carried, TRIGGER_MCP_SERVER)) return {};
  const spec = (carried as McpServers)[TRIGGER_MCP_SERVER];
  if (!spec || typeof spec !== "object" || spec.url !== `${INTERNAL_BACKEND_URL}${TRIGGER_MCP_PATH}` || typeof spec.token !== "string") return {};
  const verdict = verifyTriggerToken(spec.token, key);
  if (!verdict.ok || verdict.claims.sid !== sessionId || verdict.claims.mid !== messageId || verdict.claims.task_id !== taskId) return {};
  return { [TRIGGER_MCP_SERVER]: spec };
}

/** The turn's `log_reads` for the plugin's servers it connects to, or null when none of them has a log read. */
export function routerLogReads(servers: readonly string[]): RouterLookups["logReads"] {
  const tools: Record<string, string> = {};
  for (const server of servers) {
    if (!Object.hasOwn(ROUTER_LOG_READS, server)) continue;
    for (const [tool, arg] of Object.entries(ROUTER_LOG_READS[server])) tools[`mcp__${server}__${tool}`] = arg;
  }
  return Object.keys(tools).length ? { tools, lines: ROUTER_LOG_LINES, chars: ROUTER_LOG_CHARS } : null;
}

/**
 * A router turn's lookups: the plugin's read tools, the user's GitHub, the user's scheduled tasks, and the web. `turn` is what the
 * request already carries: its MCP servers (where `applyTriggerToolsToTask` put the turn's `schedules` server), its message id,
 * and the trigger tools' key.
 */
export async function routerLookups(
  userId: string, sessionId: string, turn: { mcpServers?: unknown; messageId?: string; taskId?: string; triggerKey?: string } = {},
): Promise<RouterLookups> {
  const plugin = await routerReadTools(userId);
  const githubServers = await githubMcpServers(sessionId);
  const githubTools = Object.hasOwn(githubServers, GITHUB_MCP_SERVER) ? ROUTER_GITHUB_READ_TOOLS : [];
  const schedules = turn.messageId && turn.taskId && turn.triggerKey
    ? ownTriggerServer(turn.mcpServers, sessionId, turn.messageId, turn.taskId, turn.triggerKey) : {};
  const triggerReads = Object.hasOwn(schedules, TRIGGER_MCP_SERVER) ? ROUTER_TRIGGER_READ_TOOLS.map((t) => `mcp__${TRIGGER_MCP_SERVER}__${t}`) : [];
  const cleanFailures = [...githubTools.map((t) => `mcp__${GITHUB_MCP_SERVER}__${t}`), ...ROUTER_WEB_TOOLS];
  return {
    plugin, githubServers, servers: { ...githubServers, ...schedules }, githubTools, logReads: routerLogReads(plugin?.servers ?? []),
    allowlist: [...(plugin?.allowlist ?? []), ...triggerReads, ...cleanFailures], cleanFailures,
  };
}

export interface RouterReadTools {
  pluginId: number;
  /** The plugin's `mcp` rows, each cut to the servers that have read tools here, and its rules named in ROUTER_RULES. */
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

/** Cut a plugin's tools to its MCP servers that have read tools, and its rules named in ROUTER_RULES. Pure, for the tests. */
export function readToolsOfPlugin(pluginId: number, tools: readonly unknown[]): RouterReadTools {
  const pluginTools: unknown[] = [];
  const servers: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const row = tool as Record<string, unknown>;
    const type = String(row.type ?? "").toLowerCase();
    // A rule is text Brain adds to the prompt (its file, by `config.s3_key`), under its description as a heading: carried as the plugin
    // has it, under ROUTER_RULE_HEADING.
    if (type === "rule" && typeof row.name === "string" && ROUTER_RULES.includes(row.name)) {
      pluginTools.push({ ...row, description: ROUTER_RULE_HEADING });
      continue;
    }
    if (type !== "mcp") continue;
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
