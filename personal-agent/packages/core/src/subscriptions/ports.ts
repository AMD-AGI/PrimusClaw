// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the subscription keeper needs from the store (W1's repositories) and from Claw (W2's notification subscriptions). */
import type { ClawNotificationsPort } from "../ports/claw/index.js";
import type { ConversationRefRepository, LinkRepository, NotifySubscriptionRepository } from "../ports/store/index.js";

export interface SubscriptionStore {
  readonly notifySubs: Omit<NotifySubscriptionRepository, "notifySubByRoute">;
  readonly links: Pick<LinkRepository, "getKey" | "setClawUserId" | "needsClawUserId" | "linkedUsers">;
  readonly references: Pick<ConversationRefRepository, "getReference">;
}

export type ClawSubscriptions = ClawNotificationsPort;
