// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Hook runtime for Brain's agent-loop. Events fire at well-defined points in
 * `agent/agent-loop.ts` / `agent/engine.ts`; hook commands execute inside the
 * sandbox via HandsClient (so script `pwd`, workspace access, tool visibility
 * all match what the LLM sees). No Claude CLI / settings.json dependency.
 *
 * Protocol is deliberately aligned with Claude Code hook JSON so existing
 * hooks.json files in plugins can be reused unchanged:
 *   - stdin receives a JSON context object
 *   - stdout's last JSON line may carry `{decision, reason, systemMessage}`
 */
import pino from "pino";
import { HandsClient } from "../clients/hands.js";
import type { EventCallback } from "@claw/protocol";

const logger = pino({ name: "hooks" });

export type HookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd";

export const ALL_HOOK_EVENTS: HookEvent[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
];

/** Case-insensitive aliases accepted in plugin hooks.json. */
const HOOK_EVENT_ALIASES: Record<string, HookEvent> = {
  sessionstart: "SessionStart",
  session_start: "SessionStart",
  userpromptsubmit: "UserPromptSubmit",
  user_prompt_submit: "UserPromptSubmit",
  pretooluse: "PreToolUse",
  pre_tool_use: "PreToolUse",
  posttooluse: "PostToolUse",
  post_tool_use: "PostToolUse",
  stop: "Stop",
  sessionend: "SessionEnd",
  session_end: "SessionEnd",
};

export function normalizeHookEvent(raw: string): HookEvent | null {
  return HOOK_EVENT_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export interface HookCmd {
  command: string;
  /** Regex matched against tool_name for PreToolUse/PostToolUse. Ignored otherwise. */
  matcher?: RegExp;
  /** Seconds; default 30. */
  timeout?: number;
  /** Fire-and-forget; decision output is ignored. */
  async?: boolean;
  /** Treat exec failure as a blocking decision. Default false. */
  blockingOnError?: boolean;
}

export type HookRegistry = Partial<Record<HookEvent, HookCmd[]>>;

export interface HookContext {
  session_id: string;
  hook_event_name: HookEvent;
  cwd: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: string;
  prompt?: string;
  stop_reason?: string;
}

export interface HookDecision {
  /** When true, the caller must short-circuit (skip the tool / abort the turn). */
  block: boolean;
  /** Human-readable explanation surfaced to the LLM via tool_result. */
  reason?: string;
  /** Optional free-form message emitted to the UI via `hookMessage` event. */
  systemMessage?: string;
  /** P2: optional input mutation from PreToolUse hooks. When set, the engine
   *  loop passes this to HitlController and router instead of the original input. */
  updatedInput?: Record<string, unknown>;
}

/** Merge multiple registries, concatenating command lists per event. */
export function mergeHookRegistries(...regs: HookRegistry[]): HookRegistry {
  const out: HookRegistry = {};
  for (const reg of regs) {
    for (const ev of ALL_HOOK_EVENTS) {
      const src = reg[ev];
      if (!src?.length) continue;
      out[ev] = [...(out[ev] ?? []), ...src];
    }
  }
  return out;
}

/** True when the registry has at least one command for any event. */
export function registryHasAny(reg: HookRegistry): boolean {
  return ALL_HOOK_EVENTS.some((ev) => (reg[ev]?.length ?? 0) > 0);
}

/**
 * Executes hooks in the sandbox and parses their decision output.
 * One instance per agent-loop; safe to share across sub-agents since the
 * registry is read-only and HandsClient is already per-session.
 */
export class HookRunner {
  // `hands` is mutable so an in-flight sandbox rebuild can swap it; other
  // fields stay read-only.
  private hands: HandsClient;

  constructor(
    private readonly registry: HookRegistry,
    hands: HandsClient,
    private readonly onEvent: EventCallback,
    private readonly sessionId: string,
    private readonly workspaceCwd: string = "/workspace",
  ) {
    this.hands = hands;
  }

  /** Replace the HandsClient after an in-flight sandbox rebuild. */
  setHands(next: HandsClient): void {
    this.hands = next;
  }

  has(event: HookEvent): boolean {
    return (this.registry[event]?.length ?? 0) > 0;
  }

  /**
   * Runs every command registered for `event` in order. Returns the first
   * blocking decision; if none block, returns `{block:false}`. Caller may
   * ignore the return value for events where block has no meaning (e.g.
   * SessionEnd).
   */
  async run(
    event: HookEvent,
    ctx: Omit<HookContext, "session_id" | "hook_event_name" | "cwd">,
  ): Promise<HookDecision> {
    const hooks = this.registry[event];
    if (!hooks || hooks.length === 0) return { block: false };
    const payload: HookContext = {
      session_id: this.sessionId,
      hook_event_name: event,
      cwd: this.workspaceCwd,
      ...ctx,
    };
    for (const hook of hooks) {
      if (
        hook.matcher &&
        (event === "PreToolUse" || event === "PostToolUse") &&
        ctx.tool_name &&
        !hook.matcher.test(ctx.tool_name)
      ) {
        continue;
      }
      const decision = await this.execOne(hook, payload);
      if (decision.systemMessage) {
        await this.onEvent({
          type: "hookMessage",
          event,
          message: decision.systemMessage,
        });
      }
      if (decision.block) return decision;
    }
    return { block: false };
  }

  private async execOne(hook: HookCmd, payload: HookContext): Promise<HookDecision> {
    const json = JSON.stringify(payload);
    const jsonB64 = Buffer.from(json, "utf-8").toString("base64");
    const timeoutSec = Math.max(1, hook.timeout ?? 30);
    // Feed context JSON on stdin so plugin scripts follow the Claude Code
    // convention. base64 avoids shell-escaping issues for arbitrary payloads.
    const wrapper = `printf '%s' '${jsonB64}' | base64 -d | ${hook.command}`;
    const toolLabel = `hook:${payload.hook_event_name}`;

    await this.onEvent({
      type: "toolUsed",
      tool: toolLabel,
      status: "start",
      brief: hook.command.slice(0, 120),
    });

    if (hook.async) {
      // Fire-and-forget; do NOT await the sandbox call. Errors are logged but
      // never surfaced to the LLM because async hooks have no decision channel.
      void this.hands
        .callTool("bash", { command: `${wrapper} &`, timeout: timeoutSec })
        .catch((err) => logger.warn({ err, event: payload.hook_event_name }, "hook.async_failed"));
      await this.onEvent({ type: "toolUsed", tool: toolLabel, status: "success", brief: "(async)" });
      return { block: false };
    }

    try {
      const out = await this.hands.callTool("bash", { command: wrapper, timeout: timeoutSec });
      const decision = parseHookDecision(out);
      await this.onEvent({
        type: "toolUsed",
        tool: toolLabel,
        status: decision.block ? "error" : "success",
        description: (decision.reason ?? out).slice(0, 2000),
      });
      return decision;
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? String(err);
      logger.warn({ err, event: payload.hook_event_name, command: hook.command }, "hook.exec_failed");
      await this.onEvent({
        type: "toolUsed",
        tool: toolLabel,
        status: "error",
        description: msg.slice(0, 500),
      });
      if (hook.blockingOnError) {
        return { block: true, reason: `Hook '${payload.hook_event_name}' failed: ${msg}` };
      }
      return { block: false };
    }
  }
}

/**
 * Parse the last JSON-object line of stdout into a decision. Scripts that
 * print nothing / plain text / non-JSON → non-blocking. This lets simple
 * hooks (e.g. `echo "ok"`) work without adopting the full JSON protocol.
 */
export function parseHookDecision(stdout: string): HookDecision {
  const trimmed = stdout.trim();
  if (!trimmed) return { block: false };
  const lines = trimmed.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      const decision = String(obj.decision ?? "").toLowerCase();
      return {
        block: decision === "block",
        reason: typeof obj.reason === "string" ? obj.reason : undefined,
        systemMessage: typeof obj.systemMessage === "string" ? obj.systemMessage : undefined,
        updatedInput: (obj.updatedInput && typeof obj.updatedInput === "object" && !Array.isArray(obj.updatedInput))
          ? obj.updatedInput as Record<string, unknown>
          : undefined,
      };
    } catch {
      continue;
    }
  }
  return { block: false };
}

/** Wire format of a plugin hooks.json entry after download. */
interface RawHookEntry {
  command?: unknown;
  matcher?: unknown;
  timeout?: unknown;
  async?: unknown;
  blockingOnError?: unknown;
}

/**
 * Build a HookRegistry from a parsed hooks.json `hooks` field.
 * Unknown event names are skipped with a warning; malformed entries are dropped.
 * `pathRewriter`, when provided, is applied to each `command` string (used to
 * rewrite relative plugin paths to absolute sandbox paths).
 */
export function buildRegistryFromHooksField(
  hooksField: unknown,
  pathRewriter?: (command: string) => string,
): HookRegistry {
  const out: HookRegistry = {};
  if (!hooksField || typeof hooksField !== "object") return out;
  for (const [rawEvent, rawList] of Object.entries(hooksField as Record<string, unknown>)) {
    const event = normalizeHookEvent(rawEvent);
    if (!event) {
      logger.warn({ rawEvent }, "hooks.unknown_event");
      continue;
    }
    if (!Array.isArray(rawList)) {
      logger.warn({ rawEvent }, "hooks.event_payload_not_array");
      continue;
    }
    const cmds: HookCmd[] = [];
    for (const item of rawList) {
      if (!item || typeof item !== "object") continue;
      const raw = item as RawHookEntry;
      let command = typeof raw.command === "string" ? raw.command.trim() : "";
      if (!command) continue;
      if (pathRewriter) command = pathRewriter(command);
      const cmd: HookCmd = { command };
      if (typeof raw.matcher === "string" && raw.matcher.length > 0) {
        try {
          cmd.matcher = new RegExp(raw.matcher);
        } catch (err) {
          logger.warn({ err, matcher: raw.matcher }, "hooks.bad_matcher_ignored");
        }
      }
      if (typeof raw.timeout === "number" && raw.timeout > 0) cmd.timeout = raw.timeout;
      if (typeof raw.async === "boolean") cmd.async = raw.async;
      if (typeof raw.blockingOnError === "boolean") cmd.blockingOnError = raw.blockingOnError;
      cmds.push(cmd);
    }
    if (cmds.length) out[event] = [...(out[event] ?? []), ...cmds];
  }
  return out;
}
