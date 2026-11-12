// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's HTTP endpoints as it runs them (the Python worker's `build_worker_app`): `/healthz`, the console's
 * `/primus-claw-agent/link`, `/claw-events/<route>` when proactive messages are on, the routes a deployment adds, and in the
 * release gate's test entry its `/gate/v1/*`. `/metrics` is served on a port of its own.
 */
import type { ClawPort, Clock, JsonObject, Logger, MetricsPort, Plugins } from "@primusclaw/personal-agent";
import {
  bearerOf,
  bodyJson,
  clawEventsRoute,
  healthzRoute,
  linkRoute,
  type HttpRoute,
  type SqliteStore,
} from "@primusclaw/personal-agent-runtime";

export interface WorkerRoutesParts {
  readonly store: SqliteStore;
  readonly claw: ClawPort;
  readonly clock: Clock;
  readonly metrics: MetricsPort;
  readonly logger: Logger;
  readonly plugins: Plugins;
  /** PROACTIVE_ENABLED: Claw's notifications are taken at /claw-events. */
  readonly proactive: boolean;
  /** PA_CLAW_EVENTS_GONE. */
  readonly gone: boolean;
  readonly deliverEvent: (userId: string, reference: JsonObject, event: JsonObject) => Promise<string>;
}

/** A route a deployment adds (core's RouteExtension) as an HTTP route. */
function extensionRoute(extension: Plugins["routeExtensions"][number]): HttpRoute {
  return {
    method: extension.method,
    path: extension.path,
    async handle(request) {
      const answer = await extension.handle({
        headers: request.headers,
        bearer: bearerOf(request),
        body: bodyJson(request),
      });
      return { status: answer.status, json: answer.body };
    },
  };
}

export function workerRoutes(parts: WorkerRoutesParts): HttpRoute[] {
  const routes: HttpRoute[] = [
    healthzRoute,
    linkRoute(parts.store.links, async (key) => {
      try {
        await parts.claw.sessions.checkKey(key);
        return true;
      } catch {
        // (any refusal or failure of Claw: the key gets no code, as Python's ClawError)
        return false;
      }
    }),
  ];
  if (parts.proactive) {
    routes.push(
      clawEventsRoute({
        notifySubs: parts.store.notifySubs,
        links: parts.store.links,
        references: parts.store.references,
        claims: parts.store.idempotency,
        deliver: parts.deliverEvent,
        clock: parts.clock,
        gone: parts.gone,
        metrics: parts.metrics,
        logger: parts.logger,
      }),
    );
  }
  return [...routes, ...parts.plugins.routeExtensions.map(extensionRoute)];
}

/** `/metrics` on its own port: the Prometheus text. */
export function metricsRoutes(render: () => string): HttpRoute[] {
  return [
    {
      method: "GET",
      path: "/metrics",
      handle: () => Promise.resolve({ status: 200, text: render(), contentType: "text/plain; version=0.0.4" }),
    },
  ];
}
