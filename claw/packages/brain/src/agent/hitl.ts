// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * HitlController — Human-In-The-Loop approval for tool calls.
 * Disabled by default (HITL_ENABLED=false); when off, all calls auto-allow,
 * except tools a per-server policy (approval-policy.ts) marks as requiring
 * approval: those are always held for a person, and fail closed (denied) when
 * no one answers or there is no channel to ask on. The one thing that lifts such
 * a hold is the same policy's explicit `auto_approve` allowlist: a call it lists
 * runs without a decision and is recorded as `by: "policy"`.
 */

import {
  HITL_ENABLED,
  HITL_AUTO_ALLOW,
  HITL_DECISION_TIMEOUT_MS,
  HITL_DECISION_DEFAULT,
} from "../config.js";
import type { DecisionDispatcher, NatsDecisionMessage } from "../delivery/decision-dispatcher.js";
import type { EventCallback } from "@claw/protocol";
import pino from "pino";
import { explainApproval, type ApprovalExplainContext } from "./approval-explain.js";
import { metrics } from "../infra/metrics.js";

const logger = pino({ name: "hitl" });

/** Why a call was refused; the model-facing text is built from it, see `refusalMessage`. */
export type HitlRefusal = "denied" | "skipped" | "timeout" | "no_channel" | "aborted";

export type HitlResult =
  | { action: "allow"; input: Record<string, unknown>; by: "auto_allow" | "user" | "timeout" | "policy" }
  | { action: "deny" | "skip"; reason: string; by: "user" | "timeout"; cause?: HitlRefusal };

/**
 * The tool result the model sees when a held call was not run, for MCP tools
 * and bash alike. It says plainly that the action did NOT happen and why, so
 * the model reports a refusal as a refusal and not as an API failure. A note
 * the user typed is appended; the bare default reasons are not repeated.
 */
export function refusalMessage(r: { reason?: string; cause?: HitlRefusal }): string {
  const note = r.reason && !/^(denied by user|skipped by user)$/.test(r.reason) ? r.reason : "";
  switch (r.cause) {
    case "timeout":
      return "No decision was received in time; this action was not executed. Tell the user it was not done because nobody approved it in time.";
    case "no_channel":
      return "No approval channel is available, so this action required approval and was not executed. Tell the user it was not done.";
    case "aborted":
      return "The run was aborted while waiting for approval; this action was not executed.";
    case "skipped":
      return "The user skipped this action; it was not executed. Tell the user it was not done because they skipped it."
        + (note ? ` User's note: ${note}` : "");
    case "denied":
      return "The user denied this action; it was not executed. Tell the user it was not done because they denied it."
        + (note ? ` User's note: ${note}` : "");
    default:
      // A refusal with no recorded cause (an older controller): still not a run.
      return `This action was not executed: ${r.reason || "refused"}. Tell the user it was not done.`;
  }
}

export interface HitlRequest {
  sessionId: string;
  userId?: string;
  actionId: string;
  tool: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * What the loop knows that helps a person read the request (the tool's
   * description, what the agent said, a way to ask the model for a summary).
   * Explanation only: it is added to the permissionRequest and decides nothing.
   */
  explain?: ApprovalExplainContext;
}

export interface HitlOptions {
  /** Tools that must be approved regardless of HITL_ENABLED / HITL_AUTO_ALLOW. */
  requireApproval?: (tool: string) => boolean;
  /**
   * Per-call form, for tools whose input decides it (bash). Returns a label
   * when this call must be approved, else null. Same semantics as
   * `requireApproval`: always asked, never remembered, denied on no answer.
   */
  requireApprovalFor?: (tool: string, input: Record<string, unknown>) => string | null;
  /**
   * Of the calls `requireApproval` holds, the allowlist entry (an explicit
   * `auto_approve`) that lets one run without a decision, or null. Consulted only
   * for a call `requireApproval` holds and `requireApprovalFor` does not; it
   * cannot release anything else, and anything but a non-empty string releases
   * nothing. The entry may come from the request, so it goes in the log line and
   * never labels a metric.
   */
  autoApprovalRule?: (tool: string, input: Record<string, unknown>) => string | null;
}

export class HitlController {
  private autoAllowSet: Set<string>;
  private alwaysAllow = new Set<string>();

  constructor(
    private dispatcher: DecisionDispatcher | null,
    private onEvent: EventCallback,
    private opts: HitlOptions = {},
  ) {
    this.autoAllowSet = new Set(
      HITL_AUTO_ALLOW.split(",").map((s) => s.trim()).filter(Boolean),
    );
  }

  /**
   * Whether a decision on this tool will have to wait for a person.
   *
   * Asked by the caller before it decides whether this is a wait worth handing
   * the pod's execution slot back for. The alternative -- treating every tool
   * call as a possible wait -- parks and resumes around the auto-allow path
   * that returns without awaiting anything, which on a busy pod is a run
   * admitted per tool call until the resident ceiling stops it.
   *
   * The same question `beforeToolUse` asks itself, so the two cannot drift.
   */
  willAsk(tool: string, input?: Record<string, unknown>): boolean {
    return this.assess(tool, input).ask;
  }

  private holdLabel(tool: string, input?: Record<string, unknown>): string | null {
    return this.opts.requireApprovalFor?.(tool, input ?? {}) ?? null;
  }

  /**
   * Everything the controller decides about one call, read from the policy
   * once: `willAsk` and `beforeToolUse` both answer from this, so they cannot
   * drift.
   *
   * - `label`: the per-call hold (a bash rule), if any.
   * - `must`: a policy holds the call, so it is always asked and never remembered.
   * - `rule`: the allowlist entry that releases a server-level hold, else null.
   *   Only the server-level `requires_approval` hold can be released: a per-call
   *   hold is never lifted here, and a tool nothing holds is not "approved" by
   *   this, it simply follows the ordinary HITL settings.
   * - `ask`: a person has to be waited for. A released call waits for nobody,
   *   whether or not there is anyone to ask; without a dispatcher there is
   *   nobody to wait for.
   */
  private assess(tool: string, input?: Record<string, unknown>) {
    const label = this.holdLabel(tool, input);
    const held = this.opts.requireApproval?.(tool) === true;
    const must = label !== null || held;
    const entry = held && label === null ? this.opts.autoApprovalRule?.(tool, input ?? {}) : null;
    const rule = typeof entry === "string" && entry !== "" ? entry : null;
    const ask = rule === null && this.dispatcher !== null
      && (must || (HITL_ENABLED && !this.autoAllowSet.has(tool) && !this.alwaysAllow.has(tool)));
    return { label, must, rule, ask };
  }

  async beforeToolUse(req: HitlRequest): Promise<HitlResult> {
    const { label, must, rule, ask } = this.assess(req.tool, req.input);
    if (rule !== null) {
      // The operator's explicit allowlist, not a person's decision: no card, no
      // wait, and the record says so. The entry is free text a request may have
      // supplied, so it is logged and never made a metric label (a label per
      // entry would be a series per request).
      const result: HitlResult = { action: "allow", input: req.input, by: "policy" };
      metrics.onHitlPolicyAllow();
      logger.info({ tool: req.tool, rule, sessionId: req.sessionId }, "hitl.policy_allow");
      await this.emitDecisionResult(req.actionId, result);
      return result;
    }
    if (!this.dispatcher && must) {
      // Nobody could answer, and the policy says a person must. Not an allow.
      return { action: "deny", reason: "approval required but no approval channel is available", by: "timeout", cause: "no_channel" };
    }
    if (!ask) {
      return { action: "allow", input: req.input, by: "auto_allow" };
    }

    // Non-null by the guard above: `ask` is false when there is no dispatcher,
    // because there is then nobody who could answer.
    const dispatcher = this.dispatcher!;
    // Words for the person who has to decide, within a fixed budget. It runs BEFORE the
    // decision window opens: nobody can answer a request that has not been shown, so
    // the time it takes must not be taken from the person's time (with a short
    // HITL_DECISION_TIMEOUT_MS and the default "allow" on timeout, it would otherwise
    // expire before anyone was asked). It never throws; without it the request below
    // is exactly what it was.
    const explained = await explainApproval(req.tool, req.input, req.explain, { signal: req.signal });
    // register() only hears an abort that happens after it, so one that came during
    // the explanation is answered here, the way the abort path answers it.
    if (req.signal?.aborted) return { action: "deny", reason: "aborted", by: "timeout", cause: "aborted" };
    // Registered before the request is shown: an answer that arrives first
    // would otherwise find nothing pending and be dropped.
    const pending = dispatcher.register({
      actionId: req.actionId,
      type: "decision",
      timeoutMs: HITL_DECISION_TIMEOUT_MS,
      signal: req.signal,
    });
    pending.catch(() => { /* consumed below; this only keeps an early failure from being unhandled */ });

    try {
      await this.onEvent({
        type: "permissionRequest",
        ...explained,
        actionId: req.actionId,
        // The web client keys on tool_use_id (same value as actionId).
        tool_use_id: req.actionId,
        tool: req.tool,
        input: req.input,
        description: `${label ? `[${label}] ` : ""}${req.tool}: ${JSON.stringify(req.input).slice(0, 200)}`,
        ...(label ? { approval_label: label } : {}),
        timeout_ms: HITL_DECISION_TIMEOUT_MS,
        ts: Date.now(),
      });
    } catch (err) {
      dispatcher.deregister(req.actionId, "decision");
      throw err;
    }

    let msg: NatsDecisionMessage;
    try {
      msg = await pending;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === "decision_timeout") {
        // A mandatory approval never times out into an allow.
        const result: HitlResult = HITL_DECISION_DEFAULT === "deny" || must
          ? { action: "deny", reason: "timed out waiting for approval", by: "timeout", cause: "timeout" }
          : { action: "allow", input: req.input, by: "timeout" };
        await this.emitDecisionResult(req.actionId, result);
        return result;
      }
      if (errMsg === "decision_aborted") {
        return { action: "deny", reason: "aborted", by: "timeout", cause: "aborted" };
      }
      throw err;
    }

    const result = this.normalizeDecision(msg, req.input);

    // Handle "remember" for session-scoped always_allow
    if (msg.remember && result.action === "allow" && !must) {
      this.alwaysAllow.add(req.tool);
      logger.info({ tool: req.tool, sessionId: req.sessionId }, "hitl.always_allow_set");
    }

    await this.emitDecisionResult(req.actionId, result);
    return result;
  }

  private normalizeDecision(
    msg: NatsDecisionMessage,
    originalInput: Record<string, unknown>,
  ): HitlResult {
    switch (msg.decision) {
      case "allow":
        return { action: "allow", input: originalInput, by: "user" };
      case "edit":
        return {
          action: "allow",
          input: msg.edited_input ?? originalInput,
          by: "user",
        };
      case "deny":
        return { action: "deny", reason: msg.feedback ?? "denied by user", by: "user", cause: "denied" };
      case "skip":
        return { action: "deny", reason: msg.feedback ?? "skipped by user", by: "user", cause: "skipped" };
      default:
        logger.warn({ decision: msg.decision }, "hitl.unknown_decision_denied");
        return { action: "deny", reason: `unknown decision: ${msg.decision}`, by: "user", cause: "denied" };
    }
  }

  private async emitDecisionResult(actionId: string, result: HitlResult): Promise<void> {
    await this.onEvent({
      type: "decisionResult",
      actionId,
      tool_use_id: actionId,
      decision: result.action,
      action: result.action,
      by: result.by,
      ...(result.action === "deny" || result.action === "skip"
        ? { feedback: result.reason }
        : {}),
      ts: Date.now(),
    });
  }
}
