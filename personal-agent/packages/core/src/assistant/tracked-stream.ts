// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Core's wrapper over the Surface's `LiveStream`: what the receipt tracks about a stream (the text streamed so far, its age,
 * whether a final was sent) is kept here, not by the port. The stream's own message id is not given by the port (yet), so a final
 * the channel refuses is never edited into place: the reply then goes as a message of its own.
 */
import type { Clock } from "../ports/clock.js";
import type { Conversation, LiveStream, MessageId, OutMessage, StreamRefused } from "../ports/surface.js";
import type { Result } from "../result.js";
import type { ReceiptStream } from "./receipt.js";

export class TrackedStream implements ReceiptStream {
  open = true;
  streamed = "";
  readonly streamId: MessageId = "";
  readonly closable = false;
  private readonly started: number;

  constructor(
    private readonly live: LiveStream,
    private readonly conversation: Conversation,
    readonly replyTo: MessageId,
    private readonly clock: Clock,
  ) {
    this.started = clock.monotonicMs();
  }

  ageSeconds(): number {
    return (this.clock.monotonicMs() - this.started) / 1000;
  }

  inform(text: string): Promise<Result<void, StreamRefused>> {
    return this.live.inform(text);
  }

  async emit(text: string): Promise<Result<void, StreamRefused>> {
    const sent = await this.live.emit(text);
    if (sent.ok) this.streamed = text;
    return sent;
  }

  async final(message: OutMessage): Promise<Result<void, StreamRefused>> {
    const sent = await this.live.finish(message);
    if (sent.ok) this.open = false;
    return sent;
  }

  update(id: MessageId, message: OutMessage): Promise<void> {
    return this.conversation.update(id, message);
  }

  async delete(id: MessageId): Promise<void> {
    const deleted = await this.conversation.delete(id);
    if (!deleted.ok) throw new Error(deleted.error.reason);
  }
}

/** Opens the receipt's stream under the person's message `replyTo` in `conversation` (`Receipts.openIn`'s opener). */
export function streamOpener(conversation: Conversation, replyTo: MessageId, clock: Clock) {
  return async (status: string): Promise<ReceiptStream | undefined> => {
    if (!replyTo) return undefined;
    const opened = await conversation.openStream(replyTo, status);
    return opened.ok ? new TrackedStream(opened.value, conversation, replyTo, clock) : undefined;
  };
}
