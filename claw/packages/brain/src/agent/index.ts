// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { ExecuteRequest, ExecuteResult, EventCallback, TokenUsage, Message } from "@claw/protocol";
import type { HandsClient } from "../clients/hands.js";
import pino from "pino";

const logger = pino({ name: "engine" });

/** Snapshot of agent-loop execution state, persisted to NATS KV for
 *  cross-Brain resume after SIGTERM or sandbox rebuild.
 *
 *  The three fields below `setup_commands` are optional on purpose: payloads
 *  written before they existed are still schema-version 3 and must stay
 *  readable, so a reader that finds them absent falls back to the pre-existing
 *  behaviour rather than rejecting the checkpoint. New writers always set them.
 */
export interface CheckpointState {
  messages: Message[];
  turns_completed: number;
  usage: TokenUsage;
  text_parts: string[];
  error_count: number;
  tool_calls_by_name: Record<string, number>;
  total_tool_calls: number;
  elapsed_ms_before: number;
  setup_commands: Array<{ cmd: string; turn: number }>;
  /** Plan-mode latch. Absent means "unknown" — resume then falls back to the
   *  request parameter, which is what the loop did before this was persisted.
   *  Restoring it matters for authorization, not just fidelity: plan mode
   *  confines the loop to a read-only tool whitelist until the user approves
   *  via exit_plan_mode, so rebuilding it from the request either re-locks an
   *  approved run or unlocks write tools on a run that was never approved. */
  plan_mode?: boolean;
  /** Structural shape of agent-loop's TodoItem, inlined to keep this module
   *  free of a dependency on the loop. */
  todo_state?: Array<{ id: string; content?: string; status?: string }>;
  /**
   * When this run last USED the prompt cache -- read or write -- as an epoch ms.
   *
   * Both, because both prove an entry exists to lose, and a write is the only
   * proof the first time round: the turn that creates an entry reads nothing.
   * Recording reads alone would leave a run that wrote once and then missed
   * looking exactly like a cold start, which is the case the counter is for.
   * A read refreshes the entry's lifetime, so it moves the timestamp too.
   *
   * Persisted because the cache-loss detector needs to tell "we wrote
   * something and then could not read it" from "there was never an entry", and
   * that fact does not survive a redelivery on its own. Inferring it from
   * `turns_completed > 0` is what this replaces: a resumed run that compacted,
   * or one whose markers were refused before the interruption, has a high turn
   * count and no entry, and got counted as a loss.
   *
   * Absent on a checkpoint written before this field existed, and absent after
   * a compaction, which drops the entry deliberately. Both mean the same thing
   * to the reader -- no evidence an entry exists -- and it under-reports rather
   * than invents a loss.
   */
  last_cache_use_at?: number;
  /** Sandbox rebuilds already spent. Without it the per-task rebuild budget
   *  resets on every resume, so the infinite-rebuild guard stops holding. */
  rebuilds_used?: number;
  /** Recoveries already spent that did not replace the sandbox. Carried for the
   *  same reason as `rebuilds_used`: a run that resumes with this reset can
   *  repair-without-progress indefinitely, one resume at a time. */
  recoveries_used?: number;
}

/**
 * What was done to make the sandbox usable again.
 *
 * This was a `rebuilt: boolean`, which could only say "replaced" or "not
 * replaced" -- and "not replaced" was doing the work of three very different
 * outcomes: the transport was renewed and the sandbox is fine, the Hands
 * process was restarted inside a container that stayed up, and nothing at all
 * could be established so nothing was touched. Only the last of those leaves
 * the run in the same state it was in, and it is the one that must not be
 * retried without limit.
 *
 *   rebuilt         — the workload was destroyed and replaced; /workspace was
 *                     restored, and anything running in the old container is
 *                     gone.
 *   reconnected     — container and Hands both answered, so only Brain's MCP
 *                     client was stale. Nothing in the sandbox was disturbed.
 *   hands_restarted — the container was alive but its Hands server was not, so
 *                     Hands was started again in place. Background processes
 *                     and GPU work in that container survived.
 *   left_alone      — nothing could be established, so nothing was destroyed.
 *                     The run is no better off than before the attempt.
 */
export type HandsRecoveryAction =
  | "rebuilt"
  | "reconnected"
  | "hands_restarted"
  | "left_alone";

/** Result of an in-flight sandbox recovery attempt. */
export interface RecreateHandsResult {
  hands: HandsClient;
  action: HandsRecoveryAction;
  /** Short machine-ish phrase naming the evidence, for logs and the notice. */
  detail?: string;
}

export interface HandsRecoveryAllowance {
  rebuild: boolean;
  nondestructive: boolean;
}

export class HandsRecoveryBudgetExhausted extends Error {
  constructor(readonly kind: "rebuild" | "recovery") {
    super(`sandbox ${kind} budget exhausted`);
    this.name = "HandsRecoveryBudgetExhausted";
  }
}

/**
 * A rebuild that was entered and did not finish.
 *
 * The budget the loop keeps is per *attempt*, not per success: a destroy that
 * lands and a provision that then fails has spent the sandbox and has to count,
 * or the loop re-enters the same rebuild on every later batch and destroys a
 * workload each time round. Only the recovery itself knows which repair it
 * committed to -- the probe decides that, after the loop has already handed
 * over -- so the attempt is named here and read back in the catch.
 *
 * Thrown only once the recovery is past the point where it can still choose a
 * non-destructive repair; everything before that reaches the loop unwrapped and
 * is charged to the non-destructive budget as before.
 */
/**
 * The recovery cannot help this run, and no later attempt will change that.
 *
 * Distinct from HandsRecoveryBudgetExhausted, which says "not right now, this
 * budget is spent" -- a different budget may still apply, and the container the
 * probe called dead can come back. This one is a property of the run: a DAG node
 * that inherited its sandbox may never rebuild it, however much budget is left
 * and whatever the probe says next. The loop latches this and stops asking.
 */
export class HandsRecoveryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandsRecoveryRefused";
  }
}

export class HandsRebuildFailed extends Error {
  constructor(readonly cause: unknown) {
    super((cause as Error)?.message || String(cause));
    this.name = "HandsRebuildFailed";
  }
}

/** Optional cross-cutting extras Brain supplies to engines. Wrapped in an
 *  interface so adding more never breaks the per-engine signature. */
export interface ExecuteExtras {
  recreateHands?: (
    allowance?: HandsRecoveryAllowance,
  ) => Promise<HandsClient | RecreateHandsResult>;
  /** Called after each complete turn to persist execution state. */
  onCheckpoint?: (state: CheckpointState) => Promise<void>;
  /** Called when a turn uses the prefix cache, so a SIGTERM mid-tool-batch can
   *  persist a fresher last_cache_use_at than the last turn boundary wrote. */
  onCacheUse?: (at: number) => void;
  /** If present, resume from this checkpoint instead of starting fresh. */
  resumeCheckpoint?: CheckpointState;
  /**
   * Opens a sandbox for a run that started without one. Required whenever
   * `hands` is absent; the engine calls it the first time the run needs to
   * reach /workspace, and never for a turn the model answers on its own.
   */
  attachHands?: () => Promise<HandsClient>;
}

export interface Engine {
  execute(
    request: ExecuteRequest,
    onEvent: EventCallback,
    signal?: AbortSignal,
    hands?: HandsClient | null,
    extras?: ExecuteExtras,
  ): Promise<ExecuteResult>;
}

export async function createEngine(): Promise<Engine> {
  logger.info("engine.create");
  const { AgentEngine } = await import("./engine.js");
  return new AgentEngine();
}
