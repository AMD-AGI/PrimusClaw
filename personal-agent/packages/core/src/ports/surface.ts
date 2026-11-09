// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject } from "../json.js";
import type { Result } from "../result.js";

/**
 * The chat channel, as core sees it. A channel adapter (Microsoft Teams in `@primusclaw/personal-agent-teams`) turns
 * what its platform delivers into `InboundEvent`s and implements `Surface` to post back; core never sees an activity,
 * a card's JSON or a Bot Connector envelope.
 *
 * Shapes follow the Python worker's `messenger.Messenger` (one conversation's outbound operations) and
 * `activity.py` (what is read from an inbound activity). Identifiers on the wire and in storage keep their spelling;
 * these names are core's.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Who and where

/** The kinds of conversation core tells apart: a 1:1 chat with the bot, a group chat, a channel of a team. */
export type ConversationKind = "personal" | "group" | "channel";

/**
 * A person on the channel. `id` is the person's stable directory id (Teams: the Entra object id, stored as `aad_id`);
 * `channelUserId` is the channel's own id of them in this bot's conversations (Teams: the "29:..." id).
 */
export interface UserRef {
  readonly id: string;
  readonly channelUserId: string;
  /** The display name the channel gave, as given ("" when none). */
  readonly name: string;
  /** Only when the channel supplied one (never looked up); "" otherwise. */
  readonly email: string;
}

/**
 * Where to post. Core reads `id`, `kind` and `tenantId`; `wire` is the channel's own reference (Teams: the Bot
 * Framework conversation reference that `activity.reference_of` built), kept and handed back unchanged. It is what the
 * store persists for proactive messages, so its JSON stays byte-for-byte what the Python worker stored.
 */
export interface ConversationRef {
  readonly id: string;
  readonly kind: ConversationKind;
  /** The organisation the conversation belongs to ("" when the channel has none). */
  readonly tenantId: string;
  readonly wire: Readonly<Record<string, unknown>>;
}

/** The id the channel gave a message the bot posted (Teams: the activity id). */
export type MessageId = string;

// ---------------------------------------------------------------------------------------------------------------------
// Inbound

/** One event a channel delivers that core acts on. Everything else (typing, installs, delivery acks) stays in the adapter. */
export type InboundEvent = InboundMessage | InboundAction | InboundVote;

/** Where an inbound message came from when not from the person's own typing. */
export type Provenance = "typed" | "on_behalf";

interface InboundBase {
  /** The channel's id of the event; processing is idempotent per id ("" when the channel gave none). */
  readonly id: string;
  readonly sender: UserRef;
  readonly conversation: ConversationRef;
  /** The locale of the person's client ("" when not said), e.g. "zh-CN". */
  readonly locale: string;
  /** The client the person used ("Windows", "Web", "iOS", ...; "" when not said), letters and digits only. */
  readonly clientPlatform: string;
}

/** A link in a message: its address and the text it was shown with. */
export interface InboundLink {
  readonly url: string;
  readonly title: string;
}

/** A message the person quoted or replied to. */
export interface InboundQuote {
  readonly author: string;
  readonly text: string;
  /** Whether the quoted message is one this bot posted. */
  readonly fromBot: boolean;
  /** When it was written, as the channel said it ("" when not said). */
  readonly sentAt: string;
}

/** Someone the message @mentions (never the bot itself: the adapter removes its own mention). */
export interface InboundMention {
  /** The channel's id of the person (Teams: "29:..."). */
  readonly channelUserId: string;
  /** Their directory id (Teams: the Entra object id); "" when the channel did not give it. */
  readonly userId: string;
  readonly name: string;
  /** The mention as it appears in the message text. */
  readonly shown: string;
}

/** A file that came with a message. The bytes are fetched through `Surface.fetchFile`, never by core directly. */
export interface InboundFile {
  readonly name: string;
  /** The file type as the channel said it (extension or media type), lower case. */
  readonly type: string;
  /** Opaque to core: what the adapter needs to fetch it. */
  readonly handle: Readonly<Record<string, unknown>>;
}

export interface InboundMessage extends InboundBase {
  readonly type: "message";
  /** What the person wrote, the bot's own mention removed. */
  readonly text: string;
  /** In a group or channel: whether the bot was @mentioned or the message otherwise addressed to it. Always true in 1:1. */
  readonly addressedToBot: boolean;
  /** The conversation's name (a group chat's title; "" in 1:1 or when the channel gave none). */
  readonly conversationName: string;
  /** The people the message @mentions, in order, the bot excluded. */
  readonly mentions: readonly InboundMention[];
  readonly links: readonly InboundLink[];
  readonly quotes: readonly InboundQuote[];
  readonly files: readonly InboundFile[];
  readonly provenance: Provenance;
}

/** A button pressed on a card the bot posted. */
export interface InboundAction extends InboundBase {
  readonly type: "action";
  /** Which action (the card's own `kind`/verb; the adapter does not interpret it). */
  readonly verb: string;
  /** The data the card attached to the button: unvalidated, each handler reads it through its own schema. */
  readonly data: Readonly<Record<string, unknown>>;
  /** The message that holds the card, which the handler replaces to settle the click ("" when not said). */
  readonly cardMessageId: MessageId;
}

/** A thumbs up or down on a message the bot posted, with the comment the person gave. */
export interface InboundVote extends InboundBase {
  readonly type: "vote";
  readonly messageId: MessageId;
  readonly reaction: "like" | "dislike";
  readonly comment: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Outbound

/**
 * The semantic views core can show (a card on Teams). Each feature adds its own by declaration merging, next to its
 * view model:
 *
 *     declare module "../ports/surface.js" {
 *       interface ViewMap { approval: ApprovalView }
 *     }
 *
 * A channel adapter renders every key (`Renderers<ViewMap>` in the Teams package), so a view without a renderer does
 * not compile. A view carries no channel markup: no card JSON, no HTML.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- extended by declaration merging, one entry per feature view
export interface ViewMap {}

/** One view: its name and its model. */
export type View = { readonly [K in keyof ViewMap]: { readonly name: K; readonly model: ViewMap[K] } }[keyof ViewMap];

/** A source a reply cites (`[n]` in its text). */
export interface Citation {
  readonly title: string;
  readonly url: string;
  readonly abstract: string;
}

/**
 * A reply to tap: the button's `title` and the text it sends as the person's message, `value` (they differ: "Back to
 * Clawy" sends "back to Clawy"; Teams: an imBack action).
 */
export interface SuggestedReply {
  readonly title: string;
  readonly value: string;
}

/** What a message is. */
export type OutBody =
  /** Plain text, sent as markdown. */
  | { readonly type: "text"; readonly text: string }
  /** Markdown the channel renders richly (Teams: converted to its HTML subset); `lead` bolds a first label line. */
  | { readonly type: "rich"; readonly markdown: string; readonly lead: boolean }
  /** A view the channel renders (Teams: an Adaptive Card). `fallbackText` is what a client that cannot show it shows. */
  | { readonly type: "view"; readonly view: View; readonly fallbackText: string };

/** One outbound message: the body and what goes with it. Every decoration is optional; a channel drops what it lacks. */
export interface OutMessage {
  readonly body: OutBody;
  /** What an agent wrote (an answer): carries the channel's "AI generated" label when that is on. */
  readonly aiGenerated?: boolean;
  /** Ask the channel's own thumbs up / down under the message. */
  readonly feedback?: boolean;
  /** People to @mention, in the order given. */
  readonly mentions?: readonly UserRef[];
  /** Replies to tap (at most three are shown). */
  readonly suggestions?: readonly SuggestedReply[];
  readonly citations?: readonly Citation[];
}

/** What the channel can do, so core picks the shape that works instead of trying and failing. */
export interface SurfaceCaps {
  /** A live, growing status/answer bubble (`LiveStream`). */
  readonly streaming: boolean;
  /** `post` returns the id of the new message (so it can be edited later). */
  readonly messageIds: boolean;
  readonly edit: boolean;
  readonly delete: boolean;
  /** Views are rendered (otherwise their `fallbackText` is sent). */
  readonly views: boolean;
  readonly citations: boolean;
  readonly suggestions: boolean;
}

/** A message could not be removed (the channel cannot delete, or it refused). The message is still there. */
export interface DeleteUnsupported {
  readonly kind: "delete_unsupported";
  readonly reason: string;
}

/** A stream request was not taken: refused (`status`, the channel's `code`), unanswered (status 0), or not supported. */
export interface StreamRefused {
  readonly kind: "stream_refused";
  readonly reason: string;
  readonly status: number;
  readonly code: string;
}

/**
 * A live bubble that shows progress and then the answer (Teams: a streaming message). The text of a stream only grows;
 * `finish` replaces it with the final message and closes it. Every call may be refused; the caller then shows the same
 * thing the way it would without a stream.
 */
export interface LiveStream {
  /** Informative status lines ("Thinking…", the step in progress). */
  inform(text: string): Promise<Result<void, StreamRefused>>;
  /** The answer text so far; each call carries the whole text, which must start with the previous one. */
  emit(text: string): Promise<Result<void, StreamRefused>>;
  finish(message: OutMessage): Promise<Result<void, StreamRefused>>;
}

/**
 * A message built for one conversation and not yet sent: the channel's own envelope (Teams: the Python worker's
 * `{"operation": "send", "reference": ..., "activity": ...}`), opaque to core. A flow that must keep what it is about to
 * send until it has been sent (an approval card, a question card) stores it first and `deliver`s it after; another
 * worker can deliver a stored one again. Stored as JSON, byte-for-byte what the Python worker stored.
 */
export type Envelope = JsonObject;

/**
 * One conversation's outbound side (the Python `Messenger`). In a group conversation the adapter masks credential
 * shapes in everything it posts, since every member sees it.
 */
export interface Conversation {
  readonly ref: ConversationRef;
  /** The messages this conversation has tried to replace (a clicked card is settled when its id is here). */
  readonly edited: ReadonlySet<MessageId>;
  typing(): Promise<void>;
  /** Post and do not wait for the new message's id. */
  send(message: OutMessage): Promise<void>;
  /** Post and return the new message's id; undefined when the channel never said it (keep sending, do not edit). */
  post(message: OutMessage): Promise<MessageId | undefined>;
  update(id: MessageId, message: OutMessage): Promise<void>;
  delete(id: MessageId): Promise<Result<void, DeleteUnsupported>>;
  /** The envelope `send` would publish for `message` (masked in a group), built without sending it. */
  outgoing(message: OutMessage): Envelope;
  /** Publish an envelope `outgoing` built (possibly in another process, from storage). */
  deliver(envelope: Envelope): Promise<void>;
  /**
   * A live stream that answers `replyTo` (the person's message), showing `status` as its first informative update.
   * Success means that first update has been sent and the channel took it; refused when the channel cannot stream here
   * or did not take it. What a caller tracks about the stream (whether text was streamed, its age, whether it can still
   * be closed) is kept by core's own stream wrapper, not by the port.
   */
  openStream(replyTo: MessageId, status: string): Promise<Result<LiveStream, StreamRefused>>;
}

/** A file's bytes, fetched by the adapter; refused when the channel would not give them. */
export interface FetchedFile {
  readonly name: string;
  /** The media type the file is uploaded with (e.g. "image/png", "text/plain"). */
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface FileRefused {
  readonly kind: "file_refused";
  /** Why ("too_large", "not_allowed", "unreachable", ...); never a URL or a body. */
  readonly reason: string;
}

/** A member of a conversation, as the channel's roster lists them ("" for what it does not give). */
export interface RosterMember {
  readonly channelUserId: string;
  readonly userId: string;
  readonly name: string;
  readonly givenName: string;
  readonly surname: string;
  readonly email: string;
  readonly userPrincipalName: string;
}

/** The channel. */
export interface Surface {
  readonly caps: SurfaceCaps;
  conversation(ref: ConversationRef): Conversation;
  fetchFile(file: InboundFile): Promise<Result<FetchedFile, FileRefused>>;
  /**
   * The bot's 1:1 conversation with `user`, created through the organisation of `via` (a conversation both are in);
   * undefined when the channel cannot open it (the bot is not in their roster, the channel refuses).
   */
  openPersonal(
    via: ConversationRef,
    user: { readonly channelUserId: string; readonly userId: string },
  ): Promise<Conversation | undefined>;
  /** The members of `conversation`; undefined when the channel cannot list them. */
  members(conversation: ConversationRef): Promise<readonly RosterMember[] | undefined>;
}

/** A plain-text message: the common case. */
export function textMessage(text: string): OutMessage {
  return { body: { type: "text", text } };
}

/** A rich (markdown) message; `lead` bolds a first label line. */
export function richMessage(markdown: string, options: { lead?: boolean; aiGenerated?: boolean } = {}): OutMessage {
  return {
    body: { type: "rich", markdown, lead: options.lead ?? false },
    ...(options.aiGenerated === undefined ? {} : { aiGenerated: options.aiGenerated }),
  };
}
