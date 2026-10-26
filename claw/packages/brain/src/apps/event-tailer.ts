// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Forwarding a hosted application's progress events (hosting design 5.7).
 *
 * The application appends CloudEvents 1.0 JSON lines to rolling segment files
 * `<events dir>/<10 digits>.jsonl` (the `cloudevents/v1` format of the app
 * manifest). The tailer reads them from inside the app sandbox through EnvD,
 * checks the envelope, publishes each event to the session's event stream and
 * only then moves the cursor on the run's row. Claw reads the envelope and
 * nothing in `data`.
 *
 * Four rules carry the correctness, each in one place:
 *
 *  - Only a line that ends in a newline is an event ({@link scanLines}): the
 *    writer can be killed mid-line, and the unfinished bytes are never taken
 *    for one. The cursor never moves past them.
 *  - The directory is listed BEFORE the segment is read. A newer segment can
 *    exist only once the older one is complete, so when the listing shows a newer
 *    one and the read then hits end of file, the older one is finished and the
 *    cursor rolls over to the next ({@link tailOnce}).
 *  - Publish first, cursor second. A crash in between re-reads the batch, so the
 *    delivery is at least once; the consumer de-duplicates on
 *    `(app_task_id, event.id)`. Within one run of the tailer, ids at or below the
 *    last forwarded one are skipped too (`last_id` is part of the cursor, so this
 *    also holds after a restart of the Brain).
 *  - Every read is bounded: 1 MiB and 500 events a round.
 */
import pino from "pino";
import { APP_EVENT_ID, APP_EVENT_SEGMENT_NAME } from "@claw/protocol";
import type { SandboxExecResult, SandboxInstance } from "../sandbox/provider.js";
import type { AppEventsCursor, AppRunRecord, AppRunStore } from "./app-run-store.js";
import type { AppRunContext, AppRunnerSeams } from "./app-runner.js";
import { shq } from "./app-env.js";

const logger = pino({ name: "app-event-tailer" });

export const EVENTS_READ_BYTES = 1024 * 1024;
export const EVENTS_PER_ROUND = 500;
/** An event over this is skipped. The usual writer keeps each under 16 KiB. */
export const EVENT_MAX_BYTES = 64 * 1024;
/** Rounds one drain makes at most, so a runaway writer cannot hold a run open. */
export const DRAIN_MAX_ROUNDS = 64;
const EXEC_TIMEOUT = "30s";
const DECIMAL_ID = APP_EVENT_ID;

export type AppEventMessage = {
  type: "appEvent";
  app_task_id: string;
  event: Record<string, unknown>;
};

export interface EventTailerDeps {
  exec(inst: SandboxInstance, command: string, timeout: string): Promise<SandboxExecResult>;
  store: Pick<AppRunStore, "patch">;
  /** To the session's event stream, `events.<sessionId>`. */
  publish(sessionId: string, message: AppEventMessage): Promise<void>;
}

export interface Scan {
  /** The complete lines, without their newline, and where each one ends (bytes from the start of the buffer, newline included). */
  lines: Array<{ text: Buffer; end: number }>;
  /** Bytes after the last scanned line: an unfinished line, or lines past the per-round cap. */
  rest: number;
  /** True when the cap stopped the scan, so `rest` may hold complete lines. */
  capped: boolean;
}

/** The newline-terminated lines of `buf`, at most `max` of them. */
export function scanLines(buf: Buffer, max: number): Scan {
  const lines: Scan["lines"] = [];
  let pos = 0;
  while (lines.length < max) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) return { lines, rest: buf.length - pos, capped: false };
    lines.push({ text: buf.subarray(pos, nl), end: nl + 1 });
    pos = nl + 1;
  }
  return { lines, rest: buf.length - pos, capped: pos < buf.length };
}

/** The envelope's required attributes, or why the line is not an event. */
export function checkEnvelope(value: unknown): { ok: true; id: bigint } | { ok: false; reason: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "not_an_object" };
  const e = value as Record<string, unknown>;
  for (const key of ["specversion", "id", "source", "type"] as const) {
    if (typeof e[key] !== "string" || e[key] === "") return { ok: false, reason: `missing_${key}` };
  }
  if (e.specversion !== "1.0") return { ok: false, reason: "specversion_not_1_0" };
  if (!DECIMAL_ID.test(e.id as string)) return { ok: false, reason: "id_not_decimal" };
  return { ok: true, id: BigInt(e.id as string) };
}

const toBigInt = (id: string | undefined): bigint | null => (id !== undefined && DECIMAL_ID.test(id) ? BigInt(id) : null);

/**
 * Bytes of one segment from `offset`, at most `limit`, as one line of base64 (so
 * the byte count survives the exec text channel). Prints nothing when the file is not there.
 */
export function readCommand(file: string, offset: number, limit: number): string {
  const f = shq(file);
  return `if [ -f ${f} ]; then tail -c +${offset + 1} ${f} | head -c ${limit} | base64 | tr -d '\\n'; fi`;
}

const SEPARATOR = "@@claw-events-read@@";

/**
 * The listing and, when the cursor names a segment, the read of that segment, in
 * ONE exec: an idle run costs one call a tick, and the listing still comes first
 * (see the second rule in the header), because one shell runs them in order.
 */
export function roundCommand(dir: string, cursorSegment: string | undefined, offset: number, limit: number): string {
  const read = cursorSegment ? readCommand(`${dir}/${cursorSegment}`, offset, limit) : "true";
  return `ls -1 ${shq(dir)} 2>/dev/null; echo ${SEPARATOR}; ${read}`;
}

function splitRound(stdout: string): { listing: string; payload: string } | null {
  const at = stdout.indexOf(`${SEPARATOR}\n`);
  const end = at < 0 ? stdout.indexOf(SEPARATOR) : at;
  if (end < 0) return null;
  return { listing: stdout.slice(0, end), payload: stdout.slice(end + SEPARATOR.length).trim() };
}

function sameCursor(a: AppEventsCursor, b: AppEventsCursor): boolean {
  return a.segment === b.segment && a.offset === b.offset && a.last_id === b.last_id;
}

interface Where { dir: string; instance: SandboxInstance; record: AppRunRecord }

function whereOf(ctx: AppRunContext): Where | null {
  const { record, instance } = ctx;
  const rel = record.manifest.events?.dir;
  if (!rel || !record.state_dir || !instance) return null;
  return { dir: `${record.state_dir}/${rel}`, instance, record };
}

/** Events published at once. Order is kept (one connection, calls made in order); the acks are awaited together. */
export const PUBLISH_CONCURRENCY = 32;

interface Planned { end: number; event?: { id: string; value: bigint; body: Record<string, unknown> } }

/**
 * One round: at most one segment read, up to {@link EVENTS_READ_BYTES} and
 * {@link EVENTS_PER_ROUND} events. Answers the cursor it ended at; `progressed`
 * is false when there was nothing to move over.
 *
 * Without `ctx.scrub` (the run's secret values are not known yet) nothing is
 * read: a line the application wrote could carry one, and the cursor would
 * move past it for good.
 */
export async function tailOnce(
  deps: EventTailerDeps, ctx: AppRunContext, from: AppEventsCursor,
): Promise<{ cursor: AppEventsCursor; progressed: boolean }> {
  const where = whereOf(ctx);
  const idle = { cursor: from, progressed: false };
  if (!where) return idle;
  const { record } = where;
  if (!ctx.scrub) {
    logger.warn({ runId: record.run_id }, "app_events.waiting_for_secrets");
    return idle;
  }
  const scrub = ctx.scrub;

  // The listing comes first: see the second rule in the header.
  const startOffset = from.offset ?? 0;
  const first = await deps.exec(where.instance, roundCommand(where.dir, from.segment, startOffset, EVENTS_READ_BYTES), EXEC_TIMEOUT);
  if (first.exitCode !== 0) return idle;
  const round = splitRound(first.stdout);
  if (!round) return idle;
  const segments = round.listing.split("\n").map((s) => s.trim()).filter((s) => APP_EVENT_SEGMENT_NAME.test(s)).sort();
  if (segments.length === 0) return idle;

  let segment: string;
  let offset: number;
  let payload: string | null = null;
  if (from.segment && segments.includes(from.segment)) {
    segment = from.segment;
    offset = startOffset;
    payload = round.payload;
  } else if (!from.segment) {
    segment = segments[0]!;
    offset = 0;
  } else {
    const next = segments.find((s) => s > from.segment!);
    if (next) {
      logger.warn({ runId: record.run_id, was: from.segment, now: next }, "app_events.segment_gone");
      segment = next;
    } else {
      // Every segment is older than the cursor: the directory was emptied, or numbering started again.
      // Start over at the oldest one; `last_id` still drops what was forwarded already.
      segment = segments[0]!;
      logger.warn({ runId: record.run_id, was: from.segment, now: segment }, "app_events.segment_numbering_went_back");
    }
    offset = 0;
  }
  const later = segments.find((s) => s > segment);

  if (payload === null) {
    const read = await deps.exec(where.instance, readCommand(`${where.dir}/${segment}`, offset, EVENTS_READ_BYTES), EXEC_TIMEOUT);
    if (read.exitCode !== 0) return idle;
    payload = read.stdout.trim();
  }
  const buf = Buffer.from(payload, "base64");
  const atEnd = buf.length < EVENTS_READ_BYTES;
  const scan = scanLines(buf, EVENTS_PER_ROUND);

  // First look at every line (cheap, no I/O): what is skipped, what is an event.
  let lastId = toBigInt(from.last_id);
  const plan: Planned[] = [];
  for (const line of scan.lines) {
    const skip = (reason: string, id?: string): void => {
      logger.warn({ runId: record.run_id, segment, reason, ...(id ? { id } : {}) }, "app_events.skipped");
      plan.push({ end: line.end });
    };
    if (line.text.length === 0) { plan.push({ end: line.end }); continue; }
    if (line.text.length > EVENT_MAX_BYTES) { skip("too_large"); continue; }
    let parsed: unknown;
    try {
      parsed = JSON.parse(scrub(line.text.toString("utf8")));
    } catch {
      skip("not_json");
      continue;
    }
    const envelope = checkEnvelope(parsed);
    if (!envelope.ok) { skip(envelope.reason); continue; }
    const id = (parsed as { id: string }).id;
    if (lastId !== null && envelope.id <= lastId) { skip("id_not_increasing", id); continue; }
    lastId = envelope.id;
    plan.push({ end: line.end, event: { id, value: envelope.id, body: parsed as Record<string, unknown> } });
  }

  const cursorAfter = (count: number): AppEventsCursor => {
    let lastForwarded = from.last_id;
    for (const p of plan.slice(0, count)) if (p.event) lastForwarded = p.event.id;
    return {
      segment, offset: offset + (count > 0 ? plan[count - 1]!.end : 0),
      ...(lastForwarded !== undefined ? { last_id: lastForwarded } : {}),
    };
  };
  const persist = async (cursor: AppEventsCursor): Promise<void> => {
    if (!sameCursor(cursor, from)) await deps.store.patch(record.run_id, { events_cursor: cursor });
  };

  // Publish in order, a bounded number at a time. Anything published beyond the
  // first failure is published again next round (at least once); the cursor
  // only moves over what came before it.
  for (let at = 0; at < plan.length; ) {
    let upto = at;
    const batch: Array<{ index: number; p: Promise<void> }> = [];
    while (upto < plan.length && batch.length < PUBLISH_CONCURRENCY) {
      const event = plan[upto]!.event;
      if (event) batch.push({ index: upto, p: deps.publish(record.session_id, { type: "appEvent", app_task_id: record.run_id, event: event.body }) });
      upto++;
    }
    const settled = await Promise.allSettled(batch.map((b) => b.p));
    const failed = settled.findIndex((r) => r.status === "rejected");
    if (failed >= 0) {
      await persist(cursorAfter(batch[failed]!.index)).catch(() => undefined);
      throw (settled[failed] as PromiseRejectedResult).reason;
    }
    at = upto;
  }

  let cursor = cursorAfter(plan.length);
  const lastForwarded = cursor.last_id;
  if (scan.lines.length === 0 && scan.rest >= EVENTS_READ_BYTES) {
    // A full window without a newline is not an event the writer makes: skip it.
    // The fragment that follows, up to the next newline, is skipped as not_json.
    logger.warn({ runId: record.run_id, segment }, "app_events.window_without_newline_skipped");
    cursor = { ...cursor, offset: offset + buf.length };
  } else if (atEnd && !scan.capped && later) {
    // End of a finished segment: whatever is left is a write that never completed.
    if (scan.rest > 0) logger.warn({ runId: record.run_id, segment, bytes: scan.rest }, "app_events.unfinished_tail_dropped");
    cursor = { segment: later, offset: 0, ...(lastForwarded !== undefined ? { last_id: lastForwarded } : {}) };
  }
  await persist(cursor);
  return { cursor, progressed: !sameCursor(cursor, from) };
}

/** The AppRunner's seams for event forwarding: one round per tick while running, and a bounded drain at finishing. */
export function createEventTailer(deps: EventTailerDeps): Pick<AppRunnerSeams, "tailEvents" | "drainEvents"> {
  return {
    async tailEvents(ctx) {
      await tailOnce(deps, ctx, ctx.record.events_cursor ?? {});
    },
    async drainEvents(ctx) {
      // Not "nothing to read": finishing step 2 would be marked done with the events unread. The step retries.
      if (!ctx.scrub && ctx.instance && ctx.record.manifest.events) throw new Error("events cannot be drained before the run's secrets are known");
      let cursor = ctx.record.events_cursor ?? {};
      for (let round = 0; round < DRAIN_MAX_ROUNDS; round++) {
        const step = await tailOnce(deps, ctx, cursor);
        if (!step.progressed) return;
        cursor = step.cursor;
      }
      logger.warn({ runId: ctx.record.run_id, rounds: DRAIN_MAX_ROUNDS }, "app_events.drain_round_limit");
    },
  };
}
