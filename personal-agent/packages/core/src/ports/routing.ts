// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Lang } from "../locales/lang.js";
import type { Conversation, InboundAction, InboundMessage, InboundVote, OutMessage, UserRef } from "./surface.js";

/**
 * How features plug into the router (the Python worker's `Agent._dispatch` and `Agent._route_group`). The router only
 * dispatches: it reads who sent what and where, applies the chat's own rules (rate, account, language, the chat's
 * commands), and hands the event to the first feature that takes it. A feature registers
 *
 *  - `MessageInterceptor`s: read a message before the router's own reading of it (a review request, a feedback
 *    answer, an observed group's message). Run in the order the assembly lists them; the first that takes it ends it.
 *  - `CommandHandler`s: carry out a command word the router does not own (`/brief`, `/github`, `/board`).
 *  - `ClickHandler`s: answer the buttons of the cards the feature posts, by the card's verb.
 *
 * Every handler is given the conversation to answer in and the person's language at that moment; a click handler
 * settles the click it was given (`ClickRoute.settle`), and the router settles whatever a handler left open.
 */

/** What every routed event carries. */
export interface RouteBase {
  readonly sender: UserRef;
  /** Where to answer. In a group chat the conversation masks credential shapes in everything it posts. */
  readonly conversation: Conversation;
  /** The chat a person's state is kept under: "" for their 1:1 chat, the conversation id of a group chat. */
  readonly scope: string;
  /** The language the person is answered in now (it can change while the event is handled: read it when saying). */
  lang(): Lang;
}

export interface MessageRoute extends RouteBase {
  readonly message: InboundMessage;
  /**
   * The message as commands read it: a word of the commands menu as its command (`help` is `/help`) and a sentence help
   * teaches as the command it means (`停一下` is `/stop`). `message.text` is what the person wrote.
   */
  readonly text: string;
}

/** How a click handler replaces the clicked card. */
export interface SettleOptions {
  /** The outcome's one line, said as a new message when `card` is more than a note (a phone does not redraw an edit). */
  readonly fallback?: string;
  /** False for a handler that has already posted its outcome as a message of its own. */
  readonly announce?: boolean;
}

export interface ClickRoute extends RouteBase {
  readonly action: InboundAction;
  /**
   * THE way a handler ends a click: the clicked card is replaced (by `card`, or by a note card saying `card` when it is
   * text), and the outcome is also said as a new message. True when the card was replaced. Never throws for a failed
   * edit once the outcome was said.
   */
  settle(card: OutMessage | string, options?: SettleOptions): Promise<boolean>;
  /**
   * In a group chat: the presser's credential, read as their @-messages in that group read it (undefined: none, or not just
   * now). Read only when needed; never asks the person to connect. Absent in a 1:1 chat (`withCredential` is given it).
   */
  readonly groupCredential?: () => Promise<string | undefined>;
}

/** A message read before the router's own reading of it. */
export interface MessageInterceptor {
  /** For logs and tests. */
  readonly name: string;
  /** True when it took the message: nothing after it reads the message. */
  intercept(route: MessageRoute): Promise<boolean>;
}

export interface CommandRoute extends RouteBase {
  /** What Claw is called with for this person (their linked key, or an exchanged token). */
  readonly credential: string;
  /** The message the command came in; undefined for a command the assistant asked the chat to carry out. */
  readonly message: InboundMessage | undefined;
}

/** A command word the router does not carry out itself (`/brief`, `/board`, `/github`, `/agent`). */
export interface CommandHandler {
  /** The command word, lower case, without the slash. */
  readonly name: string;
  /**
   * Read before the account check (it needs no Claw credential: `/github`, `/lang`). Such a handler is given an empty
   * credential.
   */
  readonly beforeCredential?: boolean;
  /** Carry out `/name args`; false when it did not take it (the message then goes on as the person's words). */
  run(route: CommandRoute, args: string): Promise<boolean>;
}

/** The buttons of a feature's cards, by verb (the card data's `primusclaw` field). */
export interface ClickHandler {
  readonly verbs: readonly string[];
  /**
   * A click in a 1:1 chat, before the person's credential is read: true when it was answered with no Claw key (a
   * person with no linked key, an answer given with an exchanged identity token only).
   */
  beforeCredential?(click: ClickRoute): Promise<boolean>;
  /** A click in a 1:1 chat, with the person's credential. */
  withCredential?(click: ClickRoute, credential: string): Promise<void>;
  /** A click in a group chat: true when answered (a group answers only the buttons that may be pressed there). */
  inGroup?(click: ClickRoute): Promise<boolean>;
}

export interface VoteRoute extends RouteBase {
  readonly vote: InboundVote;
}

/** The channel's own thumbs under an answer (feedback's). */
export interface VoteHandler {
  vote(route: VoteRoute): Promise<void>;
}

/** The handlers a feature brings, in the order they are tried. */
export interface RouteHandlers {
  /** Read in a 1:1 chat before the account check. */
  readonly personalInterceptors: readonly MessageInterceptor[];
  /** Read in a group chat after the group's own commands, before the account check. */
  readonly groupInterceptors: readonly MessageInterceptor[];
  readonly commands: readonly CommandHandler[];
  readonly clicks: readonly ClickHandler[];
  /** The channel's thumbs (undefined: they are dropped). */
  readonly votes?: VoteHandler;
}

/** No handlers. */
export const noRouteHandlers: RouteHandlers = {
  personalInterceptors: [],
  groupInterceptors: [],
  commands: [],
  clicks: [],
};
