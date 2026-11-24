// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { SseEvent } from "../claw/model.js";
import type { PublicErrors } from "../public-error/public-errors.js";
import { type RemoteStep, NOTHING, decode } from "./events.js";
import { SEEN_KEPT, SEGMENT_KEEP_CHARS, SEGMENTS_KEPT } from "./limits.js";
import { cpSlice, pyStrip } from "../text/py-text.js";

/** How many prompts a reader keeps track of at once (each is dropped at its turn's end, its refusal, or the session's end). */
const PROMPTS_KEPT = 32;

/**
 * The turns Claw puts to a session for itself (a seat's question, `CLAW_OWN_CLIENTS`). Every prompt Claw queues has its
 * `user_prompt`, and the agent runs them one after another, so the prompts read and not yet ended are a queue whose first is the
 * turn running now. While that one is Claw's own, every event is nothing to any reader of the chat: its text, steps and mode
 * switches. A prompt ends at its `turn_end` (one naming it, or the first one naming none) or its refusal; the session closing, or its
 * connector restarting with the turn gone, ends the running one, and a `turn_end` naming a prompt this reader never saw while Claw's
 * own is first means that one never ran (it is refused: an answer-only prompt is, behind another).
 */
export class OwnTurns {
  private readonly queue: { readonly seq: number; readonly own: boolean; readonly before: string }[] = [];
  private last = ""; // the id of the last event read

  /** The turn running now is one Claw put to the session for itself. */
  get hiding(): boolean {
    return this.queue[0]?.own === true;
  }

  /**
   * The read position a reader may write after reading up to `cursor`: while such a turn runs, the one before its prompt (`start`:
   * where the reader started, for a prompt that was the first event it read), so a reader that starts there hides the rest too.
   */
  hold(cursor: string, start: string): string {
    const first = this.queue[0];
    return first?.own === true ? first.before || start : cursor;
  }

  /** One event (`id`, '' none) and what it decoded to: whether no reader shows it. */
  hides(id: string, step: RemoteStep): boolean {
    const before = this.last;
    if (id) this.last = id;
    if (step.replay) return false;
    if (step.prompted !== null) {
      this.queue.push({ ...step.prompted, before });
      if (this.queue.length > PROMPTS_KEPT) this.queue.shift();
      return step.prompted.own;
    }
    if (step.closed !== null) {
      this.queue.length = 0;
      return false;
    }
    if (step.recovered !== null && !step.recovered.continuing) {
      this.queue.shift();
      return false;
    }
    if (step.finished) return this.ended(step.endsSeq);
    if (step.rejected?.type === "prompt" && step.rejected.cmdSeq !== null)
      return this.drop(step.rejected.cmdSeq) ?? false;
    return this.hiding;
  }

  /** A turn end: the prompt it names, else the one running, is over. Whether it was Claw's own (then it is not shown). */
  private ended(seq: number | null): boolean {
    if (seq === null) return this.queue.shift()?.own === true;
    const own = this.drop(seq);
    if (own !== undefined) return own;
    if (this.hiding) this.queue.shift(); // (a turn this reader never saw the prompt of ran first: Claw's own did not run)
    return false;
  }

  /** Forget the prompt `seq`: whether it was Claw's own, undefined when it is not one this reader saw. */
  private drop(seq: number): boolean | undefined {
    const at = this.queue.findIndex((p) => p.seq === seq);
    if (at < 0) return undefined;
    return this.queue.splice(at, 1)[0]?.own;
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
