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

/**
 * Poll until `probe` returns something other than undefined, or the deadline passes (then null: never "assumed fine").
 * The deadline is strict: an answer that arrives after it, or a deadline already past, is null.
 */
export async function until<T>(probe: () => Promise<T | undefined> | T | undefined, deadlineAt: number, everyMs = 250): Promise<T | null> {
  for (;;) {
    if (Date.now() > deadlineAt) return null;
    const value = await probe();
    if (value !== undefined) return Date.now() <= deadlineAt ? value : null;
    if (Date.now() >= deadlineAt) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * The tag every task name of one run carries. The Router answers a task it closed in the last day from that item
 * ("already done"), so a rerun whose task names repeat an earlier run's gets no new item; a tag per run prevents it.
 */
export function runTag(given: string | undefined, now = Date.now()): string {
  const tag = (given ?? "").trim();
  return tag || `r${now.toString(36)}`;
}

/** Items created after the board's highest number was `floorSeq`, that the run has not already counted as its own. */
export function newItemsSince<T extends { item_id: string; seq: number }>(board: readonly T[], floorSeq: number, taken: ReadonlySet<string>): T[] {
  return board.filter((i) => Number(i.seq) > floorSeq && !taken.has(i.item_id)).sort((a, b) => a.seq - b.seq);
}

/** The item whose title names this task (`S3a` names neither `S13a` nor `S3ab`), if any. */
export function itemNamed<T extends { title: string }>(items: Iterable<T>, name: string): T | undefined {
  const re = new RegExp(`(^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9])`, "i");
  for (const i of items) if (re.test(i.title)) return i;
  return undefined;
}

export const SESSION_ID_LABEL = "primus-claw/session-id";
const TERMINAL_PHASES = new Set(["Stopped", "Succeeded", "Failed"]);

export interface WorkloadList {
  items?: Array<{ metadata?: { name?: string; labels?: Record<string, string> }; status?: { phase?: string } }>;
}

/** Names of the sandboxes (SaFE workloads) of these sessions that are not yet in a terminal phase. */
export function aliveSandboxes(list: WorkloadList, sessions: ReadonlySet<string>): string[] {
  if (!Array.isArray(list?.items)) throw new Error("the workload list has no items array");
  return list.items
    .filter((w) => sessions.has(w.metadata?.labels?.[SESSION_ID_LABEL] ?? "") && !TERMINAL_PHASES.has(w.status?.phase ?? ""))
    .map((w) => w.metadata?.name ?? "?");
}

/**
 * Runs the scenario, then every registered cleanup whatever happened (latest first, each one even if another failed),
 * and answers the exit code: 0 only if nothing failed. A scenario that throws, or ends without a recorded failure
 * but without finishing, is a failure too.
 */
export async function settle(
  scenario: () => Promise<"finished" | void>, cleanups: Array<{ what: string; run: () => Promise<void> }>, failures: string[],
): Promise<number> {
  try {
    if ((await scenario()) !== "finished" && failures.length === 0) failures.push("the scenario ended before it finished");
  } catch (err) {
    failures.push(`the scenario could not be carried out: ${err instanceof Error ? err.message : String(err)}`);
  }
  for (const c of [...cleanups].reverse()) {
    try { await c.run(); } catch (err) { failures.push(`cleanup: ${c.what}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  return failures.length === 0 ? 0 : 1;
}
