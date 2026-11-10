// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Approval and question cards as a turn shows them and as they are answered (the Python tests' BrainLike / Asking Claw and their
 * `click` / `send`): the record a turn makes before its card goes out (`turnApprovals`, the turn's `onApproval`), a Claw that
 * records every decision and answer it is given, and a press as the router hands it over (in a 1:1 chat with the presser's
 * linked key; in a group through `inGroup`).
 */
import type { JsonObject } from "@primusclaw/personal-agent";

import { ApprovalDecisions } from "../../packages/core/src/approvals/decide.js";
import type { CardClick } from "../../packages/core/src/approvals/click.js";
import { turnApprovals } from "../../packages/core/src/approvals/records.js";
import { silentLogger } from "../../packages/core/src/ports/logger.js";
import type { SettleOptions } from "../../packages/core/src/ports/routing.js";
import type { StorePort } from "../../packages/core/src/ports/store/index.js";
import type { Conversation, OutMessage, View } from "../../packages/core/src/ports/surface.js";
import { noTokenExchange } from "../../packages/core/src/plugins/token-exchange.js";

export type FlowStore = Pick<StorePort, "approvals" | "sessions" | "prefs" | "reviewDelegation" | "now" | "links">;

/** A Claw that records what it was asked: ["decide", key, session, tool use, action] or ["answer", key, session, tool use, answers, skipped]. */
export class RecordingClaw {
  readonly calls: unknown[][] = [];

  decide(key: string, sessionId: string, toolUseId: string, action: string): Promise<void> {
    this.calls.push(["decide", key, sessionId, toolUseId, action]);
    return Promise.resolve();
  }

  answer(
    key: string,
    sessionId: string,
    toolUseId: string,
    answers: Readonly<Record<string, string>>,
    skipped: readonly string[],
  ): Promise<void> {
    this.calls.push(["answer", key, sessionId, toolUseId, { ...answers }, [...skipped]]);
    return Promise.resolve();
  }

  of(kind: string): unknown[][] {
    return this.calls.filter((c) => c[0] === kind);
  }
}

export interface Settled {
  readonly card: OutMessage | string;
  readonly options: SettleOptions;
}

export class ApprovalFlow {
  readonly claw = new RecordingClaw();
  /** (person, scope) of each denial of a running turn's approval. */
  readonly denied: [string, string][] = [];
  readonly decisions: ApprovalDecisions;

  constructor(private readonly store: FlowStore) {
    this.decisions = new ApprovalDecisions({
      store,
      claw: this.claw,
      exchange: noTokenExchange,
      allowance: { take: () => undefined, giveBack: () => undefined },
      audit: () => undefined,
      logger: silentLogger,
      onDenied: (userId, scope) => this.denied.push([userId, scope]),
    });
  }

  /**
   * A turn of `userId` shows the card `view` for one approval (or question) in `conversation`: recorded first, for as long as
   * Brain waits (`waitSeconds`, undefined: the turn's deadline), then sent. False when a card for it is in a chat already.
   */
  async show(
    conversation: Conversation,
    request: { userId: string; sessionId: string; toolUseId: string; tool: string; waitSeconds: number | undefined },
    view: View,
  ): Promise<boolean> {
    const records = turnApprovals(this.store);
    const envelope = conversation.outgoing({ body: { type: "view", view, fallbackText: "" } });
    if (
      !records.record(request.userId, request.sessionId, request.toolUseId, request.tool, request.waitSeconds, envelope)
    )
      return false;
    await conversation.deliver(envelope);
    records.sent(request.sessionId, request.toolUseId);
    return true;
  }

  /**
   * `userId` presses a button carrying `data`: in their 1:1 chat with their linked key, or in a group (`scope`) answered only by
   * the person it was raised for. How it was settled.
   */
  async press(userId: string, data: JsonObject, scope = ""): Promise<Settled[]> {
    const settled: Settled[] = [];
    const click: CardClick = {
      sender: { id: userId, name: "", email: "", channelUserId: `29:${userId}` },
      conversation: {} as CardClick["conversation"],
      scope,
      action: { data },
      lang: () => "en",
      settle: (card, options = {}) => {
        settled.push({ card, options });
        return Promise.resolve(true);
      },
    };
    const key = () => Promise.resolve(this.store.links.getKey(userId));
    if (scope) await this.decisions.inGroup(click, key);
    else await this.decisions.decide(click, await key());
    return settled;
  }
}

/** The view a press settled with (undefined: a note). */
export function settledView(settled: Settled | undefined): View | undefined {
  const card = settled?.card;
  return typeof card === "object" && card.body.type === "view" ? card.body.view : undefined;
}
