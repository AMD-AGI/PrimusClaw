// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Lang } from "../locales/lang.js";
import type { Conversation, InboundFile, OutMessage } from "../ports/surface.js";
import type { CredentialProvider } from "./features.js";

/**
 * The turn engine as the router starts it (the Python `turn.TurnContext` and `run_turn`). The router decides whether a
 * turn may start (the person's task limit, the chat's queue) and in which session; the engine sends the message to
 * Claw, follows the session's stream and shows progress and the answer. A review's own fields are declared by the review
 * service on `ReviewRunFields` (declaration merging), so the router carries them without reading them.
 */

/** Fields of a review's run, declared by the review service: `declare module ".../turn-runner.js" { interface ReviewRunFields { ... } }`. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extended by declaration merging, by the review service
export interface ReviewRunFields {}

export interface TurnRun {
  readonly conversation: Conversation;
  /** The person the turn is for (whose approvals its cards are; Python `sender.aad_id`). */
  readonly userId: string;
  /** The person this turn acts for: their key, or an exchanged token. */
  readonly credential: string;
  readonly provider: CredentialProvider;
  /** The session to continue; null: Claw creates one with this message. */
  readonly sessionId: string | null;
  /** What the person wrote (the session's title, the language of the answer). */
  readonly text: string;
  /** The message's id: the idempotency key of the send. */
  readonly messageId: string;
  readonly group: boolean;
  readonly ownerName: string;
  /** The model the session is pinned to ("" Claw's default). */
  readonly model: string;
  readonly fallbackModel: string;
  /** The model the existing session is known to have ("" none known). */
  readonly sessionModel: string;
  /** The repository a NEW session is bound to (`/repo`); null: none. */
  readonly repo: { readonly url: string; readonly branch: string } | null;
  /** A card with what the session changed follows a finished answer. */
  readonly showChanges: boolean;
  /** The message(s) this one quotes, as text for the model ("" none). */
  readonly quote: string;
  /** `text` with the address behind each of its links ("" when it is `text`). */
  readonly sent: string;
  readonly files: readonly InboundFile[];
  readonly lang: Lang;
  /**
   * The language the turn is to be answered in, told to Claw after the message: in a 1:1 chat the one the person chose (`/lang
   * zh|en`, `chosenLang`), in a group the group's (`groupChosenLang`), or with none the asker's (`AskerLanguages`); undefined:
   * none, and the answer is in the language of what they wrote. A chat turn's only: a review's follows its request.
   */
  readonly replyLang?: Lang;
  /** The answer gets thumbs of the worker's own (a phone, whose own thumbs never reach the worker). */
  readonly ownThumbs: boolean;
  /** Claw pushes this person a run's end and its approvals. */
  readonly notifies: boolean;
  /** A review's own fields; undefined for a chat turn. */
  readonly review: (ReviewRunFields & { readonly kind: "review" }) | undefined;
}

/** What the turn tells the router, and asks it, while it runs. */
export interface TurnHooks {
  /** Claw took the message: `sessionId` is the turn's session; `sessionModel` the model it now has. */
  onSession(sessionId: string, sessionModel: string): void;
  /** Claw is running this turn's message: a message queued behind it may go. */
  onRunning(): void;
  /** The turn's record: started, delivered (its answer is in the chat) or not. */
  onTurn(sessionId: string, what: "started" | "delivered" | "failed", messageId: string): void;
  stopRequested(): boolean;
  /** The person pressed Deny on one of this turn's approval cards. */
  toolDenied(): boolean;
  /** Claw took this turn's stop: its failed end is the stop, not an error. */
  stopConfirmed(): boolean;
  /** The "Report a problem" card for a turn that went wrong; undefined: none. */
  reportView(): OutMessage | undefined;
}

/** How a turn ended, as far as the router and a review read it. */
export interface TurnOutcome {
  readonly finalAnswer: string;
}

export interface TurnRunner {
  run(run: TurnRun, hooks: TurnHooks): Promise<TurnOutcome>;
  /**
   * The answer of the session's last finished turn, read with `credential` (undefined: none finished yet). Claw refuses a
   * session the credential does not own (a ClawError 401/403/404); one it cannot be reached for is a ClawUnreachable.
   */
  lastAnswer(credential: string, sessionId: string): Promise<string | undefined>;
}
