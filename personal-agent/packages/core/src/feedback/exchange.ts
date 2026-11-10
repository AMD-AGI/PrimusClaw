// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { SseEvent } from "../claw/model.js";
import type { JsonObject } from "../json.js";
import { pyStr, pyStrip } from "../text/py-text.js";
import { objectOf, splitTurns, turnIdOf, type HistoryRow, type TurnEvent } from "./scene.js";

/**
 * A reporter's last question and the answer to it, as the chat showed them: what they chose to add to their issue.
 * Reading an answer is the turn engine's (`answerOf`: the text a turn's events showed), and so is taking the worker's
 * own additions off a question (`withoutRule`).
 */
export interface TurnText {
  /** The text the person typed, without what the worker appended to it (the change summary, the reply-style rule). */
  withoutRule(text: string): string;
  /** The answer a turn's events showed, as the chat showed it. */
  answerOf(turnId: string, events: readonly SseEvent[]): string;
}

export interface Exchange {
  readonly question: string;
  readonly answer: string;
}

function questionOf(first: TurnEvent): string {
  const blocks = objectOf(first.data["data"])["content"];
  const typed = Array.isArray(blocks)
    ? blocks
        .map((b) => objectOf(b))
        .filter((b) => b["type"] === "text")
        .map((b) => pyStr(b["text"]))
        .join("")
    : "";
  return typed;
}

/** The exchange of the turn `turnId` (else the last turn); undefined when there is neither a question nor an answer. */
export function lastExchange(rows: readonly HistoryRow[], turnId: string, text: TurnText): Exchange | undefined {
  const turns = splitTurns(rows);
  const chosen = turnId ? turns.find((t) => turnIdOf(t) === turnId) : undefined;
  const events = chosen ?? turns.at(-1);
  const first = events?.[0];
  if (events === undefined || first === undefined) return undefined;
  const question = pyStrip(text.withoutRule(questionOf(first)));
  const id = pyStr(first.data["message_id"]) || first.id;
  const answer = pyStrip(
    text.answerOf(
      id,
      events.map((e) => ({ id: e.id, name: e.type, data: e.data as JsonObject })),
    ),
  );
  return question || answer ? { question, answer } : undefined;
}
