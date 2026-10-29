// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A real HTTP server standing in for an upstream (SaFE, the LLM gateway).
 *
 * A stubbed `fetch` would prove the route calls `fetch`; a server proves what
 * actually went over the wire -- the URL, the method and, above all, which
 * credential was presented -- and lets "the dependency is down" be a closed
 * socket rather than a thrown string the test wrote itself.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenRequest {
  method: string;
  /** The request target as sent, query included. */
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeUpstream {
  url: string;
  seen: SeenRequest[];
  close(): Promise<void>;
}

export type Handler = (req: SeenRequest, res: http.ServerResponse, raw: http.IncomingMessage) => void;

export async function startFakeUpstream(handler: Handler): Promise<FakeUpstream> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((raw, res) => {
    const chunks: Buffer[] = [];
    raw.on("data", (c: Buffer) => chunks.push(c));
    raw.on("end", () => {
      const req: SeenRequest = {
        method: raw.method ?? "",
        url: raw.url ?? "",
        headers: raw.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(req);
      handler(req, res, raw);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/** A port nothing is listening on: connecting to it is refused. */
export async function closedPortUrl(): Promise<string> {
  const probe = await startFakeUpstream((_r, res) => res.end());
  const url = probe.url;
  await probe.close();
  return url;
}
