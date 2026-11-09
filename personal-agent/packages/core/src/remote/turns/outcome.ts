// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a remote turn ended, as the person is told it: the agent's answer (its last piece of text), and lines of ours after it (a
 * failure with a reference, the session's end, a stop at a limit, a turn the connector could not complete). A turn that ended with
 * no words of the agent's is never said as "Done" when a line of ours says otherwise.
 */
import type { Lang } from "../../locales/lang.js";
import { remoteAgentText } from "../../locales/remote-agents.js";
import {
  CONNECTOR_RESTARTED,
  DELIVERY_UNCONFIRMED,
  NOT_DELIVERED,
  answerParts,
  isStopReason,
  recoveredLine,
  stopNote,
} from "../../remote-view/index.js";
import { neutral } from "../../text/neutral.js";
import { isCode } from "../connector/reasons.js";
import { saidIn, withReason } from "../refusals.js";

/** What the turn's fold says of its end. */
export interface TurnEnd {
  readonly answer: string;
  readonly stopReason: string;
  readonly note: string | null;
  readonly closed: string | null;
  /** The person asked to stop it. */
  readonly stopRequested: boolean;
}

/** What says a turn's end in words: the session's end, a connector's code, a raw error withheld. */
export interface EndSayers {
  readonly label: string;
  readonly host: string;
  readonly lang: Lang;
  splitErrorTail(text: string): { readonly kept: string; readonly tail: string };
  /** Log the raw error of a failed call and return its reference. */
  withhold(error: string): string;
  sessionEnded(reason: string): Promise<string>;
  turnIncomplete(code: string): Promise<string>;
  /** The answer's parts under the agent's head, in a chat that is its window (`signer.ts`). */
  sign?: (parts: string[]) => string[];
}

export interface TurnOutcome {
  /** The messages of the answer, the lines of ours on the last. */
  readonly parts: string[];
  /** The lines of ours ('' none). */
  readonly tail: string;
  /** The agent wrote something. */
  readonly ai: boolean;
}

async function notesOf(end: TurnEnd, say: EndSayers, told: string): Promise<string[]> {
  const notes = told ? [told] : [];
  const reason = end.stopReason;
  if (end.closed !== null) notes.push(await say.sessionEnded(end.closed));
  else if (reason === "error" && end.note === CONNECTOR_RESTARTED) {
    // The connector restarted and ended this turn: the session is back and resumes with the next message.
    notes.push(recoveredLine(say.label, say.host, say.lang, true, false));
  } else if (isStopReason(reason) && reason !== "cancelled") notes.push(stopNote(reason, say.lang));
  else if (!["end_turn", "cancelled", ""].includes(reason)) {
    if (end.note && isCode(end.note)) notes.push(await say.turnIncomplete(end.note));
    else notes.push(withReason(remoteAgentText.in(say.lang).turnEnded({ reason: neutral(reason, 40) }), end.note));
  }
  return notes;
}

/** The answer and the lines of ours, as the person is told the end of the turn. */
export async function turnOutcome(end: TurnEnd, say: EndSayers): Promise<TurnOutcome> {
  let answer = end.answer;
  let told = "";
  if (end.stopReason === "error") {
    // the raw error of a failed call is no answer: cut off and logged, the agent's words stay
    const split = say.splitErrorTail(answer);
    answer = split.kept;
    if (split.tail) told = remoteAgentText.in(say.lang).turnFailed({ ref: say.withhold(split.tail) });
  }
  const tail = (await notesOf(end, say, told)).join("\n\n");
  let parts: string[];
  const silent = told !== "" || end.note === NOT_DELIVERED || end.note === DELIVERY_UNCONFIRMED || end.closed !== null;
  if (answer) parts = say.sign ? say.sign(answerParts(answer, say.lang)) : answerParts(answer, say.lang);
  else if (silent)
    parts = []; // (the note alone says so: a session that closed under the turn did not finish it)
  else if (end.stopRequested || end.stopReason === "cancelled") parts = [saidIn(say.lang, "stopped")];
  else if (tail)
    parts = []; // (a turn that did not complete, or stopped at a limit, with no words: never "Done")
  else parts = answerParts("", say.lang);
  if (tail) parts = parts.length > 0 ? [...parts.slice(0, -1), `${parts.at(-1) ?? ""}\n\n${tail}`] : [tail];
  return { parts, tail, ai: Boolean(answer) };
}
