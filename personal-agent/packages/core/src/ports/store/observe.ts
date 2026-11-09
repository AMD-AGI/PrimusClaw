// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Group chats the assistant observes, and the suggestions shown on /board (tables `observed_groups`, `observe_cards`). */
import type { JsonObject } from "./json.js";

export interface GroupObserver {
  readonly userId: string;
  readonly scope: string;
}

export interface ObservedGroup {
  readonly conversationId: string;
  readonly scope: string;
  readonly name: string;
  /** Observing is on now. */
  readonly on: boolean;
}

export type ObserveCardState = "open" | "busy" | "accepted" | "dismissed" | "unsure" | (string & {});

export interface ObserveCard {
  readonly cardId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly seq: number;
  readonly tool: string;
  readonly args: string;
  readonly message: string;
  readonly state: ObserveCardState;
}

export interface NewObserveCard {
  readonly userId: string;
  readonly conversationId: string;
  readonly runId: string;
  readonly seq: number;
  readonly tool: string;
  readonly args: string;
  readonly message: string;
}

export interface ObserveRepository {
  /** `/observe on`: one observer per group, the last to turn it on. `name` is kept to 200 characters. */
  observeGroup(conversationId: string, observer: GroupObserver & { readonly reference: JsonObject; readonly name?: string }): void;
  /** `/observe off`: returns whose observer it was, or null when it was not on. The row stays for /board. */
  unobserveGroup(conversationId: string): string | null;
  groupObserver(conversationId: string): GroupObserver | null;
  /** Every group this person turned observing on in, newest first. */
  observedBy(userId: string): ObservedGroup[];
  observedReference(conversationId: string): JsonObject | null;
  addObserveCard(card: NewObserveCard): string;
  getObserveCard(cardId: string): ObserveCard | null;
  /** Accepted, dismissed or unsure already (on any card of it): not offered again. */
  observeSuggestionSettled(userId: string, runId: string, seq: number): boolean;
  /** With `onlyFrom`, of two presses on one suggestion only one moves it; 'busy' also refuses a suggestion already in hand. */
  moveObserveCard(cardId: string, state: ObserveCardState, onlyFrom?: ObserveCardState): boolean;
}
