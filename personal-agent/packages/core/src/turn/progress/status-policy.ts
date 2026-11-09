// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a StatusMessage shows of a turn, and how it closes its live stream: injected, so that a turn of another kind (a
 * remote agent's) shows its own steps and words through the same status message. `TurnStatusPolicy` is a Claw turn's.
 */

import type { OutMessage } from "../../ports/surface.js";
import { cpLength, pyStrip } from "../../text/py-text.js";
import { LiveView } from "../live-view.js";
import type { Step } from "../step.js";
import { type FinishOptions, plainMessage } from "./answer-messages.js";

/** The agent's text streamed into a bubble stops growing here; the answer still comes whole. */
export const STREAM_TEXT_MAX = 6000;

/** What a status message needs of a live view: its first line, its text, its status lines and the setup flag. */
export interface LiveViewLike {
  readonly header: string;
  /** Setup is running: one transient line at the end. */
  preparing: boolean;
  render(): string;
  /** The view as a floating status's lines; `withWords`: the agent's own words and plan may be shown (a 1:1 chat). */
  statusLines(withWords: boolean): string[];
}

/** Everything the stream's last message is decided from. */
export interface StreamFinishInput {
  /** What the bubble shows now. */
  readonly streamed: string;
  /** What the policy would stream now (`streamable(streamed)`). */
  readonly streamable: string;
  /** The answer's messages as they would be sent without a stream. */
  readonly messages: readonly OutMessage[];
  readonly parts: readonly string[];
  readonly options: FinishOptions;
}

/** The stream's final message, and what follows it as messages of their own. */
export interface StreamFinish {
  readonly final: OutMessage;
  readonly rest: readonly OutMessage[];
}

export interface StatusPolicy<S> {
  readonly view: LiveViewLike;
  /** Fold one step in; true when what is shown changed. */
  applyStep(step: S): boolean;
  /** The text the bubble should hold now, given what it shows (`streamed`); '' when there is nothing to stream. */
  streamable(streamed: string): string;
  /**
   * The final message when the bubble holds streamed text (`input.streamed` not ''); undefined: the default (the text
   * as it stands, and the answer after it unless it ends with the answer).
   */
  finishStream?(input: StreamFinishInput): StreamFinish | undefined;
}

/**
 * The default way a stream that holds text closes: the final keeps all of it (the chat refuses a stream whose content
 * shrinks). When it ends with the answer, that is the whole of it (thumbs and replies go on it); otherwise the answer
 * follows as messages of its own.
 */
export function defaultStreamFinish(input: StreamFinishInput): StreamFinish {
  const { messages, parts, options } = input;
  const text = input.streamable || input.streamed;
  const whole = parts.length > 0 && text.endsWith(pyStrip(parts.join("\n\n")));
  let final = plainMessage(text, options.ai ?? false);
  const suggestions = messages.at(-1)?.suggestions;
  if (whole)
    final = { ...final, ...(options.feedback ? { feedback: true } : {}), ...(suggestions ? { suggestions } : {}) };
  return { final, rest: whole ? [] : messages };
}

/**
 * A Claw turn's status: the LiveView of its steps, and with `streamText` the agent's whole model turns and the one being
 * written, streamed into the answer's bubble up to STREAM_TEXT_MAX.
 */
export class TurnStatusPolicy implements StatusPolicy<Step> {
  private readonly said: string[] = [];
  private partial = "";

  constructor(
    readonly view: LiveView,
    private readonly streamText: boolean,
  ) {}

  applyStep(step: Step): boolean {
    const changed = this.view.apply(step);
    if (this.streamText && step.narration) {
      this.said.push(step.narration);
      this.partial = "";
      return true;
    }
    if (this.streamText && step.partial) {
      this.partial = step.partial;
      return true;
    }
    return changed;
  }

  streamable(streamed: string): string {
    if (!this.streamText) return "";
    const text = [...this.said, ...(this.partial ? [this.partial] : [])].join("\n\n");
    return cpLength(text) > STREAM_TEXT_MAX || !text.startsWith(streamed) ? streamed : text;
  }
}
