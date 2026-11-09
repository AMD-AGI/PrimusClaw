// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Per-person notification subscriptions (tables `notify_subs`, `notify_sub_attempts`). Claw signs a subscription's
 * events with its own secret and names neither the subscription nor the person, so each person gets a URL with a
 * random route token of its own, and the token finds the secret (encrypted at rest) and the person.
 */

export interface NotifySubscription {
  readonly route: string;
  readonly subscriptionId: string;
}

export interface NotifyRoute {
  readonly userId: string;
  readonly secret: string;
}

export interface NotifySubscriptionRepository {
  saveNotifySub(userId: string, sub: NotifySubscription & { readonly secret: string; readonly typesVersion?: number }): void;
  /** Which set of event types the subscription was made or changed for (0: the original two); null: none. */
  notifyTypesVersion(userId: string): number | null;
  setNotifyTypesVersion(userId: string, typesVersion: number): void;
  getNotifySub(userId: string): NotifySubscription | null;
  /** Null when the route is unknown or its secret cannot be decrypted. */
  notifySubByRoute(route: string): NotifyRoute | null;
  forgetNotifySub(userId: string): void;
  /** True (and the attempt is recorded) when none was made in the last `minInterval` seconds. */
  claimNotifyAttempt(userId: string, minInterval: number): boolean;
}
