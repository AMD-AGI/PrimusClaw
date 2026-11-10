// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's turn, followed live while it answers a message, so that its receipt moves (teams_agent/assistant_follow.py).
 *
 * The turn's live stream says each tool it calls (`toolUsed`) and the words of its reply as the model writes them
 * (`toolTextDelta`); this shows the step it is on, then the words, in the receipt. The reply itself still comes by notification
 * and closes the receipt. Best effort: a stream that cannot be opened, breaks or says nothing leaves the receipt as it was. Only
 * the live part is read (`LIVE_ONLY`), until the turn has spoken or ended, the receipt is closed, or FOLLOW_SECONDS have passed.
 */
import type { SseEvent } from "../claw/model.js";
import { errorName } from "../errors.js";
import type { Lang } from "../locales/lang.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { Receipt } from "./receipt.js";

/** An event id later than every id Claw gives: the stream sends no history, only what happens from now on. */
export const LIVE_ONLY = "claw-99999999999999";
export const FOLLOW_SECONDS = 180;
/** How long a message waits for its turn's stream to open (`TurnFollower.waitOpen`); later, it is sent anyway. */
export const FOLLOW_OPEN_SECONDS = 2.0;
export const SAY_TOOL = "mcp__assistant__say";
const TEXT_DELTA = "toolTextDelta";
/** Claw takes back the say text it streamed for the turn: the say is not going to be said. */
const TEXT_VOID = "toolTextVoid";
const STEP_ELLIPSIS = "…";

/** Opens the session's live stream after `after`; closed when `signal` aborts. */
/** The session's stream from `after`; `onOpen` once Claw has answered its request, before any event. */
export type OpenStream = (after: string, signal: AbortSignal, onOpen: () => void) => AsyncIterable<SseEvent>;
/** The step a tool call is, in the person's language (step_labels.lookup_label). */
export type StepLabel = (tool: string, lang: Lang) => string;

/**
 * Whether a say's terminal toolUsed event says it was sent: not when the call failed, or Claw answered it with a refusal
 * (`{"ok": false, ...}` as its `description`).
 */
export function said(data: Readonly<Record<string, unknown>>): boolean {
  if (data["status"] === "error" || data["is_error"] === true) return false;
  const description = data["description"];
  let answer: unknown;
  try {
    answer = JSON.parse(typeof description === "string" ? description : "");
  } catch {
    return true; // (a result cut short, or not JSON: nothing says it failed)
  }
  return !(typeof answer === "object" && answer !== null && (answer as Record<string, unknown>)["ok"] === false);
}

export interface FollowerOptions {
  readonly open: OpenStream;
  readonly receipt: Receipt;
  readonly lang: Lang;
  /** Stream the reply's words into the receipt (style `assistant_stream_say`). */
  readonly streamSay: boolean;
  readonly stepLabel: StepLabel;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * One message's turn, followed into its receipt: `start` before the message is handed over, then `answers(messageId)` with the
 * id Claw gave it, or `answers(undefined)` when there is none (then nothing is shown).
 */
export class TurnFollower {
  private messageId: string | undefined;
  private known = false;
  private readonly early: SseEvent[] = [];
  private readonly steps: string[] = [];
  private readonly stop = new AbortController();
  private knownWaiters: (() => void)[] = [];
  /** Settles when following has ended (for tests and orderly shutdown). */
  done: Promise<void> = Promise.resolve();
  private markOpen: () => void = () => undefined;
  /** Claw has answered the stream's request (or it could not open at all): the turn's events reach it from now on. */
  private readonly opened = new Promise<void>((resolve) => {
    this.markOpen = resolve;
  });

  constructor(private readonly options: FollowerOptions) {}

  start(): void {
    this.done = this.run();
  }

  /**
   * Wait, at most `seconds`, until Claw has answered the stream's request, so that a message sent after it cannot have its turn's
   * first event go by before the stream is there (the stream reads only what comes after it opens: LIVE_ONLY). False when it
   * did not open in time (the receipt then shows what reaches it, as before). A stream that could not open at all ends the wait.
   */
  async waitOpen(seconds: number): Promise<boolean> {
    const timer = new AbortController();
    const late = this.options.clock.sleep(seconds * 1000, timer.signal).then(
      () => true,
      () => true,
    );
    try {
      if (await Promise.race([this.opened.then(() => false), late])) {
        this.options.logger.info("the assistant's turn stream did not open in time");
        return false;
      }
      return true;
    } finally {
      timer.abort();
    }
  }

  /** The id of the message the followed turn answers; undefined stops following. */
  answers(messageId: string | undefined): void {
    this.messageId = messageId;
    this.known = true;
    for (const resolve of this.knownWaiters.splice(0)) resolve();
    if (messageId === undefined) this.stop.abort();
  }

  private async run(): Promise<void> {
    const { clock, receipt, logger } = this.options;
    const timer = new AbortController();
    const following = this.follow().finally(() => {
      this.markOpen(); // (a stream that could not open frees whoever waits for it)
    });
    const outcome = await Promise.race([
      following.then(
        () => undefined,
        (error: unknown) => error,
      ),
      receipt.closed().then(() => undefined),
      clock.sleep(FOLLOW_SECONDS * 1000, timer.signal).then(
        () => undefined,
        () => undefined,
      ),
    ]);
    const cancelled = this.stop.signal.aborted; // (answers(undefined): nothing to show, nothing went wrong)
    timer.abort();
    this.stop.abort();
    if (outcome !== undefined && !cancelled) {
      // (Claw down, the stream refused or cut: the receipt stays as it was)
      logger.info("the assistant's turn could not be followed into its receipt", { error: errorName(outcome) });
    }
  }

  private async follow(): Promise<void> {
    const onOpen = (): void => {
      this.markOpen();
    };
    for await (const event of this.options.open(LIVE_ONLY, this.stop.signal, onOpen)) {
      if (this.stop.signal.aborted) return;
      if (!this.known) {
        this.early.push(event);
        continue;
      }
      for (const e of [...this.early.splice(0), event]) {
        if (this.apply(e)) return;
      }
    }
  }

  /** Show what `event` says the followed turn did. True when the turn has spoken or ended: nothing more to follow. */
  private apply(event: SseEvent): boolean {
    const { data, name } = event;
    if ((data["message_id"] || data["turn_message_id"]) !== this.messageId) return false;
    if (name === "AssistantSay") return true;
    if (name === "ResultMessage" || name === "error") {
      this.options.receipt.voidText(); // (the turn ended without a say: words shown of one were not said)
      return true;
    }
    const tool = typeof data["tool"] === "string" ? data["tool"] : "";
    if (tool === SAY_TOOL) this.applySay(name, data);
    else if (name === "toolUsed" && data["status"] === "start" && tool) this.applyStep(tool);
    return false;
  }

  /** The say's own events: its words as the model writes them, or that they will not be said. */
  private applySay(name: string, data: SseEvent["data"]): void {
    const { receipt, streamSay } = this.options;
    if (name === TEXT_VOID || (name === "toolUsed" && data["status"] !== "start" && !said(data))) {
      receipt.voidText(); // (a refused say, or the turn handed a review back: its words were not sent)
    } else if (name === TEXT_DELTA && streamSay && typeof data["text"] === "string") {
      receipt.showText(data["text"].replace(/^\s+/u, "")); // (the reply is stored trimmed: what is shown must be its start)
    }
  }

  /** A tool call starts: its step joins the steps shown so far. */
  private applyStep(tool: string): void {
    const line = this.options.stepLabel(tool, this.options.lang);
    if (!this.steps.includes(line)) this.steps.push(line);
    this.options.receipt.showStep(this.steps.join(" · ") + STEP_ELLIPSIS);
  }
}
