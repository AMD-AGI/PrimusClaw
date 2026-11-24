// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { SseEvent } from "../claw/model.js";
import type { PublicErrors } from "../public-error/public-errors.js";
import { type RemoteStep, NOTHING, decode } from "./events.js";
import { SEEN_KEPT, SEGMENT_KEEP_CHARS, SEGMENTS_KEPT } from "./limits.js";
import { cpSlice, pyStrip } from "../text/py-text.js";

/**
 * The turns Claw puts to a session for itself (a seat's question, `CLAW_OWN_CLIENTS`): its prompt (`user_prompt`) starts one, and
 * everything until its end is nothing to any reader of the chat. Its end (`turn_end` naming it or naming none, an error, the connector
 * refusing it) ends it; the session closing, its connector restarting with the turn gone, or a turn end naming another prompt end it
 * and are read as usual.
 */
export class OwnTurns {
  private hidden: number | null = null;
  private last = ""; // the id of the last event read
  /** The id of the event read before the start of the hidden turn open now ('' none, or none was read before it). */
  from = "";

  get hiding(): boolean {
    return this.hidden !== null;
  }

  /**
   * The read position a reader may write after reading up to `cursor`: while such a turn is open, the one before its start (`start`:
   * where the reader started, for a turn that began with the first event it read), so a reader that starts there hides the rest too.
   */
  hold(cursor: string, start: string): string {
    return this.hidden === null ? cursor : this.from || start;
  }

  /** One event (`id`, '' none) and what it decoded to: whether it is part of such a turn (its start and end included). */
  hides(id: string, step: RemoteStep): boolean {
    const before = this.last;
    if (id) this.last = id;
    if (step.replay) return false;
    if (step.hiddenTurn !== null) {
      if (this.hidden === null) this.from = before;
      this.hidden = step.hiddenTurn;
      return true;
    }
    const hidden = this.hidden;
    if (hidden === null) return false;
    if (OwnTurns.endsOutside(step, hidden)) {
      this.hidden = null;
      return false;
    }
    if (step.finished || (step.rejected?.type === "prompt" && step.rejected.cmdSeq === hidden)) this.hidden = null;
    return true;
  }

  /** The hidden turn is over and this event is not part of it: the session closed, the connector restarted without the turn, or
   * another prompt's turn ended. */
  private static endsOutside(step: RemoteStep, hidden: number): boolean {
    const recoveredWithout = step.recovered !== null && !step.recovered.continuing;
    const othersEnd = step.finished && step.endsSeq !== null && step.endsSeq !== hidden;
    return step.closed !== null || recoveredWithout || othersEnd;
  }
}

/**
 * One turn of a remote agent, folded event by event. The stream is read from the cursor after the previous turn's end, so every
 * message chunk until the turn's end is this turn's. Like Claw's own turns, the answer is the agent's last piece of text: the text
 * before a tool call is narration, shown while it runs. What it holds is bounded, however long a turn runs.
 */
export class RemoteTurnState {
  /** Event ids already seen, oldest first (at most SEEN_KEPT). */
  readonly seen = new Set<string>();
  /** Message text, one entry per stretch between tool calls (at most SEGMENTS_KEPT). */
  readonly segments: string[] = [];
  stopReason = "";
  ended = false;
  closed: string | null = null;
  note: string | null = null;
  private toolSinceText = true;
  private readonly own = new OwnTurns();

  constructor(
    private readonly errors: PublicErrors,
    /**
     * Claw's number of the prompt this turn answers, read at each event (a queued message's reader may start before its send has
     * answered): the connector's refusal of it ends the turn (no `turn_end` follows one).
     */
    private readonly seqOf: () => number | undefined = () => undefined,
  ) {}

  feed(event: SseEvent): RemoteStep {
    if (event.id && this.seen.has(event.id)) return NOTHING;
    if (event.id) this.remember(event.id);
    const step = decode(event, this.errors);
    if (this.own.hides(event.id, step)) return NOTHING;
    if (step.replay) return step;
    // (the end of another prompt's turn, one queued in front of this one: not this turn's, and nothing to show)
    if (this.othersEnd(step)) return NOTHING;
    if (step.chunk?.kind === "message") {
      this.addText(step.chunk.text);
    } else if (step.tool) {
      this.toolSinceText = true;
    }
    if (step.finished) this.end(step.stopReason, step.note);
    if (step.closed !== null) this.closed = step.closed;
    // (the connector refused this turn's own prompt: no turn_end follows that)
    if (this.refusedOwn(step)) this.end("error", step.rejected?.reason ?? null);
    return step;
  }

  /** A turn Claw put to the session for itself is being read: no reader shows it (its text, steps, mode switches). */
  get hiding(): boolean {
    return this.own.hiding;
  }

  /**
   * The read position a reader may write after reading up to `cursor`: never past the start of a turn Claw put to the session for
   * itself while it is being read, so a reader that starts there hides the rest of it too (`from`: where this reader started, for a
   * hidden turn that began with the first event it read).
   */
  holdCursor(cursor: string, from: string): string {
    return this.own.hold(cursor, from);
  }

  /** A turn end that names another prompt than this turn's. */
  private othersEnd(step: RemoteStep): boolean {
    const mine = this.seqOf();
    return step.finished && mine !== undefined && step.endsSeq !== null && step.endsSeq !== mine;
  }

  /** The connector refused the prompt this turn answers. */
  private refusedOwn(step: RemoteStep): boolean {
    const mine = this.seqOf();
    return step.rejected?.type === "prompt" && mine !== undefined && step.rejected.cmdSeq === mine;
  }

  private end(stopReason: string, note: string | null): void {
    this.ended = true;
    this.stopReason = stopReason;
    this.note = note;
  }

  /** The agent's last piece of text, stripped. */
  get answer(): string {
    for (let i = this.segments.length - 1; i >= 0; i -= 1) {
      const text = pyStrip(this.segments[i] ?? "");
      if (text) return text;
    }
    return "";
  }

  /** The answer so far, and the text is forgotten (the event ids already seen are not): what a reader that goes on after a
   * piece of the agent's output was delivered folds the next piece from. */
  takeAnswer(): string {
    const text = this.answer;
    this.segments.length = 0;
    this.toolSinceText = true;
    this.ended = false;
    this.stopReason = "";
    this.note = null;
    return text;
  }

  private remember(id: string): void {
    this.seen.add(id);
    for (const oldest of this.seen) {
      if (this.seen.size <= SEEN_KEPT) break;
      this.seen.delete(oldest);
    }
  }

  private addText(text: string): void {
    if (this.toolSinceText || this.segments.length === 0) {
      this.segments.push("");
      this.segments.splice(0, Math.max(0, this.segments.length - SEGMENTS_KEPT));
      this.toolSinceText = false;
    }
    const last = this.segments.length - 1;
    this.segments[last] = cpSlice((this.segments[last] ?? "") + text, 0, SEGMENT_KEEP_CHARS);
  }
}
