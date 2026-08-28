// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { agentLoop } from "./agent-loop.js";
import { ToolRouter, type WebToolServices } from "../tools/router.js";
import type { HandsClient } from "../clients/hands.js";
import type { HookRunner } from "./hooks.js";
import type { Message, ToolSchema, EventCallback } from "@claw/protocol";
import pino from "pino";
import { randomUUID } from "node:crypto";

const logger = pino({ name: "sub-agent" });

/**
 * Permission profiles. Each profile is a *whitelist* of tool base names the
 * sub-agent may see. The final list is always intersected with the parent's
 * schemas and has the global DENY_LIST applied (so sub-agents cannot write
 * to global knowledge or recurse into new sub-agents).
 *
 * "generalPurpose" deliberately does NOT include `task` — recursion depth is
 * controlled centrally in agentLoop via the `depth` option.
 */
export const SUBAGENT_TYPES = ["explore", "readonly", "shell", "generalPurpose"] as const;
export type SubagentType = typeof SUBAGENT_TYPES[number];

const PROFILE_ALLOW: Record<SubagentType, string[] | "all"> = {
  explore:         ["read", "grep", "glob", "ls", "bash"],
  readonly:        ["read", "grep", "glob", "ls"],
  shell:           ["bash"],
  generalPurpose:  "all",
};

/**
 * Tools sub-agents never get, regardless of profile. They are either
 * Brain↔Hands plumbing (upload/download) or break isolation (save_memory /
 * save_skill write to global knowledge; task would allow uncontrolled
 * recursion beyond SUB_AGENT_MAX_DEPTH).
 */
const DENY_LIST = new Set([
  "save_memory",
  "save_skill",
  "task",
  "upload_to_s3",
  "download_from_s3",
]);

export interface RunSubagentOptions {
  /** Sub-agent identity, used for event tagging and log correlation. */
  subagentId?: string;
  description: string;
  prompt: string;
  subagentType?: SubagentType;
  /** Optional explicit tool whitelist (further narrows the profile). */
  allowedTools?: string[];

  // Wiring from the parent context.
  parentSchemas: ToolSchema[];
  hands: HandsClient;
  platformMcpClients?: Map<string, { callTool: (name: string, args: Record<string, unknown>) => Promise<string> }>;
  onEvent: EventCallback;
  signal?: AbortSignal;
  /** Parent agent-loop's ToolRouter. When supplied, the sub-agent's router is
   *  registered as a child so the parent's in-flight sandbox rebuild
   *  (`router.setHands(newHands)`) cascades to this sub too — otherwise an
   *  in-flight sub would keep using a dead HandsClient after the parent
   *  swapped its sandbox. */
  parentRouter?: { registerChild: (c: ToolRouter) => void; unregisterChild: (c: ToolRouter) => void };

  // LLM config (inherited from parent engine).
  model: string;
  apiUrl: string;
  apiKey: string;
  maxTurns: number;
  userId?: string;
  sessionId?: string;
  /** Depth of this sub-agent. The agent-loop decides whether `task` is exposed
   *  in the child's tools based on this value vs SUB_AGENT_MAX_DEPTH. */
  depth: number;
  /** Parent's HookRunner, forwarded so PreToolUse/PostToolUse fire in subs too. */
  hooks?: HookRunner;
  /** Web tool services from the parent, shared across sub-agents. */
  webToolServices?: WebToolServices;
}

export interface SubagentResult {
  subagent_id: string;
  subagent_type: SubagentType;
  finalText: string;
  turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create: number;
  tool_calls: number;
  error_calls: number;
  elapsed_ms: number;
}

/** Pick the effective tool schemas for this sub-agent. */
function filterSchemas(
  parentSchemas: ToolSchema[],
  profile: SubagentType,
  explicitAllow?: string[],
): ToolSchema[] {
  const profileAllow = PROFILE_ALLOW[profile];
  return parentSchemas.filter((s) => {
    const name = s.name;
    // Universal deny.
    if (DENY_LIST.has(name)) return false;
    // If an explicit list is given, restrict to it.
    if (explicitAllow && !explicitAllow.includes(name)) return false;
    // Apply the profile. MCP tools (mcp__*) are always allowed under the
    // profile's semantic — they're namespaced and generally side-effect-
    // bounded by their own servers.
    if (profileAllow === "all") return true;
    if (name.startsWith("mcp__")) return true;
    return profileAllow.includes(name);
  });
}

/**
 * Run a sub-agent: fresh messages, own budget, bubbled events tagged with
 * subagent_id so the frontend can indent / collapse them.
 *
 * Contract with the parent:
 *   - Returns only the final text as the tool result (alongside stats for the
 *     parent's own tool_stats rollup).
 *   - Shares the Hands sandbox (same /workspace) — writes are visible to the
 *     parent.
 *   - Does NOT share LLM conversation context — sub sees only `prompt`.
 */
export async function runSubagent(opts: RunSubagentOptions): Promise<SubagentResult> {
  const subagentId = opts.subagentId || `sub-${randomUUID().slice(0, 8)}`;
  const type: SubagentType = opts.subagentType && SUBAGENT_TYPES.includes(opts.subagentType)
    ? opts.subagentType
    : "generalPurpose";

  const schemas = filterSchemas(opts.parentSchemas, type, opts.allowedTools);
  // Empty toolset → give the LLM a heads-up; don't hard-fail.
  if (!schemas.length) {
    logger.warn({ subagentId, type }, "sub-agent.no_tools_left");
  }

  const startedAt = Date.now();

  // Event bubbling: tag every event with subagent metadata before forwarding.
  const bubble: EventCallback = async (evt) => {
    await opts.onEvent({
      ...evt,
      subagent_id: subagentId,
      subagent_type: type,
      subagent_depth: opts.depth,
    });
  };

  await bubble({
    type: "subagentStart",
    description: opts.description,
    prompt: opts.prompt.slice(0, 2000),
    tool_names: schemas.map((s) => s.name),
  });

  // Fresh tool router scoped to the allowed schemas. Since filterSchemas
  // already enforces DENY_LIST, route() will also refuse any leaked call.
  const router = new ToolRouter(opts.hands, opts.platformMcpClients || new Map(), opts.webToolServices);
  // Monkey-patch route() to enforce the sub-agent's whitelist even if the
  // LLM tries to call a tool outside the declared schemas.
  const allowedSet = new Set(schemas.map((s) => s.name));
  const origRoute = router.route.bind(router);
  router.route = async (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    if (DENY_LIST.has(name) || !allowedSet.has(name)) {
      throw new Error(`sub-agent (${type}) denied tool: ${name}`);
    }
    return origRoute(name, input, signal);
  };

  // Subscribe to parent rebuilds: when the parent agent-loop swaps its hands,
  // this child router gets the same swap so in-flight sub tool calls hit the
  // new sandbox. Cleanup on completion to avoid keeping references alive.
  opts.parentRouter?.registerChild(router);

  const messages: Message[] = [
    { role: "user", content: opts.prompt },
  ];

  let result;
  let failed = false;
  try {
    result = await agentLoop(messages, schemas, {
      model: opts.model,
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      maxTurns: opts.maxTurns,
      router,
      onEvent: bubble,
      signal: opts.signal,
      userId: opts.userId,
      sessionId: opts.sessionId,
      // Sub-agents forbid further nesting (enforced by agent-loop via depth).
      depth: opts.depth,
      hooks: opts.hooks,
    } as any);
  } catch (err: any) {
    failed = true;
    result = {
      finalText: `Sub-agent failed: ${err?.message || String(err)}`,
      turns: 0,
      tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
      errorCount: 1,
      toolStats: { total_calls: 0, error_calls: 1, by_tool: {} },
      elapsedMs: Date.now() - startedAt,
    };
  } finally {
    opts.parentRouter?.unregisterChild(router);
  }

  await bubble({
    type: "subagentEnd",
    failed,
    turns: result.turns,
    final_text: result.finalText.slice(0, 2000),
    tool_stats: result.toolStats,
    token_usage: result.tokenUsage,
    elapsed_ms: result.elapsedMs,
  });

  return {
    subagent_id: subagentId,
    subagent_type: type,
    finalText: result.finalText,
    turns: result.turns,
    input_tokens: result.tokenUsage.input_tokens,
    output_tokens: result.tokenUsage.output_tokens,
    cache_read: result.tokenUsage.cache_read,
    cache_create: result.tokenUsage.cache_create,
    tool_calls: result.toolStats.total_calls,
    error_calls: result.toolStats.error_calls,
    elapsed_ms: result.elapsedMs,
  };
}
