// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the subscription keeper needs from Claw (the notification subscription endpoints of claw.py, W2's ClawPort satisfies this
 * structurally) and from the store (W1's repositories).
 */
import type { ConversationRefRepository, LinkRepository, NotifySubscriptionRepository } from "../ports/store/index.js";

export interface SubscriptionStore {
  readonly notifySubs: Omit<NotifySubscriptionRepository, "notifySubByRoute">;
  readonly links: Pick<LinkRepository, "getKey" | "setClawUserId" | "needsClawUserId" | "linkedUsers">;
  readonly references: Pick<ConversationRefRepository, "getReference">;
}

/** A subscription as Claw lists it (`GET /notifications/subscriptions`). */
export interface ClawSubscriptionRow {
  readonly subscription_id: string;
  readonly url?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly event_types?: readonly string[] | undefined;
  readonly sources?: readonly string[] | undefined;
}

export interface CreatedSubscription {
  readonly subscription_id: string;
  readonly secret: string;
}

export interface ClawSubscriptions {
  createSubscription(
    key: string,
    url: string,
    types?: readonly string[],
    sources?: readonly string[],
  ): Promise<CreatedSubscription>;
  listSubscriptions(key: string): Promise<readonly ClawSubscriptionRow[]>;
  updateSubscriptionTypes(
    key: string,
    subscriptionId: string,
    types: readonly string[],
    options: { readonly enable: boolean; readonly sources: readonly string[] | undefined },
  ): Promise<void>;
  deleteSubscription(key: string, subscriptionId: string): Promise<void>;
}
