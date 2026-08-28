// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * HitlController — Human-In-The-Loop approval for tool calls.
 * Disabled by default (HITL_ENABLED=false); when off, all calls auto-allow.
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

const logger = pino({ name: "hitl" });

export type HitlResult =
  | { action: "allow"; input: Record<string, unknown>; by: "auto_allow" | "user" | "timeout" }
  | { action: "deny" | "skip"; reason: string; by: "user" | "timeout" };

export interface HitlRequest {
  sessionId: string;
  userId?: string;
  actionId: string;
  tool: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}

export class HitlController {
  private autoAllowSet: Set<string>;
  private alwaysAllow = new Set<string>();

  constructor(
    private dispatcher: DecisionDispatcher | null,
    private onEvent: EventCallback,
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
  willAsk(tool: string): boolean {
    if (!HITL_ENABLED || !this.dispatcher) return false;
    return !this.autoAllowSet.has(tool) && !this.alwaysAllow.has(tool);
  }

  async beforeToolUse(req: HitlRequest): Promise<HitlResult> {
    if (!this.willAsk(req.tool)) {
      return { action: "allow", input: req.input, by: "auto_allow" };
    }

    await this.onEvent({
      type: "permissionRequest",
      actionId: req.actionId,
      tool: req.tool,
      input: req.input,
      description: `${req.tool}: ${JSON.stringify(req.input).slice(0, 200)}`,
      timeout_ms: HITL_DECISION_TIMEOUT_MS,
      ts: Date.now(),
    });

    // Non-null by the guard above: willAsk() is false when there is no
    // dispatcher, because there is then nobody who could answer.
    const dispatcher = this.dispatcher!;
    let msg: NatsDecisionMessage;
    try {
      msg = await dispatcher.register({
        actionId: req.actionId,
        type: "decision",
        timeoutMs: HITL_DECISION_TIMEOUT_MS,
        signal: req.signal,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg === "decision_timeout") {
        const result: HitlResult = HITL_DECISION_DEFAULT === "deny"
          ? { action: "deny", reason: "timed out waiting for approval", by: "timeout" }
          : { action: "allow", input: req.input, by: "timeout" };
        await this.emitDecisionResult(req.actionId, result);
        return result;
      }
      if (errMsg === "decision_aborted") {
        return { action: "deny", reason: "aborted", by: "timeout" };
      }
      throw err;
    }

    const result = this.normalizeDecision(msg, req.input);

    // Handle "remember" for session-scoped always_allow
    if (msg.remember && result.action === "allow") {
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
        return { action: "deny", reason: msg.feedback ?? "denied by user", by: "user" };
      case "skip":
        return { action: "deny", reason: msg.feedback ?? "skipped by user", by: "user" };
      default:
        logger.warn({ decision: msg.decision }, "hitl.unknown_decision_denied");
        return { action: "deny", reason: `unknown decision: ${msg.decision}`, by: "user" };
    }
  }

  private async emitDecisionResult(actionId: string, result: HitlResult): Promise<void> {
    await this.onEvent({
      type: "decisionResult",
      actionId,
      decision: result.action,
      by: result.by,
      ...(result.action === "deny" || result.action === "skip"
        ? { feedback: result.reason }
        : {}),
      ts: Date.now(),
    });
  }
}
