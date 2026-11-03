// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The connector's outbound event log.
 *
 * Every event gets a per-session sequence number that is persisted before the
 * event is queued, so a restart never reuses one (the server keeps the first
 * event it sees for a `(session, seq)` and ignores the rest, so a reused number
 * would silently lose the new event). Events stay on disk until the server
 * acknowledges them, so a dropped connection, a failed POST or a restart loses
 * nothing and, because the server stores each `(session, seq)` once, duplicates
 * nothing either.
 */
import fs from "node:fs";
import path from "node:path";
import { REMOTE_AGENT_LIMITS } from "./protocol.js";

export interface OutEvent {
  session_id: string;
  seq: number;
  type: string;
  ts: number;
  data: Record<string, unknown>;
}

/**
 * The only event types that may be dropped when a session's backlog is full:
 * streaming text and progress. Everything a decision or a turn depends on is
 * kept: `permissionRequest`, `permission_resolved`, `turn_end`, `session_*`.
 */
export const DROPPABLE_TYPES: ReadonlySet<string> = new Set([
  "agent_message_chunk", "agent_thought_chunk", "tool_call_update", "usage_update", "plan",
]);

export interface OutboxOptions {
  dir: string;
  /** Unacknowledged bytes one session may hold before droppable events are shed. */
  maxBytesPerSession?: number;
  now?: () => number;
}

interface Meta { lastSeq: number; acked: number }

/** How long the number of a closed session is remembered. */
export const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;

const safeName = (sid: string) => sid.replace(/[^A-Za-z0-9._-]/g, "_");

/** An event whose data would exceed the server's per-event limit keeps its type and says what happened. */
export function fitData(data: Record<string, unknown>, max: number = REMOTE_AGENT_LIMITS.maxEventBytes - 1024): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(data), "utf8");
  if (bytes <= max) return data;
  return { truncated: true, original_bytes: bytes };
}

export class Outbox {
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private queue: OutEvent[] = [];
  private readonly meta = new Map<string, Meta>();
  private readonly bytes = new Map<string, number>();
  private readonly closed = new Set<string>();

  constructor(opts: OutboxOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytesPerSession ?? 5 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.load();
  }

  private eventsFile = (sid: string) => path.join(this.dir, `${safeName(sid)}.jsonl`);
  private metaFile = (sid: string) => path.join(this.dir, `${safeName(sid)}.meta.json`);

  private writeMeta(sid: string): void {
    const tmp = this.metaFile(sid) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.meta.get(sid)), { mode: 0o600 });
    fs.renameSync(tmp, this.metaFile(sid));
  }

  /** Rebuild the queue from disk. The highest sequence number ever used is the larger of the meta file and the log itself. */
  private load(): void {
    const loaded: OutEvent[] = [];
    const bases = new Set<string>();
    for (const name of fs.readdirSync(this.dir)) {
      if (name.endsWith(".meta.json")) bases.add(name.slice(0, -".meta.json".length));
      else if (name.endsWith(".jsonl")) bases.add(name.slice(0, -".jsonl".length));
    }
    for (const base of bases) {
      let meta: Meta = { lastSeq: 0, acked: 0 };
      try { meta = JSON.parse(fs.readFileSync(path.join(this.dir, `${base}.meta.json`), "utf8")) as Meta; } catch { /* rebuilt from the log below */ }
      let sid: string | null = null;
      const file = path.join(this.dir, `${base}.jsonl`);
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch { /* no log: nothing pending */ }
      for (const line of text.split("\n")) {
        if (!line) continue;
        let ev: OutEvent;
        try { ev = JSON.parse(line) as OutEvent; } catch { continue; } // a torn last line from a crash
        sid = ev.session_id;
        meta.lastSeq = Math.max(meta.lastSeq, ev.seq);
        if (ev.seq > meta.acked) loaded.push(ev);
      }
      if (sid === null) {
        // Nothing pending: the session id is only known from the file name, which is a safe form of it.
        sid = base;
        // A tombstone (a closed session, nothing queued) is forgotten after a long while.
        try {
          if (this.now() - fs.statSync(path.join(this.dir, `${base}.meta.json`)).mtimeMs > TOMBSTONE_MS) {
            for (const f of [`${base}.meta.json`, `${base}.jsonl`]) fs.rmSync(path.join(this.dir, f), { force: true });
            continue;
          }
        } catch { /* keep it */ }
      }
      this.meta.set(sid, meta);
    }
    loaded.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    this.queue = loaded;
    for (const ev of loaded) this.bytes.set(ev.session_id, (this.bytes.get(ev.session_id) ?? 0) + JSON.stringify(ev).length);
  }

  lastSeq(sessionId: string): number {
    return this.meta.get(sessionId)?.lastSeq ?? 0;
  }

  /** Assign the next sequence number, persist the event, queue it. */
  append(sessionId: string, type: string, data: Record<string, unknown>, ts: number = this.now()): OutEvent {
    const meta = this.meta.get(sessionId) ?? { lastSeq: 0, acked: 0 };
    const ev: OutEvent = { session_id: sessionId, seq: meta.lastSeq + 1, type, ts, data: fitData(data) };
    meta.lastSeq = ev.seq;
    this.meta.set(sessionId, meta);
    const line = JSON.stringify(ev);
    fs.appendFileSync(this.eventsFile(sessionId), line + "\n", { mode: 0o600 });
    // The meta file is rewritten on every acknowledgement; between acknowledgements the log's own lines carry the high-water mark.
    if (ev.seq === 1) this.writeMeta(sessionId);
    this.queue.push(ev);
    this.bytes.set(sessionId, (this.bytes.get(sessionId) ?? 0) + line.length);
    if ((this.bytes.get(sessionId) ?? 0) > this.maxBytes) this.shed(sessionId);
    return ev;
  }

  /** Drop the oldest droppable events of a session until it is back under its cap. */
  private shed(sessionId: string): void {
    let total = this.bytes.get(sessionId) ?? 0;
    const keep: OutEvent[] = [];
    let dropped = 0;
    for (const ev of this.queue) {
      if (ev.session_id === sessionId && total > this.maxBytes && DROPPABLE_TYPES.has(ev.type)) {
        total -= JSON.stringify(ev).length;
        dropped++;
        continue;
      }
      keep.push(ev);
    }
    if (!dropped) return;
    this.queue = keep;
    this.bytes.set(sessionId, total);
    this.rewrite(sessionId);
  }

  private rewrite(sessionId: string): void {
    // The log may be about to lose lines the high-water mark was read from (a shed chunk, a refused event): write it down first.
    this.writeMeta(sessionId);
    const mine = this.queue.filter((e) => e.session_id === sessionId);
    const tmp = this.eventsFile(sessionId) + ".tmp";
    fs.writeFileSync(tmp, mine.map((e) => JSON.stringify(e) + "\n").join(""), { mode: 0o600 });
    fs.renameSync(tmp, this.eventsFile(sessionId));
  }

  /** The oldest events not yet acknowledged, in the order they were appended. */
  pending(max: number): OutEvent[] {
    return this.queue.slice(0, max);
  }

  get size(): number {
    return this.queue.length;
  }

  /** The server stored everything up to `acked[session]`. */
  ack(acked: Record<string, number>): void {
    const touched = new Set<string>();
    this.queue = this.queue.filter((ev) => {
      const upTo = acked[ev.session_id];
      if (typeof upTo === "number" && ev.seq <= upTo) {
        touched.add(ev.session_id);
        this.bytes.set(ev.session_id, Math.max(0, (this.bytes.get(ev.session_id) ?? 0) - JSON.stringify(ev).length));
        return false;
      }
      return true;
    });
    for (const sid of touched) this.settle(sid, acked[sid]!);
  }

  /** An event the server refused for good (retrying cannot help): forget it. */
  drop(sessionId: string, seq: number): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => !(e.session_id === sessionId && e.seq === seq));
    if (this.queue.length === before) return;
    // Rewritten at once: a refused event must not come back after a restart.
    this.rewrite(sessionId);
    this.settle(sessionId, this.meta.get(sessionId)?.acked ?? 0);
  }

  private settle(sid: string, ackedUpTo: number): void {
    const meta = this.meta.get(sid) ?? { lastSeq: 0, acked: 0 };
    meta.acked = Math.max(meta.acked, ackedUpTo);
    this.meta.set(sid, meta);
    this.writeMeta(sid);
    const left = this.queue.filter((e) => e.session_id === sid);
    if (left.length === 0) {
      fs.writeFileSync(this.eventsFile(sid), "", { mode: 0o600 });
      this.bytes.set(sid, 0);
      if (this.closed.has(sid)) this.forget(sid);
    } else if (left.length < this.queue.length / 2 || meta.acked > 1000) {
      this.rewrite(sid);
    }
  }

  /** A closed session needs no more numbers once its events are acknowledged. */
  markClosed(sessionId: string): void {
    this.closed.add(sessionId);
    if (!this.queue.some((e) => e.session_id === sessionId)) this.forget(sessionId);
  }

  /**
   * A closed session needs no events once they are acknowledged, but its high-water mark must outlive them: a later
   * event for the same session id (the answer to a stale command, `session_closed {unknown_session}`) must go on
   * from the last number, because the server keeps the first event it saw for each `(session, seq)` and drops a
   * repeat. What stays is the small meta file, a tombstone, removed after {@link TOMBSTONE_MS}.
   */
  private forget(sid: string): void {
    fs.rmSync(this.eventsFile(sid), { force: true });
    if (this.meta.has(sid)) this.writeMeta(sid);
    this.bytes.delete(sid);
    this.closed.delete(sid);
  }
}
