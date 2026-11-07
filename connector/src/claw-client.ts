// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The connector's side of the remote-agents HTTP API: register, heartbeat, post events, hold the command stream. */
import type { TokenProvider } from "./credentials.js";
import type { OutEvent } from "./outbox.js";
import { readSse, type SseFrame } from "./sse.js";
import type { RemoteAgentDescriptor } from "./protocol.js";
import { errMessage, isObject, secureUrl } from "./util.js";

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
export class TransportError extends Error {
  /** `true`: Claw had answered (a command stream that broke or went silent after it opened), so Claw was up. */
  constructor(message: string, readonly afterAnswer = false) { super(message); }
}

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
    // A bearer token is never sent over plain http to anything but this machine.
    this.o = { ...o, server: secureUrl(o.server, "the Claw server URL") };
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

  private async json(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const res = await this.send(method, path, body, signal);
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
   * Whether command `cmdId`, received late (after a stall, held in the network, or past the live TTL), may still be carried out:
   * Claw's answer, `live` or why not (`session_closed`, `cancelled`, `expired`, `gone`). `received_late`: it was already older than
   * the live TTL when it came (only then may Claw call it `expired`). Throws {@link RevokedError} when this connector was revoked,
   * and {@link HttpError} 404 with a code other than `not_found` from a Claw that has no such route.
   */
  async confirmCommand(cid: string, cmdId: string, q: { why: string; received_late: boolean }, signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.o.requestTimeoutMs ?? 20_000);
    const d = await this.json("POST", `/v1/remote-agents/connectors/${encodeURIComponent(cid)}/commands/${encodeURIComponent(cmdId)}/confirm`, q,
      signal ? AbortSignal.any([signal, timeout]) : timeout);
    return typeof d.status === "string" ? d.status : "unknown";
  }

  /**
   * Revoke connector `cid` at Claw, for `logout`: Claw sends it nothing more and closes its sessions. A key is a user's
   * credential and uses the user-side DELETE; a device sign-in's access token is refused there, and uses the
   * connector-side route made for this. Throws {@link HttpError} 404 `not_found` when Claw has no live row by that id
   * for this sign-in (already revoked, or another account's).
   */
  async revoke(cid: string, kind: "key" | "device" | "grant"): Promise<void> {
    const id = encodeURIComponent(cid);
    if (kind === "key") await this.json("DELETE", `/v1/remote-agents/connectors/${id}`);
    else await this.json("POST", `/v1/remote-agents/connectors/${id}/revoke`);
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
        throw new TransportError(timedOut ? `no byte for ${opts.watchdogMs} ms` : `command stream: ${errMessage(e)}`, true);
      }
      if (timedOut) throw new TransportError(`no byte for ${opts.watchdogMs} ms`, true);
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
