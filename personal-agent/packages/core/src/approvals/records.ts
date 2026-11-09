// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One approval, one card (teams_agent/agent.py `on_approval`, `on_approval_sent`, `on_approval_unsent`; proactive.py `_send` for
 * a pushed one): a card is recorded BEFORE it is shown, so its owner is known when it is pressed and the other way the same
 * approval arrives (the running turn's stream, or Claw's `approval.requested` notification) finds it and shows nothing; and it is
 * recorded WITH the card, so that a worker that dies before the send leaves it to the next (`resendUnsent`).
 */
import type { Conversation, Envelope, OutMessage } from "../ports/surface.js";
import type { ApprovalRepository, StorePort } from "../ports/store/index.js";

export type ApprovalRecordStore = Pick<StorePort, "now"> & {
  readonly approvals: Pick<ApprovalRepository, "saveApproval" | "approvalSent" | "forgetApproval">;
};

export interface ApprovalCardRequest {
  readonly userId: string;
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly tool: string;
  /** When it runs out, epoch seconds. */
  readonly expiresAt: number;
}

export class ApprovalCards {
  constructor(private readonly store: ApprovalRecordStore) {}

  /**
   * Show `card` for an approval in `conversation`, once: false when a card for it is in a chat already (nothing is sent). A card
   * that could not be sent leaves no record (whatever else shows the approval then may show it), and the error goes on.
   */
  async show(conversation: Conversation, request: ApprovalCardRequest, card: OutMessage): Promise<boolean> {
    const envelope = conversation.outgoing(card);
    if (!this.store.approvals.saveApproval({ ...request, envelope })) return false;
    try {
      await conversation.deliver(envelope);
    } catch (error) {
      this.store.approvals.forgetApproval(request.sessionId, request.toolUseId); // (nobody saw it: a replay or the notification may)
      throw error;
    }
    this.store.approvals.approvalSent(request.sessionId, request.toolUseId);
    return true;
  }

  /** When an approval a turn shows runs out: as long as Brain waits for it (`expiresIn` seconds), else `fallbackSeconds` on. */
  expiry(expiresIn: number | undefined, fallbackSeconds: number): number {
    return this.store.now() + (expiresIn || fallbackSeconds);
  }
}

/** A turn's deadline: an approval a turn shows is answerable this long when Brain did not say how long it waits (turn.py). */
export const TURN_DEADLINE_SECONDS = 30 * 60;

/** The turn engine's view of the records (W4b `TurnApprovals`, satisfied structurally), bound to the person the turn is for. */
export interface TurnApprovalRecords {
  record(
    sessionId: string,
    toolUseId: string,
    tool: string,
    expiresIn: number | undefined,
    envelope: Envelope,
  ): boolean;
  sent(sessionId: string, toolUseId: string): void;
  unsent(sessionId: string, toolUseId: string): void;
}

/** The records of the approvals one person's turn shows (the Python `on_approval`, `on_approval_sent`, `on_approval_unsent`). */
export function turnApprovalsFor(store: ApprovalRecordStore, userId: string): TurnApprovalRecords {
  return {
    record: (sessionId, toolUseId, tool, expiresIn, envelope) =>
      store.approvals.saveApproval({
        userId,
        sessionId,
        toolUseId,
        tool,
        expiresAt: store.now() + (expiresIn || TURN_DEADLINE_SECONDS),
        envelope,
      }),
    sent: (sessionId, toolUseId) => {
      store.approvals.approvalSent(sessionId, toolUseId);
    },
    unsent: (sessionId, toolUseId) => {
      store.approvals.forgetApproval(sessionId, toolUseId);
    },
  };
}
