// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a card press handler of this feature reads of the click it is given: the router's `ClickRoute` (W4,
 * core/src/ports/routing.ts) satisfies it structurally.
 */
import type { Lang } from "../locales/lang.js";
import type { Conversation, OutMessage, UserRef, View } from "../ports/surface.js";

export interface SettleOptions {
  readonly fallback?: string;
  readonly announce?: boolean;
}

export interface CardClick {
  readonly sender: UserRef;
  readonly conversation: Conversation;
  /** "" in the person's 1:1 chat, the conversation id of a group chat. */
  readonly scope: string;
  readonly action: { readonly data: Readonly<Record<string, unknown>> };
  lang(): Lang;
  settle(card: OutMessage | string, options?: SettleOptions): Promise<boolean>;
}

/** A view as a message, with the line a client that cannot show it shows. */
export function viewMessage(view: View, fallbackText = ""): OutMessage {
  return { body: { type: "view", view, fallbackText } };
}
