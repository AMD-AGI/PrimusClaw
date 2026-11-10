// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Approvals as the Python tests drive them (`test_proactive_ux.approval_event`, `click`, the fake Claw's `decide`): a Claw
 * notification for one approval, the data its card's buttons carry (what views/approval `decisionButtons` puts there), a press of
 * one of them by a person, and a Claw that records what it was asked to decide.
 */
import {
  ApprovalDecisions,
  noTokenExchange,
  silentLogger,
  type CardClick,
  type JsonObject,
  type OutMessage,
  type StorePort,
} from "@primusclaw/personal-agent";

import type { SettleOptions } from "../../packages/core/src/ports/routing.js";

/** A `approval.requested` notification (Python `approval_event`); `extra` is merged over the whole event. */
export function approvalEvent(
  options: {
    eventId?: string;
    toolUseId?: string;
    expiresAt?: string;
    userId?: string;
    sessionId?: string;
    extra?: JsonObject;
  } = {},
): JsonObject {
  return {
    event_id: options.eventId ?? "ap-1",
    type: "approval.requested",
    occurred_at: "2026-10-27T00:00:00Z",
    user_id: options.userId ?? "u-alice",
    session_id: options.sessionId ?? "s-trig",
    task_id: "t1",
    trigger_id: null,
    title: "Approval needed",
    summary: "",
    link: "/primus-claw/sessions/s1",
    approval: {
      tool_use_id: options.toolUseId ?? "tu1",
      tool: "workload_stop",
      target: "llama-70b-ft",
      expires_at: options.expiresAt ?? "2026-10-27T04:30:00Z",
    },
    ...options.extra,
  };
}

/** What a pushed approval card's button carries (views/approval `decisionButtons`): the first is allow, the second deny. */
export function buttonData(event: JsonObject, action: "allow" | "deny" = "allow"): JsonObject {
  const approval = event["approval"] as JsonObject;
  return {
    primusclaw: "decision",
    session_id: event["session_id"] ?? "",
    tool: approval["tool"] ?? "",
    tool_use_id: approval["tool_use_id"] ?? "",
    action,
  };
}

/** A Claw that records the decisions it is asked for; `fail` is the error every call throws until it is cleared. */
export class DecidingClaw {
  readonly calls: [string, string, string, string, string][] = [];
  fail: Error | undefined;

  decide(key: string, sessionId: string, toolUseId: string, action: string): Promise<void> {
    this.calls.push(["decide", key, sessionId, toolUseId, action]);
    return this.fail === undefined ? Promise.resolve() : Promise.reject(this.fail);
  }

  answer(): Promise<void> {
    return Promise.reject(new Error("DecidingClaw: no question is answered here"));
  }
}

export interface Settled {
  readonly card: OutMessage | string;
  readonly options: SettleOptions | undefined;
}

/** The view a settled press shows (its name), or the note it says. */
export function settledAs(settled: Settled | undefined): string {
  if (settled === undefined) return "(not settled)";
  const card = settled.card;
  return typeof card === "string" ? card : card.body.type === "view" ? `view:${card.body.view.name}` : "?";
}

/** What a press is answered with: the note, or the line said with the card. */
export function saidOf(settled: Settled | undefined): string {
  if (settled === undefined) return "";
  return typeof settled.card === "string" ? settled.card : (settled.options?.fallback ?? "");
}

/** The model of the view a press settled with. */
export function settledModel(settled: Settled | undefined): Readonly<Record<string, unknown>> {
  const card = settled?.card;
  return typeof card === "object" && card.body.type === "view" ? (card.body.view.model as Record<string, unknown>) : {};
}

export type DecisionStore = Pick<StorePort, "approvals" | "sessions" | "prefs" | "reviewDelegation" | "now" | "links">;

/** The decisions of approval presses, as the worker wires them, over a real store and `claw`. */
export function approvalDecisions(store: DecisionStore, claw: DecidingClaw): ApprovalDecisions {
  return new ApprovalDecisions({
    store,
    claw,
    exchange: noTokenExchange,
    allowance: { take: () => undefined, giveBack: () => undefined },
    audit: () => undefined,
    logger: silentLogger,
  });
}

/**
 * `userId` presses a button carrying `data` in their 1:1 chat: the router hands the press over with the presser's own linked key
 * (the Python handler read it from the store the same way). Returns how the press was settled.
 */
export async function press(
  decisions: ApprovalDecisions,
  store: DecisionStore,
  userId: string,
  data: JsonObject,
): Promise<Settled[]> {
  const settled: Settled[] = [];
  const click: CardClick = {
    sender: { id: userId, name: "", email: "", channelUserId: `29:${userId}` },
    conversation: {} as CardClick["conversation"],
    scope: "",
    action: { data },
    lang: () => "en",
    settle: (card, options) => {
      settled.push({ card, options });
      return Promise.resolve(true);
    },
  };
  await decisions.decide(click, store.links.getKey(userId));
  return settled;
}
