// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stand-in for SaFE, for the terminal's tests.
 *
 * It speaks the part of SaFE the terminal uses -- the workload list and detail,
 * a pod's containers, and the webshell WebSocket -- over real sockets, so what is
 * asserted is what crosses the wire: the credential presented, the query the
 * upgrade carries, and the frames in both directions. Every behaviour a test
 * needs to vary is a field on `safe`.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

export interface ShellConnection {
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  socket: WebSocket;
  received: { data: Buffer; isBinary: boolean }[];
  closed: { code: number; reason: string } | null;
}

export interface FakeSafe {
  url: string;
  port: number;
  /** The bearer the fake accepts; any other is a 401. */
  key: string;
  workloads: Record<string, Record<string, unknown>>;
  list: Record<string, unknown>[];
  containers: Record<string, { name: string }[]>;
  /** Every request path (with query) the fake answered, in order. */
  calls: string[];
  shells: ShellConnection[];
  /** When set, the webshell upgrade is answered with this HTTP status instead. */
  refuseShell: number | null;
  /** How long the webshell upgrade is held before it is answered. */
  upgradeDelayMs: number;
  /** Called when a shell connects, so a test can make it talk or hang up. */
  onShell: ((conn: ShellConnection) => void) | null;
  close(): Promise<void>;
}

export const SAFE_KEY = "ak-test-owner-key";

export async function startFakeSafe(): Promise<FakeSafe> {
  const wss = new WebSocketServer({ noServer: true });
  const safe: FakeSafe = {
    url: "", port: 0, key: SAFE_KEY, workloads: {}, list: [], containers: {}, calls: [], shells: [],
    refuseShell: null, upgradeDelayMs: 0, onShell: null, close: async () => {},
  };
  const authorised = (header: string | undefined) => header === `Bearer ${safe.key}`;

  const server: Server = createServer((req, res) => {
    safe.calls.push(req.url ?? "");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!authorised(req.headers.authorization)) return send(401, { errorCode: "unauthorized" });
    const url = new URL(req.url ?? "", "http://fake");
    let m = /^\/api\/v1\/workloads\/([^/]+)\/pods\/([^/]+)\/containers$/.exec(url.pathname);
    if (m) {
      const c = safe.containers[`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`];
      return c ? send(200, { containers: c, shells: ["sh"] }) : send(404, {});
    }
    m = /^\/api\/v1\/workloads\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const w = safe.workloads[decodeURIComponent(m[1])];
      return w ? send(200, w) : send(404, {});
    }
    if (url.pathname === "/api/v1/workloads") {
      const want = url.searchParams.get("envValue");
      return send(200, { totalCount: safe.list.length, items: safe.list.filter((w) => w.__env === want).map(({ __env, ...w }) => w) });
    }
    return send(404, {});
  });

  server.on("upgrade", (req, socket, head) => {
    safe.calls.push(req.url ?? "");
    socket.on("error", () => {});
    if (!authorised(req.headers.authorization)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      return socket.destroy();
    }
    if (safe.refuseShell) {
      socket.write(`HTTP/1.1 ${safe.refuseShell} Refused\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
      return socket.destroy();
    }
    const accept = () => wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: ShellConnection = {
        url: new URL(req.url ?? "", "http://fake"),
        headers: req.headers,
        socket: ws,
        received: [],
        closed: null,
      };
      ws.on("message", (data: Buffer, isBinary: boolean) => conn.received.push({ data: Buffer.from(data as Buffer), isBinary }));
      ws.on("close", (code: number, reason: Buffer) => { conn.closed = { code, reason: reason.toString("utf8") }; });
      safe.shells.push(conn);
      safe.onShell?.(conn);
    });
    if (safe.upgradeDelayMs > 0) setTimeout(accept, safe.upgradeDelayMs); else accept();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  safe.port = (server.address() as AddressInfo).port;
  safe.url = `http://127.0.0.1:${safe.port}`;
  safe.close = async () => {
    for (const c of safe.shells) c.socket.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return safe;
}

/** A workload as SaFE reports it. */
export function workload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workloadId: "wl-1",
    workspaceId: "ws-a",
    phase: "Running",
    message: "",
    creationTime: "2026-10-29T08:00:00",
    userId: "u-1",
    pods: [{ podId: "wl-1-pod-0", phase: "Running" }],
    ...over,
  };
}

/** A fake SaFE already holding one running sandbox, bound to wl-1. */
export function withRunningSandbox(safe: FakeSafe): void {
  safe.workloads["wl-1"] = workload();
  safe.containers["wl-1/wl-1-pod-0"] = [{ name: "main" }];
}

/** Connect and resolve when open; reject with the HTTP status when the upgrade is refused. */
export function openSocket(
  url: string,
  opts: { autoPong?: boolean } = {},
): Promise<{ ws: WebSocket } | { status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { autoPong: opts.autoPong ?? true, perMessageDeflate: false });
    ws.once("open", () => resolve({ ws }));
    ws.once("unexpected-response", (_req, res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => { ws.terminate(); resolve({ status: res.statusCode ?? 0, body }); });
    });
    ws.once("error", (err) => reject(err));
  });
}

export function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no message arrived")), timeoutMs);
    ws.once("message", (data: Buffer, isBinary: boolean) => { clearTimeout(t); resolve({ data: Buffer.from(data), isBinary }); });
  });
}

export function nextClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.CLOSED) return reject(new Error("already closed"));
    const t = setTimeout(() => reject(new Error("socket did not close")), timeoutMs);
    ws.once("close", (code: number, reason: Buffer) => { clearTimeout(t); resolve({ code, reason: reason.toString("utf8") }); });
  });
}

/** Poll until `pred` holds; the sockets close on their own schedule. */
export async function until(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
