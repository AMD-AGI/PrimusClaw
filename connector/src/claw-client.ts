// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The connector's side of the remote-agents HTTP API: register, heartbeat, post events, hold the command stream. */
import type { TokenProvider } from "./credentials.js";
import type { OutEvent } from "./outbox.js";
import { readSse, type SseFrame } from "./sse.js";
import type { RemoteAgentDescriptor } from "./protocol.js";
import { errMessage, isObject } from "./util.js";

/** 401 `revoked`: the owner disconnected this connector. Not an error to retry. */
export class RevokedError extends Error {
  constructor() { super("this connector was revoked"); }
}
/** The server answered, with a status that is not a success. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, readonly path: string) {
    super(`${path} answered ${status} ${code}`);
  }
}
/** The network failed or the stream went silent. */
export class TransportError extends Error {}

export interface ClawClientOptions {
  /** Base URL up to and including any gateway prefix, without a trailing slash. */
  server: string;
  tokens: TokenProvider;
  fetch?: typeof fetch;
  /** Sent as `X-Claw-Client`, for the audit trail. */
  clientLabel?: string;
  requestTimeoutMs?: number;
}

export interface EventsAck {
  acked: Record<string, number>;
  rejected: Array<{ index: number; session_id: string | null; seq: number | null; reason: string }>;
}

export class ClawClient {
  private readonly f: typeof fetch;
  constructor(private readonly o: ClawClientOptions) {
    this.f = o.fetch ?? fetch;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.o.tokens.bearer()}`,
      "x-claw-client": this.o.clientLabel ?? "connector",
      accept: "application/json",
      ...extra,
    };
  }

  private async send(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const url = this.o.server + path;
    for (let attempt = 0; ; attempt++) {
      // Credential problems (a revoked grant, an unreachable identity service) propagate as themselves.
      const headers = await this.headers(body === undefined ? {} : { "content-type": "application/json" });
      let res: Response;
      try {
        res = await this.f(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(this.o.requestTimeoutMs ?? 20_000),
        });
      } catch (e) {
        throw new TransportError(`${method} ${path}: ${errMessage(e)}`);
      }
      if (res.status !== 401) return res;
      const err = await errorCode(res);
      if (err === "revoked") throw new RevokedError();
      // Maybe the access token simply expired: get a fresh one once.
      if (attempt === 0) { this.o.tokens.invalidate(); continue; }
      throw new HttpError(401, err, path);
    }
  }

  private async json(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.send(method, path, body);
    if (!res.ok) throw new HttpError(res.status, await errorCode(res), path);
    const parsed: unknown = await res.json().catch(() => null);
    return isObject(parsed) && isObject(parsed.data) ? parsed.data : {};
  }

  async register(name: string, version: string): Promise<string> {
    const d = await this.json("POST", "/v1/remote-agents/connectors", { name, version });
    if (typeof d.connector_id !== "string") throw new HttpError(500, "no_connector_id", "/v1/remote-agents/connectors");
    return d.connector_id;
  }

  async heartbeat(cid: string, hb: { version: string; agents: RemoteAgentDescriptor[]; cmd_cursor: number | null }): Promise<void> {
    await this.json("POST", `/v1/remote-agents/connectors/${cid}/heartbeat`, hb);
  }

  async postEvents(cid: string, batchId: string, events: OutEvent[]): Promise<EventsAck> {
    const d = await this.json("POST", `/v1/remote-agents/connectors/${cid}/events`, { batch_id: batchId, events });
    return { acked: (isObject(d.acked) ? d.acked : {}) as Record<string, number>, rejected: (Array.isArray(d.rejected) ? d.rejected : []) as EventsAck["rejected"] };
  }

  /**
   * Hold the command stream. Yields every frame (a `ping` too, since it is
   * proof of life). Ends normally when the server closes it; throws
   * {@link TransportError} when the network fails or nothing arrives for
   * `watchdogMs`, and {@link RevokedError} on 401 `revoked`.
   */
  async *commands(cid: string, opts: { lastEventId?: number; signal?: AbortSignal; watchdogMs: number }): AsyncGenerator<SseFrame> {
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; stop.abort(); }, opts.watchdogMs);
      timer.unref?.();
    };
    try {
      arm();
      const path = `/v1/remote-agents/connectors/${cid}/commands`;
      const headers = await this.headers({ accept: "text/event-stream", ...(opts.lastEventId ? { "last-event-id": String(opts.lastEventId) } : {}) });
      let res: Response;
      try {
        res = await this.f(this.o.server + path, { headers, signal: stop.signal });
      } catch (e) {
        throw new TransportError(timedOut ? `no response for ${opts.watchdogMs} ms` : `GET ${path}: ${errMessage(e)}`);
      }
      if (res.status === 401) {
        const err = await errorCode(res);
        if (err === "revoked") throw new RevokedError();
        this.o.tokens.invalidate();
        throw new HttpError(401, err, path);
      }
      if (!res.ok || !res.body) throw new HttpError(res.status, await errorCode(res), path);
      try {
        for await (const frame of readSse(res.body, arm)) yield frame;
      } catch (e) {
        throw new TransportError(timedOut ? `no byte for ${opts.watchdogMs} ms` : `command stream: ${errMessage(e)}`);
      }
      if (timedOut) throw new TransportError(`no byte for ${opts.watchdogMs} ms`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      stop.abort();
    }
  }
}

async function errorCode(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  return isObject(body) && typeof body.error === "string" ? body.error : `http_${res.status}`;
}
