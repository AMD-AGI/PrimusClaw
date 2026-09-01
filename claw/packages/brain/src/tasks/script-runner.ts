// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `mode=script` execution path (task-design.md §7.3).
 *
 * Runs a predefined sequence of tool calls against a mix of Hands-side and
 * Backend-side MCP tools. No LLM is invoked; AgentHook PreToolUse /
 * PostToolUse / Stop / SessionEnd still fire so the same observability
 * envelope works across mode=llm and mode=script tasks.
 *
 * Runtime template variables (`${captures.X}` / `${prev.captures.X}` /
 * `${prev.structured.Y}`) are expanded inside this runner; every other
 * `${...}` placeholder was already collapsed to a literal by Backend
 * dispatcher before the script reached Brain.
 */
import pino from "pino";
import type {
  ExecuteRequest,
  ExecuteResult,
  EventCallback,
  Artifact,
  TokenUsage,
  ToolStats,
} from "@claw/protocol";
import type { HandsClient } from "../clients/hands.js";
import { callBackendMcpTool } from "../clients/backend-mcp.js";
import { getPluginToolScope } from "../tools/scope.js";

const logger = pino({ name: "script-runner" });
const WAIT_EXTERNAL_SENTINEL = "AKA_WAIT_EXTERNAL";

export interface ScriptRunCtx {
  hands?: HandsClient | null;
  /** AgentHook fire(...) function from `agent/hooks.ts`; optional for the harness. */
  fireHook?: (event: string, payload: Record<string, unknown>) => Promise<{ block?: boolean; reason?: string }>;
  signal?: AbortSignal;
}

function zeroTokens(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 };
}

function nowMs(): number {
  return Date.now();
}

/**
 * Render every `${...}` placeholder inside a JSON-ish value using the
 * runner's `captures` / `prev` state. Throws when a placeholder cannot be
 * resolved -- that's a Backend-rendering bug we want to surface loudly.
 */
function renderRuntimeTemplates(
  value: unknown,
  state: { captures: Record<string, string>; prev?: { captures: Record<string, string>; structured?: unknown } },
): unknown {
  if (typeof value === "string") return renderString(value, state);
  if (Array.isArray(value)) return value.map((v) => renderRuntimeTemplates(v, state));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderRuntimeTemplates(v, state);
    return out;
  }
  return value;
}

function renderString(
  s: string,
  state: { captures: Record<string, string>; prev?: { captures: Record<string, string>; structured?: unknown } },
): string {
  return s.replace(/\$\{([^}]+)\}/g, (whole, raw: string) => {
    const path = raw.trim();
    // A name with no dot is a shell variable, not a template path -- and it never
    // could have been one: resolvePath returns undefined for anything shorter than
    // `root.rest`. Throwing on it took the whole task down for writing `${HOME}`
    // or `${PATH}` in an inline command, which is the ordinary way to write shell.
    //
    // Left literal, which is what the backend renderer already does with the same
    // input (template-renderer.ts). The two run over the same strings in sequence,
    // so disagreeing about what counts as a template meant a step could survive one
    // stage and be destroyed by the next.
    if (!path.includes(".")) return whole;
    const val = resolvePath(path, state);
    if (val === undefined) {
      throw new Error(`script runtime template '${path}' did not resolve; Backend dispatcher should have rendered it`);
    }
    return typeof val === "string" ? val : JSON.stringify(val);
  });
}

/**
 * Largest a single capture may be.
 *
 * Captures travel to Backend inside the `agent_done` body, and that body has a
 * size limit. Unbounded, one step that captured a large `result.json` did not
 * lose the capture -- it failed the entire completion callback, so a run that had
 * finished its work was recorded as never having reported at all, and everything
 * else it captured went with it.
 *
 * Truncated here rather than at the boundary because this is where the step that
 * produced it can be named.
 */
const MAX_CAPTURE_BYTES = 256 * 1024;

/** Total across all captures, so many medium ones cannot do what one large one cannot. */
const MAX_CAPTURES_TOTAL_BYTES = 1024 * 1024;

/**
 * A capture cut to size, with the cut stated in the value.
 *
 * The marker matters: a consumer parsing a capture as JSON has to be able to tell
 * a truncated document from a malformed one, and silently handing over the first
 * 256 KiB of a JSON file is how a caller concludes the producer is broken.
 */
export function truncateCapture(name: string, value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_CAPTURE_BYTES) return value;
  const head = Buffer.from(value, "utf8").subarray(0, MAX_CAPTURE_BYTES).toString("utf8");
  return `${head}\n[capture '${name}' truncated at ${MAX_CAPTURE_BYTES} bytes]`;
}

/**
 * Captures cut to a total, dropping whole entries from the largest down.
 *
 * Whole entries rather than a second per-entry trim: a caller reading
 * `captures.result` wants a document or an absence, and half of one is the answer
 * that looks valid and is not.
 */
export function capCapturesTotal(captures: Record<string, string>): Record<string, string> {
  const sizes = Object.entries(captures)
    .map(([k, v]) => [k, Buffer.byteLength(v, "utf8")] as const)
    .sort((a, b) => b[1] - a[1]);
  let total = sizes.reduce((n, [, size]) => n + size, 0);
  const out = { ...captures };
  for (const [name, size] of sizes) {
    if (total <= MAX_CAPTURES_TOTAL_BYTES) break;
    out[name] = `[capture '${name}' dropped: ${size} bytes, over the ${MAX_CAPTURES_TOTAL_BYTES}-byte total]`;
    total -= size - Buffer.byteLength(out[name], "utf8");
  }
  return out;
}

function resolvePath(
  path: string,
  state: { captures: Record<string, string>; prev?: { captures: Record<string, string>; structured?: unknown } },
): unknown {
  const parts = path.split(".");
  if (parts.length < 2) return undefined;
  const root = parts[0];
  const rest = parts.slice(1);

  if (root === "captures") return resolveCapture(state.captures, rest);
  if (root === "prev") {
    if (!state.prev) return undefined;
    if (rest[0] === "captures") return resolveCapture(state.prev.captures, rest.slice(1));
    if (rest[0] === "structured") return getDeep(state.prev.structured, rest.slice(1));
  }
  return undefined;
}

/**
 * Look the leading capture key up directly; when present and the consumer
 * asks for `<key>.<...>` we parse the captured JSON and dig into it. This
 * lets DAG authors write `${captures.prompt.s3_asset_url}` without having
 * to capture every leaf field as its own key.
 */
function resolveCapture(captures: Record<string, string>, parts: string[]): unknown {
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return captures[parts[0]];
  for (let i = parts.length - 1; i >= 1; i--) {
    const head = parts.slice(0, i).join(".");
    const raw = captures[head];
    if (typeof raw !== "string") continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const deep = getDeep(parsed, parts.slice(i));
    if (deep !== undefined) return deep;
  }
  return undefined;
}

function getDeep(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Execute `script` to completion / wait_external / failure.
 *
 * Captures are written to `state.captures[<step.captures>]` after each step.
 * Per task-design.md §7.3, `wait_external` returns a `ExecuteResult` whose
 * `abortReason="wait_external"`; the caller (Brain handleTask) is expected
 * to forward this to Backend via `agent_done`.
 */
export async function runScript(
  request: ExecuteRequest,
  ctx: ScriptRunCtx,
  onEvent: EventCallback,
): Promise<ExecuteResult> {
  const startedAt = nowMs();
  const script = request.script ?? [];
  const captures: Record<string, string> = {};
  const toolStats: ToolStats = { total_calls: 0, error_calls: 0, by_tool: {} };
  const artifacts: Artifact[] = [];
  let lastResultText = "";
  let lastStructured: unknown = undefined;

  await ctx.fireHook?.("SessionStart", { mode: "script", task_id: request.task_id ?? "" });

  for (let i = 0; i < script.length; i++) {
    if (ctx.signal?.aborted) {
      return {
        finalText: "",
        tokenUsage: zeroTokens(),
        turns: 0,
        pendingMemories: [],
        pendingSkills: [],
        skillsUsed: {},
        errorCount: toolStats.error_calls,
        toolStats,
        elapsedMs: nowMs() - startedAt,
        captures,
        artifacts,
        abortReason: "cancelled",
        failureReason: "script aborted by signal",
      };
    }
    const step = script[i];
    let args: Record<string, unknown>;
    try {
      args = (renderRuntimeTemplates(step.arguments ?? {}, {
        captures,
        prev: { captures, structured: lastStructured },
      }) ?? {}) as Record<string, unknown>;
    } catch (renderErr) {
      const msg = renderErr instanceof Error ? renderErr.message : String(renderErr);
      logger.error({ step: i, name: step.name, err: msg }, "script.template_render_failed");
      return failResult(`script_template_render_failed: ${msg}`, "error", captures, artifacts, toolStats, startedAt);
    }

    const hook = await ctx.fireHook?.("PreToolUse", { tool_name: step.name, tool_input: args });
    if (hook?.block) {
      const reason = hook.reason ?? "hook blocked";
      logger.warn({ step: i, name: step.name, reason }, "script.pre_hook_blocked");
      return failResult(reason, "script_pre_hook_blocked", captures, artifacts, toolStats, startedAt);
    }

    // Prefer the scope Backend stamped at dispatch time (task-design §8.2);
    // fall back to plugin_tools lookup for legacy chat paths.
    const scope = step.scope ?? getPluginToolScope(step.name, request.plugin_tools);
    const stepDeadlineSec = step.timeout_sec ?? 300;
    let resultText = "";
    let structured: unknown = undefined;
    let waitExternal = false;
    let stepError: string | undefined;
    let waitExternalId: string | undefined;

    await onEvent({ type: "scriptStep", name: step.name, step: i, status: "started", scope });

    try {
      if (scope === "backend") {
        if (!request.backend_mcp_url) throw new Error("backend_mcp_url not provided for scope=backend tool");
        if (!request.backend_internal_token) throw new Error("backend_internal_token not provided for scope=backend tool");
        const out = await callBackendMcpTool(
          request.backend_mcp_url,
          request.backend_internal_token,
          step.name,
          args,
          { timeoutMs: stepDeadlineSec * 1000, signal: ctx.signal },
        );
        if (out.wait_external) {
          waitExternal = true;
          stepError = out.error;
          const md = out.metadata as Record<string, unknown> | undefined;
          if (md && typeof md.external_id === "string") waitExternalId = md.external_id;
        } else if (out.isError) {
          stepError = out.error || out.text || "backend tool returned isError";
        }
        resultText = out.text;
        structured = out.structured;
      } else {
        if (!ctx.hands) throw new Error("Hands client not provided for scope=hands tool");
        const handsArgs = step.timeout_sec === undefined || Object.prototype.hasOwnProperty.call(args, "timeout")
          ? args
          : { ...args, timeout: stepDeadlineSec };
        const out = await ctx.hands.callToolFull(step.name, handsArgs, ctx.signal);
        resultText = out.text;
        structured = out.structured;
        if (out.isError) stepError = out.text || "hands tool returned isError";
        if (
          stepError &&
          step.on_fail === "wait_external" &&
          resultText.includes(WAIT_EXTERNAL_SENTINEL)
        ) {
          waitExternal = true;
          stepError = undefined;
          waitExternalId = `timer:${request.task_id}:${i}`;
        }
      }
    } catch (callErr) {
      stepError = callErr instanceof Error ? callErr.message : String(callErr);
    }

    toolStats.total_calls++;
    toolStats.by_tool[step.name] = (toolStats.by_tool[step.name] ?? 0) + 1;
    if (stepError && !waitExternal) toolStats.error_calls++;

    await ctx.fireHook?.("PostToolUse", { tool_name: step.name, tool_response: stepError ? { error: stepError } : { text: resultText, structured } });

    if (waitExternal) {
      if (step.on_fail !== "wait_external") {
        const reason = `step ${i} (${step.name}) returned wait_external but on_fail is '${step.on_fail ?? "abort"}'`;
        return failResult(reason, "error", captures, artifacts, toolStats, startedAt);
      }
      await onEvent({ type: "scriptStep", name: step.name, step: i, status: "wait_external", error: stepError ?? "" });
      return {
        finalText: "",
        tokenUsage: zeroTokens(),
        turns: 0,
        pendingMemories: [],
        pendingSkills: [],
        skillsUsed: {},
        errorCount: toolStats.error_calls,
        toolStats,
        elapsedMs: nowMs() - startedAt,
        captures,
        artifacts,
        abortReason: "wait_external",
        failureReason: stepError,
        // Prefer the resolver-friendly id the tool surfaced via metadata;
        // fall back to the step name for tools that don't supply one.
        waitExternalId: waitExternalId ?? step.name,
      };
    }

    if (stepError) {
      if (step.on_fail === "continue") {
        await onEvent({ type: "scriptStep", name: step.name, step: i, status: "continued", error: stepError });
      } else {
        return failResult(`step ${i} (${step.name}): ${stepError}`, "script_step_failed", captures, artifacts, toolStats, startedAt);
      }
    } else {
      await onEvent({ type: "scriptStep", name: step.name, step: i, status: "completed" });
    }

    if (step.captures) {
      // Prefer `structured` (already typed) when present, else the textual
      // result. JSON.stringify keeps captures a uniform string map so
      // template expansion downstream is predictable.
      const value = structured !== undefined && structured !== null
        ? JSON.stringify(structured)
        : resultText;
      captures[step.captures] = truncateCapture(step.captures, value ?? "");
    }
    lastResultText = resultText ?? lastResultText;
    lastStructured = structured;
  }

  await ctx.fireHook?.("Stop", { mode: "script" });
  await ctx.fireHook?.("SessionEnd", { mode: "script" });

  return {
    finalText: lastResultText,
    tokenUsage: zeroTokens(),
    turns: 0,
    pendingMemories: [],
    pendingSkills: [],
    skillsUsed: {},
    errorCount: toolStats.error_calls,
    toolStats,
    elapsedMs: nowMs() - startedAt,
    captures: capCapturesTotal(captures),
    artifacts,
    abortReason: "completed",
  };
}

function failResult(
  reason: string,
  abortReason: ExecuteResult["abortReason"],
  captures: Record<string, string>,
  artifacts: Artifact[],
  toolStats: ToolStats,
  startedAt: number,
): ExecuteResult {
  return {
    finalText: "",
    tokenUsage: zeroTokens(),
    turns: 0,
    pendingMemories: [],
    pendingSkills: [],
    skillsUsed: {},
    errorCount: toolStats.error_calls,
    toolStats,
    elapsedMs: nowMs() - startedAt,
    captures: capCapturesTotal(captures),
    artifacts,
    abortReason,
    failureReason: reason,
  };
}
