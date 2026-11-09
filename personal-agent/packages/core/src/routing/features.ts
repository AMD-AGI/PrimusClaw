// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { GithubConnection } from "../claw/model.js";
import type { JsonObject } from "../json.js";
import type { KeyOwner } from "../plugins/identity-lookup.js";
import type { Lang } from "../locales/lang.js";
import type { Conversation, InboundFile, InboundMessage, OutMessage, UserRef } from "../ports/surface.js";

/**
 * What the router asks of the features it hands messages to. Each is implemented by the feature's own module (the
 * assistant, remote agents, the turn engine, the review service, observing, notifications) and given to the router by
 * the assembly; the router never reaches into a feature, and a feature that is off is given as its `off` value.
 */

/** A fresh credential per call for a chat that runs on exchanged tokens (they expire); undefined: the key as it is. */
export type CredentialProvider = (() => Promise<string>) | undefined;

/** A 1:1 message on the plain route (the Python `Assistant.route`). */
export interface AssistantRouteRequest {
  readonly userId: string;
  readonly credential: string;
  readonly prompt: string;
  readonly conversation: Conversation;
  readonly files: readonly InboundFile[];
  /** Present only where remote agents are on: what this chat is attached to (null for nothing). */
  readonly attached?: JsonObject | null;
}

/** A message of a person the assistant understands (the Python `Assistant.understand`). */
export interface UnderstandRequest {
  readonly userId: string;
  /** The exchanged identity token when there is one, else the linked key. */
  readonly credential: string;
  /** The linked key beside an identity token, for the model ("" when `credential` is the key). */
  readonly modelKey: string;
  readonly prompt: string;
  /** The chat's context (`channel_context`). */
  readonly context: JsonObject;
  readonly lang: Lang;
  readonly conversation: Conversation;
  readonly files: readonly InboundFile[];
}

/** The person's assistant (Python `assistant.Assistant`). */
export interface AssistantChat {
  /** A 1:1 chat that talks to the assistant (no sessions of its own). */
  on(userId: string): boolean;
  /** The assistant reads every message of this person (only an exact command is read by the router). */
  understands(userId: string): boolean;
  /** The assistant can be sent a message now. */
  reachable(userId: string): boolean;
  /** The reply, in `lang`, to a command that has no meaning with the assistant on; undefined when `text` is not one. */
  hiddenCommand(text: string, lang: Lang): string | undefined;
  board(userId: string, credential: string, conversation: Conversation): Promise<void>;
  /** What the assistant is doing this moment is stopped. */
  stop(userId: string, credential: string, conversation: Conversation): Promise<void>;
  /** Forget what is kept for the person (they unlinked). */
  forget(userId: string): void;
  /** True when the assistant took the message. */
  route(request: AssistantRouteRequest): Promise<boolean>;
  /** True when it was sent. */
  understand(request: UnderstandRequest): Promise<boolean>;
  /** What a message of files and no words asks, in `lang`. */
  filesOnly(lang: Lang): string;
}

/** What a chat is attached to, as help's first lines say it (each already made safe to show). */
export interface Attachment {
  readonly label: string;
  readonly host: string;
  /** "" when the session has no folder. */
  readonly cwd: string;
  /** The line that says where the chat box goes while the session card is the window, in the language asked for. */
  readonly cardWindowLine: string;
}

export interface RemotePrompt {
  readonly message: InboundMessage;
  /** The chat's own identity (a group binding's chat key, or the person in their 1:1 chat). */
  readonly chat: UserRef;
  readonly credential: string;
  readonly prompt: string;
  readonly conversation: Conversation;
  readonly provider: CredentialProvider;
}

export interface RemoteAgentCommand {
  readonly chat: UserRef;
  readonly credential: string;
  /** What follows `/agent`. */
  readonly args: string;
  readonly conversation: Conversation;
  /** Undefined for a command the assistant asked for. */
  readonly message: InboundMessage | undefined;
  readonly provider: CredentialProvider;
}

/** Agents on the person's own machines (Python `remote.RemoteAgents`). Keys are chat keys: a person, or a group binding. */
export interface RemoteChat {
  readonly enabled: boolean;
  attached(chatKey: string): boolean;
  /** The chat is the agent's window itself (direct chat). */
  direct(chatKey: string): boolean;
  windowMode(chatKey: string): "card" | "chat";
  /** The message replies quoting the session's card. */
  quotesWindow(chatKey: string, message: InboundMessage): boolean;
  /** A turn of the attached agent is running for this person. */
  running(userId: string): boolean;
  /** What the chat is attached to, as the assistant is told it (null: nothing). */
  chatContext(userId: string, credential: string): Promise<JsonObject | null>;
  attachment(chatKey: string, lang: Lang): Attachment | undefined;
  prompt(request: RemotePrompt): Promise<void>;
  /** True when the attached agent was the one to stop. */
  stop(chat: UserRef, credential: string, conversation: Conversation): Promise<boolean>;
  agents(sender: UserRef, credential: string, conversation: Conversation): Promise<void>;
  agent(command: RemoteAgentCommand): Promise<void>;
  forgetPerson(userId: string): void;
  /** The chat key of a person's binding in a group chat. */
  groupChatKey(userId: string, scope: string): string;
}

/** The person's notification subscription in Claw (Python `subscriptions.Subscriptions`); undefined when notifications are off. */
export interface Subscriptions {
  ensure(userId: string): Promise<void>;
  /** Before the key is revoked: Claw needs it to delete the subscription. */
  remove(userId: string, key: string): Promise<void>;
}

/** Observing a group for a person's assistant (Python `observe.Observer`). */
export interface Observing {
  /** A group message not addressed to the bot: to the group's observer, if it has one. */
  forward(message: InboundMessage): Promise<void>;
  mayTurnOn(userId: string): boolean;
  /** The suggestions the observed groups make for the person (`/board`). */
  board(userId: string, credential: string, conversation: Conversation): Promise<void>;
}

/** The review service's part in the chat (Python `github_review.GithubReview` and `github_connect.GithubConnect`). */
export interface GithubChat {
  /** Which channel id is whose, for reading a mention in a group. */
  remember(message: InboundMessage): void;
  /** Help's values of the person's GitHub ("github", "delegation", "confirm_mode"); those it cannot read are left out. */
  helpValues(userId: string, lang: Lang): Promise<Readonly<Record<string, string>>>;
  /**
   * Beside a question about the person's own GitHub while Claw has no token of theirs: the connect card, sent before the
   * question goes on; `again` asks it again once they connect.
   */
  offerConnect(request: {
    readonly sender: UserRef;
    readonly credential: string;
    readonly text: string;
    readonly lang: Lang;
    readonly conversation: Conversation;
    readonly again: () => Promise<void>;
  }): Promise<void>;
  /** The open confirmations of the person (the assistant's context). */
  pendingConfirmations(userId: string): readonly JsonObject[];
  /**
   * The person's GitHub binding at the identity service, as `/whoami` passes it on to `ConnectionsText` (the review
   * service's own value: bound, none, or not known just now).
   */
  connectionState(userId: string): Promise<unknown>;
}

/** What `/whoami` lists after its first line (the Python `github_connect.connections_text`, the review service's). */
export interface WhoamiConnections {
  readonly owner: KeyOwner | undefined;
  /** `GithubChat.connectionState`; undefined without the review service. */
  readonly githubState: unknown;
  /** Claw's answer about the person's GitHub tools (undefined: none, or could not be asked). */
  readonly connection: GithubConnection | null | undefined;
  /** Whether Claw could say. */
  readonly connectionKnown: boolean;
  readonly githubPart: boolean;
  /** [enabled, available] of the person's memory in Claw; undefined: not known just now. */
  readonly memory: readonly [boolean, boolean] | undefined;
  readonly memoryPage: string;
  readonly zh: boolean;
}

export type ConnectionsText = (connections: WhoamiConnections) => string;

/** The person's own review-stop words in a group ("停 825"): the pull requests named, as [owner/repo or "", number]. */
export type ReviewStopReader = (text: string) => readonly (readonly [string, number])[];

/** What a message to the assistant carries about the chat (the Python `understanding.channel_context`). */
export interface ChannelContextRequest {
  readonly channelMessageId: string;
  readonly userId: string;
  readonly message: InboundMessage;
  /** The parts of the worker that are on (help's parts): which actions the chat declares. */
  readonly parts: ReadonlySet<string>;
  /** What this chat can be handed back to carry out itself (the review service's `review_for_other`). */
  readonly handoffs: readonly string[];
  /** Present only where remote agents are on: what the chat is attached to (null: nothing). */
  readonly attached?: JsonObject | null;
  /** "on_behalf" for a message this worker posted for the person. */
  readonly via: string;
}

export interface ChannelContext {
  readonly context: JsonObject;
  /** The names of the actions it declared. */
  readonly actions: readonly string[];
  /** The Claw user ids of the people it names. */
  readonly people: readonly string[];
}

export type ChannelContextBuilder = (request: ChannelContextRequest) => ChannelContext;

/** Reading what a message carries besides its words (the channel's inbound text, W3: the Python `activity` helpers). */
export interface MessageText {
  /** The message(s) it quotes, as text for the model ("" none). `group`: as a group chat shows them. */
  quoteBlock(message: InboundMessage, group: boolean): string;
  /** `text` with the address behind each of the message's links. */
  withLinks(text: string, message: InboundMessage): string;
  /** `text` after the quote block it answers. */
  withQuote(text: string, quote: string): string;
  /** The line that names the files the channel gave no way to fetch (undefined: none). */
  unreadable(message: InboundMessage): { readonly line: string; readonly count: number } | undefined;
}

/** A button on a note card: what it says and what pressing it sends back (the card data's verb and fields). */
export interface NoteButton {
  readonly title: string;
  readonly verb: string;
  readonly data: Readonly<Record<string, string>>;
  readonly style?: "positive" | "destructive";
}

/** The note card a settled click ends as (rendered by the channel; the Python `render.note_card`). */
export type NoteFactory = (
  text: string,
  options?: { readonly title?: string; readonly tone?: string; readonly buttons?: readonly NoteButton[] },
) => OutMessage;
