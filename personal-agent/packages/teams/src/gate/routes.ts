// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The release gate's test entry, as HTTP routes on the worker's own server (127.0.0.1 only). The gate posts a person's
 * message, file or press as the Bot Framework activity the inbound queue carries (`POST /gate/v1/activity`), links its
 * made-up people (`PUT /gate/v1/people/<aad>`), reads a chat's session and a person's subscription (`GET`), makes or removes
 * the subscription (`POST`/`DELETE .../subscription`) and lists the Claw sessions this worker made (`GET /gate/v1/sessions`,
 * deleted at the end of a run). A worker in any language that implements these routes and the Bot Connector calls is driven
 * by the same gate.
 */
import type {
  JsonValue,
  LinkRepository,
  Logger,
  MemberDirectoryRepository,
  NotifySubscriptionRepository,
  SessionRepository,
  TokenExchange,
} from "@primusclaw/personal-agent";
import { errorName, silentLogger } from "@primusclaw/personal-agent";
import {
  bodyJson,
  json,
  type HttpRequest,
  type HttpResponse,
  type HttpRoute,
} from "@primusclaw/personal-agent-runtime";
import type { GateSubscriptions } from "@primusclaw/personal-agent-worker";
import { z } from "zod";

import type { JsonObject } from "../cards/json.js";
import { NO_SUBSCRIPTION_SECONDS, PREFIX } from "./entry-env.js";

export type { GateSubscriptions };

export interface GateEntryDeps {
  /** What the inbound queue's consumer hands an activity to. */
  readonly handle: (activity: JsonObject) => Promise<void>;
  readonly links: Pick<LinkRepository, "stashPending" | "redeemPending" | "setClawUserId">;
  readonly members: Pick<MemberDirectoryRepository, "rememberMember">;
  readonly notifySubs: Pick<NotifySubscriptionRepository, "claimNotifyAttempt" | "getNotifySub">;
  readonly sessions: Pick<SessionRepository, "getSession">;
  readonly exchange: TokenExchange;
  /** undefined: proactive messages are off, so there are no subscriptions. */
  readonly subscriptions: GateSubscriptions | undefined;
  /** The ids of the Claw sessions this worker made, in order. */
  readonly madeSessions: () => readonly string[];
  readonly logger?: Logger;
}

const Person = z
  .object({
    name: z.union([z.string(), z.number()]),
    key: z.union([z.string(), z.number()]),
    claw_user_id: z.unknown().optional(),
    teams_id: z.unknown().optional(),
    subscribe: z.unknown().optional(),
  })
  .loose();

function aadOf(request: HttpRequest): string {
  return (request.params["aad"] ?? "").toLowerCase();
}

/** Python's `str(x)` of a JSON scalar, and "" for what is not one. */
function str(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

async function personState(deps: GateEntryDeps, aad: string, scope: string): Promise<JsonValue> {
  let signedIn: boolean | null = null;
  if (deps.exchange.enabled) {
    // (not bound, or the identity service did not answer: either way not signed in now)
    signedIn = (await deps.exchange.tokenFor(aad)).ok;
  }
  const sub = deps.notifySubs.getNotifySub(aad);
  return {
    session_id: deps.sessions.getSession(aad, scope),
    signed_in: signedIn,
    subscription: sub
      ? { id: sub.subscriptionId, assistant_types: deps.subscriptions?.hasAssistantTypes(aad) ?? false }
      : null,
  };
}

function activityRoute(deps: GateEntryDeps): HttpRoute {
  return {
    method: "POST",
    path: `${PREFIX}/activity`,
    async handle(request): Promise<HttpResponse> {
      const body = bodyJson(request);
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return json(400, { error: "not_an_activity" });
      }
      try {
        await deps.handle(body as JsonObject);
      } catch (error) {
        // (the queue would redeliver it; the gate sees the answer)
        (deps.logger ?? silentLogger).error("gate entry: handling an activity failed", { error: errorName(error) });
        return json(500, { error: errorName(error) });
      }
      return json(200, { status: "handled" });
    },
  };
}

function putPersonRoute(deps: GateEntryDeps): HttpRoute {
  return {
    method: "PUT",
    path: `${PREFIX}/people/:aad`,
    handle(request): Promise<HttpResponse> {
      const aad = aadOf(request);
      const parsed = Person.safeParse(bodyJson(request));
      if (!parsed.success) return Promise.resolve(json(400, { error: "name_and_key_required" }));
      const data = parsed.data;
      const name = str(data.name);
      const outcome = deps.links.redeemPending(aad, name, deps.links.stashPending(str(data.key)));
      if (outcome !== "ok") return Promise.resolve(json(409, { error: "not_linked", outcome }));
      if (str(data.claw_user_id)) deps.links.setClawUserId(aad, str(data.claw_user_id));
      deps.members.rememberMember(str(data.teams_id) || `29:${aad}`, aad, name);
      // (a second chat of one key: in production one key is one person, and a second subscription would replace the first)
      if (data.subscribe === false) deps.notifySubs.claimNotifyAttempt(aad, NO_SUBSCRIPTION_SECONDS);
      return Promise.resolve(json(200, { status: "linked" }));
    },
  };
}

function personRoutes(deps: GateEntryDeps): HttpRoute[] {
  return [
    {
      method: "GET",
      path: `${PREFIX}/people/:aad`,
      handle: async (request) => json(200, await personState(deps, aadOf(request), request.query.get("scope") ?? "")),
    },
    {
      method: "POST",
      path: `${PREFIX}/people/:aad/subscription`,
      async handle(request) {
        const aad = aadOf(request);
        await deps.subscriptions?.ensure(aad);
        return json(200, await personState(deps, aad, ""));
      },
    },
    {
      method: "DELETE",
      path: `${PREFIX}/people/:aad/subscription`,
      async handle(request) {
        const aad = aadOf(request);
        const sub = deps.notifySubs.getNotifySub(aad);
        if (sub && deps.subscriptions) await deps.subscriptions.remove(aad);
        return json(200, { removed: sub ? sub.subscriptionId : null });
      },
    },
  ];
}

/** Every route of the test entry, to mount on the worker's server before it starts. */
export function gateRoutes(deps: GateEntryDeps): HttpRoute[] {
  return [
    activityRoute(deps),
    putPersonRoute(deps),
    ...personRoutes(deps),
    {
      method: "GET",
      path: `${PREFIX}/sessions`,
      handle: () => Promise.resolve(json(200, { created: [...deps.madeSessions()] })),
    },
  ];
}
