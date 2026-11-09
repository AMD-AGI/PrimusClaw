// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `POST /claw-events/<route>`: a signed event from Claw's outbound notifications, posted into the chat of the person whose
 * subscription's route it arrived on. The route finds that person's secret; the signature must verify under it, the
 * timestamp be fresh, and the event be that person's own (a person's secret speaks only for them).
 *
 * Claw delivers at least once: a copy comes again after a timeout, a crash, or from another api replica. The event id (from
 * the signed body; a header that disagrees is refused) is claimed in the store before the send, so a copy is caught by
 * whichever process gets it, and a copy that arrives while another is being sent waits briefly for that send's outcome.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  Clock,
  ConversationRefRepository,
  IdempotencyRepository,
  JsonObject,
  LinkRepository,
  Logger,
  MetricsPort,
  NotifyRoute,
  NotifySubscriptionRepository,
} from "@primusclaw/personal-agent";
import { errorName, silentLogger } from "@primusclaw/personal-agent";
import { z } from "zod";

import { bodyJson, json, type HttpRequest, type HttpResponse, type HttpRoute } from "./routes.js";

/** The largest event Claw posts, with room (a say of 9000 characters with its sources, or an image carried inline). */
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_SKEW_SECONDS = 300;
/** A copy of an event another copy is being sent for waits this long for that send (under Claw's 5 s delivery deadline). */
export const BUSY_WAIT_MS = 3000;
export const BUSY_POLL_MS = 50;

/** What carries an event into the chat: "delivered", "held", "dropped", ... or "retry" (decided later: Claw sends it again). */
export type EventSink = (userId: string, reference: JsonObject, event: JsonObject) => Promise<string>;

export interface ClawEventsDeps {
  readonly notifySubs: Pick<NotifySubscriptionRepository, "notifySubByRoute">;
  readonly links: Pick<LinkRepository, "clawUserIdOf">;
  readonly references: Pick<ConversationRefRepository, "getReference">;
  readonly claims: Pick<IdempotencyRepository, "claimEvent" | "finishEvent" | "releaseEvent">;
  readonly deliver: EventSink;
  readonly clock: Clock;
  /** TEAMS_CLAW_EVENTS_GONE: an event for a person with no chat here is answered 410 (else 200 "dropped", for an older Claw). */
  readonly gone: boolean;
  readonly metrics?: Pick<MetricsPort, "eventDelivered">;
  readonly logger?: Logger;
}

/** `sha256=` HMAC of `<timestamp>.<body>` under the subscription's secret: Claw's signature. */
export function sign(secret: string, timestamp: string, body: Uint8Array): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.`);
  mac.update(body);
  return `sha256=${mac.digest("hex")}`;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  // (timingSafeEqual needs equal lengths; comparing against itself keeps the work the same for a wrong length)
  return x.length === y.length ? timingSafeEqual(x, y) : !timingSafeEqual(y, y);
}

const ClawEvent = z.object({ event_id: z.unknown(), user_id: z.unknown() }).loose();

/** Python's `str(x)` of a JSON scalar (an id written as a number is the same id). */
function idText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}

/** Seconds from when Claw says the event happened (ISO 8601 with a zone) to `nowSeconds`; null when it does not say. */
export function sinceOccurred(occurredAt: unknown, nowSeconds: number): number | null {
  if (typeof occurredAt !== "string" || !/(Z|[+-]\d{2}:?\d{2})$/i.test(occurredAt)) return null;
  const at = Date.parse(occurredAt);
  return Number.isNaN(at) ? null : nowSeconds - at / 1000;
}

function isFresh(stamp: string, nowSeconds: number): boolean {
  if (!/^\s*[+-]?\d+\s*$/.test(stamp)) return false;
  return Math.abs(nowSeconds - Number.parseInt(stamp, 10)) <= MAX_SKEW_SECONDS;
}

export function clawEventsRoute(deps: ClawEventsDeps): HttpRoute {
  return {
    method: "POST",
    path: "/claw-events/:route",
    handle: (request) => handleEvent(deps, request),
  };
}

/** The subscription whose route and signature the request carries, or the answer that refuses it. */
function verified(deps: ClawEventsDeps, request: HttpRequest): NotifyRoute | HttpResponse {
  const stamp = request.headers["x-claw-timestamp"] ?? "";
  const found = deps.notifySubs.notifySubByRoute(request.params["route"] ?? "");
  // An unknown route is answered exactly like a wrong signature, and costs the same HMAC.
  const secret = found?.secret ?? randomBytes(16).toString("hex");
  const given = request.headers["x-claw-signature"] ?? "";
  if (!sameText(given, sign(secret, stamp, request.body)) || !found) return json(401, { error: "bad_signature" });
  if (!isFresh(stamp, deps.clock.epochMs() / 1000)) return json(401, { error: "stale_timestamp" });
  return found;
}

interface ParsedEvent {
  readonly event: JsonObject;
  readonly eventId: string;
  readonly userId: string;
}

/** The event the body is, with its ids; undefined when it is not one (or the event id header disagrees with it). */
function parsedEvent(request: HttpRequest): ParsedEvent | undefined {
  const raw = bodyJson(request);
  const parsed = ClawEvent.safeParse(raw);
  if (!parsed.success || !isEvent(raw)) return undefined;
  const eventId = idText(parsed.data.event_id);
  const userId = idText(parsed.data.user_id);
  if (eventId === undefined || userId === undefined) return undefined;
  // (the header is not signed: the signed body's id is the one used, and a header that disagrees is refused)
  if ((request.headers["x-claw-event-id"] ?? eventId) !== eventId) return undefined;
  return { event: raw, eventId, userId };
}

async function handleEvent(deps: ClawEventsDeps, request: HttpRequest): Promise<HttpResponse> {
  const started = deps.clock.monotonicMs();
  const route = verified(deps, request);
  if ("status" in route) return route;
  const parsed = parsedEvent(request);
  if (parsed === undefined) return json(400, { error: "bad_event" });
  // (a person's secret speaks only for that person)
  const owner = deps.links.clawUserIdOf(route.userId) === parsed.userId ? route.userId : undefined;
  const reference = owner === undefined ? null : deps.references.getReference(owner);
  if (owner === undefined || reference === null) return dropped(deps, owner !== undefined);
  // (the event as it came, keys in Claw's order: a held event is stored as JSON and read back by either worker)
  return deliverOnce(deps, owner, reference, parsed.event, parsed.eventId, { started });
}

function isEvent(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dropped(deps: ClawEventsDeps, linked: boolean): HttpResponse {
  // Nothing a retry could change: no chat with the person is known (or the event is not this person's).
  (deps.logger ?? silentLogger).info("an event from Claw was dropped", {
    why: linked ? "no 1:1 chat with the person is known" : "the link does not record the Claw user it is for",
  });
  return deps.gone ? json(410, { error: "no_chat", status: "dropped" }) : json(200, { status: "dropped" });
}

async function claimed(deps: ClawEventsDeps, key: string): Promise<ReturnType<ClawEventsDeps["claims"]["claimEvent"]>> {
  let claim = deps.claims.claimEvent(key);
  for (let waited = 0; claim.state === "busy" && waited < BUSY_WAIT_MS; waited += BUSY_POLL_MS) {
    await deps.clock.sleep(BUSY_POLL_MS);
    claim = deps.claims.claimEvent(key);
  }
  return claim;
}

async function deliverOnce(
  deps: ClawEventsDeps,
  owner: string,
  reference: JsonObject,
  event: JsonObject,
  eventId: string,
  at: { readonly started: number },
): Promise<HttpResponse> {
  const key = `claw-event:${eventId}`;
  const claim = await claimed(deps, key);
  if (claim.state === "done") return json(200, { status: "duplicate" });
  // (still being sent elsewhere: Claw is told to try again, never that it was delivered: that send may fail)
  if (claim.state === "busy") return json(503, { error: "in_progress" });
  let outcome: string;
  try {
    outcome = await deps.deliver(owner, reference, event);
  } catch (error) {
    deps.claims.releaseEvent(key, claim.holder);
    (deps.logger ?? silentLogger).error("proactive send failed", { error: errorName(error) });
    return json(503, { error: "send_failed" });
  }
  if (outcome === "retry") {
    deps.claims.releaseEvent(key, claim.holder);
    return json(503, { error: "turn_in_progress" });
  }
  deps.claims.finishEvent(key); // (a held event is stored durably, so it counts as taken)
  if (outcome === "delivered") {
    deps.metrics?.eventDelivered(
      typeof event["type"] === "string" ? event["type"] : "",
      (deps.clock.monotonicMs() - at.started) / 1000,
      sinceOccurred(event["occurred_at"], deps.clock.epochMs() / 1000),
    );
  }
  return json(200, { status: outcome });
}
