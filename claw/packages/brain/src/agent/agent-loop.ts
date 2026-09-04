// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ToolRouter } from "../tools/router.js";
import { runSubagent, SUBAGENT_TYPES, type SubagentType } from "./sub-agent.js";
import {
  SUB_AGENT_MAX_TURNS, SUB_AGENT_MAX_CONCURRENT, SUB_AGENT_MAX_DEPTH,
  BRAIN_BLOCK_SKILL_SUBAGENTS,
  SANDBOX_REBUILD_THRESHOLD, SANDBOX_REBUILD_MAX_PER_TASK,
  SANDBOX_RECOVERY_MAX_PER_TASK,
  ASK_USER_QUESTION_TIMEOUT_MS, ASK_USER_QUESTION_ENABLED,
  TODO_WRITE_ENABLED, EXIT_PLAN_MODE_ENABLED,
  COMPACTION_TRIGGER_INPUT_TOKENS,
  CHECKPOINT_TURN_INTERVAL, CHECKPOINT_MAX_WALL_GAP_MS,
  LLM_CACHE_TTL,
} from "../config.js";
import {
  HandsRebuildFailed,
  HandsRecoveryBudgetExhausted,
  HandsRecoveryRefused,
  type CheckpointState,
  type HandsRecoveryAction,
  type HandsRecoveryAllowance,
  type RecreateHandsResult,
} from "./index.js";
import type { Message, ToolSchema, TokenUsage, EventCallback } from "@claw/protocol";
import { safePreview } from "@claw/utils";
import { HandsClient, isHandsNetworkError, isHandsToolTimeout, explainHandsError, handsNetworkErrorReason } from "../clients/hands.js";
import { isSandboxTool } from "../tools/hands.js";
import type { HookRunner } from "./hooks.js";
import type { HitlController } from "./hitl.js";
import { metrics } from "../infra/metrics.js";
import { whileWaiting } from "../tasks/run-phase.js";
import pino from "pino";
import { randomUUID } from "node:crypto";
import { getProvider } from "../llm/index.js";
import type { LlmSession } from "../llm/provider.js";

const logger = pino({ name: "agent-loop" });

/**
 * Tools whose whole job is to block until something else finishes. Time spent
 * in one is time the run holds a slot without using it.
 */
const WAITING_TOOLS = new Set(["wait"]);

/**
 * Detect upstream-connect failures that LiteLLM mis-classifies as 401
 * `auth_error` (e.g. wrapping `httpx.ConnectError` when it can't reach the
 * real LLM provider) so they retry like 5xx instead of failing the task
 * fast. Scope is narrow enough that a genuine bad-key 401 still fails fast.
 */
function isUpstreamConnectError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; name?: string; message?: string };
  if (typeof e.status === "number" && [502, 503, 504].includes(e.status)) return true;
  const msg = String(e.message || "");
  // LiteLLM wraps several *transient upstream backend* failures as a generic
  // 401 auth_error (httpx ConnectError "All connection attempts failed", a
  // provider whose query engine is not yet connected, connection reset, etc.).
  // A genuine bad-key 401 instead carries an x-api-key / invalid-key marker,
  // so retry the transient class while still fast-failing real credential
  // errors. Observed: provider returned "not connected to the query engine,
  // you must call connect() before attempting to query data" as 401 mid-run.
  if (
    e.status === 401 &&
    /All connection attempts failed|not connected to the query engine|connect\(\)\s*before|connection (error|reset|refused)|temporarily unavailable/i.test(msg) &&
    !/invalid x-api-key|invalid api key|x-api-key header|no auth credentials|missing.*api.?key/i.test(msg)
  ) {
    return true;
  }
  if (e.name === "APIConnectionError" || e.name === "APIConnectionTimeoutError") return true;
  if (/All connection attempts failed/i.test(msg)) return true;
  return false;
}

/**
 * Detect mid-stream socket drops (gateway/proxy/provider TLS FIN/RST after
 * the SSE stream started, surfaced by Node's undici as `TypeError:
 * terminated` / `UND_ERR_SOCKET`) that neither isUpstreamConnectError nor
 * isTimeout would catch, so a single transient hiccup mid-prefill doesn't
 * kill an otherwise-healthy long agent run.
 */
function isMidStreamDrop(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string; cause?: { name?: string; message?: string } };
  const msg = String(e.message || "");
  const causeMsg = String(e.cause?.message || "");
  if (e.name === "TypeError" && /^terminated$/i.test(msg)) return true;
  return /other side closed|UND_ERR_SOCKET|ECONNRESET|EPIPE|premature close|socket hang up/i
    .test(`${msg} ${causeMsg}`);
}

/**
 * Detect upstream LLM provider overload / rate-limit responses (Anthropic
 * 529 `overloaded_error`, or Vertex/Bedrock 503 with the same body) that
 * isUpstreamConnectError and isMidStreamDrop both miss, so these retry
 * with backoff per Anthropic's guidance instead of failing the task on a
 * transient regional capacity blip.
 */
// ── Resume notice filter (Plan Y v2 §5.4.1, NP1-2) ────────────────────
//
// brain/src/index.ts injects "[system-notice]: ..." messages (role=user)
// on a resume that lost workspace or checkpoint state. These linger in
// ckpt.messages forever, so a session that survives multiple rolling
// deploys would accumulate N copies and pollute every subsequent LLM
// request (~50 tokens each + LLM may interpret repetition as "stuck in
// a degraded loop"). We keep the last K such notices, drop earlier
// ones, and never mutate the persisted workingMessages — KV stays a
// monotonic audit trail.
const RESUME_NOTICE_PREFIX = "[system-notice]:";
const RESUME_NOTICE_KEEP_RECENT = 3;

export function filterResumeNotices(messages: Message[]): Message[] {
  const noticeIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (
      m.role === "user"
      && typeof m.content === "string"
      && m.content.startsWith(RESUME_NOTICE_PREFIX)
    ) {
      noticeIndices.push(i);
    }
  }
  if (noticeIndices.length <= RESUME_NOTICE_KEEP_RECENT) return messages;
  const keepSet = new Set(noticeIndices.slice(-RESUME_NOTICE_KEEP_RECENT));
  // Pre-build a Set of all notice indices so the per-message predicate
  // is O(1) instead of Array.includes O(n) — keeps the filter cheap on
  // long conversations (~200+ messages after several rolling deploys).
  const noticeSet = new Set(noticeIndices);
  const filtered = messages.filter((_, i) => !noticeSet.has(i) || keepSet.has(i));
  // NP1-2 metric: tick the counter once per pass that actually dropped
  // at least one notice. agent/agent-loop.ts calls this filter on every LLM
  // attempt so the rate trend reflects per-session pollution pressure.
  metrics.onResumeNoticeFiltered();
  return filtered;
}

function isOverloaded(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; name?: string; message?: string };
  if (typeof e.status === "number" && [429, 503, 529].includes(e.status)) return true;
  const msg = String(e.message || "");
  if (/"type"\s*:\s*"overloaded_error"/i.test(msg)) return true;
  if (/"type"\s*:\s*"rate_limit_error"/i.test(msg)) return true;
  if (/\b(overloaded|rate.?limit|too many requests)\b/i.test(msg)) return true;
  return false;
}

/**
 * What to tell the model about each way the sandbox was made usable again.
 *
 * Accuracy here is not cosmetic. A model told the sandbox was replaced assumes
 * /workspace was restored from a snapshot and its background processes are
 * gone, and it will re-run work it already did; a model told nothing changed
 * when the container was in fact rebuilt keeps polling a shell id that no
 * longer exists. Each of these says exactly what survived.
 */
const RECOVERY_NOTICE: Record<HandsRecoveryAction, string> = {
  rebuilt:
    "The sandbox was unreachable and has been replaced. The previous "
    + "/workspace contents were restored from the last snapshot, but anything "
    + "that was running in the old sandbox -- background shells, long jobs -- is "
    + "gone. Re-run the failing command.",
  reconnected:
    "The sandbox was reachable all along; the connection to it had gone stale "
    + "and has been renewed. Nothing in the sandbox was disturbed and no files "
    + "or background processes were lost. Retry the failing command.",
  hands_restarted:
    "The sandbox container stayed up but its tool server had stopped, and has "
    + "been started again inside the same container. Files in /workspace are "
    + "untouched and processes started with bash(run_in_background) are still "
    + "running, but any shell id from before is no longer addressable. Retry "
    + "the failing command.",
  left_alone:
    "The sandbox could not be reached and could not be repaired, and it was "
    + "deliberately not replaced -- doing so would have destroyed a container "
    + "that may still be running your work. Sandbox tools will keep failing. "
    + "Report what you have finished rather than retrying indefinitely.",
};

function asRecreateHandsResult(value: HandsClient | RecreateHandsResult): RecreateHandsResult {
  if (value && typeof value === "object" && "action" in value && "hands" in value) {
    return value as RecreateHandsResult;
  }
  return { hands: value as HandsClient, action: "rebuilt" };
}

export interface ToolStats {
  total_calls: number;
  error_calls: number;
  by_tool: Record<string, number>;
}

export interface LoopResult {
  finalText: string;
  tokenUsage: TokenUsage;
  turns: number;
  errorCount: number;
  toolStats: ToolStats;
  elapsedMs: number;
}

export interface LoopOptions {
  model: string;
  apiUrl: string;
  apiKey: string;
  maxTurns: number;
  router: ToolRouter;
  onEvent: EventCallback;
  signal?: AbortSignal;
  userId?: string;
  sessionId?: string;
  /** Current recursion depth. 0 = top-level agent; ≥1 = inside a sub-agent.
   *  `task` is dropped from the LLM-visible schemas once depth reaches
   *  SUB_AGENT_MAX_DEPTH, preventing uncontrolled nesting. Default: 0. */
  depth?: number;
  /** Hands client, needed to pass through to sub-agents so they share the
   *  same sandbox workspace. If absent, `task` tool calls fail gracefully. */
  hands?: HandsClient | null;
  /** Opens the sandbox for a run that deferred it; see ToolRouter.attachHands. */
  attachHands?: () => Promise<HandsClient>;
  /**
   * Key this run is tracked under while it waits on something external, so the
   * time can be attributed to it (see tasks/run-phase.ts). Absent means the run is
   * not tracked and the waits go uncounted.
   */
  runKey?: string;
  /** Platform MCP clients (same map the parent is using), so sub-agents can
   *  reuse the parent's MCP connections without reconnecting. */
  platformMcpClients?: Map<string, { callTool: (name: string, args: Record<string, unknown>) => Promise<string> }>;
  /** Optional in-flight sandbox rebuild hook. When the agent-loop sees enough
   *  consecutive Hands network errors (per `SANDBOX_REBUILD_THRESHOLD`) it
   *  invokes this to obtain a freshly-created sandbox. Caller is responsible
   *  for tearing down the old workload, ensuring the new one is up, and
   *  rehydrating /workspace from S3. Return either a RecreateHandsResult or a
   *  HandsClient (treated as rebuilt=true). Sub-agent loops do NOT trigger
   *  rebuilds independently — only the top-level loop owns this hook. */
  recreateHands?: (
    allowance?: HandsRecoveryAllowance,
  ) => Promise<HandsClient | RecreateHandsResult>;
  /** Plugin-provided hooks; null/undefined disables all hook dispatch.
   *  Shared across sub-agents (same registry + same sandbox HandsClient). */
  hooks?: HookRunner;
  /** HITL controller for user approval flow. Null = auto-allow everything. */
  hitl?: HitlController;
  /** NATS decision dispatcher for ask_user_question answers. */
  questionDispatcher?: import("../delivery/decision-dispatcher.js").DecisionDispatcher;
  /** Start in plan mode (read-only tools only until exit_plan_mode). */
  startInPlanMode?: boolean;
  /** Called after each complete turn (tool results appended to messages).
   *  Caller persists state to NATS KV for cross-Brain resume. */
  onCheckpoint?: (state: CheckpointState) => Promise<void>;
  /**
   * Called the moment a turn's response shows the prefix cache was used, with
   * the timestamp that goes into `last_cache_use_at`.
   *
   * A checkpoint is written at a turn BOUNDARY, so between the response that
   * updates this timestamp and the checkpoint that persists it lies the whole
   * of that turn's tool batch -- which can be half an hour of one bash call.
   * A SIGTERM in that window persists the PREVIOUS turn's timestamp, and the
   * gap the detector computes on resume is overstated by the length of the
   * batch, which biases the diagnosis towards "over_ttl" on exactly the runs
   * where a tool call ran long.
   *
   * Synchronous, in-memory, no I/O: this is a notification, not a write, and
   * deliberately does not touch the checkpoint cadence. It exists so the
   * SIGTERM path can overlay a fresher timestamp on the state it is already
   * about to persist. See the note on `latestCacheUseAt` in the runner.
   */
  onCacheUse?: (at: number | undefined) => void;
  /** Resume from a prior checkpoint. Skips turns 0..resumeFrom.turns_completed-1.
   *  Messages, usage, stats are pre-populated from checkpoint values. */
  resumeFrom?: CheckpointState;
  /** Test seam: use this LLM session instead of building one from the
   *  deployment-wide provider. Production callers leave it unset — everything
   *  else the loop needs already arrives through this interface, and that one
   *  module-level call was what made the file untestable. */
  llmSession?: LlmSession;
}

// ── P1: todo_write in-loop state ──
interface TodoItem { id: string; content?: string; status?: string }

/** Merge todo_write updates into existing in-loop todo state, keyed by id. */
function mergeTodos(existing: TodoItem[], updates: TodoItem[]): TodoItem[] {
  const map = new Map(existing.map((t) => [t.id, { ...t }]));
  for (const u of updates) {
    const prev = map.get(u.id);
    if (prev) {
      map.set(u.id, { ...prev, ...u });
    } else {
      map.set(u.id, { ...u });
    }
  }
  return [...map.values()];
}

/** Tool-result size cap fed back to the LLM. Without this each long bash /
 *  read result accumulates verbatim into conversation history and a 30-turn
 *  inference-optimization run inflates input_tokens past 1M (validated:
 *  session 65c2518b reached 1.3M tokens, well past Opus' 200K window, and
 *  the gateway truncated subsequent streams).
 *  Strategy: keep head + tail (most diagnostic info lives at boundaries) and
 *  attach a marker so the LLM knows content was elided. */
const TOOL_RESULT_MAX_CHARS = 6000;
const TOOL_RESULT_HEAD_CHARS = 4000;
const TOOL_RESULT_TAIL_CHARS = 1500;

function truncateToolResult(text: string): string {
  if (typeof text !== "string" || text.length <= TOOL_RESULT_MAX_CHARS) return text;
  const head = text.slice(0, TOOL_RESULT_HEAD_CHARS);
  const tail = text.slice(-TOOL_RESULT_TAIL_CHARS);
  const dropped = text.length - TOOL_RESULT_HEAD_CHARS - TOOL_RESULT_TAIL_CHARS;
  return `${head}\n\n[... ${dropped} chars truncated for context efficiency; if you need the elided portion, re-run the command with narrower scope (head/tail/grep/sed range) ...]\n\n${tail}`;
}

/** Cap on any single string inside a persisted `tool_use.input`.
 *
 *  Tool *results* were already bounded; tool *inputs* were not, and the
 *  checkpoint carries the whole message array. A single `write` of a large
 *  file therefore put the entire file body into the conversation history and
 *  into every subsequent checkpoint, which is the cheapest way to cross the
 *  16MiB KV value limit. The budget is larger than the result budget because
 *  an input is what the model asked for and is less recoverable by re-running.
 */
const TOOL_INPUT_MAX_CHARS = 12000;
const TOOL_INPUT_HEAD_CHARS = 9000;
const TOOL_INPUT_TAIL_CHARS = 2000;

function truncateToolInputString(text: string): string {
  if (text.length <= TOOL_INPUT_MAX_CHARS) return text;
  const head = text.slice(0, TOOL_INPUT_HEAD_CHARS);
  const tail = text.slice(-TOOL_INPUT_TAIL_CHARS);
  const dropped = text.length - TOOL_INPUT_HEAD_CHARS - TOOL_INPUT_TAIL_CHARS;
  return `${head}\n\n[... ${dropped} chars elided from this argument in the conversation history; the tool received the full value ...]\n\n${tail}`;
}

/** Bound `tool_use.input` strings in the assistant content about to be pushed
 *  into the conversation history.
 *
 *  Runs after the tools have executed, so it never changes what a tool
 *  received. Only string values are shortened and every key is preserved, so
 *  a truncated input still satisfies the tool's schema. Blocks that need no
 *  change are passed through by reference; only the ones that do get copied.
 */
function truncateToolUseInputs(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const out = content.map((block: any) => {
    if (!block || block.type !== "tool_use" || !block.input || typeof block.input !== "object") {
      return block;
    }
    let blockChanged = false;
    const input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(block.input as Record<string, unknown>)) {
      if (typeof value === "string") {
        const capped = truncateToolInputString(value);
        if (capped !== value) blockChanged = true;
        input[key] = capped;
      } else {
        input[key] = value;
      }
    }
    if (!blockChanged) return block;
    changed = true;
    return { ...block, input };
  });
  return changed ? out : content;
}

/** Result recorded for a tool call that was skipped because the run was
 *  stopped. Every `tool_use` needs a matching `tool_result`, so cancelled
 *  calls report the cancellation rather than silently getting "(no result)". */
const CANCELLED_TOOL_RESULT =
  "Cancelled: the run was stopped before this tool call was dispatched.";

// ── Auto-compaction config ──
// Trigger threshold lives in config.ts (env-overridable) so a deployment
// can switch back to the legacy 200K-window default of 120K without code
// changes. See COMPACTION_TRIGGER_INPUT_TOKENS docstring there for the
// 1M-context rationale.
// How many recent turn-pairs (assistant + user_tool_results) to keep verbatim
// after compaction. 8 pairs = 16 messages gives the LLM enough recent tool
// call context to avoid replaying decisions it just made. (Original value of
// 4 was too aggressive and occasionally caused the agent to re-run commands
// that were already completed.)
/** Anthropic's default ephemeral lifetime, the line the survival check splits on. */
/**
 * How long an entry this deployment asked for is supposed to live.
 *
 * Taken from LLM_CACHE_TTL rather than pinned at five minutes. A deployment
 * configured for 5m has entries that expire at five minutes by design, and
 * comparing its gaps against a constant reported every one of those normal
 * expiries as a defect. The label means "longer than we paid for" -- which is
 * a different claim depending on what was paid for.
 */
const CONFIGURED_CACHE_TTL_MS = LLM_CACHE_TTL === "5m" ? 5 * 60 * 1000 : 60 * 60 * 1000;

/**
 * The two block-distances worth logging when a cache read is lost, kept apart.
 *
 * Only the ROLLING markers form a chain that can break, so only distances
 * between them -- and from the last one to the end of the prompt -- are
 * evidence. The anchor is pinned to the end of the system run and never moves,
 * so its distance to anything is planCacheBreakpoints' own geometry: it grows
 * with the conversation and is identical on the healthy turns. Folding it into
 * one maximum made every conversation past ~57 blocks report a broken chain.
 * It is returned separately, under its own name, so a reader can see it
 * without it being mistaken for the thing that went wrong.
 *
 * Nothing is reported when the anchor is all there is. `blocks - anchor` was
 * being filled in as `rollingMaxGap` in that case, which is the same
 * conflation one subtraction further along: a number that grows with the
 * conversation, published under a name that means "the chain broke". An absent
 * field says there was no chain to measure, and it is honest -- offsets and
 * promptBlocks are logged beside it, so a reader who wants the geometry has
 * it. Both are also absent when the provider cannot report offsets at all: an
 * absent measurement must not read as a zero-width gap.
 */
export function cacheChainGaps(
  offsets: readonly number[] | undefined,
  blocks: number | undefined,
): { anchorGap: number | undefined; rollingMaxGap: number | undefined } {
  if (!offsets || offsets.length < 2 || blocks === undefined) {
    return { anchorGap: undefined, rollingMaxGap: undefined };
  }
  let rollingMaxGap = blocks - offsets[offsets.length - 1]!;
  for (let i = 2; i < offsets.length; i++) {
    rollingMaxGap = Math.max(rollingMaxGap, offsets[i]! - offsets[i - 1]!);
  }
  return { anchorGap: offsets[1]! - offsets[0]!, rollingMaxGap };
}

const COMPACTION_KEEP_RECENT_TURNS = 8;
// Don't bother compacting tiny conversations.
const COMPACTION_MIN_MESSAGES = 8;

const COMPACTION_PROMPT = `You are summarizing an in-progress agent execution so the next turns stay within the model's context window. Compress the messages below into a structured markdown summary that preserves:
- The user's original goal and key constraints (from the very first user message)
- Decisions the agent made and why
- Concrete artifacts produced: file paths written, throughput / latency numbers, kernel names identified, GEAK task ids, etc.
- Errors encountered and how they were resolved (or are still open)
- Current TODO / phase progress so the agent can resume the right step

Keep it under 4 KB. Do not editorialize. Output the summary text only.`;

/** Compact older messages into a single summary message when input_tokens
 *  cross COMPACTION_TRIGGER_INPUT_TOKENS. Returns the new message array.
 *  Reuses the main loop's model (no extra gateway routing required) — cost
 *  delta vs sonnet is ~$0.4/call which is negligible for a low-frequency op.
 *  Falls back to the original messages on summarization error. */
/**
 * What compaction did, said outright rather than inferred.
 *
 * The caller used to compare array identity and length, which cannot tell a
 * summariser failure from "nothing worth compacting" -- both came back as the
 * same array. That made `result="failed"` a metric value no production line
 * could ever emit, and a counter that cannot report the bad case is worse than
 * no counter. Best-effort behaviour is unchanged: a failure still leaves the
 * loop running on the uncompacted history.
 */
type CompactionOutcome = {
  status: "compacted" | "noop" | "failed";
  messages: Message[];
};

async function compactConversation(
  session: LlmSession,
  workingMessages: Message[],
  sessionIdLog: string | undefined,
  compactRound: number,
  atTurn: number,
): Promise<CompactionOutcome> {
  const noop = (): CompactionOutcome => ({ status: "noop", messages: workingMessages });
  if (workingMessages.length < COMPACTION_MIN_MESSAGES) return noop();

  // Preserve the head: any leading role:"system" run, plus the first user
  // message (the original prompt) so the agent never loses sight of the goal.
  //
  // The system run is KEPT rather than treated as a reason to bail. Bailing is
  // what made a system-headed conversation permanently uncompactable -- it
  // could only ever grow, until it hit the context window and died on a 400
  // that streamTurnWithRetry does not retry. Keeping the run contiguous at
  // index 0 also leaves the tools -> system -> messages cache prefix intact.
  let headEnd = 0;
  while (headEnd < workingMessages.length && workingMessages[headEnd].role === "system") headEnd++;
  if (workingMessages[headEnd]?.role === "user") headEnd++;
  if (headEnd === 0) return noop();
  const head = workingMessages.slice(0, headEnd);

  // Find a safe cut boundary: the kept tail must START with an assistant
  // message so the prepended "user"-role summary connects naturally.
  const desiredKeep = COMPACTION_KEEP_RECENT_TURNS * 2;
  let keepStart = workingMessages.length - desiredKeep;
  if (keepStart <= head.length) return noop(); // nothing meaningful to compact yet
  while (keepStart < workingMessages.length && workingMessages[keepStart].role !== "assistant") {
    keepStart++;
  }
  if (keepStart >= workingMessages.length) return noop();

  const middle = workingMessages.slice(head.length, keepStart);
  const tail = workingMessages.slice(keepStart);
  if (middle.length === 0) return noop();

  // Serialize middle messages into a flat text the summarizer can read.
  const middleText = middle.map((m, i) => {
    const role = m.role.toUpperCase();
    let body: string;
    if (typeof m.content === "string") {
      body = m.content;
    } else {
      body = m.content.map((b) => {
        const bb = b as Record<string, unknown>;
        if (bb.type === "text") return String(bb.text ?? "");
        if (bb.type === "thinking") return `[thinking: ${String(bb.thinking ?? "").slice(0, 500)}]`;
        if (bb.type === "tool_use") return `[tool_use ${bb.name}(${JSON.stringify(bb.input).slice(0, 800)})]`;
        if (bb.type === "tool_result") return `[tool_result ${String(bb.content ?? "").slice(0, 1500)}]`;
        return `[${bb.type}]`;
      }).join("\n");
    }
    return `[${i}] ${role}:\n${body}`;
  }).join("\n\n---\n\n");

  const t0 = Date.now();
  let summary: string;
  try {
    summary = await session.complete(COMPACTION_PROMPT, middleText.slice(0, 600_000), 4096);
  } catch (err: any) {
    logger.warn({ err: err?.message || String(err), sessionId: sessionIdLog }, "compaction.failed");
    return { status: "failed", messages: workingMessages };
  }

  const summaryMsg: Message = {
    role: "user",
    content: [{
      type: "text",
      text: `[Compact #${compactRound} at turn ${atTurn} — ${middle.length} messages (msgs ${head.length}..${keepStart - 1}) replaced with this summary]\n\n${summary}`,
    }],
  };
  const newMessages = [...head, summaryMsg, ...tail];
  logger.info(
    {
      sessionId: sessionIdLog,
      compactedMessages: middle.length,
      keptMessages: tail.length,
      summaryLen: summary.length,
      elapsedMs: Date.now() - t0,
    },
    "compaction.done",
  );
  return { status: "compacted", messages: newMessages };
}

/** Detects bash commands that install system-level packages. */
const SETUP_CMD_RE =
  /\b(pip3?\s+install|npm\s+install|npm\s+ci|yarn\s+add|pnpm\s+install|apt-get?\s+install|apt\s+install|conda\s+install|cargo\s+install|gem\s+install|brew\s+install|poetry\s+add|uv\s+pip\s+install)\b/;

/** Plan mode read-only allowlist (§5.7) */
const PLAN_MODE_ALLOWLIST = new Set([
  "read", "glob", "grep", "ls", "web_search", "web_fetch",
  "bash_output", "todo_write", "exit_plan_mode", "ask_user_question",
]);

/**
 * Generic agent loop: LLM call → tool_use → route to Hands/MCP → tool_result → repeat.
 * All state is local (per-request safe for multi-user Brain).
 *
 * Implemented as a class so the many per-run mutable fields (usage, working
 * messages, sandbox-rebuild counters, todo/plan-mode state, ...) get named,
 * typed fields instead of a wall of closured `let`s. This is a pure
 * structural refactor: every method preserves the exact statement order,
 * branch conditions and await timing of the original single function.
 * `agentLoop()` below is the unchanged public entrypoint.
 */
class AgentLoopRunner {
  private readonly opts: LoopOptions;
  private readonly tools: ToolSchema[];
  private readonly model: string;
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly maxTurns: number;
  private readonly router: ToolRouter;
  private readonly onEvent: EventCallback;
  private readonly signal?: AbortSignal;
  private readonly userId?: string;
  private readonly sessionId?: string;
  private readonly depth: number;
  private readonly rawMessageCount: number;
  private readonly session: LlmSession;

  // --- Resume: pre-populated from checkpoint in the constructor ---
  private workingMessages: Message[];
  private textParts: string[];
  private usage: TokenUsage;
  private errorCount: number;
  private toolCallsByName: Record<string, number>;
  private totalToolCalls: number;
  private setupCommands: Array<{ cmd: string; turn: number }>;
  private readonly startTime: number;
  private readonly initialTurn: number;
  // Checkpoint cadence anchor (checkpoint-architecture-redesign §5.4).
  // Seeded to startTime so the wall-clock fallback uses elapsed task time,
  // not pod uptime; resumed runs continue the same effective baseline.
  private lastCheckpointAt: number;

  // In-flight sandbox rebuild tracking. consecutiveSandboxErrors increments on
  // every Hands network error, resets to 0 on any successful route(). Once it
  // hits SANDBOX_REBUILD_THRESHOLD we mark `recoveryPending` so the repair
  // happens after the current tool-batch finishes (avoids tearing down the
  // sandbox while parallel tasks are still running). rebuildsUsed is a hard
  // budget per task to prevent infinite rebuild loops on a doomed sandbox.
  private consecutiveSandboxErrors = 0;
  private recoveryPending = false;
  private rebuildsUsed = 0;
  /**
   * Recoveries that did not replace the sandbox.
   *
   * Counted apart from `rebuildsUsed` because the rebuild budget cannot bound
   * them: this used to decrement `rebuildsUsed` back down whenever the sandbox
   * was left in place, so a container that stayed alive with a dead tool server
   * was repaired-and-not-repaired forever, with the rebuild budget stuck at zero
   * and the exhaustion notice it guards unreachable.
   */
  private recoveriesUsed = 0;
  /**
   * A budget refusal that re-probing cannot turn into a repair.
   *
   * `exhaustedBudget` cannot see this case: it only knows the two counters,
   * while which budget an attempt needs is decided by the probe, inside the
   * recovery. So a task with one budget spent and the other intact passed the
   * gate, paid for a probe, was refused for the spent one, and did it again on
   * every later batch -- the refusal itself consumed nothing, and neither
   * counter ever moved. Latching the refusal is sound because neither counter
   * decreases *while the sandbox stays broken*: the one thing that lowers
   * `recoveriesUsed` is a sandbox call that succeeded, and that clears this
   * latch with it (see the reset beside it). So for as long as the refusal
   * could still be true, the same evidence produces the same answer, and the
   * moment that stops holding the latch is gone.
   *
   * The case this gives up on is a container that is unreachable while the
   * non-destructive budget runs out and is then confirmed dead, with rebuilds
   * still available. That trade is deliberate: SANDBOX_RECOVERY_MAX_PER_TASK
   * repairs have already failed to make one tool call succeed, and spending a
   * destroy on top of that is the trade this whole path exists to refuse.
   */
  /**
   * A refusal that no later batch can talk out of.
   *
   * Two things live here: a refusal that can never come out differently, and a
   * spent budget. The second is a known compromise -- the record says which
   * budget refused, but every read treats its presence as "recovery is over",
   * so a rebuild refused while the container was dead also cancels the
   * untouched repair budget if the container later comes back. The alternative
   * tried and rejected was to stop latching budgets: that branch charges
   * neither counter, so the loop re-probes every batch until maxTurns.
   */
  private recoveryRefusal: { kind: string; used: number; max: number } | null = null;
  private compactionRound = 0;
  /** Set once per turn, before any early return, so compaction reads one number. */
  private promptTokensThisTurn = 0;
  /**
   * When this run last USED a cache entry -- read or write -- anchored at that
   * turn's request. Undefined means there is no entry whose loss this run
   * could observe, which is also what compaction leaves behind.
   */
  private lastCacheUseAt: number | undefined;

  // Throttle for sandboxStatus event emission. Key = `${status}:${tool||""}`,
  // value = last emit timestamp (ms). Only high-frequency statuses pass a
  // throttle window; terminal/rebuild statuses always emit.
  //
  // Nothing that varies per emit belongs in this key. A counter in it gives
  // every event a key of its own, which silently turns the window off and
  // grows this map for the life of the run -- a caller that wants an
  // individual event through says so by passing throttleMs 0.
  private readonly lastSandboxStatusAt = new Map<string, number>();

  // ── P1: todo_write in-loop state ──
  private todoState: TodoItem[] = [];
  private todoCallSeq = 0;

  // ── P4: plan mode state ──
  private planMode: boolean;
  private effectiveTools: ToolSchema[];

  // maxTurns <= 0 disables the cap (unlimited). Caller must accept runaway risk.
  // We track loop turns independently of usage.turns: some LLM gateways omit
  // `usage` (especially for streamed errors), in which case usage.turns stays
  // 0 and any reporting / quota driven by it would be wrong.
  private turnsExecuted = 0;

  constructor(messages: Message[], tools: ToolSchema[], opts: LoopOptions) {
    this.opts = opts;
    this.tools = tools;
    const { model, apiUrl, apiKey, maxTurns, router, onEvent, signal, userId, sessionId } = opts;
    this.model = model;
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.maxTurns = maxTurns;
    this.router = router;
    this.onEvent = onEvent;
    this.signal = signal;
    this.userId = userId;
    this.sessionId = sessionId;
    this.depth = opts.depth ?? 0;
    this.rawMessageCount = messages.length;

    // --- Resume: pre-populate state from checkpoint ---
    const resumeFrom = opts.resumeFrom;
    this.workingMessages = resumeFrom
      ? [...resumeFrom.messages]
      : [...messages];

    this.textParts = resumeFrom ? [...resumeFrom.text_parts] : [];
    this.usage = resumeFrom
      ? { ...resumeFrom.usage }
      : { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 };
    this.errorCount = resumeFrom?.error_count ?? 0;
    this.toolCallsByName = resumeFrom
      ? { ...resumeFrom.tool_calls_by_name }
      : {};
    this.totalToolCalls = resumeFrom?.total_tool_calls ?? 0;
    this.setupCommands =
      resumeFrom?.setup_commands ? [...resumeFrom.setup_commands] : [];
    this.startTime = Date.now() - (resumeFrom?.elapsed_ms_before ?? 0);
    this.initialTurn = resumeFrom?.turns_completed ?? 0;
    // Carried across the redelivery rather than re-inferred. See
    // CheckpointState.last_cache_use_at.
    this.lastCacheUseAt = resumeFrom?.last_cache_use_at;
    this.lastCheckpointAt = this.startTime;
    this.todoState = resumeFrom?.todo_state ? [...resumeFrom.todo_state] : [];
    this.rebuildsUsed = resumeFrom?.rebuilds_used ?? 0;
    this.recoveriesUsed = resumeFrom?.recoveries_used ?? 0;

    // Plan mode is an authorization latch, so it has to survive resume: a run
    // that already passed exit_plan_mode must not be re-locked, and one that
    // never did must not come back with write tools enabled. Checkpoints
    // written before plan_mode was persisted have it absent, and those fall
    // back to the request parameter — the pre-existing behaviour.
    this.planMode = resumeFrom?.plan_mode ?? opts.startInPlanMode ?? false;
    this.effectiveTools = this.buildEffectiveTools();

    // LLM session: constructed once per loop so per-user headers/retry state
    // don't leak across concurrent agent loops in the brain process. Which
    // wire protocol (Anthropic Messages vs OpenAI Chat Completions) this
    // speaks is decided once for the whole Brain deployment — see
    // config.ts LLM_API_STYLE and llm/index.ts getProvider(). maxRetries=2
    // (set inside each provider) lets the SDK absorb transient network noise
    // (DNS hiccups / ECONNRESET / 503), which previously surfaced as
    // `task.failed` after dozens of successful turns and forced the task to
    // restart from scratch via NATS redelivery. SDK retry only fires for
    // APIConnectionError + 408/409/429/5xx — it does NOT interfere with
    // sandbox-rebuild (which counts Hands tool errors, not LLM errors) or
    // with our turn-level abort/interrupt path.
    //
    // opts.llmSession is a test seam. Everything else the loop touches arrives
    // through LoopOptions, so this one call to a module-level singleton was the
    // only thing standing between this file and being testable at all.
    this.session = opts.llmSession
      ?? getProvider().createSession({ model, apiUrl, apiKey, userId, sessionId });
  }

  async run(): Promise<LoopResult> {
    logger.info({
      sessionId: this.sessionId, model: this.model, apiUrl: this.apiUrl,
      maxTurns: this.maxTurns, depth: this.depth,
      messageCount: this.rawMessageCount,
      toolCount: this.effectiveTools.length,
    }, "agent-loop.start");

    for (
      let turn = this.initialTurn;
      this.maxTurns <= 0 || turn < this.maxTurns + this.initialTurn;
      turn++
    ) {
      this.turnsExecuted = turn + 1 - this.initialTurn;
      if (this.signal?.aborted) break;
      const shouldBreak = await this.runTurn(turn);
      if (shouldBreak) break;
    }

    logger.info({
      sessionId: this.sessionId,
      turnsExecuted: this.turnsExecuted,
      totalToolCalls: this.totalToolCalls,
      errorCount: this.errorCount,
      elapsedMs: Date.now() - this.startTime,
      finalTextLen: this.textParts.join("").length,
    }, "agent-loop.finished");

    return {
      finalText: this.textParts.join("\n").trim(),
      tokenUsage: this.usage,
      turns: this.turnsExecuted,
      errorCount: this.errorCount,
      toolStats: { total_calls: this.totalToolCalls, error_calls: this.errorCount, by_tool: this.toolCallsByName },
      elapsedMs: Date.now() - this.startTime,
    };
  }

  private buildEffectiveTools(): ToolSchema[] {
    let filtered = this.tools;
    if (this.depth >= SUB_AGENT_MAX_DEPTH) {
      filtered = filtered.filter((t) => t.name !== "task");
    }
    if (this.planMode) {
      filtered = filtered.filter((t) => PLAN_MODE_ALLOWLIST.has(t.name));
    }
    return filtered;
  }

  private async emitSandboxStatus(
    status: string,
    extra: Record<string, unknown> = {},
    throttleMs = 0,
  ): Promise<void> {
    if (throttleMs > 0) {
      const key = `${status}:${String((extra as Record<string, unknown>).tool ?? "")}`;
      const now = Date.now();
      const prev = this.lastSandboxStatusAt.get(key) ?? 0;
      if (now - prev < throttleMs) return;
      this.lastSandboxStatusAt.set(key, now);
    }
    await this.onEvent({ type: "sandboxStatus", status, ...extra });
  }

  /**
   * Announce a recovery step without letting the announcement decide the
   * outcome. The status stream is telemetry, but it reaches JetStream, and a
   * publish there fails transiently often enough that the KV write in
   * task-runner guards against it. Left unguarded here, a throw while
   * reporting a repair that already happened falls into the failure handler
   * below: it charges a second budget unit for one recovery, records a
   * `failed` decision for a sandbox that works, and hands the model a "could
   * not be recovered" notice for a client it is holding and can use. The same
   * throw on the failure and exhausted paths swallows the only notice the
   * model gets, and on the `recovering` path it aborts the repair before it
   * is attempted.
   */
  private async emitRecoveryStatus(
    status: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.emitSandboxStatus(status, extra);
    } catch (err) {
      logger.warn(
        { err, sessionId: this.sessionId, status },
        "sandbox.recovery.status_emit_failed",
      );
    }
  }

  /**
   * Count a Hands MCP network error toward an in-flight recovery attempt.
   *
   * Counting is all this does. It used to probe the container first and, when
   * the container answered, reset the count to zero -- so an error class that
   * always took that branch could never reach the threshold, and a sandbox
   * whose tool server had died inside a live container produced an unbounded
   * run of these notices and no attempt to fix anything. Whether the container
   * is worth keeping is a question for the recovery itself, which has to ask it
   * anyway before destroying anything, and asking it in two places with two
   * answers was the other half of the problem.
   */
  private async noteSandboxNetworkError(err: unknown, toolName: string): Promise<void> {
    if (this.depth !== 0 || !this.opts.recreateHands) return;
    if (!isSandboxTool(toolName) || !isHandsNetworkError(err)) return;
    const reason = handsNetworkErrorReason(err);
    const errText = String((err as { message?: string })?.message || err).slice(0, 300);
    this.consecutiveSandboxErrors++;
    this.recoveryPending ||= this.consecutiveSandboxErrors >= SANDBOX_REBUILD_THRESHOLD;
    // Two moments in a failing batch carry information; the rest is repetition
    // of the first. The opening error says the sandbox stopped answering, and
    // the one that reaches the threshold says a repair is about to run --
    // that one goes out whatever the window says, because it is the event a
    // reader is waiting for. `=== threshold` and not `>=`: every later call in
    // the same batch is past it, and letting those through is the flood this
    // window exists to stop.
    const crossesThreshold = this.consecutiveSandboxErrors === SANDBOX_REBUILD_THRESHOLD;
    await this.emitSandboxStatus(
      "tool_unreachable",
      {
        tool: toolName,
        reason,
        consecutive_errors: this.consecutiveSandboxErrors,
        threshold: SANDBOX_REBUILD_THRESHOLD,
        message: errText,
      },
      crossesThreshold ? 0 : 5_000,
    );
  }

  /**
   * Try to make the sandbox usable again, after a tool batch.
   *
   * After the batch rather than during it, so a recovery cannot pull the
   * sandbox out from under tool calls that are still running in parallel. The
   * notice must be a `text` block, not a `tool_result`: Claude rejects a
   * tool_result whose tool_use_id does not match the preceding assistant
   * message.
   */
  private async maybeRecoverSandbox(
    results: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (!this.recoveryPending || !this.opts.recreateHands || this.depth !== 0) return;
    this.recoveryPending = false;
    this.consecutiveSandboxErrors = 0;
    // A cancelled task must not provision anything. Session cleanup stops the
    // task and destroys its sandbox concurrently -- on different replicas, so
    // in no fixed order -- and a teardown that lands first looks exactly like
    // a dead sandbox from in here: the tool calls fail with connection errors
    // and trip this rebuild. Checking the signal rather than the ordering
    // makes the race moot.
    if (this.signal?.aborted) {
      logger.info({ sessionId: this.sessionId }, "sandbox.recovery.skipped_aborted");
      results.push({
        type: "text",
        text: "Sandbox was unreachable, and this task has been cancelled — not rebuilding.",
      });
      return;
    }
    const exhausted = this.recoveryRefusal ?? this.exhaustedBudget();
    if (exhausted) {
      await this.noteRecoveryExhausted(results, exhausted);
      return;
    }
    await this.performSandboxRecovery(results);
  }

  /** Stop before probing only when neither kind of recovery remains available. */
  private exhaustedBudget(): { kind: string; used: number; max: number } | null {
    const rebuildExhausted = this.rebuildsUsed >= SANDBOX_REBUILD_MAX_PER_TASK;
    const recoveryExhausted = this.recoveriesUsed >= SANDBOX_RECOVERY_MAX_PER_TASK;
    if (!rebuildExhausted || !recoveryExhausted) return null;
    return { kind: "recovery", used: this.recoveriesUsed, max: SANDBOX_RECOVERY_MAX_PER_TASK };
  }

  private async noteRecoveryExhausted(
    results: Array<Record<string, unknown>>,
    budget: { kind: string; used: number; max: number },
    refusal?: string,
  ): Promise<void> {
    // A permanent refusal has no count to quote. Reusing the budget wording
    // here would tell the model the sandbox "has been replaced 0 time(s)",
    // which is both false and the wrong instruction -- the fix is upstream,
    // not a retry.
    const msg = refusal
      ? `${refusal} No further recovery will be attempted for this task.`
      : budget.kind === "rebuild"
      ? `The sandbox has been replaced ${budget.used} time(s) and keeps failing, `
        + `so it will not be replaced again. Report what you have completed; the `
        + `user will need to retry.`
      : `The sandbox has been repaired ${budget.used} time(s) without any tool `
        + `call succeeding afterwards, so no further attempts will be made. `
        + `Sandbox tools will keep failing -- report what you have completed `
        + `rather than retrying.`;
    logger.error(
      { sessionId: this.sessionId, budget: budget.kind, used: budget.used, max: budget.max },
      "sandbox.recovery.exhausted",
    );
    metrics.onSandboxRecoveryDecision("exhausted");
    await this.emitRecoveryStatus("recovery_exhausted", {
      budget: budget.kind,
      attempt: budget.used,
      max: budget.max,
      message: msg,
    });
    results.push({ type: "text", text: msg });
  }

  private async performSandboxRecovery(
    results: Array<Record<string, unknown>>,
  ): Promise<void> {
    const t0 = Date.now();
    await this.emitRecoveryStatus("recovering", {
      rebuilds_used: this.rebuildsUsed,
      recoveries_used: this.recoveriesUsed,
    });
    try {
      const allowance: HandsRecoveryAllowance = {
        rebuild: this.rebuildsUsed < SANDBOX_REBUILD_MAX_PER_TASK,
        nondestructive: this.recoveriesUsed < SANDBOX_RECOVERY_MAX_PER_TASK,
      };
      const outcome = asRecreateHandsResult(await this.opts.recreateHands!(allowance));
      // Swap the client in regardless of which repair happened: even when the
      // sandbox was left alone, the client may be a fresh one, and the router
      // and the hooks must never be left holding the discarded object.
      this.router.setHands(outcome.hands);
      this.opts.hands = outcome.hands;
      this.opts.hooks?.setHands(outcome.hands);
      const elapsedMs = Date.now() - t0;
      if (outcome.action === "rebuilt") this.rebuildsUsed++;
      else this.recoveriesUsed++;
      metrics.onSandboxRecoveryDecision(outcome.action);
      logger.warn(
        {
          sessionId: this.sessionId,
          action: outcome.action,
          detail: outcome.detail,
          rebuildsUsed: this.rebuildsUsed,
          recoveriesUsed: this.recoveriesUsed,
          elapsedMs,
        },
        "sandbox.recovery.done",
      );
      await this.emitRecoveryStatus(`recovery_${outcome.action}`, {
        detail: outcome.detail,
        elapsed_ms: elapsedMs,
      });
      results.push({ type: "text", text: RECOVERY_NOTICE[outcome.action] });
    } catch (e: any) {
      const elapsedMs = Date.now() - t0;
      if (e instanceof HandsRecoveryRefused) {
        // Nothing about the next batch changes this answer, so remember it and
        // stop asking: without the latch each batch pays for another probe to
        // be told the same thing, and repeats the same notice to the model.
        const refusal = { kind: "refused", used: 0, max: 0 };
        this.recoveryRefusal = refusal;
        await this.noteRecoveryExhausted(results, refusal, e.message);
        return;
      }
      if (e instanceof HandsRecoveryBudgetExhausted) {
        const used = e.kind === "rebuild" ? this.rebuildsUsed : this.recoveriesUsed;
        const max = e.kind === "rebuild"
          ? SANDBOX_REBUILD_MAX_PER_TASK
          : SANDBOX_RECOVERY_MAX_PER_TASK;
        // Latched, because without it the next batch pays for the same probe
        // and reaches the same refusal. Note what this costs: the latch is
        // consulted without regard to which budget refused, so a rebuild
        // refused while the container was dead also stops the untouched repair
        // budget being used if the container later comes back. Removing the
        // latch is not the fix -- this branch charges neither counter, so the
        // loop would then re-probe every batch until maxTurns. Bounding total
        // recovery attempts would let both be true at once; that is a design
        // change, and it is written up rather than smuggled in here.
        this.recoveryRefusal = { kind: e.kind, used, max };
        await this.noteRecoveryExhausted(results, { kind: e.kind, used, max });
        return;
      }
      // A throw is the recovery declining to act, not a silent no-op: the
      // clearest case is a DAG node refusing to destroy a sandbox it inherited.
      // It still counts, or the refusal repeats every batch.
      //
      // Which budget it counts against is the recovery's to say. A rebuild that
      // was entered and failed has spent the sandbox whether or not it produced
      // a client, so it is charged to the rebuild budget; everything else was
      // refused or repaired without destroying anything.
      const rebuildAttempt = e instanceof HandsRebuildFailed;
      if (rebuildAttempt) this.rebuildsUsed++;
      else this.recoveriesUsed++;
      metrics.onSandboxRecoveryDecision("failed");
      logger.error(
        {
          err: e,
          sessionId: this.sessionId,
          attempted: rebuildAttempt ? "rebuild" : "nondestructive",
          rebuildsUsed: this.rebuildsUsed,
          recoveriesUsed: this.recoveriesUsed,
          elapsedMs,
        },
        "sandbox.recovery.failed",
      );
      await this.emitRecoveryStatus("recovery_failed", {
        attempt: rebuildAttempt ? this.rebuildsUsed : this.recoveriesUsed,
        max: rebuildAttempt ? SANDBOX_REBUILD_MAX_PER_TASK : SANDBOX_RECOVERY_MAX_PER_TASK,
        elapsed_ms: elapsedMs,
        error: e?.message || String(e),
      });
      results.push({
        type: "text",
        text: `The sandbox could not be recovered: ${e?.message || e}. Sandbox `
          + `tools will keep failing until this is resolved.`,
      });
    }
  }

  /** One full loop iteration: LLM call → tool dispatch → bookkeeping.
   *  Returns true when the caller's `for` loop should break (end_turn / no
   *  tool calls), false to continue to the next turn. */
  private async runTurn(turn: number): Promise<boolean> {
    // Rebuild tool list each turn (planMode may have changed via exit_plan_mode)
    this.effectiveTools = this.buildEffectiveTools();

    const turnStart = Date.now();
    const streamResult = await this.streamTurnWithRetry(turn, turnStart);
    const { content, stopReason, usage: turnUsage, firstByteMs, routedModel } = streamResult;
    logger.info(
      {
        turn, sessionId: this.sessionId, firstByteMs, elapsedMs: Date.now() - turnStart,
        blocks: content.length, stopReason,
        routedModel,
      },
      "agent-loop.stream.done",
    );

    // Accumulate token usage across turns.
    this.usage.input_tokens += turnUsage.input_tokens;
    this.usage.output_tokens += turnUsage.output_tokens;
    this.usage.cache_read += turnUsage.cache_read;
    this.usage.cache_create += turnUsage.cache_create;
    this.usage.turns++;

    // Cache accounting, per turn. Before this, the only place cache_read and
    // cache_create reached anybody was the terminal ResultMessage -- and the
    // long-running monitor sessions that this cost the most never reach one,
    // so Brain was structurally blind to its own headline number for the exact
    // workload that broke.
    // How big was this prompt? A provider that reports nothing is a different
    // fact from one reporting zero, and `??` cannot separate them because 0 is
    // not nullish. It matters because compaction is the only context-size
    // guard here: with no number to compare, the guard cannot fire and the run
    // continues with nothing watching it -- indistinguishable from a healthy
    // run until the context window rejects a request. Recorded before the
    // end_turn return below, because the measurement is true of every turn,
    // not only the ones that continue.
    this.promptTokensThisTurn = streamResult.promptTokens ?? turnUsage.input_tokens;
    if (streamResult.promptTokens === undefined && turnUsage.input_tokens === 0) {
      metrics.onPromptSizeUnknown();
      logger.warn({ turn, sessionId: this.sessionId, routedModel }, "agent-loop.prompt_size_unknown");
    }

    const cacheReport = streamResult.cacheReport;

    // Did the entry we wrote survive the gap?
    //
    // The provider-reported TTL says what the gateway CLAIMS it wrote, and on
    // some transports it does not say even that -- the OpenAI-shaped streaming
    // response carries no ephemeral breakdown at all, so a 1h request answered
    // with a 5m entry is invisible there. This asks the question the TTL label
    // is a proxy for, and asks it of behaviour instead of of a claim: we wrote
    // an entry, we came back with the same prefix, and nothing was read.
    //
    // Split by how long the gap was, because the two causes are different
    // problems. Past five minutes it is consistent with an entry shorter-lived
    // than the one we asked for. Inside five minutes the TTL is not the
    // suspect and the prefix is -- a tool list that changed, a backend switch,
    // an eviction.
    //
    // Guarded on three things that make a miss legitimate rather than a
    // symptom: markers actually went out this turn, we have written something
    // to miss, and compaction did not just rewrite the prefix out from under
    // us.
    if (
      cacheReport?.enabled
      && (cacheReport.breakpointsSent ?? 0) > 0
      // The response has to have SAID zero. `cache_read` defaults to zero, so
      // a gateway that drops its final usage chunk produces the same number as
      // a genuine miss -- and blaming the cache for a turn we could not
      // measure is the shape of the incident this whole change exists to fix.
      // `reported` was built to tell those apart; it has to be consumed.
      && (cacheReport.reported ?? []).includes("cache_read")
      && turnUsage.cache_read === 0
      // An entry has to have existed. This used to fall back to
      // `initialTurn > 0` when the timestamp was unset, so that a redelivery
      // resumed on another pod -- which arrives with nothing in memory -- was
      // not written off as a cold start. That fallback was too coarse. It also
      // fired for a resumed run that had just compacted, where the timestamp is
      // cleared precisely because the entry is gone, and for one whose markers
      // had been refused before the interruption. Both were counted as losses
      // that never had anything to lose, and the guards meant to prevent that
      // -- `cacheReport.enabled` above and the compaction clear -- were being
      // routed around by the very disjunct added to catch resumes.
      //
      // The timestamp now survives the redelivery inside the checkpoint, so
      // this is answered with evidence rather than a proxy. A checkpoint
      // written before that field existed leaves it unset, which under-reports
      // instead of inventing.
      && this.lastCacheUseAt !== undefined
    ) {
      const gapMs = turnStart - this.lastCacheUseAt;
      // `>=`, so a gap of exactly the TTL reads as expiry. At that point the
      // lifetime the deployment paid for has fully elapsed and expiry is a
      // complete explanation for the miss; "under_ttl" is the label that says
      // the lifetime is NOT the suspect, and pointing an investigation at the
      // prefix on the one gap expiry accounts for exactly is the kind of
      // wrong-first-guess this whole branch is about.
      const gap = gapMs >= CONFIGURED_CACHE_TTL_MS ? "over_ttl" : "under_ttl";
      metrics.onCacheEntryLost(gap);
      // Everything needed to tell the three causes apart, on the one turn that
      // can still tell them apart -- the next turn re-plans and the evidence is
      // gone. The counter says a read was lost; it cannot say why, and the
      // three answers want different fixes:
      //
      //   cacheCreate > 0        the prefix was rewritten, not dropped. Cost is
      //                          a write instead of a read, not a full-price
      //                          prompt, which is why the bill does not show it.
      //   rollingMaxGap large    the chain broke: two ROLLING markers further
      //                          apart than the lookback, which one turn
      //                          appending many blocks opens in a single step.
      //                          Ours. `anchorGap` is logged beside it and is
      //                          NOT this: the distance from the anchor to the
      //                          first rolling marker is planCacheBreakpoints'
      //                          own geometry (ROLLING_TARGET x
      //                          MAX_STRIDE_BLOCKS), so it grows with the
      //                          conversation and is identical on the healthy
      //                          turns. Folding it into one maximum, as this
      //                          did, made every long conversation report a
      //                          broken chain: the field read the same on the
      //                          hits as on the losses, because it was
      //                          measuring the conversation's length, and it
      //                          sent the first investigation after the wrong
      //                          cause.
      //   neither                the entry was not where we left it -- eviction,
      //                          or a gateway that routed to a backend without
      //                          it. Not ours, and the gateway has to answer.
      //
      // `markerBlockOffsets` is absent on providers that cannot report it, and
      // an absent measurement must not read as a zero-width gap.
      const offsets = cacheReport.markerBlockOffsets;
      const blocks = cacheReport.promptBlocks;
      const { anchorGap, rollingMaxGap } = cacheChainGaps(offsets, blocks);
      logger.warn(
        {
          turn,
          sessionId: this.sessionId,
          gapMs,
          gap,
          routedModel,
          breakpointsSent: cacheReport.breakpointsSent,
          markerBlockOffsets: offsets,
          promptBlocks: blocks,
          rollingMaxGap,
          anchorGap,
          upstreamHeaders: cacheReport.upstreamHeaders,
          cacheCreate: turnUsage.cache_create,
          inputTokens: turnUsage.input_tokens,
          promptTokens: streamResult.promptTokens,
          reported: cacheReport.reported,
          ttl5m: cacheReport.createdEphemeral5m,
          ttl1h: cacheReport.createdEphemeral1h,
        },
        "agent-loop.cache_entry_lost",
      );
    }
    // Last USE, not last write, and anchored at the request rather than the
    // response. A read refreshes the entry's lifetime, so a session that keeps
    // hitting keeps its entry alive however long it runs -- timing from the
    // original write would call that session's first real miss "over_ttl"
    // because the write happened hours ago. And the gateway's clock starts
    // when it receives the prompt, so timing from the response charges this
    // turn's own generation time to the gap.
    if (turnUsage.cache_create > 0 || turnUsage.cache_read > 0) {
      this.lastCacheUseAt = turnStart;
      // Tell the caller now rather than at the next checkpoint: the tool batch
      // that follows this line is exactly the window a SIGTERM would land in.
      this.opts.onCacheUse?.(turnStart);
    }

    metrics.onLlmTurnCache({
      inputTokens: turnUsage.input_tokens,
      outputTokens: turnUsage.output_tokens,
      cacheRead: turnUsage.cache_read,
      cacheCreate: turnUsage.cache_create,
      breakpointsSent: cacheReport?.breakpointsSent ?? 0,
      enabled: cacheReport?.enabled ?? false,
      reported: cacheReport?.reported ?? [],
      createdEphemeral5m: cacheReport?.createdEphemeral5m,
      createdEphemeral1h: cacheReport?.createdEphemeral1h,
    });

    // Per-turn token stats + output throughput
    const turnElapsedMs = Date.now() - turnStart;
    const generationMs = turnElapsedMs - (firstByteMs || 0);
    const turnOutputTps = generationMs > 0 ? turnUsage.output_tokens / generationMs * 1000 : 0;
    const totalElapsedMs = Date.now() - this.startTime;
    const avgOutputTps = totalElapsedMs > 0 ? this.usage.output_tokens / totalElapsedMs * 1000 : 0;
    const turnTokenStats = {
      turn,
      turn_input_tokens: turnUsage.input_tokens,
      turn_output_tokens: turnUsage.output_tokens,
      turn_output_tps: Math.round(turnOutputTps * 10) / 10,
      turn_first_byte_ms: firstByteMs,
      cumulative_input_tokens: this.usage.input_tokens,
      cumulative_output_tokens: this.usage.output_tokens,
      cumulative_turns: this.usage.turns,
      turn_cache_read_tokens: turnUsage.cache_read,
      turn_cache_create_tokens: turnUsage.cache_create,
      cumulative_cache_read_tokens: this.usage.cache_read,
      cumulative_cache_create_tokens: this.usage.cache_create,
      cache_breakpoints_sent: cacheReport?.breakpointsSent ?? 0,
      ...(cacheReport?.createdEphemeral5m !== undefined
        ? { turn_cache_create_5m: cacheReport.createdEphemeral5m } : {}),
      ...(cacheReport?.createdEphemeral1h !== undefined
        ? { turn_cache_create_1h: cacheReport.createdEphemeral1h } : {}),
      avg_output_tps: Math.round(avgOutputTps * 10) / 10,
      ...(routedModel ? { routed_model: routedModel } : {}),
    };
    for (const b of content) {
      if ((b as any).type === "text") {
        const text = (b as any).text as string;
        this.textParts.push(text);
        // The model reproduces whatever it was shown, so its output can carry a
        // credential the agent read out of a file moments earlier.
        logger.info({ turn, sessionId: this.sessionId, textLen: text.length, textPreview: safePreview(text, 500) }, "llm.text_block");
        await this.onEvent({ type: "AssistantMessage", data: { content: [b] }, ...turnTokenStats });
      } else if ((b as any).type === "thinking") {
        logger.info({ turn, sessionId: this.sessionId, thinkingLen: ((b as any).thinking || "").length }, "llm.thinking_block");
        await this.onEvent({ type: "ThinkingMessage", data: { content: [b] }, ...turnTokenStats });
      }
    }
    // A tool-only turn emits nothing, deliberately.
    //
    // It used to emit an AssistantMessage with empty content, so the client
    // could see the backend on a turn with no text. Twice that fired far wider
    // than intended: first gated on `routedModel` being set, which every
    // upstream satisfies, then on the model having come from the LiteLLM
    // header, which turns out to be every deployment behind LiteLLM v1.96.2
    // (see llm/routed-model.ts). There is no available signal that means "a router
    // chose this", so rather than gate it a third time it is gone: an extra
    // event shape reaching a client that has never seen one is not worth it
    // for information the next turn with text carries anyway.

    const toolUses = content.filter((b: any) => b.type === "tool_use");
    if (!toolUses.length || stopReason === "end_turn") {
      logger.info({ turn, sessionId: this.sessionId, stopReason, textPartsCount: this.textParts.length }, "agent-loop.end_turn");
      // Stop: fires once per loop completion. Only the top-level loop runs
      // this — sub-agents finishing their own loop get SubagentStop-like
      // semantics from the engine layer (not emitted here to keep the event
      // set minimal). Block is ignored because the loop is already exiting.
      if (this.depth === 0 && this.opts.hooks?.has("Stop")) {
        await this.opts.hooks.run("Stop", { stop_reason: stopReason ?? undefined });
      }
      const finalElapsedMs = Date.now() - this.startTime;
      const finalAvgTps = finalElapsedMs > 0 ? this.usage.output_tokens / finalElapsedMs * 1000 : 0;
      await this.onEvent({
        type: "ResultMessage",
        data: { subtype: "success", stop_reason: stopReason },
        token_usage: {
          input_tokens: this.usage.input_tokens,
          output_tokens: this.usage.output_tokens,
          cache_read: this.usage.cache_read,
          cache_create: this.usage.cache_create,
          turns: this.usage.turns,
        },
        total_tool_calls: this.totalToolCalls,
        elapsed_ms: finalElapsedMs,
        avg_output_tps: Math.round(finalAvgTps * 10) / 10,
      });
      return true;
    }

    // Execute tool calls. `task` is dispatched separately: we run them
    // concurrently (bounded by SUB_AGENT_MAX_CONCURRENT) because sub-agents
    // don't mutate Brain state and are usually I/O bound. Other tools keep
    // their existing serial execution — the sandbox is a single writer.
    //
    // Results are keyed by tool_use_id so the final `tool_result` array can
    // be reordered back into the schema-required order (one entry per
    // tool_use block, in the same order the model emitted them).
    const resultByToolId = new Map<string, string>();

    const taskCalls = toolUses.filter((tc: any) => tc.name === "task");
    const otherCalls = toolUses.filter((tc: any) => tc.name !== "task");

    // Run non-`task` tools serially (sandbox-safe).
    //
    // The abort check belongs inside the loop, not just at the turn boundary:
    // one turn can emit many tool calls, and dispatching them all after the
    // user has already stopped the run is what made "stop" take up to the
    // whole tool-call timeout to take effect. Cancelled calls still get a
    // tool_result — the API rejects an assistant tool_use with no matching
    // result — they just get one that says so instead of running.
    for (const tc of otherCalls) {
      if (this.signal?.aborted) {
        resultByToolId.set((tc as any).id as string, CANCELLED_TOOL_RESULT);
        continue;
      }
      await this.runRegularTool(tc, turn, resultByToolId);
    }

    // Run `task` tools concurrently, bounded.
    if (taskCalls.length) {
      const concurrency = Math.max(1, SUB_AGENT_MAX_CONCURRENT);
      for (let i = 0; i < taskCalls.length; i += concurrency) {
        const batch = taskCalls.slice(i, i + concurrency);
        if (this.signal?.aborted) {
          for (const tc of batch) {
            resultByToolId.set((tc as any).id as string, CANCELLED_TOOL_RESULT);
          }
          continue;
        }
        await Promise.all(batch.map((tc: any) => this.runTaskTool(tc, turn, resultByToolId)));
      }
    }

    // Build results in the model's emitted order so tool_result blocks line up.
    // Apply per-result truncation here (single chokepoint) so every tool's
    // contribution to the conversation history is bounded — see
    // truncateToolResult() docstring for rationale.
    const results: Array<Record<string, unknown>> = toolUses.map((tc: any) => ({
      type: "tool_result",
      tool_use_id: tc.id as string,
      content: truncateToolResult(resultByToolId.get(tc.id as string) ?? "(no result)"),
    }));

    await this.maybeRecoverSandbox(results);

    this.workingMessages.push({
      role: "assistant",
      content: truncateToolUseInputs(content) as any,
    });
    this.workingMessages.push({ role: "user", content: results as any });

    // Auto-compaction: when this turn's prompt crossed the trigger, compress
    // older messages to a summary so the next turn fits in the model context
    // window. Top-level loop only — sub-agents have their own short-lived
    // context and rarely need this. Best-effort: failure to compact falls back
    // to the original messages and the loop continues.
    //
    // Compared against promptTokens, not turnUsage.input_tokens. Anthropic
    // reports input_tokens as the UNCACHED REMAINDER: measured on the live
    // gateway, one prompt reads 10,960 without a cache marker and 6 with one.
    // This is the only context-size guard in Brain, and a context-window
    // rejection is a 400, which streamTurnWithRetry does not retry — so with
    // markers on and this reading input_tokens, a twelve-hour run would grow
    // unchecked to the 1M window and die there. The two must never ship apart.
    const promptTokens = this.promptTokensThisTurn;
    if (this.depth === 0 && promptTokens > COMPACTION_TRIGGER_INPUT_TOKENS) {
      const before = this.workingMessages.length;
      this.compactionRound++;
      const outcome = await compactConversation(this.session, this.workingMessages, this.sessionId, this.compactionRound, turn);
      const compacted = outcome.messages;
      // The status is reported, not inferred. Deriving it from array identity
      // cannot tell a summariser failure from "nothing to compact", which left
      // result="failed" a value no production line could ever emit.
      metrics.onCompaction(outcome.status);
      if (outcome.status === "compacted") {
        // The next turn legitimately cannot read: everything between the head
        // and the summary is gone, so the prefix it would have matched no
        // longer exists.
        // Not a one-turn flag: the entry is gone, so there is nothing to lose
        // until a new one is written. A boolean cleared after one turn left
        // the pre-compaction timestamp standing, and the SECOND miss after a
        // compaction was reported as an expired entry.
        this.lastCacheUseAt = undefined;
        // Say the clear out loud, here, before the await below. The caller is
        // told about cache USE on the same line it happens for the same
        // reason, and a clear is the half that matters more: the checkpoint
        // that would otherwise carry the pre-compaction timestamp already
        // exists, so a SIGTERM landing between this line and the checkpoint
        // call at the bottom of the turn would persist a timestamp for an
        // entry this compaction just destroyed -- and the resumed run would
        // measure a gap against it and report a loss that never happened.
        // Waiting for `onCheckpoint` to carry the news is a window, and it is
        // an `await onEvent` wide.
        this.opts.onCacheUse?.(undefined);
        this.workingMessages.length = 0;
        this.workingMessages.push(...compacted);
        await this.onEvent({
          type: "statusUpdate",
          agentStatus: "running",
          event: "context_compacted",
          compact_round: this.compactionRound,
          at_turn: turn,
          messages_before: before,
          messages_after: compacted.length,
          trigger_input_tokens: promptTokens,
        });
      } else {
        this.compactionRound--; // rollback if no-op
      }
    }

    // Track setup commands from bash tool calls in this turn.
    for (const tc of otherCalls) {
      const tn = (tc as any).name as string;
      const ti = (tc as any).input as Record<string, unknown>;
      const rt = resultByToolId.get((tc as any).id as string) ?? "";
      if (tn === "bash") {
        const cmd = String(ti.command ?? "");
        if (SETUP_CMD_RE.test(cmd) && !rt.startsWith("Error:")) {
          this.setupCommands.push({ cmd, turn });
        }
      }
    }

    // Checkpoint cadence (Plan Y v2, §5.4): per-turn writes by default
    // (CHECKPOINT_TURN_INTERVAL=1) plus a wall-clock fallback that only
    // fires at turn boundaries. The fallback exists purely as a safety
    // net if CHECKPOINT_TURN_INTERVAL is ever tuned above 1; it does NOT
    // preempt an in-progress tool call, so a 30-minute bash call still
    // checkpoints only when the next turn boundary is reached.
    //
    // turnsFromStart > 0 guards the very first iteration (turn==initialTurn,
    // delta 0): writing a checkpoint there would persist empty progress
    // and waste a KV slot per task launch.
    const turnsFromStart = turn + 1 - this.initialTurn;
    const elapsedSinceCkpt = Date.now() - this.lastCheckpointAt;
    const shouldCheckpoint =
      turnsFromStart > 0
      && !this.signal?.aborted
      && (
        turnsFromStart % CHECKPOINT_TURN_INTERVAL === 0
        || elapsedSinceCkpt > CHECKPOINT_MAX_WALL_GAP_MS
      );
    if (this.opts.onCheckpoint && shouldCheckpoint) {
      // lastCheckpointAt only advances on success. Advancing it unconditionally
      // made a failing checkpoint look like a fresh one, so the wall-clock
      // fallback stopped retrying and the run kept going with no durable state.
      try {
        await this.opts.onCheckpoint({
          // A snapshot, like every other field in this literal. workingMessages
          // is mutated in place -- compaction does `length = 0` then pushes the
          // replacement -- so handing over the live array lets the writer
          // serialize a conversation from after the counters beside it were
          // read. The deep copy the checkpoint redactor used to make hid this;
          // it does not run on this path any more.
          messages: this.workingMessages.slice(),
          last_cache_use_at: this.lastCacheUseAt,
          turns_completed: turn + 1,
          usage: { ...this.usage },
          text_parts: [...this.textParts],
          error_count: this.errorCount,
          tool_calls_by_name: { ...this.toolCallsByName },
          total_tool_calls: this.totalToolCalls,
          elapsed_ms_before: Date.now() - this.startTime,
          setup_commands: [...this.setupCommands],
          plan_mode: this.planMode,
          todo_state: [...this.todoState],
          rebuilds_used: this.rebuildsUsed,
          recoveries_used: this.recoveriesUsed,
        });
        this.lastCheckpointAt = Date.now();
      } catch (e) {
        logger.error({ err: e, sessionId: this.sessionId, turn },
          "checkpoint.write_failed");
      }
    }

    logger.info({
      turn, sessionId: this.sessionId,
      toolsInTurn: toolUses.length,
      inputTokens: this.usage.input_tokens,
      outputTokens: this.usage.output_tokens,
      totalToolCalls: this.totalToolCalls,
    }, "agent-loop.turn_done");

    return false;
  }

  /** One LLM streamTurn call with retry-with-backoff on transient errors. */
  private async streamTurnWithRetry(
    turn: number,
    turnStart: number,
  ): Promise<Awaited<ReturnType<LlmSession["streamTurn"]>>> {
    const STREAM_MAX_RETRIES = 3;
    // Backoff (ms) per attempt index. Jittered ±50% to spread reconnect storms
    // across concurrent agent loops in the same brain pod / cluster.
    const STREAM_BACKOFF_MS = [5_000, 15_000, 30_000];
    for (let attempt = 0; ; attempt++) {
      try {
        // Filter accumulated [system-notice]: messages before each
        // attempt (NP1-2). We rebuild on every retry because compaction
        // / sub-agent merges may add new ones between attempts. This
        // does NOT mutate workingMessages — KV stays a full audit trail.
        const llmMessages = filterResumeNotices(this.workingMessages);
        return await this.session.streamTurn(llmMessages, this.effectiveTools, this.signal);
      } catch (err: any) {
        let code = err?.code as string | undefined;
        const errMsg = err?.message || String(err);
        const isTruncated = code === "STREAM_TRUNCATED"
          || code === "TOOL_INPUT_EMPTY"
          || code === "TOOL_INPUT_PARSE_FAILED";
        const isTimeout = isTruncated || /abort|timeout/i.test(errMsg);
        // LiteLLM wraps upstream LLM connect failures (httpx ConnectError /
        // "All connection attempts failed") as auth_error 401 — Anthropic SDK
        // surfaces them as AuthenticationError which the previous retry guard
        // treated as fatal. Reclassify these (plus 5xx gateway errors) as
        // transient so the user task survives short upstream outages.
        const isUpstreamFlaky = isUpstreamConnectError(err);
        const isDrop = isMidStreamDrop(err);
        const isOverload = isOverloaded(err);
        if (isUpstreamFlaky && !code) code = "UPSTREAM_CONNECT_FAILED";
        if (isDrop && !code) code = "MID_STREAM_DROP";
        if (isOverload && !code) code = "UPSTREAM_OVERLOADED";
        const canRetry = (isTimeout || isUpstreamFlaky || isDrop || isOverload)
          && attempt < STREAM_MAX_RETRIES
          && !this.signal?.aborted;
        logger.error(
          { err: errMsg, code, turn, sessionId: this.sessionId, attempt, canRetry,
            upstreamConnectFailed: isUpstreamFlaky, midStreamDrop: isDrop,
            upstreamOverloaded: isOverload,
            elapsedMs: Date.now() - turnStart },
          "agent-loop.stream.failed",
        );
        if (!canRetry) throw err;
        const base = STREAM_BACKOFF_MS[Math.min(attempt, STREAM_BACKOFF_MS.length - 1)];
        const delay = Math.max(500, base + Math.floor((Math.random() - 0.5) * base));
        logger.info({ turn, sessionId: this.sessionId, attempt: attempt + 1, maxRetries: STREAM_MAX_RETRIES, code, delayMs: delay }, "agent-loop.stream.retry");
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async runRegularTool(
    tc: any,
    turn: number,
    resultByToolId: Map<string, string>,
  ): Promise<void> {
      const toolName = tc.name as string;
      const toolId = tc.id as string;
      const toolInput = tc.input as Record<string, unknown>;

      // Log the tool call input, redacted and truncated to keep logs readable.
      // Inputs routinely carry credentials: a `write` of a config file, or a
      // `bash` command with a token on its argument list.
      const logInput: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(toolInput)) {
        logInput[k] = typeof v === "string" ? safePreview(v, 300) : v;
      }
    logger.info({ turn, sessionId: this.sessionId, toolName, input: logInput }, "tool.call");

      // Emit `start` synchronously with full argumentsDetail. The web client's
      // event reducer only creates the tool card on
      // status="start" and does NOT read argumentsDetail on the terminal
      // event, so args MUST be on the start event for the spinner UX to
      // show the command. The previous lazy-start optimisation was reverted
      // because it dropped short-tool cards entirely (success-only path
      // had no matching entry to update). Total bytes still drop ~60% vs
      // the pre-optimisation baseline because the terminal event no longer
      // re-sends argumentsDetail (only `description` carrying the result).
    await this.onEvent({
        type: "toolUsed", tool: toolName, actionId: toolId, status: "start",
        argumentsDetail: { [toolName]: toolInput },
      });
    this.totalToolCalls++;
    this.toolCallsByName[toolName] = (this.toolCallsByName[toolName] || 0) + 1;

      // PreToolUse: plugin hooks may block the call, edit input, or no-op.
      let finalInput = toolInput;
    if (this.opts.hooks?.has("PreToolUse")) {
      const decision = await this.opts.hooks.run("PreToolUse", {
          tool_name: toolName,
          tool_input: toolInput,
        });
        if (decision.block) {
          const reason = decision.reason || "blocked by PreToolUse hook";
        await this.onEvent({ type: "toolUsed", tool: toolName, actionId: toolId, status: "error", description: reason });
          resultByToolId.set(toolId, `Error: ${reason}`);
          return;
        }
        if (decision.updatedInput) finalInput = decision.updatedInput;
      }

      // HITL: user approval (after hooks, before routing)
    if (this.opts.hitl) {
      const decide = () => this.opts.hitl!.beforeToolUse({
        sessionId: this.sessionId ?? "", userId: this.userId, actionId: toolId,
        tool: toolName, input: finalInput, signal: this.signal,
      });
      // Waiting on a person, which is the longest wait a run has and the one
      // least related to how much work it is doing -- but only when there is
      // actually a person to wait for. Approval is off by default and most
      // tools are auto-allowed when it is on, and that path returns without
      // awaiting anything: parking around it would hand the slot back and take
      // it again on every tool call, admitting a run each time until the
      // resident ceiling stopped it.
      const hitlResult = this.opts.hitl.willAsk(toolName)
        ? await whileWaiting(this.opts.runKey, "approval", decide)
        : await decide();
        if (hitlResult.action === "deny" || hitlResult.action === "skip") {
          const reason = `Error: ${hitlResult.reason}`;
        await this.onEvent({ type: "toolUsed", tool: toolName, actionId: toolId, status: "error", description: reason });
          resultByToolId.set(toolId, reason);
          return;
        }
        if (hitlResult.action === "allow") finalInput = hitlResult.input;
      }

      // ── Loop-intercepted tools (§4.5) — handled before router.route() ──
      if (toolName === "todo_write") {
        if (!TODO_WRITE_ENABLED) {
          resultByToolId.set(toolId, "Error: todo_write disabled");
          return;
        }
        const todos = (finalInput.todos as TodoItem[]) ?? [];

        // V1 compat: auto-assign id when missing (V1 TodoWrite schema has no id field)
        let autoIdx = 0;
        for (const t of todos) {
        if (!t.id) t.id = `todo-${this.todoCallSeq}-${autoIdx++}`;
        }

        if (!finalInput.merge && todos.some((t) => !t.content || !t.status)) {
          const errMsg = "Error: when merge=false, every todo item must include content and status.";
        await this.onEvent({ type: "toolUsed", tool: toolName, actionId: toolId, status: "error", description: errMsg });
          resultByToolId.set(toolId, errMsg);
          return;
        }
      if (finalInput.merge && todos.some((t) => !this.todoState.some((e) => e.id === t.id) && (!t.content || !t.status))) {
          const errMsg = "Error: when merge=true, new todo items must include content and status.";
        await this.onEvent({ type: "toolUsed", tool: toolName, actionId: toolId, status: "error", description: errMsg });
          resultByToolId.set(toolId, errMsg);
          return;
        }
      this.todoCallSeq++;
      this.todoState = finalInput.merge ? mergeTodos(this.todoState, todos) : todos;

      const eventTodos = this.todoState;
        const allDone = eventTodos.length > 0
          && eventTodos.every((t) => t.status === "completed" || t.status === "cancelled");
      if (allDone) this.todoState = [];

        const resultMsg = "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable.";
      await this.onEvent({
          type: "toolUsed", tool: toolName, actionId: toolId, status: "success",
          argumentsDetail: { todo_write: { todos: eventTodos } },
          description: `${eventTodos.length} todos updated`,
        });
      logger.info({ turn, sessionId: this.sessionId, toolName, resultLen: resultMsg.length, resultPreview: `${eventTodos.length} todos updated` }, "tool.result");
        resultByToolId.set(toolId, resultMsg);
        return;
      }

      // exit_plan_mode intercept (§5.7)
      if (toolName === "exit_plan_mode") {
        if (!EXIT_PLAN_MODE_ENABLED) {
          resultByToolId.set(toolId, "Error: exit_plan_mode disabled");
          return;
        }
      if (!this.planMode) {
          const errMsg = "You are not in plan mode. This tool is only for exiting plan mode after writing a plan.";
        await this.onEvent({ type: "toolUsed", tool: toolName, actionId: toolId, status: "error", description: errMsg });
          resultByToolId.set(toolId, errMsg);
          return;
        }
      this.planMode = false;
        const resultMsg = "Plan accepted. Write tools now available.";
      await this.onEvent({
          type: "toolUsed", tool: toolName, actionId: toolId, status: "success",
          description: resultMsg, full_output: ((finalInput.plan as string) ?? "").slice(0, 2000),
        });
      logger.info({ turn, sessionId: this.sessionId, toolName, resultLen: resultMsg.length, resultPreview: resultMsg }, "tool.result");
        resultByToolId.set(toolId, resultMsg);
        return;
      }

      // ask_user_question intercept (§5.9) — suspends on NATS answer
      if (toolName === "ask_user_question") {
        if (!ASK_USER_QUESTION_ENABLED) {
          resultByToolId.set(toolId, "Error: ask_user_question disabled");
          return;
        }
      if (!this.opts.questionDispatcher) {
          const errMsg = "Error: ask_user_question is not available (dispatcher not configured)";
        await this.onEvent({ type: "toolUsed", tool: toolName, actionId: toolId, status: "error", description: errMsg });
          resultByToolId.set(toolId, errMsg);
          return;
        }
      await this.onEvent({
          type: "userQuestion",
          actionId: toolId,
          questions: finalInput.questions,
          ts: Date.now(),
        });
        try {
        const answer = await this.opts.questionDispatcher.register({
            actionId: toolId, type: "answer",
            timeoutMs: ASK_USER_QUESTION_TIMEOUT_MS,
          signal: this.signal,
          });
          const resultMsg = answer ? JSON.stringify(answer.answers ?? {}) : "No answer received";
        await this.onEvent({ type: "toolUsed", tool: toolName, actionId: toolId, status: "success", description: resultMsg.slice(0, 200) });
        logger.info({ turn, sessionId: this.sessionId, toolName, resultLen: resultMsg.length, resultPreview: safePreview(resultMsg, 200) }, "tool.result");
          resultByToolId.set(toolId, resultMsg);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ toolId, err: msg }, "ask_user_question.failed");
          const errMsg = `Error: question ${msg.includes("timeout") ? "timed out" : "was aborted"} — ${msg}`;
        await this.onEvent({ type: "toolUsed", tool: toolName, actionId: toolId, status: "error", description: errMsg });
          resultByToolId.set(toolId, errMsg);
        }
        return;
      }

      const toolStart = Date.now();
      let resultText: string;
      try {
      // `wait` blocks on a background command finishing, which is the run
      // sitting still rather than working -- the case the whole waiting/
      // executing split exists to measure.
      resultText = WAITING_TOOLS.has(toolName)
        ? await whileWaiting(this.opts.runKey, "background_command", () =>
            this.router.route(toolName, finalInput, this.signal))
        : await this.router.route(toolName, finalInput, this.signal);
        // A sandbox tool that answered is the only evidence the sandbox is up,
        // so it is the only thing that clears the count -- even if the result
        // text describes a business-level failure (exit != 0), which still came
        // back from the sandbox. A `web_search` or an `mcp__*` tool says nothing
        // about it, and clearing on those is how a dead sandbox interleaved with
        // browsing never reached the threshold the increments count towards.
        // It also clears the recovery budget, which is what keeps that budget a
        // bound on repetition without progress rather than a cap on how many
        // blips a long run is allowed: a repair followed by a tool call that
        // worked is a repair that did its job.
      if (isSandboxTool(toolName)) {
        this.consecutiveSandboxErrors = 0;
        this.recoveriesUsed = 0;
        // The latch stands for a budget, so it cannot outlive one. A sandbox
        // call that worked is the evidence that resets the budget above; if the
        // refusal were kept, the next failure would be turned away quoting a
        // budget that is no longer spent.
        this.recoveryRefusal = null;
      }
        logger.info(
          {
          turn, sessionId: this.sessionId, toolName,
            elapsedMs: Date.now() - toolStart,
            resultLen: resultText.length,
            // Tool output is the widest exposure of the four: this is the text
            // of whatever the agent just read, ran or searched.
            resultPreview: safePreview(resultText, 500),
          },
          "tool.result",
        );
      } catch (err: any) {
        // Both the name and the arguments as sent, because the deadline the
        // message reports is built from the two together: the tool decides the
        // ceiling a timeout argument is clamped to, and whether any of this is
        // about a sandbox at all.
        resultText = explainHandsError(err, toolName, finalInput);
      this.errorCount++;
      logger.warn({ err: err.message, toolName, sessionId: this.sessionId, elapsedMs: Date.now() - toolStart }, "tool.error");
        // Narrowed for the reason the counter below is: a `sandboxStatus` event
        // about an external MCP server that timed out describes the sandbox to
        // everyone reading it, and the sandbox was not involved.
        if (isSandboxTool(toolName) && isHandsToolTimeout(err)) {
        await this.emitSandboxStatus(
            "tool_timeout",
            {
              tool: toolName,
              reason: "-32001",
              message: String((err as any)?.message || err).slice(0, 300),
            },
            5_000,
          );
        }
        await this.noteSandboxNetworkError(err, toolName);
      }
      // PostToolUse: observe-only for now. Decision output is evaluated so
      // hooks can still surface a systemMessage to the UI; a block here does
      // not rewrite the tool_result (the LLM already paid for the call).
    if (this.opts.hooks?.has("PostToolUse")) {
      await this.opts.hooks.run("PostToolUse", {
          tool_name: toolName,
          tool_input: finalInput,
          tool_response: resultText,
        });
      }

      // Terminal event: result only. argumentsDetail was already sent on
      // `start` (above); not re-sending it halves bytes vs always-double
      // serialising args without breaking the frontend reducer (which
      // matches by actionId and updates description on success/error).
    await this.onEvent({
        type: "toolUsed", tool: toolName, actionId: toolId, status: "success",
        description: resultText.slice(0, 2000),
      });
      resultByToolId.set(toolId, resultText);
  }

  private async runTaskTool(
    tc: any,
    turn: number,
    resultByToolId: Map<string, string>,
  ): Promise<void> {
      const toolId = tc.id as string;
      const toolInput = (tc.input || {}) as Record<string, unknown>;
      const subagentId = `sub-${randomUUID().slice(0, 8)}`;
      const subagentType: SubagentType = (SUBAGENT_TYPES as readonly string[]).includes(toolInput.subagent_type as string)
        ? (toolInput.subagent_type as SubagentType)
        : "generalPurpose";

      // Skill-read sub-agent guard. Opus persistently wraps multi-file
      // `read`s of skill content in explore sub-agents which (a) adds 4-7
      // wasted LLM turns each, (b) truncates the merged final_text forcing
      // re-dispatches. Validated regression: session 37dbaecd took 14 min
      // reading skill via 11 explore sub-agents vs ~2 min direct.
      if (BRAIN_BLOCK_SKILL_SUBAGENTS) {
        const promptText = String((toolInput.prompt as string) || "")
          + " " + String((toolInput.description as string) || "");
        const skillPathHits = (promptText.match(
          /\/\.skills\/|(?:^|[\s`"'/])SKILL\.md\b|\/actions\/[a-z_\-]+\.md|\/kernel-opt\/[a-z_\-]+\.md|\/modes\/[A-Za-z]+\.md/g,
        ) || []).length;
        const readVerb = /\b(read|cat|contents?|full contents?|simultaneously|in parallel)\b/i.test(promptText);
        if (skillPathHits >= 2 && readVerb) {
          const errMsg = `Error: do not dispatch sub-agents to read skill files (${skillPathHits} skill paths detected in prompt). Use the \`read\` tool directly — one call per file, no truncation, no overhead. See SKILL.md "How to Read This Skill". To override per-deployment set BRAIN_BLOCK_SKILL_SUBAGENTS=false.`;
        await this.onEvent({
            type: "toolUsed", tool: "task", actionId: toolId, status: "error",
            argumentsDetail: { task: { description: toolInput.description, subagent_type: subagentType, subagent_id: subagentId } },
            description: errMsg,
          });
        this.totalToolCalls++;
        this.toolCallsByName["task"] = (this.toolCallsByName["task"] || 0) + 1;
          logger.warn(
          { sessionId: this.sessionId, subagentId, subagentType, skillPathHits, promptPreview: safePreview(promptText, 200) },
            "task.blocked_skill_read",
          );
          resultByToolId.set(toolId, errMsg);
          return;
        }
      }

    await this.onEvent({
        type: "toolUsed", tool: "task", actionId: toolId, status: "start",
        argumentsDetail: { task: { description: toolInput.description, subagent_type: subagentType, subagent_id: subagentId } },
      });
    this.totalToolCalls++;
    this.toolCallsByName["task"] = (this.toolCallsByName["task"] || 0) + 1;

      let resultText: string;
      try {
      if (this.depth >= SUB_AGENT_MAX_DEPTH) {
        throw new Error(`sub-agent nesting limit reached (depth=${this.depth}, max=${SUB_AGENT_MAX_DEPTH})`);
        }
      // A sub-agent gets its own router around the same sandbox, so the run
      // has to have one by now even if this turn's parent never used a tool.
      const subHands = this.opts.hands ?? await this.opts.attachHands?.();
      if (!subHands) {
          throw new Error("sub-agent requires HandsClient in LoopOptions");
        }
      this.opts.hands = subHands;
        const sub = await runSubagent({
          subagentId,
          description: String(toolInput.description || ""),
          prompt: String(toolInput.prompt || ""),
          subagentType,
          allowedTools: Array.isArray(toolInput.tools) ? (toolInput.tools as string[]) : undefined,
        parentSchemas: this.tools,
        hands: subHands,
        platformMcpClients: this.opts.platformMcpClients,
          // Register sub's router as a child of the parent's so an in-flight
          // sandbox rebuild also swaps the sub's HandsClient transparently.
        parentRouter: this.router,
        onEvent: this.onEvent,
        signal: this.signal,
        model: this.model, apiUrl: this.apiUrl, apiKey: this.apiKey,
        maxTurns: SUB_AGENT_MAX_TURNS > 0 ? SUB_AGENT_MAX_TURNS : this.maxTurns,
        userId: this.userId, sessionId: this.sessionId,
        depth: this.depth + 1,
        hooks: this.opts.hooks,
        webToolServices: this.router.getWebToolServices?.(),
        });
        resultText = sub.finalText || "(sub-agent produced no final text)";
      } catch (err: any) {
        resultText = `Error: ${err?.message || String(err)}`;
      this.errorCount++;
      logger.warn({ err, subagentId, depth: this.depth, sessionId: this.sessionId }, "sub-agent.failed");
      }

    await this.onEvent({
        type: "toolUsed", tool: "task", actionId: toolId, status: "success",
        description: resultText.slice(0, 2000),
      });
      resultByToolId.set(toolId, resultText);
  }
}

/**
 * Generic agent loop: LLM call → tool_use → route to Hands/MCP → tool_result → repeat.
 * All state is local (per-request safe for multi-user Brain).
 */
export async function agentLoop(
  messages: Message[],
  tools: ToolSchema[],
  opts: LoopOptions,
): Promise<LoopResult> {
  return new AgentLoopRunner(messages, tools, opts).run();
}
