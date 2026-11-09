// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A request the fake server received, as read (the body as text; `json` when it parsed). */
export interface ReceivedRequest {
  readonly method: string;
  /** Path and query, as sent. */
  readonly url: string;
  readonly path: string;
  readonly query: URLSearchParams;
  /** Header names lower case; repeated headers joined with ", ". */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly json: unknown;
}

/** What a route answers: a status and a JSON or text body, or a stream of server-sent events. */
export type Reply =
  | {
      readonly status: number;
      readonly json?: unknown;
      readonly text?: string;
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly sse: AsyncIterable<SseFrame> | Iterable<SseFrame>; readonly status?: number };

export interface SseFrame {
  readonly event?: string;
  readonly data: string;
  readonly id?: string;
}

export type Handler = (request: ReceivedRequest) => Reply | Promise<Reply>;

/** A route: method and a path that is equal (a string) or matches (a RegExp). */
export interface Route {
  readonly method: string;
  readonly path: string | RegExp;
  readonly handle: Handler;
}

/**
 * A real HTTP server on the loopback, for tests of an HTTP client (a fake Claw, a fake Bot Connector, a fake identity
 * service). Every request is recorded in `requests`; the first route that matches answers it, and a request no route
 * matches gets 404 and is recorded in `unmatched` (a test can assert there were none). Routes can be added while it runs.
 */
export class FakeHttpServer {
  readonly requests: ReceivedRequest[] = [];
  readonly unmatched: ReceivedRequest[] = [];
  private readonly routes: Route[] = [];
  private readonly server: Server;

  private constructor(routes: readonly Route[]) {
    this.routes.push(...routes);
    this.server = createServer((req, res) => {
      void this.serve(req, res);
    });
  }

  /** Start on 127.0.0.1 with an ephemeral port. */
  static async start(routes: readonly Route[] = []): Promise<FakeHttpServer> {
    const fake = new FakeHttpServer(routes);
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    return fake;
  }

  /** The base URL, e.g. "http://127.0.0.1:41234" (no trailing slash). */
  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${String(port)}`;
  }

  route(method: string, path: string | RegExp, handle: Handler): void {
    this.routes.push({ method, path, handle });
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const request = await read(req);
    this.requests.push(request);
    const route = this.routes.find((r) => r.method === request.method && matches(r.path, request.path));
    if (route === undefined) {
      this.unmatched.push(request);
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "no_route" }));
      return;
    }
    try {
      await write(res, await route.handle(request));
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" }).end(error instanceof Error ? error.name : "error");
    }
  }
}

function matches(pattern: string | RegExp, path: string): boolean {
  return typeof pattern === "string" ? pattern === path : pattern.test(path);
}

async function read(req: IncomingMessage): Promise<ReceivedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const url = req.url ?? "/";
  const parsed = new URL(url, "http://fake");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return {
    method: req.method ?? "GET",
    url,
    path: parsed.pathname,
    query: parsed.searchParams,
    headers,
    body,
    json: parseJson(body),
  };
}

function parseJson(body: string): unknown {
  if (body === "") return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

async function write(res: ServerResponse, reply: Reply): Promise<void> {
  if ("sse" in reply) {
    res.writeHead(reply.status ?? 200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for await (const frame of reply.sse) res.write(sseText(frame));
    res.end();
    return;
  }
  if (reply.json !== undefined) {
    res.writeHead(reply.status, { "content-type": "application/json", ...reply.headers });
    res.end(JSON.stringify(reply.json));
    return;
  }
  res.writeHead(reply.status, { "content-type": "text/plain", ...reply.headers }).end(reply.text ?? "");
}

/** One server-sent event as it is written on the wire. */
export function sseText(frame: SseFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  for (const line of frame.data.split("\n")) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}
