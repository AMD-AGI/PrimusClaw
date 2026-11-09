// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The open receipts, one per conversation (teams_agent/stream.py open_receipt, open_receipt_of, take_receipt, reserve_receipt),
 * and the conversation that answers a handed-back review into the receipt kept for it (ReceiptMessenger, with_postscript).
 */
import { receiptText } from "../locales/assistant.js";
import type { Lang } from "../locales/lang.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import type { Conversation, Envelope, MessageId, OutMessage, UpdateOptions } from "../ports/surface.js";
import { pyRstrip, pyStrip } from "../text/py-text.js";
import { Receipt, messageWords, type ReceiptStream } from "./receipt.js";

/** Opens a live stream under the message being answered with `status` as its first update; undefined where none can be. */
export type ReceiptOpener = (status: string) => Promise<ReceiptStream | undefined>;

export class Receipts {
  private readonly open = new Map<string, Receipt>();

  constructor(
    private readonly clock: Clock,
    private readonly log: Logger,
    /** The reply style has receipts on (`assistant_receipt`). */
    private readonly enabled: () => boolean = () => true,
  ) {}

  /**
   * Open the assistant's receipt in `conversation`. Undefined when there is none (receipts off, one already open, no stream here,
   * or the channel refused it): the caller shows the typing indicator.
   */
  async openIn(conversation: string, lang: Lang, opener: ReceiptOpener): Promise<Receipt | undefined> {
    if (!this.enabled()) return undefined;
    if (this.open.get(conversation)?.stream.open) return undefined;
    const stream = await opener(receiptText.in(lang).received);
    if (stream === undefined) return undefined;
    const receipt = new Receipt(stream, conversation, lang, this.log);
    this.open.set(conversation, receipt);
    receipt.arm(
      this.clock,
      () => this.open.get(conversation) === receipt,
      () => this.open.delete(conversation),
    );
    return receipt;
  }

  /** The open receipt of this conversation, left where it is (what follows the turn shows its steps in it). */
  openOf(conversation: string): Receipt | undefined {
    const receipt = this.open.get(conversation);
    return receipt !== undefined && receipt.stream.open && !receipt.done ? receipt : undefined;
  }

  /**
   * The open receipt of this conversation, taken (the first reply closes it). One kept for a handed-back review's answer is
   * taken only by that answer (`reserved`).
   */
  take(conversation: string, reserved?: Receipt): Receipt | undefined {
    const receipt = this.open.get(conversation);
    if (receipt === undefined || (receipt.reserved && receipt !== reserved)) return undefined;
    this.open.delete(conversation);
    return receipt.stream.open ? receipt : undefined;
  }

  /** Keep the open receipt for the answer to a review handed back for the message `replyTo` (only the receipt under it). */
  reserve(conversation: string, replyTo: MessageId): Receipt | undefined {
    const receipt = this.openOf(conversation);
    if (receipt === undefined || !replyTo || receipt.stream.replyTo !== replyTo) return undefined;
    receipt.reserved = true;
    return receipt;
  }
}

/**
 * `message` (a text message) with what the assistant said beside it added at its end, after "另外：" ("Also: " when nothing is
 * Chinese).
 */
export function withPostscript(message: OutMessage, said: readonly string[]): OutMessage {
  const text = messageWords(message);
  const chinese = /[一-鿿]/u.test(text + said.join(""));
  const lead = receiptText.in(chinese ? "zh" : "en").alsoLead;
  const added = `${pyRstrip(text)}\n\n${lead}${said.join("\n\n")}`;
  if (message.body.type === "rich") return { ...message, body: { ...message.body, markdown: added } };
  return { ...message, body: { type: "text", text: added } };
}

/**
 * A conversation whose first text message closes `receipt` in its place under the person's message: the answer to a review the
 * assistant handed back is the one reply to it. A view, and a first message the channel does not take there, are messages of
 * their own. What the assistant said beside the handoff (`postscript`) is added to the first text message.
 */
export class ReceiptConversation implements Conversation {
  private receipt: Receipt | undefined;
  private postscript: readonly string[];

  constructor(
    private readonly inner: Conversation,
    private readonly receipts: Receipts,
    receipt: Receipt | undefined,
    postscript: readonly string[] = [],
  ) {
    this.receipt = receipt;
    this.postscript = postscript;
  }

  get ref() {
    return this.inner.ref;
  }

  get edited() {
    return this.inner.edited;
  }

  markSettled(id: MessageId): void {
    this.inner.markSettled(id);
  }

  typing(): Promise<void> {
    return this.inner.typing();
  }

  async send(message: OutMessage): Promise<void> {
    let out = message;
    if (this.postscript.length && out.body.type !== "view" && pyStrip(messageWords(out))) {
      out = withPostscript(out, this.postscript);
      this.postscript = [];
    }
    const receipt = this.receipt;
    if (receipt !== undefined && out.body.type !== "view") {
      this.receipt = undefined;
      const taken = this.receipts.take(receipt.conversation, receipt);
      if (taken === receipt && (await receipt.deliver(out))) return;
    }
    await this.inner.send(out);
  }

  post(message: OutMessage): Promise<MessageId | undefined> {
    return this.inner.post(message);
  }

  update(id: MessageId, message: OutMessage, options?: UpdateOptions): Promise<void> {
    return this.inner.update(id, message, options);
  }

  delete(id: MessageId): ReturnType<Conversation["delete"]> {
    return this.inner.delete(id);
  }

  outgoing(message: OutMessage): Envelope {
    return this.inner.outgoing(message);
  }

  deliver(envelope: Envelope): Promise<void> {
    return this.inner.deliver(envelope);
  }

  openStream(replyTo: MessageId, status: string): ReturnType<Conversation["openStream"]> {
    return this.inner.openStream(replyTo, status);
  }

  /** What the assistant said beside the handoff, when no text message carried it: said on its own. */
  async sayPostscript(): Promise<void> {
    if (!this.postscript.length) return;
    const parts = this.postscript;
    this.postscript = [];
    await this.send({ body: { type: "text", text: parts.join("\n\n") } });
  }

  /** Nothing was said: the receipt is no longer kept, so a reply of the assistant (or its own limit) closes it. */
  release(): void {
    const receipt = this.receipt;
    this.receipt = undefined;
    if (receipt !== undefined) receipt.reserved = false;
  }
}
