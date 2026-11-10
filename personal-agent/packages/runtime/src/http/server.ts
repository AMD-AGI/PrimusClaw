// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's HTTP server (fastify): the routes it is given, each body read raw (never parsed by the server: a route
 * that verifies a signature needs the bytes as sent), within a size limit. With an access log, one line per request: its
 * method, the route it matched as declared (`/claw-events/:route`, never the path as sent, nor its query or body: a path
 * parameter or a query can carry a token), the status answered and how long it took (the Python worker's `aiohttp.access`).
 */
import type { Logger } from "@primusclaw/personal-agent";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import type { HttpRequest, HttpResponse, HttpRoute } from "./routes.js";

export interface ServerOptions {
  readonly routes: readonly HttpRoute[];
  /** The largest body accepted, in bytes (413 beyond it). */
  readonly maxBodyBytes: number;
  /** Where the one line per request goes; none: no line. */
  readonly accessLog?: Logger;
  /** Routes (as declared) whose line is at debug, not info: a probe that answers every few seconds. */
  readonly quietRoutes?: readonly string[];
}

/** The route a request matched, as declared; a request that matched none is logged as this, never by its path. */
export const UNMATCHED_ROUTE = "(unmatched)";

/** One line for the request once it is answered: method, declared route, status, duration in ms. */
function logRequest(log: Logger, quiet: ReadonlySet<string>, request: FastifyRequest, reply: FastifyReply): void {
  const route = request.routeOptions.url ?? UNMATCHED_ROUTE;
  const fields = { method: request.method, route, status: reply.statusCode, ms: Math.round(reply.elapsedTime) };
  if (quiet.has(route)) log.debug("http request", fields);
  else log.info("http request", fields);
}

/** The headers as sent (names lower case); Object.fromEntries keeps a "__proto__" header as an own key. */
function headersOf(request: FastifyRequest): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]): [string, string][] =>
      value === undefined ? [] : [[name.toLowerCase(), Array.isArray(value) ? value.join(", ") : value]],
    ),
  );
}

function toRequest(request: FastifyRequest): HttpRequest {
  const url = new URL(request.url, "http://localhost");
  const params = (request.params ?? {}) as Record<string, string>;
  const body = request.body instanceof Uint8Array ? request.body : new Uint8Array();
  return { headers: headersOf(request), params, query: url.searchParams, body };
}

async function send(reply: FastifyReply, response: HttpResponse): Promise<void> {
  reply.code(response.status);
  if ("json" in response) {
    await reply.type("application/json; charset=utf-8").send(JSON.stringify(response.json));
    return;
  }
  await reply.type(response.contentType ?? "text/plain; charset=utf-8").send(response.text);
}

/** A server with `routes` mounted; not yet listening. */
export function buildServer(options: ServerOptions): FastifyInstance {
  const app = fastify({ bodyLimit: options.maxBodyBytes, logger: false });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  const accessLog = options.accessLog;
  if (accessLog !== undefined) {
    const quiet = new Set(options.quietRoutes ?? []);
    app.addHook("onResponse", (request, reply, done) => {
      logRequest(accessLog, quiet, request, reply);
      done();
    });
  }
  for (const route of options.routes) {
    app.route({
      method: route.method,
      url: route.path,
      handler: async (request, reply) => {
        await send(reply, await route.handle(toRequest(request)));
      },
    });
  }
  return app;
}

/** Listen on `host:port`; the port actually bound (for port 0). */
export async function listen(app: FastifyInstance, host: string, port: number): Promise<number> {
  await app.listen({ host, port });
  const address = app.server.address();
  return typeof address === "object" && address !== null ? address.port : port;
}
