// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The parts of the assistant's end-to-end script that are not the scenario: a webhook receiver that checks
 * what it is sent, the measurements, and a small API client. Kept apart so they are tested (see
 * `assistant-e2e-lib.test.ts`) and the script itself is only the story it tells.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, verifySignature } from "../../src/notifications/signing.js";

export interface Received {
  /** `Date.now()` when the receiver accepted it. */
  at: number;
  eventId: string;
  type: string;
  text: string;
  item?: { item_id: string; seq: number; title: string; board_state: string; result_version: number; can_accept: boolean };
  fallback: boolean;
  /** The signature and timestamp checked out under the subscription's secret. */
  verified: boolean;
}

export interface Receiver {
  port: number;
  /** Events it accepted (answered 2xx), in arrival order. */
  received: Received[];
  /** Events it was sent and refused: bad signature, or `reject` mode. */
  refused: Array<{ at: number; why: string }>;
  /** Set once the subscription exists; until then nothing can be verified and everything is refused. */
  setSecret(secret: string): void;
  /** While true every delivery is answered 500 and not recorded as received. */
  setRejecting(rejecting: boolean): void;
  close(): Promise<void>;
}

export async function startReceiver(port = 0, host = "0.0.0.0"): Promise<Receiver> {
  let secret = "";
  let rejecting = false;
  const received: Received[] = [];
  const refused: Receiver["refused"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const at = Date.now();
      const refuse = (status: number, why: string) => { refused.push({ at, why }); res.statusCode = status; res.end(why); };
      if (req.method !== "POST" || req.url !== "/hook") return refuse(404, "not found");
      if (rejecting) return refuse(500, "rejecting");
      const verdict = verifySignature({
        secret, body,
        timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
        signature: req.headers[SIGNATURE_HEADER] as string | undefined,
      });
      if (verdict !== "ok") return refuse(401, `signature ${verdict}`);
      let payload: Record<string, any>;
      try { payload = JSON.parse(body); } catch { return refuse(400, "not json"); }
      if (payload.event_id !== req.headers[EVENT_ID_HEADER]) return refuse(400, "event id header differs from body");
      received.push({
        at, eventId: String(payload.event_id), type: String(payload.type), text: String(payload.text ?? ""),
        item: payload.item, fallback: payload.fallback === true, verified: true,
      });
      res.statusCode = 200;
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  return {
    port: (server.address() as AddressInfo).port,
    received, refused,
    setSecret: (s) => { secret = s; },
    setRejecting: (r) => { rejecting = r; },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Event ids the receiver accepted more than once: a delivered message that arrived twice. Must be none. */
export function duplicateEventIds(received: readonly Received[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const r of received) (seen.has(r.eventId) ? dups : seen).add(r.eventId);
  return [...dups];
}

/** Nearest-rank percentile of a list of numbers; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export interface Timing { label: string; sentAt: number; answeredAt: number | null }

export const latencyMs = (t: Timing): number | null => (t.answeredAt === null ? null : t.answeredAt - t.sentAt);

/** A table a person can read in the log, with a verdict column against the budget. */
export function renderTimings(timings: readonly Timing[], budgetMs: number): string {
  const rows = timings.map((t) => {
    const ms = latencyMs(t);
    const verdict = ms === null ? "NO ANSWER" : ms < budgetMs ? "ok" : "TOO SLOW";
    return `${t.label.padEnd(34)} ${new Date(t.sentAt).toISOString()}  ${ms === null ? "-".padStart(8) : `${ms}ms`.padStart(8)}  ${verdict}`;
  });
  return ["interjection                       sent (UTC)                   latency  verdict", ...rows].join("\n");
}

export interface ApiResult { status: number; json: any }

export function apiClient(base: string, defaultKey: string) {
  return async (method: string, path: string, body?: unknown, key: string = defaultKey): Promise<ApiResult> => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* a file, or an error page: the status says */ }
    return { status: res.status, json: json ?? text };
  };
}

/** Poll until `probe` returns something other than undefined, or the deadline passes (then null: never "assumed fine"). */
export async function until<T>(probe: () => Promise<T | undefined> | T | undefined, deadlineAt: number, everyMs = 250): Promise<T | null> {
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadlineAt) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
