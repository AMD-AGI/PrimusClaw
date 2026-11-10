// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turns the router starts (W4b's turn engine), the Stop cards of turns a phone starts, and the approval and question cards
 * those turns show (`Agent._start_turn`'s `on_approval*`, `Agent._decide`).
 */
import type {
  ApprovalAudit,
  ClickHandler,
  Guardrails,
  Integrations,
  PublicErrors,
  TurnHooks,
  TurnOutcome,
  TurnRunner,
} from "@primusclaw/personal-agent";
import {
  ApprovalClicks,
  ApprovalDecisions,
  approvalTurnCards,
  correlationId,
  thumbsMessage,
  turn,
  turnApprovals,
} from "@primusclaw/personal-agent";

import { streamsIn, type Style } from "../config/style.js";
import type { AssemblyBase, RouterHooks } from "./features-base.js";
import { conversationTypeOf } from "./features-base.js";
import { fetchAll } from "./features-text.js";

export interface TurnInputs {
  readonly style: Style;
  readonly errors: PublicErrors;
  readonly integrations: Integrations;
}

/** The router's turn runner: one engine per run, its approval records bound to the person the turn is for. */
export function turnRunner(base: AssemblyBase, inputs: TurnInputs): TurnRunner {
  const { claw, clock, logger, store, metrics, plugins, settings, surface } = base;
  const { style } = inputs;
  const approvals = turnApprovals(store); // (W5: the records of the person each approval names)
  return {
    lastAnswer: (credential, sessionId) =>
      turn.lastAnswer({ claw: claw.sessions, clock, log: logger, errors: inputs.errors }, credential, sessionId),
    run(run: Parameters<TurnRunner["run"]>[0], hooks: TurnHooks): Promise<TurnOutcome> {
      const engine = new turn.TurnEngine({
        claw: claw.sessions,
        clock,
        log: logger,
        refusals: plugins.modelRefusalPolicy,
        errors: inputs.errors,
        publicBaseUrl: settings.publicBaseUrl,
        style: {
          streamText: style.streamText,
          suggestedReplies: style.suggestedReplies,
          streamsIn: (kind) => streamsIn(style, conversationTypeOf(kind)),
        },
        approvals,
        fetchFiles: async (files) => {
          const got = await fetchAll(surface, files);
          return [got.fetched, got.failed] as const;
        },
        onFilesDropped: (count) => {
          if (count > 0) metrics.filesDropped("session", count);
        },
        integrations: inputs.integrations,
        cards: { ...approvalTurnCards, thumbs: () => thumbsMessage() },
      });
      return engine.run(run, hooks);
    },
  };
}

/** The Stop cards of turns a phone starts (`StopButtons`). */
export function stopCards(base: AssemblyBase) {
  return new turn.StopButtons({ clock: base.clock, random: base.random, log: base.logger });
}

/** The audit record of an answer to an approval card (Python `Agent._audit_approval`). */
function auditApproval(base: AssemblyBase): (record: ApprovalAudit) => void {
  return (record) => {
    base.securityLog.event("approval_answered", {
      operation: "approval",
      aad_object_id: record.userId,
      session_id: record.sessionId || null,
      approval_id: record.approvalId,
      tool: record.tool,
      decision: record.decision,
      outcome: record.outcome,
      status: record.status || null,
      correlation_id: correlationId(record.sessionId, record.toolUseId),
    });
  };
}

/** The buttons of approval and question cards (`Agent._decide`), the person's allowance taken per approval given. */
export function approvalClicks(base: AssemblyBase, guard: Guardrails, hooks: RouterHooks): ClickHandler {
  const { store, claw, exchange, logger } = base;
  const decisions = new ApprovalDecisions({
    store,
    claw: claw.sessions,
    exchange,
    allowance: {
      take: (userId, ticket, ids) =>
        guard
          .take(userId, "approval", ticket, {
            session_id: ids.sessionId || null,
            approval_id: ids.approvalId,
            tool: ids.tool,
            correlation_id: correlationId(ids.sessionId, ids.toolUseId),
          })
          ?.text(),
      giveBack: (userId, ticket) => {
        guard.giveBack(userId, "approval", ticket);
      },
    },
    audit: auditApproval(base),
    logger,
    onDenied: (userId, scope) => {
      hooks.toolDenied(userId, scope);
    },
  });
  return new ApprovalClicks(
    decisions,
    (sessionId) => store.reviewDelegation.isActingSession(sessionId),
    (userId) => Promise.resolve(store.links.getKey(userId)),
  );
}
