// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the HTTP route tests share: a linked person with a subscription, signed posts, and a sink that records what it sent. */
import type { JsonObject } from "@primusclaw/personal-agent";

import type { FakeClock } from "../../../../test-support/clock.js";
import type { SqliteStore } from "../../src/sqlite/store.js";
import { sign, type EventSink } from "../../src/http/claw-events.js";
import type { HttpRequest } from "../../src/http/routes.js";

export const SECRET = "s3cret";
export const ROUTE = "route-alice";
export const NOW_MS = 1_700_000_000_000;

/** Alice: linked to Claw user u-alice, with a subscription on ROUTE and (unless `withRef` is false) a 1:1 chat. */
export function linkedAlice(store: SqliteStore, withRef = true): void {
  const code = store.links.stashPending("ak-alice");
  store.links.redeemPending("aad-a", "Alice", code);
  store.links.setClawUserId("aad-a", "u-alice");
  store.notifySubs.saveNotifySub("aad-a", { route: ROUTE, subscriptionId: "sub-a", secret: SECRET });
  if (withRef) {
    store.references.saveReference("aad-a", {
      serviceUrl: "https://smba.test/",
      conversation: { id: "c1" },
      bot: { id: "28:bot" },
      user: { id: "29:a", aadObjectId: "aad-a" },
      activityId: "act-9",
    });
  }
}

export function say(eventId = "say-1"): JsonObject {
  return {
    type: "assistant.say",
    event_id: eventId,
    occurred_at: "2026-11-07T08:53:00Z",
    user_id: "u-alice",
    text: "收到一",
  };
}

export interface PostOptions {
  readonly eventIdHeader?: string;
  readonly secret?: string;
  readonly signature?: string;
  readonly stampSeconds?: number;
  readonly route?: string;
}

/** A request as Claw posts the event. */
export function signed(clock: FakeClock, payload: JsonObject, options: PostOptions = {}): HttpRequest {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const stamp = String(Math.trunc(options.stampSeconds ?? clock.epochMs() / 1000));
  const eventId = options.eventIdHeader ?? (typeof payload["event_id"] === "string" ? payload["event_id"] : "");
  return {
    headers: {
      "x-claw-timestamp": stamp,
      "x-claw-event-id": eventId,
      "x-claw-signature": options.signature ?? sign(options.secret ?? SECRET, stamp, body),
    },
    params: { route: options.route ?? ROUTE },
    query: new URLSearchParams(),
    body,
  };
}

/** A sink that records what it delivers; `before` runs first (a slow send), `failNext` makes the next one throw. */
export class RecordingSink {
  readonly sent: Array<{ readonly userId: string; readonly event: JsonObject }> = [];
  failNext = false;
  outcome = "delivered";
  before: () => Promise<void> = () => Promise.resolve();

  readonly deliver: EventSink = async (userId, _reference, event) => {
    await this.before();
    if (this.failNext) {
      this.failNext = false;
      throw new Error("bus down");
    }
    if (this.outcome === "delivered") this.sent.push({ userId, event });
    return this.outcome;
  };
}
