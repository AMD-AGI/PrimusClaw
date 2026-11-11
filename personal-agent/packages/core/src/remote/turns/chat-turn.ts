// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A remote agent's turn as the chat shows it: with a stream, the agent's words fill the answer's bubble as it writes them (each
 * stretch of text between two of its steps is a paragraph) and the floating status says the step running now; the final message
 * is the answer, in the same bubble. Where the stream is refused, the turn is shown by a progress message edited in place.
 *
 * The agent's words are untrusted: what is streamed is credential-masked over the whole text, and the raw error of a failed call
 * is cut off. In a chat that is the agent's window itself (`signer`), its words are shown under its head from the first update on,
 * later messages get a short head of their own, and the way on and back goes under the last message.
 */
import { errorName } from "../../errors.js";
import type { Logger } from "../../ports/logger.js";
import type { Clock } from "../../ports/clock.js";
import { type OutMessage, richMessage } from "../../ports/surface.js";
import { answerParts } from "../answer.js";
import { type RemoteStep } from "../events.js";
import type { RemoteLive } from "../ports.js";
import { cpLength, pyRstrip, pyStrip } from "../../text/py-text.js";
import { redactText } from "../../security/redact.js";
import {
  type LiveViewLike,
  STREAM_TEXT_MAX,
  type StatusPolicy,
  type StreamFinish,
  type StreamFinishInput,
  defaultStreamFinish,
} from "../../turn/progress/status-policy.js";
import { plainMessage } from "../../turn/progress/answer-messages.js";
import { StatusMessage } from "../../turn/progress/status-message.js";
import type { TurnSurface } from "../../turn/ports.js";
import type { FinishWith, TurnDisplay } from "./display.js";
import type { Signer } from "./signer.js";
import { inertAnswer } from "../links/answer.js";

/** What the bubble shows of a remote turn, and how its stream ends. */
export class RemoteStatusPolicy implements StatusPolicy<RemoteStep> {
  /** A line of ours after the answer (how the turn ended): not the agent's words. */
  tail = "";
  private readonly segments: string[] = [];
  private newSegment = true;

  /** The live view as the status shows it (a remote turn has no setup phase: it never says "Preparing"). */
  readonly view: LiveViewLike;

  constructor(
    private readonly live: RemoteLive,
    private readonly cutError: (text: string) => string,
    private readonly signer: Signer | null,
  ) {
    this.view = {
      header: live.header,
      preparing: false,
      render: () => live.render(),
      statusLines: () => live.statusLines(),
    };
  }

  applyStep(step: RemoteStep): boolean {
    let changed = this.live.apply(step);
    if (step.chunk?.kind === "message") {
      if (this.newSegment || this.segments.length === 0) {
        this.segments.push("");
        this.newSegment = false;
      }
      const last = this.segments.length - 1;
      this.segments[last] = (this.segments[last] ?? "") + step.chunk.text;
      changed = true;
    } else if (step.tool) {
      this.newSegment = true;
    }
    return changed;
  }

  /**
   * Everything the agent has written this turn, as it is shown (under its head, with a signer). `settled`: only what the rest of the
   * text can no longer change, for the bubble while the agent still writes (`streamable`).
   */
  private saidText(settled = false): string {
    let text = this.segments
      .map((s) => pyStrip(s))
      .filter(Boolean)
      .join("\n\n");
    if (settled) text = withoutOpenCode(text);
    // (its links become words; a link still being written changes what was streamed, and the answer then comes whole)
    const shown = pyRstrip(inertAnswer(this.cutError(redactText(text).text)));
    return this.signer !== null && shown ? this.signer.first(shown) : shown;
  }

  streamable(streamed: string): string {
    const text = this.saidText(true);
    if (!text || cpLength(text) > STREAM_TEXT_MAX || !text.startsWith(streamed)) return streamed;
    return text;
  }

  /**
   * The bubble holds the agent's words. The final message keeps them (the chat refuses a stream whose text shrinks), and what the
   * agent wrote after them follows as messages of its own: nothing is said twice. The line of ours about how the turn ended goes
   * last. Only when the words shown are not the start of what the agent wrote (a mask that moved) does it end as every turn's does.
   */
  finishStream(input: StreamFinishInput): StreamFinish | undefined {
    const said = this.saidText();
    if (!input.streamed || !said.startsWith(input.streamed)) return defaultStreamFinish(input);
    let shown = bubbleEnd(said, input);
    const rest = pyStrip(said.slice(shown.length));
    let more = rest ? answerParts(rest) : [];
    if (this.signer !== null && more.length > 0) more = this.signer.later(more, 2);
    if (this.tail) {
      if (more.length > 0) more[more.length - 1] = `${more.at(-1) ?? ""}\n\n${this.tail}`;
      else shown = `${pyRstrip(shown)}\n\n${this.tail}`;
    }
    const ai = input.options.ai ?? false;
    let final: OutMessage = plainMessage(pyRstrip(shown), ai);
    const follow: OutMessage[] = more.map((part) => richMessage(part, { lead: false, aiGenerated: ai }));
    const replies = this.signer?.replies ?? [];
    if (replies.length > 0) {
      // (under the last message of the answer: the chat shows them there only)
      const last = follow.at(-1);
      if (last) follow[follow.length - 1] = { ...last, suggestions: replies };
      else final = { ...final, suggestions: replies };
    }
    return { final, rest: follow };
  }
}

/** What the bubble ends with: all the agent wrote while it fits (a code span held back while it was open, too), else what it showed. */
function bubbleEnd(said: string, input: StreamFinishInput): string {
  return said && cpLength(said) <= STREAM_TEXT_MAX ? said : input.streamable || input.streamed;
}

/** A fence line, as the rich text reads one (`links/answer.ts`): its backticks open a code block, not a code span. */
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/u;

/**
 * `text` up to a code span still being written: on its last line (where the agent is still writing; a span never crosses a line), the
 * first run of backticks that no later run of the same length closes, and what follows it. Streamed, such a backtick is shown as a
 * look-alike (`inertAnswer`: one the rich text cannot pair), and once the agent closes the span it is a backtick again: the text no
 * longer begins with what the bubble shows, so the bubble ends on that lone character and the answer follows as a message of its own
 * (2026-11-11 guide re-check: a reply that began with `` `hook.txt` `` ended its bubble on "ˋ"). Escaped backticks open nothing.
 */
export function withoutOpenCode(text: string): string {
  const start = text.lastIndexOf("\n") + 1;
  const line = text.slice(start);
  if (FENCE_LINE.test(line)) return text;
  const runs: [number, number][] = [];
  for (let i = 0; i < line.length;) {
    if (line.charAt(i) === "\\") {
      i += 2;
      continue;
    }
    if (line.charAt(i) !== "`") {
      i += 1;
      continue;
    }
    let j = i;
    while (line.charAt(j) === "`") j += 1;
    runs.push([i, j - i]);
    i = j;
  }
  for (let n = 0; n < runs.length; n += 1) {
    const [at, length] = runs[n] ?? [0, 0];
    const closer = runs.findIndex(([, l], m) => m > n && l === length);
    if (closer < 0) return text.slice(0, start + at);
    n = closer;
  }
  return text;
}

/** The turn shown in the chat (a stream, else a progress message), as a `TurnDisplay`. */
export class ChatTurn implements TurnDisplay {
  private readonly status: StatusMessage<RemoteStep>;

  constructor(
    private readonly surface: TurnSurface,
    private readonly policy: RemoteStatusPolicy,
    private readonly options: {
      readonly clock: Clock;
      readonly log: Logger;
      readonly lang: string;
      readonly replyTo: string | undefined;
    },
  ) {
    this.status = new StatusMessage(surface, {
      clock: options.clock,
      log: options.log,
      lang: options.lang,
      policy,
      streamReplyTo: options.replyTo,
    });
  }

  get tail(): string {
    return this.policy.tail;
  }

  set tail(line: string) {
    this.policy.tail = line;
  }

  begin(): void {
    this.status.begin();
    // (a stream shows the channel's own status at once: no typing indicator besides it)
    if (this.options.replyTo === undefined) {
      this.surface.typing().catch((error: unknown) => {
        this.options.log.warn("typing indicator failed; the turn goes on", { error: errorName(error) });
      });
    }
  }

  progress(step: RemoteStep): void {
    this.status.progress(step);
  }

  close(hard = false): void {
    this.status.close(hard);
  }

  finish(parts: readonly string[], options: FinishWith): Promise<void> {
    return this.status.finish(parts, { rich: true, feedback: false, ai: options.ai, replies: options.replies });
  }
}
