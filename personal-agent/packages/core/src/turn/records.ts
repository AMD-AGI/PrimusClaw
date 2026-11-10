// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A chat turn's record (the Python worker's `Agent._record_turn`): the turn's start, and whether its answer reached the
 * chat. Claw's notification of the same run is then matched to it (`TurnAnswerRepository.answeredInChat`) and sends no
 * second card. The message id matches the notification to this turn exactly; the turn id keeps this turn's end out of
 * the row of a later turn in the same session.
 */

import type { TurnAnswerRepository } from "../ports/store/turns.js";
import type { TurnHooks } from "./engine/context.js";

/** The `onTurn` hook of one turn: `prompt` names the run if its answer has to come another way. */
export function turnRecorder(
  turns: TurnAnswerRepository,
  prompt: string,
  turnId: string,
): NonNullable<TurnHooks["onTurn"]> {
  return (sessionId, what, messageId) => {
    if (what === "started") turns.turnStarted(sessionId, { prompt, messageId, turnId });
    else if (what === "delivered") turns.turnDelivered(sessionId, { messageId, turnId });
    else turns.turnNotDelivered(sessionId, turnId);
  };
}
