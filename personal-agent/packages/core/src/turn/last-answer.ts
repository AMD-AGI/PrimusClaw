// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The answer of a session's last finished turn, read from its history ("Show here", a turn lost with its worker). */

import { isObject, textOf, truthy } from "./json.js";
import { turnText } from "../locales/turn.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import { sleepSeconds, type TurnClaw } from "./ports.js";
import { TurnState, messageIdOf } from "./turn-state.js";
import type { PublicErrors } from "../public-error/public-errors.js";
import { ClawError, errorKind, pickLang, type SseEvent, splitErrorTail } from "./upstream.js";
import { isClawFailure } from "./engine/claw-errors.js";

export const READ_OVERALL_SECONDS = 20;
/** After a turn has finished, this much silence means the history replay is over. */
export const READ_IDLE_SECONDS = 2;
/** Events read for the last answer: the last finished turn is in it even behind a long running one. */
export const LAST_ANSWER_TAIL = 2000;
/** A replay larger than this is refused unread: a Claw that predates `tail` sends everything. */
export const LAST_ANSWER_MAX_BYTES = 4 * 1024 * 1024;
/** Turns whose state is kept while the history is read: the newest ones (the last finished turn is kept apart). */
export const LAST_ANSWER_TURNS = 8;
/** What the stream never sends, so the replay is read without it. */
const NOT_EVENTS: ReadonlySet<string> = new Set(["exec_complete"]);

/**
 * The turns of a history read for its last answer: one TurnState per message, and only the newest LAST_ANSWER_TURNS of
 * them, so a long history does not leave a state behind for every turn it ever had.
 */
export class Turns {
  readonly states = new Map<string, TurnState>();
  current = "";
  lastDone: TurnState | undefined;

  feed(event: SseEvent): void {
    const said = messageIdOf(event.data);
    this.current = truthy(said) ? textOf(said) : this.current;
    let state = this.states.get(this.current);
    if (state) {
      this.states.delete(this.current); // (moved to the newest end)
    } else {
      state = new TurnState(this.current);
    }
    this.states.set(this.current, state);
    while (this.states.size > LAST_ANSWER_TURNS) {
      const oldest = this.states.keys().next().value;
      if (oldest === undefined) break;
      this.states.delete(oldest);
    }
    if (state.feed(event).finished) this.lastDone = state;
  }
}

/** Replay rows `{event_id, event_type, data}` as the events the stream would have sent for them. */
export function replayed(
  rows: ReadonlyArray<{ event_id?: unknown; event_type?: unknown; data?: unknown }>,
): SseEvent[] {
  const events: SseEvent[] = [];
  for (const row of rows) {
    if (!isObject(row.data)) continue;
    const data = row.data;
    const name = typeof data["type"] === "string" && data["type"] ? data["type"] : row.event_type;
    if (typeof name === "string" && name && !NOT_EVENTS.has(name))
      events.push({ id: textOf(row.event_id), name, data });
  }
  return events;
}

/** The stream's history, read until it goes quiet after a finished turn, or READ_OVERALL_SECONDS at most. */
async function streamedTurns(claw: TurnClaw, clock: Clock, key: string, sessionId: string): Promise<Turns> {
  const turns = new Turns();
  const overall = new AbortController();
  const timer = sleepSeconds(clock, READ_OVERALL_SECONDS, overall.signal).then(
    () => {
      overall.abort(new Error("read overall"));
    },
    () => undefined,
  );
  const iterator = claw.stream(key, sessionId, undefined, overall.signal)[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await nextWithin(iterator, clock, turns.lastDone ? READ_IDLE_SECONDS : undefined, overall.signal);
      if (!next) break;
      turns.feed(next);
    }
  } finally {
    overall.abort(new Error("done"));
    await timer;
    await iterator.return?.();
  }
  return turns;
}

function nothing(): undefined {
  return undefined;
}

/** The iterator's next event, or undefined when it ended, went quiet for `idle` seconds, or the read is over. */
async function nextWithin(
  iterator: AsyncIterator<SseEvent>,
  clock: Clock,
  idle: number | undefined,
  signal: AbortSignal,
): Promise<SseEvent | undefined> {
  const quiet = new AbortController();
  const waits: Array<Promise<IteratorResult<SseEvent> | undefined>> = [iterator.next()];
  if (idle !== undefined) waits.push(sleepSeconds(clock, idle, quiet.signal).then(nothing, nothing));
  waits.push(
    new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          resolve(undefined);
        },
        { once: true },
      );
    }),
  );
  try {
    const result = await Promise.race(waits);
    return result && !result.done ? result.value : undefined;
  } catch (err) {
    if (signal.aborted) return undefined;
    throw err;
  } finally {
    quiet.abort();
  }
}

function answerOf(lastDone: TurnState | undefined, sessionId: string, deps: LastAnswerDeps): string | undefined {
  if (!lastDone) return undefined;
  const answer = lastDone.answer;
  if (!lastDone.failed) return answer;
  // as in a turn: the error that ended it is cut off and logged, the model's words stay
  const [words, error] = splitErrorTail(answer);
  if (!error) return answer;
  const ref = deps.errors.withhold("last_answer_failed", error, { session: sessionId });
  deps.log.info("the user is told the task failed", { ref });
  const told = turnText.in(pickLang(words)).taskFailed;
  return words ? `${words}\n\n${told}` : told;
}

export interface LastAnswerDeps {
  readonly claw: TurnClaw;
  readonly clock: Clock;
  readonly log: Logger;
  readonly errors: PublicErrors;
}

/**
 * The answer of the session's last finished turn (undefined: no turn has finished), read with `key`. Reads the last
 * LAST_ANSWER_TAIL events, never the whole history; when the replay cannot be read (other than refused), the stream's
 * history is read, keeping only the newest turns' states. Claw refuses either (401/403/404) for a session the key does not
 * own, which is what stops anybody reading somebody else's session.
 */
export async function lastAnswer(deps: LastAnswerDeps, key: string, sessionId: string): Promise<string | undefined> {
  let turns: Turns;
  try {
    const rows = await deps.claw.events(key, sessionId, {
      tail: LAST_ANSWER_TAIL,
      maxBytes: LAST_ANSWER_MAX_BYTES,
    });
    turns = new Turns();
    for (const event of replayed(rows)) turns.feed(event);
  } catch (err) {
    if (!isClawFailure(err)) throw err;
    if (err instanceof ClawError && [401, 403, 404].includes(err.status)) throw err;
    deps.log.info("the last answer is read from the stream: the replay was not used", { error: errorKind(err) });
    turns = await streamedTurns(deps.claw, deps.clock, key, sessionId);
  }
  return answerOf(turns.lastDone, sessionId, deps);
}
