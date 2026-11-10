// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's receipt (teams_agent/stream.py, the receipt half): a message to the assistant returns at once and the assistant
 * answers later, by notification; the receipt is a live stream opened when the message is handed over ("Working on it…"
 * under it), and the assistant's first reply to that chat closes it, so the reply appears where the status was. A reply that does
 * not come before RECEIPT_CLOSE_SECONDS closes it with "running in the background", and the reply comes as a message of its own.
 *
 * While the turn runs, the step it is on (`showStep`) and the words of its reply as the model writes them (`showText`) may be
 * shown: only the newest of either is sent. Words streamed in are only a preview: words known not to be said (`voidText`) never stay
 * as the message. A receipt kept for the answer of a handed-back review (`reserve`) is closed by that answer only.
 *
 * The stream itself (pacing, one per conversation, Teams' refusals) is the channel's (`ReceiptStream`, Teams: W3's TeamsStream).
 */
import { errorName } from "../errors.js";
import type { Lang } from "../locales/lang.js";
import { receiptText } from "../locales/assistant.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { MessageId, OutMessage, StreamRefused, UpdateOptions } from "../ports/surface.js";
import type { Result } from "../result.js";
import { cpLength, pyRstrip, pyStrip } from "../text/py-text.js";
import { informativeText } from "./informative.js";

/** Teams closes a stream 10 minutes after its first request; the receipt closes itself before that. */
export const RECEIPT_CLOSE_SECONDS = 9 * 60;
/** The reply's words streamed into the receipt stop growing here; the reply itself still comes whole. */
export const STREAM_SAY_MAX = 4000;

/** What the receipt needs of a live stream (a superset of the Surface's `LiveStream`). */
export interface ReceiptStream {
  /** Still open: no final was sent and Teams has not closed it. */
  readonly open: boolean;
  /** The text streamed so far ("" none). */
  readonly streamed: string;
  /** The stream's message id once Teams gave one ("" before). */
  readonly streamId: MessageId;
  /** The person's message the stream answers. */
  readonly replyTo: MessageId;
  /** A final may still be refused and then edited into place: the stream has an id and was not closed. */
  readonly closable: boolean;
  /** Seconds since the stream's first request. */
  ageSeconds(): number;
  /** A status update; once `options.signal` aborts it is given up at once (refused). */
  inform(text: string, options?: UpdateOptions): Promise<Result<void, StreamRefused>>;
  /** The reply's words so far; as `inform`. */
  emit(text: string, options?: UpdateOptions): Promise<Result<void, StreamRefused>>;
  final(message: OutMessage): Promise<Result<void, StreamRefused>>;
  /** Replace the posted message `id` (the stream's, once it was closed). */
  update(id: MessageId, message: OutMessage): Promise<void>;
  delete(id: MessageId): Promise<void>;
}

type Wanted = { readonly kind: "informative" | "streaming"; readonly text: string };

function textOnly(message: OutMessage, text: string): OutMessage {
  return { ...message, body: { type: "text", text } };
}

function plainMessage(text: string): OutMessage {
  return { body: { type: "text", text } };
}

/** The words a message carries as text ("" for a view). */
export function messageWords(message: OutMessage): string {
  if (message.body.type === "text") return message.body.text;
  if (message.body.type === "rich") return message.body.markdown;
  return "";
}

export class Receipt {
  /** Closed, or being closed: nothing more is shown in it. */
  done = false;
  /** Kept for the answer of a handed-back review. */
  reserved = false;
  /** The words shown are known not to be said. */
  voided = false;
  /** The line the reply starts with (direct chat: Clawy's head), shown before its words. */
  head = "";
  /**
   * Which turn of the assistant's session answers the message this receipt stands under (`answeredBy`): its id, once Claw gave
   * one; for a message Claw queued (no id), the turn it was queued behind, read just before it was sent. `unsent`: the message
   * is not yet handed to Claw, so no turn there can be answering it.
   */
  messageId: string | undefined;
  behind: string | undefined;
  unsent = false;
  private want: Wanted | undefined;
  private sender: Promise<void> | undefined;
  private readonly closedWaiters: (() => void)[] = [];
  private readonly closer = new AbortController();
  /** Aborted when the receipt is dropped: an update on its way is given up. */
  private readonly updates = new AbortController();

  constructor(
    readonly stream: ReceiptStream,
    readonly conversation: string,
    readonly lang: Lang,
    private readonly log: Logger,
  ) {}

  /** The message is not yet handed to Claw (the assistant opened the receipt): nothing Claw says answers it yet. */
  awaitHandOver(): void {
    this.unsent = true;
  }

  /** The message is being handed to Claw now: from here on a turn may answer it, other than `behind` (a queued one runs after it). */
  handingOver(behind: string | undefined): void {
    this.behind = behind;
    this.unsent = false;
  }

  /** Claw took the message: when it gave the message's id, only the turn of that id answers it (none: it was queued). */
  takenAs(messageId: string | null | undefined): void {
    if (messageId) this.messageId = messageId;
  }

  /**
   * Whether a reply said by the turn `turn` (an `assistant.say`'s `turn_message_id`) may close this receipt: only the message's own
   * turn's may (stream.py `Receipt.answered_by`). Another turn of the same session says something else, and its words under this
   * message would read as the answer to it. Nothing Claw says before the message is handed over answers it, not even a reply that
   * names no turn (Claw's notice of a lost turn names none). After that, a reply that names no turn, or a receipt that knows
   * neither its turn nor the one in front of it, closes it as before.
   */
  answeredBy(turn: string | undefined): boolean {
    if (this.unsent) return false;
    if (!turn) return true;
    if (this.messageId) return turn === this.messageId;
    return turn !== this.behind;
  }

  /** Resolves when the receipt is closed (or being closed): what follows the turn stops then. */
  closed(): Promise<void> {
    return this.done ? Promise.resolve() : new Promise((resolve) => this.closedWaiters.push(resolve));
  }

  /** Show `line` as the status, unless words of the reply are shown already. */
  showStep(line: string): void {
    if (pyStrip(line) && !this.stream.streamed) this.show({ kind: "informative", text: line });
  }

  /** Show the reply's words so far: ignored once they no longer grow from what is shown, pass STREAM_SAY_MAX, or are not to be shown. */
  showText(words: string): void {
    if (this.reserved || this.voided) return;
    const text = this.head && pyStrip(words) ? `${this.head}\n\n${words}` : words;
    const shown = this.stream.streamed;
    if (pyStrip(text) && text.startsWith(shown) && text !== shown && cpLength(text) <= STREAM_SAY_MAX) {
      this.show({ kind: "streaming", text });
    }
  }

  /** The words shown are not going to be said: nothing more is streamed, and the receipt is not closed with them. */
  voidText(): void {
    this.voided = true;
    if (this.want?.kind === "streaming") this.want = undefined;
  }

  private show(wanted: Wanted): void {
    if (this.done || !this.stream.open) return;
    this.want = wanted;
    this.sender ??= this.sendWanted().finally(() => {
      this.sender = undefined;
    });
  }

  /** Send the newest wanted update, then the one wanted meanwhile, until there is none; a refusal ends it. */
  private async sendWanted(): Promise<void> {
    while (this.want !== undefined && !this.done && this.stream.open) {
      const { kind, text } = this.want;
      this.want = undefined;
      const options = { signal: this.updates.signal };
      const sent =
        kind === "informative"
          ? await this.stream.inform(informativeText([text]), options)
          : text.startsWith(this.stream.streamed)
            ? await this.stream.emit(text, options)
            : undefined;
      if (sent !== undefined && !sent.ok) return;
    }
  }

  /** Nothing more is shown, and an update already on its way has gone (or failed), so what was shown is final. */
  private async settle(): Promise<void> {
    this.done = true;
    this.want = undefined;
    for (const resolve of this.closedWaiters.splice(0)) resolve();
    try {
      await this.sender;
    } catch (error) {
      this.log.warn("a status update of the assistant's receipt failed", { error: errorName(error) });
    }
  }

  /**
   * The worker stops: the receipt is dropped, not closed (Python's shutdown cancels its tasks; the channel ends the stream
   * itself). Its close timer is cancelled, an update on its way to the channel is given up, and what follows the turn stops
   * (`closed()` resolves), so nothing keeps the process up.
   */
  drop(): void {
    this.closer.abort();
    this.updates.abort();
    this.done = true;
    this.want = undefined;
    for (const resolve of this.closedWaiters.splice(0)) resolve();
  }

  /** Close the receipt by itself at RECEIPT_CLOSE_SECONDS unless a reply closed it first. */
  arm(clock: Clock, stillMine: () => boolean, onClose: () => void): void {
    const wait = Math.max(RECEIPT_CLOSE_SECONDS - this.stream.ageSeconds(), 0) * 1000;
    clock.sleep(wait, this.closer.signal).then(
      async () => {
        if (!stillMine()) return;
        onClose();
        await this.closeInTime();
      },
      () => undefined, // (cancelled: a reply closed it)
    );
  }

  private async closeInTime(): Promise<void> {
    await this.settle();
    const shown = this.voided || this.reserved ? "" : this.stream.streamed;
    const background = receiptText.in(this.lang).background;
    // (words shown must stay: Teams refuses a stream whose text shrinks)
    const closed = shown
      ? (await this.stream.final(plainMessage(`${shown}\n\n${background}`))).ok
      : await this.closeReplacing(plainMessage(background));
    if (!closed) this.log.warn("the assistant receipt could not be closed; Teams closes it at 10 minutes");
  }

  /** The reply's words this receipt shows, final: nothing more is shown in it from now on. */
  async shownWords(): Promise<string> {
    await this.settle();
    return this.stream.streamed;
  }

  /**
   * Send `message` (the assistant's reply; `words` its words as written) as the receipt's final message. False: it was not sent
   * (the caller sends it as a message of its own). Words already streamed are kept (the reply is sent as them, now whole); a view
   * that starts with them closes the stream with the words and is a message of its own; a reply that does not start with them
   * replaces them.
   */
  async deliver(message: OutMessage, words?: string): Promise<boolean> {
    this.closer.abort();
    await this.settle();
    const shown = this.stream.streamed;
    if (!shown) return (await this.stream.final(message)).ok;
    // (the reply is stored trimmed; what was streamed may end with the blank its model wrote last)
    const whole =
      words === undefined
        ? undefined
        : words.startsWith(shown)
          ? words
          : pyRstrip(shown) === pyRstrip(words)
            ? shown
            : undefined;
    if (whole === undefined) return this.closeReplacing(message);
    if (message.body.type !== "view") return (await this.stream.final(textOnly(message, whole))).ok;
    await this.stream.final(plainMessage(shown));
    return false;
  }

  /**
   * Close the stream with `message` in place of the words streamed into it. Should Teams refuse a final that does not contain
   * what was streamed, the stream is closed with those words and that message is edited into `message` (deleted when it cannot be).
   */
  private async closeReplacing(message: OutMessage): Promise<boolean> {
    const shown = this.stream.streamed;
    const first = await this.stream.final(message);
    if (first.ok) return true;
    if (!shown || !this.stream.closable) return false;
    this.log.warn("the receipt's final in place of its streamed words was refused; editing it instead", {
      status: first.error.status,
      code: first.error.code,
    });
    const id = this.stream.streamId;
    if (!(await this.stream.final(plainMessage(shown))).ok) {
      this.log.warn("the receipt could not be closed; Teams closes it at 10 minutes");
      return false;
    }
    try {
      await this.stream.update(id, message);
      return true;
    } catch (error) {
      this.log.warn("the receipt's streamed words could not be replaced; deleting them", { error: errorName(error) });
    }
    try {
      await this.stream.delete(id);
    } catch (error) {
      this.log.warn("the receipt's streamed words could not be deleted", { error: errorName(error) });
    }
    return false;
  }
}
