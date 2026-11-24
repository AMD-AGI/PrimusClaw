// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { SseEvent } from "../claw/model.js";
import type { PublicErrors } from "../public-error/public-errors.js";
import { type RemoteStep, NOTHING, decode } from "./events.js";
import { SEEN_KEPT, SEGMENT_KEEP_CHARS, SEGMENTS_KEPT } from "./limits.js";
import { cpSlice, pyStrip } from "../text/py-text.js";

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
