// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject } from "../json.js";
import type { Lang } from "../locales/lang.js";
import type { Conversation, InboundFile, InboundMessage, UserRef } from "../ports/surface.js";

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

/** What a chat is attached to, as help's first lines say it. */
export interface Attachment {
  readonly label: string;
  readonly host: string;
  readonly cwd: string;
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
  attachment(chatKey: string): Attachment | undefined;
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
}
