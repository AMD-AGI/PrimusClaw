// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Tool approvals pushed to a chat (table `approvals`): one approval is one card, whichever way it arrives. */
import type { JsonObject } from "./json.js";

export type ApprovalState = "pending" | "approved" | "denied" | "expired" | (string & {});

export interface Approval {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly userId: string;
  readonly tool: string;
  readonly expiresAt: number;
  readonly state: ApprovalState;
}

/** An approval card that was recorded and never reached the chat: what it takes to send it again. */
export interface UnsentCard {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly userId: string;
  readonly expiresAt: number;
  readonly envelope: JsonObject;
}

export interface NewApproval {
  readonly userId: string;
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly tool: string;
  readonly expiresAt: number;
  /** The card as it will be published, kept until `approvalSent` so a worker that dies before the send leaves it to the next. */
  readonly envelope?: JsonObject | null;
  /**
   * A question card of a turn: its questions as the card's button carries them. Kept so that what the person types next in
   * the chat can be taken as the answer (`pendingQuestion`).
   */
  readonly questions?: readonly JsonObject[] | null;
}

/** A question card still waiting for its answer, with what it takes to answer it from a typed message. */
export interface PendingQuestion {
  readonly sessionId: string;
  readonly toolUseId: string;
  readonly userId: string;
  /** When it runs out, epoch seconds. */
  readonly expiresAt: number;
  /** The questions as recorded with the card (`NewApproval.questions`). */
  readonly questions: readonly JsonObject[];
  /** The chat's id of the card ("" when the channel never said it: the card cannot be edited). */
  readonly cardId: string;
}

export interface ApprovalRepository {
  /** True when this call recorded it; false when a card for the same approval was recorded before. */
  saveApproval(approval: NewApproval): boolean;
  /** The card reached the chat: nothing is left to send. `cardId`: the chat's id of the card, when it said it. */
  approvalSent(sessionId: string, toolUseId: string, cardId?: string): void;
  /** Its card is being sent right now by this process and may still fail. */
  approvalInFlight(sessionId: string, toolUseId: string): boolean;
  /** The card never reached the chat: take the record back (a row answered meanwhile stays). */
  forgetApproval(sessionId: string, toolUseId: string): void;
  /** Cards recorded and never sent, each marked in flight; ones out of time are closed as expired instead. */
  claimUnsentApprovals(): UnsentCard[];
  /** A claimed card could not be sent: the next sweep tries again. */
  approvalSendFailed(sessionId: string, toolUseId: string): void;
  getApproval(sessionId: string, toolUseId: string): Approval | null;
  /**
   * The newest question card of `userId` in `sessionId` that is still pending, in time, and was recorded with its questions;
   * null when there is none.
   */
  pendingQuestion(sessionId: string, userId: string): PendingQuestion | null;
  /** Move an approval to `state`; true if this call did it (only from 'pending' unless `onlyIfPending` is false). */
  closeApproval(
    sessionId: string,
    toolUseId: string,
    state: ApprovalState,
    options?: { readonly onlyIfPending?: boolean },
  ): boolean;
}
