// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * MCP connections kept across a user's turns.
 *
 * Every turn used to open each of its MCP servers from nothing (initialize, then tools/list) and close them when it ended, one
 * server after another, before the model was called. A turn of an assistant chat paid that every time, and one slow server paid
 * it for all of them. The pool keeps a connection open after the turn that opened it, and the next turn of the same user reuses
 * it.
 *
 * What a connection may be reused for is what it was opened with, and nothing else:
 *
 * - The key is the user, the server's name and a hash of the server's whole spec (URL, transport, token, headers, pinned address,
 *   tool filter, every other field). A different credential, a different header or a different user is a different connection;
 *   two users never share one, even when their specs are byte for byte the same.
 * - A run without a user (`user_id` absent or `default`) gets no pooled connection: it opens its own and closes it when it ends,
 *   as before.
 *
 * Health: a turn that takes a connection whose tools were last listed more than `healthMs` ago lists them again in the
 * background, which is both the check and the refresh of what it offers (a server that adds a tool is seen within that time and
 * one turn). The turn does not wait for it: it is offered the tools as last listed, so a server slow to list them does not hold
 * the turn. A listing that fails drops the connection and opens a new one, and a call made meanwhile waits for it. A call the
 * server answers 404 (the session it knew is gone, so the call was never run) reconnects and sends the call once more; a call
 * that failed for any other reason has the next turn check first.
 *
 * Lifetime: a connection nobody uses for `idleMs` is closed, and so is an idle one of the same user and server name when that
 * server's spec changed (a fresh per-turn token makes a new connection, and the old one is never reused again). Past
 * `maxEntries`, the least recently used idle connections are closed. A connection that failed is remembered for `failBackoffMs`,
 * during which turns are told it failed without waiting for it again.
 */
import { createHash } from "node:crypto";
import type { ToolSchema } from "@claw/protocol";
import pino from "pino";

const logger = pino({ name: "mcp-pool" });

/** A connected server as the pool holds it (`connectMcpServer` in `mcp.ts`). */
export interface McpConn {
  /** False: closed when the last run holding it lets go, instead of kept for a later turn. */
  persistent?: boolean;
  callTool(name: string, args: Record<string, unknown>, outcome?: unknown, meta?: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  listTools(): Promise<ToolSchema[]>;
  close(): Promise<void>;
}

export interface McpPoolOptions {
  /** Close a connection nobody has used for this long. */
  idleMs: number;
  /** List a connection's tools again (the health check) when they were last listed longer ago than this. */
  healthMs: number;
  /** Answer a server that failed to connect with that failure, without connecting again, for this long. */
  failBackoffMs: number;
  /** Close idle connections, least recently used first, past this many. */
  maxEntries: number;
}

export const MCP_POOL_DEFAULTS: McpPoolOptions = { idleMs: 10 * 60_000, healthMs: 30_000, failBackoffMs: 30_000, maxEntries: 512 };

type State =
  | { kind: "connecting"; promise: Promise<void> }
  | { kind: "ready" }
  | { kind: "failed"; err: unknown; at: number }
  | { kind: "closed" };

/** The server answered 404 to a request on an open connection: the session it had is gone, and the request was not run. */
function isSessionGone(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 404;
}

/**
 * `p`, or the signal's reason as soon as it is aborted. A connect another run may be waiting on too is shared, so a run that has
 * to stop stops waiting for it rather than cancelling it.
 */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/** One server's connection for one user and one spec. */
export class McpPoolEntry {
  refs = 0;
  lastUsedAt = Date.now();
  /** The tools as last listed. */
  tools: ToolSchema[] = [];
  /** When the tools were last listed successfully. */
  verifiedAt = 0;
  /** Out of the pool: closed as soon as nobody holds it and nothing is connecting. */
  retired = false;
  /** A later turn of the same user sent this server another spec while this one was in use: closed when it is let go. */
  superseded = false;
  /** Times a connection was opened (initialize + tools/list), for the logs and the tests. */
  opens = 0;
  private conn: McpConn | undefined;
  private state: State = { kind: "closed" };
  private checking: Promise<void> | undefined;

  constructor(
    readonly key: string,
    readonly slot: string,
    readonly name: string,
    private readonly open: () => Promise<McpConn>,
  ) {}

  get kind(): State["kind"] { return this.state.kind; }

  /** Whether the open connection may be kept for a later turn; undefined while none is open. */
  get persistent(): boolean | undefined { return this.conn ? this.conn.persistent !== false : undefined; }

  /** The failure a failed entry ended with, and when. */
  get failure(): { err: unknown; at: number } | undefined {
    return this.state.kind === "failed" ? { err: this.state.err, at: this.state.at } : undefined;
  }

  /** Open a connection and list its tools; the entry is ready when this resolves and failed when it rejects. */
  connect(): Promise<void> {
    if (this.state.kind === "connecting") return this.state.promise;
    this.opens++;
    const started = Date.now();
    const promise = (async () => {
      const conn = await this.open();
      let tools: ToolSchema[];
      try {
        tools = await conn.listTools();
      } catch (err) {
        await conn.close();
        throw err;
      }
      if (this.retired) {
        await conn.close();
        throw new Error("mcp connection closed: retired while connecting");
      }
      this.conn = conn;
      this.tools = tools;
      this.verifiedAt = Date.now();
      this.state = { kind: "ready" };
      logger.info({ name: this.name, ms: Date.now() - started, opens: this.opens }, "mcp_pool.connected");
    })().catch((err: unknown) => {
      if (this.state.kind === "connecting" && this.state.promise === promise) this.state = { kind: "failed", err, at: Date.now() };
      throw err;
    });
    // Nobody may be waiting any more (the turn that started it went on without it): never an unhandled rejection.
    promise.catch(() => {});
    this.state = { kind: "connecting", promise };
    return promise;
  }

  /**
   * What a turn waits for before it can offer this server's tools: nothing for an open connection (whose health check, when it
   * is due, runs beside the turn), else the connect in flight or a new connect.
   */
  prepare(healthMs: number): Promise<void> {
    switch (this.state.kind) {
      case "connecting": return this.state.promise;
      case "ready":
        if (Date.now() - this.verifiedAt >= healthMs) void this.check();
        return Promise.resolve();
      case "failed":
      case "closed": return this.connect();
    }
  }

  /** List the tools again on the open connection; a failure drops it and connects anew. */
  private check(): Promise<void> {
    if (this.checking) return this.checking;
    const conn = this.conn!;
    const p = conn.listTools().then(
      (tools) => { this.tools = tools; this.verifiedAt = Date.now(); },
      async (err: unknown) => {
        logger.warn({ name: this.name, err: String((err as Error)?.message ?? err) }, "mcp_pool.health_check_failed_reconnecting");
        await this.drop(conn);
        return this.connect();
      },
    ).finally(() => { if (this.checking === p) this.checking = undefined; });
    p.catch(() => {});
    this.checking = p;
    return p;
  }

  /** Close `conn` if it is still this entry's connection, leaving the entry to connect again. */
  private async drop(conn: McpConn): Promise<void> {
    if (this.conn !== conn) return;
    this.conn = undefined;
    if (this.state.kind === "ready") this.state = { kind: "closed" };
    await conn.close();
  }

  /** The open connection, waiting for one being opened. */
  private async current(): Promise<McpConn> {
    for (;;) {
      if (this.state.kind === "ready" && this.conn) return this.conn;
      if (this.state.kind === "connecting") { await this.state.promise; continue; }
      if (this.state.kind === "failed") throw this.state.err;
      if (this.retired) throw new Error(`MCP server ${this.name}: connection closed`);
      await this.connect();
    }
  }

  async callTool(
    name: string, args: Record<string, unknown>, outcome?: unknown, meta?: Record<string, unknown>, signal?: AbortSignal,
  ): Promise<string> {
    this.lastUsedAt = Date.now();
    const conn = await untilAborted(this.current(), signal);
    try {
      return await conn.callTool(name, args, outcome, meta, signal);
    } catch (err) {
      if (isSessionGone(err) && !this.retired && !signal?.aborted) {
        logger.warn({ name: this.name, tool: name }, "mcp_pool.session_gone_reconnecting");
        await this.drop(conn);
        return (await untilAborted(this.current(), signal)).callTool(name, args, outcome, meta, signal);
      }
      // The connection may be the reason: the next turn lists the tools first, and reconnects if that fails too.
      this.verifiedAt = 0;
      throw err;
    }
  }

  /** Close it now if nobody holds it, else when the last holder lets go. */
  retire(): void {
    this.retired = true;
    if (this.refs === 0) void this.closeNow();
  }

  async closeNow(): Promise<void> {
    const conn = this.conn;
    this.conn = undefined;
    if (this.state.kind !== "connecting") this.state = { kind: "closed" };
    // A connect in flight sees `retired` when it finishes and closes what it opened.
    if (conn) await conn.close();
  }
}

/** JSON with every object's keys in order, so two equal specs hash the same whatever order their fields were written in. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function mcpPoolKey(userId: string, name: string, spec: Record<string, unknown>): { key: string; slot: string } {
  const slot = `${userId}\u0000${name}`;
  return { slot, key: `${slot}\u0000${createHash("sha256").update(canonical(spec)).digest("hex")}` };
}

export class McpConnectionPool {
  private readonly entries = new Map<string, McpPoolEntry>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(readonly opts: McpPoolOptions = MCP_POOL_DEFAULTS) {}

  get size(): number { return this.entries.size; }

  /**
   * Take a hold on the user's connection to this server, made now if there is none. `ready` settles when its tools may be
   * offered (or rejects with why the server cannot be reached); `release` lets go of the hold.
   */
  acquire(userId: string, name: string, spec: Record<string, unknown>, open: () => Promise<McpConn>): { entry: McpPoolEntry; ready: Promise<void>; reused: boolean } {
    this.startSweeper();
    const { key, slot } = mcpPoolKey(userId, name, spec);
    let entry = this.entries.get(key);
    const reused = !!entry && entry.kind === "ready";
    if (!entry) {
      entry = new McpPoolEntry(key, slot, name, open);
      this.entries.set(key, entry);
      // The same user's earlier connection to this server under a spec that is no longer sent (a per-turn token) is never used again.
      for (const other of this.entries.values()) {
        if (other === entry || other.slot !== slot) continue;
        if (other.refs === 0) this.remove(other, "superseded");
        else other.superseded = true;
      }
      this.trim();
    }
    entry.refs++;
    entry.lastUsedAt = Date.now();
    const failure = entry.failure;
    const ready = failure && Date.now() - failure.at < this.opts.failBackoffMs
      ? Promise.reject(failure.err)
      : entry.prepare(this.opts.healthMs);
    // A connect that finishes after its turn let go (it was deferred) and turned out not to be keepable (SSE) is closed then.
    ready.then(() => { if (entry.refs === 0 && entry.persistent === false) this.remove(entry, "not_poolable"); }, () => {});
    return { entry, ready, reused };
  }

  release(entry: McpPoolEntry): void {
    entry.refs = Math.max(0, entry.refs - 1);
    entry.lastUsedAt = Date.now();
    if (entry.refs > 0) return;
    if (entry.persistent === false) this.remove(entry, "not_poolable");
    else if (entry.superseded) this.remove(entry, "superseded");
    else if (entry.retired) void entry.closeNow();
  }

  private remove(entry: McpPoolEntry, why: string): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    logger.info({ name: entry.name, why }, "mcp_pool.closed");
    entry.retire();
  }

  /** Close idle connections, least recently used first, until the pool is within its size. */
  private trim(): void {
    if (this.entries.size <= this.opts.maxEntries) return;
    const idle = [...this.entries.values()].filter((e) => e.refs === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const e of idle) {
      if (this.entries.size <= this.opts.maxEntries) break;
      this.remove(e, "pool_full");
    }
  }

  /** Close what nobody used for `idleMs`, and forget failures older than `failBackoffMs`. */
  sweep(now = Date.now()): void {
    for (const e of [...this.entries.values()]) {
      if (e.refs > 0) continue;
      if (now - e.lastUsedAt >= this.opts.idleMs) this.remove(e, "idle");
      else if (e.kind === "failed" && now - (e.failure?.at ?? 0) >= this.opts.failBackoffMs) this.remove(e, "failure_expired");
    }
  }

  private startSweeper(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), Math.min(60_000, Math.max(1_000, this.opts.idleMs / 2)));
    this.timer.unref?.();
  }

  /** Close every connection (shutdown, tests). */
  async closeAll(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const all = [...this.entries.values()];
    this.entries.clear();
    for (const e of all) { e.retired = true; await e.closeNow(); }
  }
}
