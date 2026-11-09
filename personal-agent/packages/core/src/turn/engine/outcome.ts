// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the chat is told when a turn ends: the answer, or why there is none. */

import { errorName } from "../../errors.js";
import { turnEnglish, turnText } from "../../locales/turn.js";
import { answerParts } from "../answer-parts.js";
import type { TurnState } from "../turn-state.js";
import type { PublicErrors } from "../../public-error/public-errors.js";
import { type ClawError, errorKind, SERVICE_REFUSAL_REASONS, serviceRefusal } from "../upstream.js";
import { langOf, type TurnContext } from "./context.js";

/** The chat stops following a turn after this; the run itself does not stop. */
export const TURN_DEADLINE_SECONDS = 30 * 60;

/** What the chat says when the turn's time is up and the run is still going. */
export function stillRunningText(ctx: TurnContext, deadlineSeconds = TURN_DEADLINE_SECONDS): string {
  const text = turnText.in(langOf(ctx));
  const follow = ctx.request.notifies && !ctx.request.group ? text.stillRunningNotify : text.stillRunningOpen;
  return text.stillRunning({ minutes: Math.round(deadlineSeconds / 60) }) + follow;
}

/** What a Claw refusal before the turn ran is said as. The log gets the status and Claw's error word only, never the body. */
export function clawFailure(errors: PublicErrors, err: ClawError, review = false): string {
  if (err.status === 403 && Object.hasOwn(SERVICE_REFUSAL_REASONS, err.code)) {
    return serviceRefusal(err.code, turnEnglish.nothingStarted);
  }
  // (the group is not told to /unlink and link again: that is for the asker alone, who is messaged)
  if (review && err.status === 401) return turnEnglish.reviewRefused;
  if (err.status === 401 || err.status === 403) return turnEnglish.keyRejected;
  if (err.status === 429) return turnEnglish.clawBusy;
  return turnEnglish.clawRequestFailed(
    err.status,
    errors.withhold("claw_request", errorKind(err), { status: err.status }),
  );
}

/**
 * A review whose stream showed its GitHub result before the turn broke off: its result line, to go above what the chat
 * is told, since the progress message that showed it is replaced. '' otherwise.
 */
export function resultLead(ctx: TurnContext, state: TurnState | undefined): string {
  const shape = ctx.hooks.shapeAnswer;
  if (!state || state.results.length === 0 || !shape) return "";
  try {
    return `${shape("", "", state.routedModel || ctx.record.sessionModel, [...state.results], state.comments, state.prSummary)}\n\n`;
  } catch (err) {
    ctx.deps.log.warn("the review's result line could not be kept", { error: errorName(err) });
    return "";
  }
}

export interface Ending {
  /** What the turn answered, with its failure cut off. */
  readonly answer: string;
  /** `answer` as the chat shows it (a review's one message). */
  readonly shown: string;
  readonly link: string;
  readonly ok: boolean;
  readonly stopped: boolean;
  /** A stop Claw confirmed: said as stopped only. */
  readonly confirmed: boolean;
  /** The line in front of an answer a fallback model gave. */
  readonly lead: string;
}

/**
 * The messages that end a turn. Claw ends a turn it was told to stop as failed: a stop it confirmed is said as stopped
 * only; a stop asked for but not confirmed leaves a failure said as one.
 */
export function endingParts(ctx: TurnContext, ending: Ending): string[] {
  const { answer, shown, link, ok, stopped, confirmed, lead } = ending;
  const text = turnText.in(langOf(ctx));
  const errorLine = `${text.taskFailed} [${text.openSession}](${link})`;
  if (stopped && !answer) {
    const stop = shown ? `${shown}\n\n${turnEnglish.stopped}` : turnEnglish.stopped;
    return [!ok && !confirmed ? `${stop}\n\n${errorLine}` : stop];
  }
  if (!ok && !answer) return [shown ? `${shown}\n\n${errorLine}` : errorLine];
  const parts = answerParts(shown, link, ctx.request.group ?? false, lead);
  if (ok || confirmed) return parts;
  return parts.map((part, n) => (n === parts.length - 1 ? `${part}\n\n${errorLine}` : part));
}
