// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's HTTP server (fastify): the routes it is given, each body read raw (never parsed by the server: a route
 * that verifies a signature needs the bytes as sent), within a size limit.
 */
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import type { HttpRequest, HttpResponse, HttpRoute } from "./routes.js";

export interface ServerOptions {
  readonly routes: readonly HttpRoute[];
  /** The largest body accepted, in bytes (413 beyond it). */
  readonly maxBodyBytes: number;
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
