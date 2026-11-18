// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the proactive tests read of a chat and do to it, beside the delivery world (`test-support/assistant/proactive-world.ts`): a
 * second person, the views that were sent, a chat whose sends of approval cards fail or wait, and a turn that shows an approval
 * card the way the turn engine records it (`turnApprovals`).
 */
import {
  turnApprovals,
  type Conversation,
  type ConversationRef,
  type Envelope,
  type JsonObject,
  type OutMessage,
  type StorePort,
} from "@primusclaw/personal-agent";

import type { FakeSurface, Recorded } from "../surface.js";

export const BOB = "aad-b";

/** The conversation reference the worker keeps for `userId` (its 1:1 chat "c-<userId>"). */
export function referenceOf(userId: string): JsonObject {
  return { serviceUrl: "https://smba.test/", conversation: { id: `c-${userId}` }, bot: { id: "28:bot" } };
}

/** Link `userId` with `key` and keep where to reach them (Python `link_user`). */
export function linkUser(store: Pick<StorePort, "links" | "references">, userId: string, name: string, key: string) {
  store.links.redeemPending(userId, name, store.links.stashPending(key));
  store.references.saveReference(userId, referenceOf(userId));
}

export interface SentView {
  readonly conversation: string;
  readonly name: string;
  readonly model: Readonly<Record<string, unknown>>;
}

/** Every view sent, in order, with the conversation it went to. */
export function sentViews(outbox: readonly Recorded[]): SentView[] {
  return outbox.flatMap((r) => {
    if (r.op !== "send" && r.op !== "post") return [];
    const body = r.message.body;
    if (body.type !== "view") return [];
    return [
      {
        conversation: r.conversation,
        name: body.view.name,
        model: body.view.model as unknown as Record<string, unknown>,
      },
    ];
  });
}

/** The words of every text or rich message sent, in order. */
export function sentTexts(outbox: readonly Recorded[]): string[] {
  return outbox.flatMap((r) => {
    if (r.op !== "send" && r.op !== "post") return [];
    const body = r.message.body;
    return body.type === "text" ? [body.text] : body.type === "rich" ? [body.markdown] : [];
  });
}

/** Every message sent, in order. */
export function sentMessages(outbox: readonly Recorded[]): OutMessage[] {
  return outbox.flatMap((r) => (r.op === "send" || r.op === "post" ? [r.message] : []));
}

/** The text a turn's approval card is drawn with here (a turn card is the turn engine's; only its id matters). */
export function turnCard(toolUseId: string): OutMessage {
  return { body: { type: "text", text: `turn approval ${toolUseId}` } };
}

/** Is this an approval card (one with Approve on it): a pushed one, a work item's, or a turn's. */
export function isApprovalCard(message: OutMessage): boolean {
  const body = message.body;
  if (body.type === "view") return body.view.name === "proactiveApproval" || body.view.name === "itemApproval";
  return body.type === "text" && body.text.startsWith("turn approval ");
}

/** The tool use ids of the approval cards sent, in order (Python `approve_cards`). */
export function approvalCards(outbox: readonly Recorded[]): string[] {
  return sentMessages(outbox)
    .filter(isApprovalCard)
    .map((m) => {
      const body = m.body;
      if (body.type === "text") return body.text.slice("turn approval ".length);
      if (body.type !== "view") return "";
      const event = (body.view.model as { event?: JsonObject }).event ?? {};
      const approval = (event["approval"] ?? {}) as JsonObject;
      return typeof approval["tool_use_id"] === "string" ? approval["tool_use_id"] : "";
    });
}

/**
 * Make the surface's conversations publish approval cards through `gate`: it is awaited before each approval card's envelope is
 * recorded, and a card it rejects is not recorded. Other messages go as they are. Returns a way to put the surface back.
 */
export function gateApprovalCards(surface: FakeSurface, gate: (envelope: Envelope) => Promise<void>): () => void {
  const original = surface.conversation.bind(surface);
  surface.conversation = (ref: ConversationRef): Conversation => {
    const real = original(ref);
    const gated = Object.create(real) as Conversation & { deliver: Conversation["deliver"] };
    gated.deliver = async (envelope: Envelope) => {
      const message = envelope["message"] as unknown as OutMessage | undefined;
      if (message !== undefined && isApprovalCard(message)) await gate(envelope);
      await real.deliver(envelope);
    };
    return gated;
  };
  return () => {
    surface.conversation = original;
  };
}

/** A gate that is shut until `open` (or `fail`) is called. */
export class Gate {
  private waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  private state: "shut" | "open" | Error = "shut";

  pass = (): Promise<void> => {
    if (this.state === "open") return Promise.resolve();
    if (this.state instanceof Error) return Promise.reject(this.state);
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  };

  open(): void {
    this.state = "open";
    for (const w of this.waiting.splice(0)) w.resolve();
  }

  fail(error: Error): void {
    this.state = error;
    for (const w of this.waiting.splice(0)) w.reject(error);
  }

  /** How many sends wait at the gate. */
  get held(): number {
    return this.waiting.length;
  }
}

/**
 * A chat turn of `userId` that shows the approval `toolUseId` of `sessionId` the way the turn engine does: recorded with its
 * envelope BEFORE the send, marked sent after it, and given back when the send fails. Returns false when it showed nothing (a
 * card for it is in a chat already). With `send: false` it stops after recording (a worker inside its send).
 */
export async function turnShowsApproval(
  store: Pick<StorePort, "approvals" | "now">,
  conversation: Conversation,
  turn: { userId: string; sessionId: string; toolUseId: string; send?: boolean; fails?: boolean },
): Promise<boolean> {
  const records = turnApprovals(store);
  const envelope = conversation.outgoing(turnCard(turn.toolUseId));
  if (!records.record(turn.userId, turn.sessionId, turn.toolUseId, "bash", undefined, envelope)) return false;
  if (turn.send === false) return true;
  if (turn.fails === true) {
    records.unsent(turn.sessionId, turn.toolUseId); // (the turn's send failed: it says so and goes on)
    return false;
  }
  await conversation.deliver(envelope);
  records.sent(turn.sessionId, turn.toolUseId);
  return true;
}
