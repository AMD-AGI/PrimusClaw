// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the chat is told when a turn ends: the answer, or why there is none. */

import { answerParts } from "../answer-parts.js";
import type { TurnState } from "../turn-state.js";
import {
  CLAW_BUSY,
  clawRequestFailed,
  KEY_REJECTED,
  NOTHING_STARTED,
  OPEN_SESSION,
  REVIEW_REFUSED,
  STILL_RUNNING,
  STILL_RUNNING_NOTIFY,
  STILL_RUNNING_OPEN,
  STOPPED,
  TASK_FAILED,
} from "../text.js";
import { type ClawError, errorKind, SERVICE_REFUSAL_REASONS, serviceRefusal, withhold } from "../upstream.js";
import { langOf, type TurnContext } from "./context.js";

/** The chat stops following a turn after this; the run itself does not stop. */
export const TURN_DEADLINE_SECONDS = 30 * 60;

/** What the chat says when the turn's time is up and the run is still going. */
export function stillRunningText(ctx: TurnContext): string {
  const lang = langOf(ctx);
  const follow = ctx.request.notifies && !ctx.request.group ? STILL_RUNNING_NOTIFY : STILL_RUNNING_OPEN;
  return STILL_RUNNING[lang](Math.round(TURN_DEADLINE_SECONDS / 60)) + follow[lang];
}

/** What a Claw refusal before the turn ran is said as. The log gets the status and Claw's error word only, never the body. */
export function clawFailure(err: ClawError, review = false): string {
  if (err.status === 403 && Object.hasOwn(SERVICE_REFUSAL_REASONS, err.code)) return serviceRefusal(err, NOTHING_STARTED);
  // (the group is not told to /unlink and link again: that is for the asker alone, who is messaged)
  if (review && err.status === 401) return REVIEW_REFUSED;
  if (err.status === 401 || err.status === 403) return KEY_REJECTED;
  if (err.status === 429) return CLAW_BUSY;
  return clawRequestFailed(err.status, withhold("claw_request", errorKind(err), { status: err.status }));
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
    ctx.deps.log.warn("the review's result line could not be kept", { error: String(err) });
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
  const lang = langOf(ctx);
  const errorLine = `${TASK_FAILED[lang]} [${OPEN_SESSION[lang]}](${link})`;
  if (stopped && !answer) {
    const stop = shown ? `${shown}\n\n${STOPPED}` : STOPPED;
    return [!ok && !confirmed ? `${stop}\n\n${errorLine}` : stop];
  }
  if (!ok && !answer) return [shown ? `${shown}\n\n${errorLine}` : errorLine];
  const parts = answerParts(shown, link, ctx.request.group ?? false, lead);
  if (!ok && !confirmed) parts[parts.length - 1] += `\n\n${errorLine}`;
  return parts;
}
