// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  err,
  ok,
  type Conversation,
  type ConversationRef,
  type DeleteUnsupported,
  type Envelope,
  type FetchedFile,
  type FileRefused,
  type InboundFile,
  type LiveStream,
  type MessageId,
  type OutMessage,
  type Result,
  type StreamRefused,
  type Surface,
  type SurfaceCaps,
} from "@primusclaw/personal-agent";

/** One thing a conversation was asked to do, in order. */
export type Recorded =
  | { readonly op: "typing"; readonly conversation: string }
  | { readonly op: "send"; readonly conversation: string; readonly message: OutMessage }
  | { readonly op: "post"; readonly conversation: string; readonly message: OutMessage; readonly id: MessageId }
  | { readonly op: "update"; readonly conversation: string; readonly id: MessageId; readonly message: OutMessage }
  | { readonly op: "delete"; readonly conversation: string; readonly id: MessageId }
  | { readonly op: "stream.open"; readonly conversation: string; readonly replyTo: MessageId; readonly text: string }
  | { readonly op: "stream.inform"; readonly conversation: string; readonly text: string }
  | { readonly op: "stream.emit"; readonly conversation: string; readonly text: string }
  | { readonly op: "stream.finish"; readonly conversation: string; readonly message: OutMessage };

export const ALL_CAPS: SurfaceCaps = {
  streaming: true,
  messageIds: true,
  edit: true,
  delete: true,
  views: true,
  citations: true,
  suggestions: true,
};

export interface FakeSurfaceOptions {
  readonly caps?: Partial<SurfaceCaps>;
  /** Files `fetchFile` returns, by name; any other file is refused as "unreachable". */
  readonly files?: Readonly<Record<string, { readonly mediaType: string; readonly bytes: Uint8Array }>>;
}

/**
 * A Surface that records every outbound operation instead of posting it (`outbox`), for tests of core. Message ids
 * are "m1", "m2", ... in posting order. What the channel cannot do (`caps`) is refused the way a channel refuses it.
 * A stream enforces the one rule every channel has: its text only grows.
 */
export class FakeSurface implements Surface {
  readonly caps: SurfaceCaps;
  readonly outbox: Recorded[] = [];
  private readonly files: NonNullable<FakeSurfaceOptions["files"]>;
  private nextId = 1;

  constructor(options: FakeSurfaceOptions = {}) {
    this.caps = { ...ALL_CAPS, ...options.caps };
    this.files = options.files ?? {};
  }

  conversation(ref: ConversationRef): Conversation {
    return new FakeConversation(this, ref);
  }

  fetchFile(file: InboundFile): Promise<Result<FetchedFile, FileRefused>> {
    const found = this.files[file.name];
    return Promise.resolve(
      found === undefined ? err({ kind: "file_refused", reason: "unreachable" }) : ok({ name: file.name, ...found }),
    );
  }

  /** @internal */
  record(entry: Recorded): void {
    this.outbox.push(entry);
  }

  /** @internal */
  newId(): MessageId {
    return `m${String(this.nextId++)}`;
  }

  /** The recorded operations of one conversation. */
  of(conversationId: string): Recorded[] {
    return this.outbox.filter((r) => r.conversation === conversationId);
  }
}

class FakeConversation implements Conversation {
  readonly edited = new Set<MessageId>();

  constructor(
    private readonly surface: FakeSurface,
    readonly ref: ConversationRef,
  ) {}

  typing(): Promise<void> {
    this.surface.record({ op: "typing", conversation: this.ref.id });
    return Promise.resolve();
  }

  send(message: OutMessage): Promise<void> {
    this.surface.record({ op: "send", conversation: this.ref.id, message });
    return Promise.resolve();
  }

  post(message: OutMessage): Promise<MessageId | undefined> {
    const id = this.surface.newId();
    this.surface.record({ op: "post", conversation: this.ref.id, message, id });
    return Promise.resolve(this.surface.caps.messageIds ? id : undefined);
  }

  /** The fake's envelope: the operation, the conversation and the message as JSON (what a store would keep). */
  outgoing(message: OutMessage): Envelope {
    return { operation: "send", conversation: this.ref.id, message: JSON.parse(JSON.stringify(message)) as Envelope };
  }

  /** Records a delivered envelope as the send it stands for. */
  deliver(envelope: Envelope): Promise<void> {
    if (envelope["operation"] !== "send" || envelope["conversation"] !== this.ref.id) {
      return Promise.reject(new Error("FakeConversation.deliver: not an envelope of this conversation"));
    }
    this.surface.record({
      op: "send",
      conversation: this.ref.id,
      message: envelope["message"] as unknown as OutMessage,
    });
    return Promise.resolve();
  }

  update(id: MessageId, message: OutMessage): Promise<void> {
    this.edited.add(id);
    this.surface.record({ op: "update", conversation: this.ref.id, id, message });
    return Promise.resolve();
  }

  delete(id: MessageId): Promise<Result<void, DeleteUnsupported>> {
    if (!this.surface.caps.delete) {
      return Promise.resolve(err({ kind: "delete_unsupported", reason: "this channel cannot delete" }));
    }
    this.surface.record({ op: "delete", conversation: this.ref.id, id });
    return Promise.resolve(ok(undefined));
  }

  openStream(replyTo: MessageId, status: string): Promise<Result<LiveStream, StreamRefused>> {
    if (!this.surface.caps.streaming) {
      return Promise.resolve(err(refused("this channel cannot stream")));
    }
    this.surface.record({ op: "stream.open", conversation: this.ref.id, replyTo, text: status });
    return Promise.resolve(ok(new FakeStream(this.surface, this.ref.id)));
  }
}

function refused(reason: string): StreamRefused {
  return { kind: "stream_refused", reason, status: 0, code: "" };
}

class FakeStream implements LiveStream {
  private text = "";
  private closed = false;

  constructor(
    private readonly surface: FakeSurface,
    private readonly conversation: string,
  ) {}

  inform(text: string): Promise<Result<void, StreamRefused>> {
    if (this.closed) return Promise.resolve(err(refused("stream closed")));
    this.surface.record({ op: "stream.inform", conversation: this.conversation, text });
    return Promise.resolve(ok(undefined));
  }

  emit(text: string): Promise<Result<void, StreamRefused>> {
    if (this.closed) return Promise.resolve(err(refused("stream closed")));
    if (!text.startsWith(this.text)) return Promise.resolve(err(refused("stream text must only grow")));
    this.text = text;
    this.surface.record({ op: "stream.emit", conversation: this.conversation, text });
    return Promise.resolve(ok(undefined));
  }

  finish(message: OutMessage): Promise<Result<void, StreamRefused>> {
    if (this.closed) return Promise.resolve(err(refused("stream closed")));
    this.closed = true;
    this.surface.record({ op: "stream.finish", conversation: this.conversation, message });
    return Promise.resolve(ok(undefined));
  }
}

/** A conversation reference for tests. */
export function testConversation(id = "conv-1", kind: ConversationRef["kind"] = "personal"): ConversationRef {
  return { id, kind, tenantId: "tenant-1", wire: { conversation: { id } } };
}
