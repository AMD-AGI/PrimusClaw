// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Chat turns that answer in the chat, so the run's own notification card is redundant (tables `turn_answers`,
 * `answered_messages`). */

export type AnsweredInChat = "delivered" | "running" | "lost";

export interface TurnRun {
  /** When the run finished (Claw's notification). */
  readonly finishedAt: number;
  /** A turn this process started and younger than this is still running. */
  readonly runningMax: number;
  /** Clock skew allowed between the delivery and the run's end. */
  readonly slack: number;
  /** The run's chat message, when Claw names it. */
  readonly messageId?: string;
}

export interface TurnAnswerRepository {
  turnStarted(sessionId: string, turn?: { readonly prompt?: string; readonly messageId?: string; readonly turnId?: string }): void;
  /** With `turnId`, the row is updated only while it is still that turn's. */
  turnDelivered(sessionId: string, turn?: { readonly messageId?: string; readonly turnId?: string }): void;
  turnNotDelivered(sessionId: string, turnId?: string): void;
  /** Whether a chat turn answered the run of this session that finished at `run.finishedAt`; null if none. */
  answeredInChat(sessionId: string, run: TurnRun): AnsweredInChat | null;
  /** What was asked in the turn that started the run ('' when no chat turn did). */
  turnPrompt(sessionId: string, finishedAt: number): string;
}
