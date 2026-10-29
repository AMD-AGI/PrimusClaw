// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The run loop: identify to Claw, hold the command stream, post events, send
 * heartbeats, and stop everything the moment the owner revokes the connector or
 * the machine's owner pauses it.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Audit } from "./audit.js";
import { ChildRegistry, processStart } from "./children.js";
import { ClawClient, HttpError, RevokedError, TransportError } from "./claw-client.js";
import type { ConnectorConfig } from "./config.js";
import { GrantRevokedError, TransientAuthError } from "./credentials.js";
import { SessionManager, type Command } from "./manager.js";
import { Outbox } from "./outbox.js";
import {
  childrenFile, identityFile, logDir, outboxDir, pauseFile, pidFile, sessionsFile, type Dirs,
} from "./paths.js";
import { REMOTE_AGENT_TIMING, type RemoteAgentDescriptor } from "./protocol.js";
import { redactDeep } from "./redact.js";
import { DEFAULT_SESSION_TIMING, type SessionEnv, type SessionTiming } from "./session.js";
import { SessionStore } from "./session-store.js";
import type { SseFrame } from "./sse.js";
import { backoffMs, errMessage, isObject, sleep, type Logger } from "./util.js";

export interface ConnectorTiming extends SessionTiming {
  heartbeatMs: number;
  /** No byte on the command stream for this long: drop it and reconnect. */
  watchdogMs: number;
  /** Events are posted this long after the first one is waiting, or at once when `batchMax` are. */
  batchMs: number;
  batchMax: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  pausePollMs: number;
}

export const DEFAULT_TIMING: ConnectorTiming = {
  ...DEFAULT_SESSION_TIMING,
  heartbeatMs: REMOTE_AGENT_TIMING.heartbeatMs,
  watchdogMs: REMOTE_AGENT_TIMING.watchdogMs,
  batchMs: 150,
  batchMax: 20,
  backoffMinMs: 1_000,
  backoffMaxMs: 60_000,
  pausePollMs: 1_000,
};

interface IdentityState {
  server: string;
  connector_id: string;
  /** Highest command number fully handled, and the ids of the last few, so a replay after a restart is skipped. */
  cursor: number;
  handled: string[];
}

/**
 * Which commands have been handled. A command is "handled" once it has been
 * carried out or accepted into a session's queue (a prompt is accepted, not
 * finished). The cursor sent to the server is the highest number such that
 * everything at or below it is handled, so the server never forgets a command
 * that is still in flight.
 */
export class CommandLedger {
  private readonly inflight = new Set<number>();
  private readonly inflightIds = new Set<string>();
  private readonly ids: string[];
  private highest = 0;
  private floor: number;

  constructor(cursor = 0, handled: string[] = []) {
    this.floor = cursor;
    this.highest = cursor;
    this.ids = [...handled];
  }

  /** Whether this command was already carried out (or is being carried out now). */
  seen(seq: number, cmdId: string): boolean {
    return seq <= this.floor || this.inflight.has(seq) || this.inflightIds.has(cmdId) || this.ids.includes(cmdId);
  }

  begin(seq: number, cmdId = ""): void {
    this.inflight.add(seq);
    this.inflightIds.add(cmdId);
    this.highest = Math.max(this.highest, seq);
  }

  end(seq: number, cmdId: string): void {
    this.inflight.delete(seq);
    this.inflightIds.delete(cmdId);
    this.ids.push(cmdId);
    if (this.ids.length > 500) this.ids.splice(0, this.ids.length - 500);
    const safe = this.inflight.size ? Math.min(...this.inflight) - 1 : this.highest;
    this.floor = Math.max(this.floor, safe);
  }

  get cursor(): number { return this.floor; }
  get recentIds(): string[] { return [...this.ids]; }
  get highestSeen(): number { return this.highest; }
}

export interface ConnectorDeps {
  config: ConnectorConfig;
  dirs: Dirs;
  client: ClawClient;
  server: string;
  audit: Audit;
  log: Logger;
  version: string;
  timing?: Partial<ConnectorTiming>;
}

export type RunResult = "stopped" | "revoked";

/** Failures that pass by themselves: no connection, a provider that is down or busy. */
export function isTransient(e: unknown): boolean {
  return e instanceof TransientAuthError || e instanceof TransportError || (e instanceof HttpError && (e.status >= 500 || e.status === 429));
}

export class Connector {
  readonly timing: ConnectorTiming;
  readonly outbox: Outbox;
  readonly registry: ChildRegistry;
  readonly manager: SessionManager;
  readonly store: SessionStore;
  private ledger: CommandLedger = new CommandLedger();
  private cid = "";
  private revoked = false;
  private paused = false;
  private wakeSender: (() => void) | null = null;
  private wakeHeartbeat: (() => void) | null = null;
  private streamCtl: AbortController | null = null;
  private readonly ctl = new AbortController();

  constructor(private readonly d: ConnectorDeps) {
    this.timing = { ...DEFAULT_TIMING, ...d.timing };
    this.outbox = new Outbox({ dir: outboxDir(d.dirs) });
    this.registry = new ChildRegistry(childrenFile(d.dirs));
    this.store = new SessionStore(sessionsFile(d.dirs));
    const env: SessionEnv = {
      config: d.config, audit: d.audit, registry: this.registry, store: this.store, timing: this.timing,
      logDir: logDir(d.dirs), version: d.version, log: d.log,
      emit: (sid, type, data) => this.emit(sid, type, data),
    };
    this.manager = new SessionManager(env);
  }

  /** Every event leaves through here: scrubbed of credential shapes, numbered, written to disk, then posted. */
  private emit(sessionId: string, type: string, data: Record<string, unknown>): void {
    this.outbox.append(sessionId, type, redactDeep(data));
    if (type === "session_closed") this.outbox.markClosed(sessionId);
    this.wakeSender?.();
  }

  get connectorId(): string { return this.cid; }
  get isRevoked(): boolean { return this.revoked; }

  /** Ask the loops to end; `run` returns once adapters are stopped. */
  stop(): void {
    this.ctl.abort();
    this.streamCtl?.abort();
  }

  private descriptors(): RemoteAgentDescriptor[] {
    return this.d.config.agents.map((a) => ({
      agent_id: a.id, kind: a.kind, name: a.name,
      capabilities: { ask_mode: a.askMode, modes: a.safeModes, roots: a.roots.slice(0, 8), protocol: 1 },
    }));
  }

  // --- identity -------------------------------------------------------------------

  private readIdentity(): IdentityState | null {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(identityFile(this.d.dirs), "utf8"));
      if (isObject(raw) && raw.server === this.d.server && typeof raw.connector_id === "string") {
        return { server: raw.server, connector_id: raw.connector_id, cursor: typeof raw.cursor === "number" ? raw.cursor : 0, handled: Array.isArray(raw.handled) ? raw.handled.filter((x): x is string => typeof x === "string") : [] };
      }
    } catch { /* first run */ }
    return null;
  }

  private writeIdentity(): void {
    const st: IdentityState = { server: this.d.server, connector_id: this.cid, cursor: this.ledger.cursor, handled: this.ledger.recentIds };
    const file = identityFile(this.d.dirs);
    fs.mkdirSync(this.d.dirs.state, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(st), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  /** Use the connector id this machine already has, or register a new one. */
  private async identify(forceNew = false): Promise<void> {
    const have = forceNew ? null : this.readIdentity();
    if (have) {
      this.cid = have.connector_id;
      this.ledger = new CommandLedger(have.cursor, have.handled);
      return;
    }
    this.cid = await this.d.client.register(this.d.config.name, this.d.version);
    this.ledger = new CommandLedger();
    this.writeIdentity();
    this.d.audit.record("connector_registered", { connector_id: this.cid, name: this.d.config.name });
  }

  private async heartbeat(): Promise<void> {
    await this.d.client.heartbeat(this.cid, {
      version: this.d.version, agents: this.descriptors(), cmd_cursor: this.ledger.cursor > 0 ? this.ledger.cursor : null,
    });
  }

  /** The first heartbeat, answering "not found" once by registering afresh (the stored id may belong to another account). */
  private async firstHeartbeat(): Promise<void> {
    try {
      await this.heartbeat();
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        await this.identify(true);
        await this.heartbeat();
        return;
      }
      throw e;
    }
  }

  /**
   * Identify to Claw and send the first heartbeat, trying again (with the usual backoff) while the failure is
   * the kind that passes: no network yet (a laptop that woke before Wi-Fi), the identity service or Claw
   * answering 5xx or 429. Anything else (a refused credential, a missing scope) is a problem a retry will not
   * fix and ends the run with its message.
   */
  private async startup(): Promise<"ok" | "stopped" | "revoked"> {
    for (let attempt = 0; !this.ctl.signal.aborted; attempt++) {
      try {
        await this.identify();
        await this.firstHeartbeat();
        return "ok";
      } catch (e) {
        if (this.isRevocation(e)) { await this.onRevoked(errMessage(e)); return "revoked"; }
        if (!isTransient(e)) throw e;
        this.d.log.warn("cannot reach Claw yet; will retry", { error: errMessage(e), attempt });
        await sleep(backoffMs(attempt, this.timing.backoffMinMs, this.timing.backoffMaxMs), this.ctl.signal);
      }
    }
    return "stopped";
  }

  // --- revocation and pause ----------------------------------------------------------

  /** The owner disconnected this connector: nothing may keep running. No retry, no reconnect. */
  private async onRevoked(why: string): Promise<void> {
    if (this.revoked) return;
    this.revoked = true;
    this.d.log.error("revoked: stopping every agent", { why });
    this.d.audit.record("revoked", { why });
    this.ctl.abort();
    this.streamCtl?.abort();
    await this.manager.killAll("revoked");
  }

  private isRevocation(e: unknown): boolean {
    return e instanceof RevokedError || e instanceof GrantRevokedError;
  }

  private async pauseWatcher(): Promise<void> {
    while (!this.ctl.signal.aborted) {
      const want = fs.existsSync(pauseFile(this.d.dirs));
      if (want && !this.paused) {
        this.paused = true;
        this.d.audit.record("paused");
        this.d.log.warn("paused: stopping every agent");
        this.streamCtl?.abort();
        await this.manager.killAll("paused");
      } else if (!want && this.paused) {
        this.paused = false;
        this.d.audit.record("resumed");
        this.d.log.info("resumed");
      }
      await sleep(this.timing.pausePollMs, this.ctl.signal);
    }
  }

  // --- the loops -----------------------------------------------------------------------

  /** Post events in batches, one request at a time and in order, until everything is acknowledged. */
  private async sender(): Promise<void> {
    let failures = 0;
    while (!this.ctl.signal.aborted) {
      if (this.outbox.size === 0) {
        await new Promise<void>((resolve) => {
          this.wakeSender = () => { this.wakeSender = null; resolve(); };
          this.ctl.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        continue;
      }
      if (this.outbox.size < this.timing.batchMax) await sleep(this.timing.batchMs, this.ctl.signal);
      if (this.ctl.signal.aborted) break;
      const batch = this.outbox.pending(this.timing.batchMax);
      if (batch.length === 0) continue;
      try {
        const ack = await this.d.client.postEvents(this.cid, `b-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, batch);
        this.outbox.ack(ack.acked);
        for (const r of ack.rejected) {
          const ev = batch[r.index];
          if (!ev) continue;
          // Refused for good (retrying cannot help): forget it, but not silently.
          this.outbox.drop(ev.session_id, ev.seq);
          this.d.audit.record("event_rejected", { session_id: ev.session_id, seq: ev.seq, type: ev.type, reason: r.reason });
        }
        failures = 0;
      } catch (e) {
        if (this.isRevocation(e)) return void (await this.onRevoked(errMessage(e)));
        failures++;
        this.d.log.warn("posting events failed; will retry", { error: errMessage(e), pending: this.outbox.size });
        await sleep(backoffMs(failures - 1, this.timing.backoffMinMs, this.timing.backoffMaxMs), this.ctl.signal);
      }
    }
  }

  private async heartbeater(): Promise<void> {
    while (!this.ctl.signal.aborted) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.timing.heartbeatMs);
        this.wakeHeartbeat = () => { clearTimeout(t); resolve(); };
        this.ctl.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
      this.wakeHeartbeat = null;
      if (this.ctl.signal.aborted) break;
      if (this.paused) continue;
      try {
        await this.heartbeat();
        this.writeIdentity();
      } catch (e) {
        if (this.isRevocation(e)) return void (await this.onRevoked(errMessage(e)));
        this.d.log.warn("heartbeat failed", { error: errMessage(e) });
      }
    }
  }

  private onFrame(f: SseFrame, reconnect: boolean): void {
    switch (f.event) {
      case "ready":
        // A card that was waiting when the connection dropped is shown again.
        if (reconnect) this.manager.resendPending();
        this.wakeHeartbeat?.();
        return;
      case "revoked":
        throw new RevokedError();
      case "command":
        return this.onCommand(f);
      default:
        return; // ping, superseded: a superseded stream simply ends and the loop reconnects
    }
  }

  private onCommand(f: SseFrame): void {
    const seq = Number(f.id);
    let data: unknown;
    try { data = f.data === undefined ? null : JSON.parse(f.data); } catch { data = null; }
    if (!Number.isSafeInteger(seq) || !isObject(data) || typeof data.cmd_id !== "string" || typeof data.type !== "string" || typeof data.session_id !== "string") {
      this.d.audit.record("command_dropped", { reason: "malformed_frame", id: f.id });
      return;
    }
    const cmd = data as Command;
    if (this.ledger.seen(seq, cmd.cmd_id)) return; // delivered again after a reconnect; already done
    this.ledger.begin(seq, cmd.cmd_id);
    // Not awaited: the stream must keep being read while a slow command (starting an adapter) runs.
    // The command counts as handled when the manager says so (a prompt: when it reaches the adapter), and
    // only then can the cursor sent to the server pass it.
    void this.manager.handle(cmd, () => {
      this.ledger.end(seq, cmd.cmd_id);
      try { this.writeIdentity(); } catch { /* best effort; the next heartbeat writes it again */ }
    });
  }

  private async streamLoop(): Promise<void> {
    let attempt = 0;
    let reconnect = false;
    while (!this.ctl.signal.aborted) {
      if (this.paused) { await sleep(this.timing.pausePollMs, this.ctl.signal); continue; }
      this.streamCtl = new AbortController();
      try {
        const sig = AbortSignal.any([this.ctl.signal, this.streamCtl.signal]);
        let got = false;
        for await (const f of this.d.client.commands(this.cid, { lastEventId: this.ledger.highestSeen || undefined, signal: sig, watchdogMs: this.timing.watchdogMs })) {
          if (!got) { got = true; attempt = 0; }
          this.onFrame(f, reconnect);
          if (f.event === "ready") reconnect = true;
        }
      } catch (e) {
        if (this.isRevocation(e)) return void (await this.onRevoked(errMessage(e)));
        if (this.ctl.signal.aborted) break;
        if (e instanceof HttpError && e.status === 404) {
          // The stored id is not this account's (or was removed): register again.
          try { await this.identify(true); await this.firstHeartbeat(); } catch (again) {
            if (this.isRevocation(again)) return void (await this.onRevoked(errMessage(again)));
            this.d.log.warn("could not register again", { error: errMessage(again) });
          }
        }
        this.d.log.warn("command stream lost; reconnecting", { error: errMessage(e), attempt });
      }
      if (this.ctl.signal.aborted) break;
      if (this.paused) continue;
      await sleep(backoffMs(attempt++, this.timing.backoffMinMs, this.timing.backoffMaxMs), this.ctl.signal);
    }
  }

  /** Run until stopped or revoked. Always leaves no adapter process behind. */
  async run(): Promise<RunResult> {
    fs.mkdirSync(this.d.dirs.state, { recursive: true, mode: 0o700 });
    // Adapters a crashed earlier run left recorded are stopped first (only if they are still the processes we started).
    await this.registry.killAll();
    // A card whose adapter died with the previous run can never be answered: close it, so a phone does not keep a dead button.
    for (const p of this.store.takePending()) {
      this.d.audit.record("permission_orphaned", { session_id: p.session_id, action_id: p.action_id });
      this.emit(p.session_id, "permission_resolved", { actionId: p.action_id, optionId: null, outcome: "cancelled", by: "connector_restart" });
    }
    const pidf = pidFile(this.d.dirs);
    fs.writeFileSync(pidf, JSON.stringify({ pid: process.pid, start: processStart(process.pid) ?? "" }), { mode: 0o600 });
    this.paused = fs.existsSync(pauseFile(this.d.dirs));
    try {
      const up = await this.startup();
      if (up !== "ok") return up;
      this.d.audit.record("connector_online", { connector_id: this.cid, agents: this.d.config.agents.map((a) => a.id), paused: this.paused });
      await Promise.all([this.sender(), this.heartbeater(), this.streamLoop(), this.pauseWatcher()]);
    } finally {
      await this.manager.killAll(this.revoked ? "revoked" : "stopped").catch(() => undefined);
      fs.rmSync(pidf, { force: true });
    }
    return this.revoked ? "revoked" : "stopped";
  }

  /** For tests: wait until every event is acknowledged. */
  async drained(timeoutMs = 5000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (this.outbox.size === 0) return true;
      await sleep(20);
    }
    return this.outbox.size === 0;
  }
}
