// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The echo surface's `Surface` (core's port): one in-memory chat app. Everything the bot does is appended to `records`, as a
 * real surface would call its platform's API. What the app cannot do (`caps`) is refused the way the port says: a stream
 * that is not taken, a delete that is unsupported, a post whose id is not known.
 */
import {
  err,
  ok,
  redactText,
  type Conversation,
  type ConversationRef,
  type DeleteUnsupported,
  type Envelope,
  type FetchedFile,
  type FileRefused,
  type LiveStream,
  type MessageId,
  type OutMessage,
  type Result,
  type RosterMember,
  type StreamRefused,
  type Surface,
  type SurfaceCaps,
} from "@primusclaw/personal-agent";

import { render } from "./render.js";
import type { EchoChat, EchoMessage, EchoRecord, EchoWire } from "./wire.js";

/** What the echo app can do when nothing says otherwise: everything but citations and suggested replies. */
export const ECHO_CAPS: SurfaceCaps = {
  channel: "echo",
  name: "Echo Chat",
  shortName: "Echo",
  citationsMax: 0,
  suggestionsMax: 0,
  streamSeconds: 120,
  streaming: true,
  messageIds: true,
  edit: true,
  delete: true,
  views: true,
  citations: false,
  suggestions: false,
};

/** The echo chat a stored reference names; undefined when it names none. */
export function chatOf(wire: Readonly<Record<string, unknown>>): EchoChat | undefined {
  const chat = wire["chat"];
  if (typeof chat !== "object" || chat === null) return undefined;
  const { id, kind } = chat as Record<string, unknown>;
  if (typeof id !== "string" || id === "" || (kind !== "personal" && kind !== "group")) return undefined;
  return { id, kind };
}

export class EchoSurface implements Surface {
  readonly records: EchoRecord[] = [];
  private n = 0;

  constructor(readonly caps: SurfaceCaps = ECHO_CAPS) {}

  conversation(ref: ConversationRef): Conversation {
    return new EchoConversation(this, ref);
  }

  fetchFile(): Promise<Result<FetchedFile, FileRefused>> {
    return Promise.resolve(err({ kind: "file_refused", reason: "not_supported" }));
  }

  /** The echo app opens no chat the person did not start. */
  openPersonal(): Promise<Conversation | undefined> {
    return Promise.resolve(undefined);
  }

  /** Nor does it list a chat's members. */
  members(): Promise<readonly RosterMember[] | undefined> {
    return Promise.resolve(undefined);
  }

  /** @internal */
  newId(): MessageId {
    this.n += 1;
    return `echo-${String(this.n)}`;
  }
}

class EchoConversation implements Conversation {
  readonly edited = new Set<MessageId>();
  private readonly chat: string;

  constructor(
    private readonly app: EchoSurface,
    readonly ref: ConversationRef,
  ) {
    this.chat = ref.id;
  }

  get caps(): SurfaceCaps {
    return this.app.caps;
  }

  /** Words as this chat shows them: in a group every member reads them, so credential shapes are masked first. */
  private masked(text: string): string {
    return this.ref.kind === "personal" ? text : redactText(text).text;
  }

  /** `message` as this chat shows it: every word a member reads masked in a group (its text, buttons and options). */
  private shown(message: OutMessage): EchoMessage {
    const drawn = render(message, this.caps);
    if (this.ref.kind === "personal") return drawn;
    const mask = (text: string) => this.masked(text);
    const choices = drawn.choices && {
      ...drawn.choices,
      options: drawn.choices.options.map((o) => ({ ...o, title: mask(o.title) })),
    };
    return {
      ...drawn,
      text: mask(drawn.text),
      buttons: drawn.buttons.map((b) => ({ ...b, title: mask(b.title) })),
      ...(choices === undefined ? {} : { choices }),
    };
  }

  get replyTo(): MessageId {
    const id = (this.ref.wire as Partial<EchoWire>).messageId;
    return typeof id === "string" ? id : "";
  }

  markSettled(id: MessageId): void {
    this.edited.add(id);
  }

  typing(): Promise<void> {
    this.app.records.push({ op: "typing", chat: this.chat });
    return Promise.resolve();
  }

  async send(message: OutMessage): Promise<void> {
    await this.post(message);
  }

  post(message: OutMessage): Promise<MessageId | undefined> {
    return this.deliver(this.outgoing(message));
  }

  /** An edit where the app can edit; where it cannot, the new words as a new message (the port's caller keeps going). */
  update(id: MessageId, message: OutMessage): Promise<void> {
    this.edited.add(id);
    const shown = this.shown(message);
    if (this.caps.edit) this.app.records.push({ op: "edit", chat: this.chat, id, message: shown });
    else this.app.records.push({ op: "post", chat: this.chat, id: this.app.newId(), message: shown });
    return Promise.resolve();
  }

  delete(id: MessageId): Promise<Result<void, DeleteUnsupported>> {
    if (!this.caps.delete) return Promise.resolve(err({ kind: "delete_unsupported", reason: "not_supported" }));
    this.app.records.push({ op: "delete", chat: this.chat, id });
    return Promise.resolve(ok(undefined));
  }

  /** The envelope is the drawn message and where it goes: JSON a store keeps and any worker can deliver later. */
  outgoing(message: OutMessage): Envelope {
    return { chat: this.chat, message: JSON.parse(JSON.stringify(this.shown(message))) as Envelope };
  }

  deliver(envelope: Envelope): Promise<MessageId | undefined> {
    const id = this.app.newId();
    const message = envelope["message"] as unknown as EchoMessage;
    const chat = typeof envelope["chat"] === "string" ? envelope["chat"] : this.chat;
    this.app.records.push({ op: "post", chat, id, message });
    return Promise.resolve(this.caps.messageIds ? id : undefined);
  }

  openStream(_replyTo: MessageId, status: string): Promise<Result<LiveStream, StreamRefused>> {
    if (!this.caps.streaming) {
      return Promise.resolve(err({ kind: "stream_refused", reason: "not_supported", status: 0, code: "" }));
    }
    const stream = new EchoStream(this.app, this.chat, this.app.newId(), {
      draw: (message) => this.shown(message),
      mask: (text) => this.masked(text),
    });
    this.app.records.push({ op: "stream", chat: this.chat, id: stream.id, text: this.masked(status), final: false });
    return Promise.resolve(ok(stream));
  }
}

/** A live message whose text only grows, then is replaced by its final message. */
class EchoStream implements LiveStream {
  private text = "";
  private closed = false;

  constructor(
    private readonly app: EchoSurface,
    private readonly chat: string,
    readonly id: MessageId,
    private readonly look: { draw(message: OutMessage): EchoMessage; mask(text: string): string },
  ) {}

  private refused(reason: string): Result<void, StreamRefused> {
    return err({ kind: "stream_refused", reason, status: 400, code: reason });
  }

  inform(text: string): Promise<Result<void, StreamRefused>> {
    if (this.closed) return Promise.resolve(this.refused("closed"));
    this.app.records.push({ op: "stream", chat: this.chat, id: this.id, text: this.look.mask(text), final: false });
    return Promise.resolve(ok(undefined));
  }

  emit(text: string): Promise<Result<void, StreamRefused>> {
    if (this.closed) return Promise.resolve(this.refused("closed"));
    if (!text.startsWith(this.text)) return Promise.resolve(this.refused("text_shrank"));
    this.text = text;
    this.app.records.push({ op: "stream", chat: this.chat, id: this.id, text: this.look.mask(text), final: false });
    return Promise.resolve(ok(undefined));
  }

  finish(message: OutMessage): Promise<Result<void, StreamRefused>> {
    if (this.closed) return Promise.resolve(this.refused("closed"));
    this.closed = true;
    this.app.records.push({
      op: "stream",
      chat: this.chat,
      id: this.id,
      message: this.look.draw(message),
      final: true,
    });
    return Promise.resolve(ok(undefined));
  }
}
