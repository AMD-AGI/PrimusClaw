// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Cards and messages of the assistant (tables `assistant_cards`, `auto_replies`, `assistant_action_cards`,
 * `assistant_confirm_cards`, `assistant_messages`). A card's buttons carry only its id; what a press means is read
 * from here, so a forged, old or someone else's card changes nothing.
 */
import type { JsonObject } from "./json.js";

/** 'open', 'busy' (a press is being carried out), 'done', or (work-item cards) 'ended'. */
export type CardState = "open" | "busy" | "done" | "ended" | (string & {});

export interface MoveOptions {
  /** Only a card in this state moves, so of two presses exactly one is carried out. */
  readonly onlyFrom?: CardState | null;
}

/** A card for result `version` of a work item. */
export interface AssistantCard {
  readonly cardId: string;
  readonly userId: string;
  readonly itemId: string;
  readonly version: number;
  /** It has an Accept button (a result waits); else only Stop. */
  readonly canAccept: boolean;
  readonly state: CardState;
  readonly createdAt: number;
  /** How the item ended, as the card shows it (state 'ended'). */
  readonly ended: string;
}

/** An open work-item card that went out and can be edited. */
export interface PlacedCard {
  readonly cardId: string;
  readonly userId: string;
  readonly itemId: string;
  readonly activityId: string;
  readonly reference: JsonObject;
  readonly render: JsonObject;
  readonly createdAt: number;
}

/** A button for one of the assistant's own commands (`/{name} {args}`). */
export interface ActionCard {
  readonly cardId: string;
  readonly userId: string;
  /** The message the assistant answered: the action must be one that message declared. */
  readonly channelMessageId: string;
  readonly name: string;
  readonly args: string;
  readonly state: CardState;
  readonly createdAt: number;
}

/** A card for a write Claw holds until the person answers. */
export interface ConfirmCard {
  readonly cardId: string;
  readonly userId: string;
  readonly confirmationId: string;
  /** trigger_create | trigger_cancel | devenv_send | github_comment */
  readonly kind: string;
  /** What the button that lets it through says. */
  readonly label: string;
  readonly state: CardState;
  readonly createdAt: number;
}

export interface AssistantMessage {
  readonly userId: string;
  /** The actions (and handoffs) the message declared. */
  readonly actions: ReadonlySet<string>;
}

export interface AssistantCardRepository {
  /** Record a card before it is sent; the id is all its buttons carry. */
  addAssistantCard(userId: string, itemId: string, version: number, canAccept: boolean): string;
  getAssistantCard(cardId: string): AssistantCard | null;
  /** An open card moves to 'ended'; true if this call moved it. */
  endAssistantCard(cardId: string, ended: string): boolean;
  /** The card went out as the channel message `activityId` in `reference`, showing `render`. */
  placeAssistantCard(cardId: string, placement: { readonly activityId: string; readonly reference: JsonObject; readonly render: JsonObject }): void;
  /** Open, posted cards: of `itemId`, or (none given) all posted since `since`, oldest first. */
  placedAssistantCards(filter: { readonly itemId: string } | { readonly since?: number }): PlacedCard[];
  moveAssistantCard(cardId: string, state: CardState, options?: MoveOptions): boolean;
  /** Automatic replies were turned on for `itemId` on `pull`. */
  setAutoReply(userId: string, itemId: string, pull: string): void;
  autoReply(userId: string, itemId: string): string | null;
  clearAutoReply(userId: string, itemId: string): void;
}

export interface AssistantButtonRepository {
  addActionCard(userId: string, channelMessageId: string, name: string, args: string): string;
  /** Null once it is older than ASSISTANT_MESSAGE_KEEP_SECONDS. */
  getActionCard(cardId: string): ActionCard | null;
  moveActionCard(cardId: string, state: CardState, options?: MoveOptions): boolean;
  addConfirmCard(userId: string, confirmationId: string, kind: string, label?: string): string;
  /** Null once it is older than CONFIRM_CARD_KEEP_SECONDS. */
  getConfirmCard(cardId: string): ConfirmCard | null;
  moveConfirmCard(cardId: string, state: CardState, options?: MoveOptions): boolean;
}

export interface AssistantMessageRepository {
  /** A message this worker sent to the person's assistant, with the actions it declared and the Claw users it named. */
  noteAssistantMessage(channelMessageId: string, userId: string, actions: readonly string[], people?: readonly string[]): void;
  /** The Claw user ids the message named, while it is kept (empty otherwise). */
  assistantMessagePeople(channelMessageId: string): ReadonlySet<string>;
  assistantMessage(channelMessageId: string): AssistantMessage | null;
}
