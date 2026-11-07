// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The run loop: identify to Claw, hold the command stream, post events, send
 * heartbeats, and stop everything the moment the owner revokes the connector or
 * the machine's owner pauses it.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { Audit } from "./audit.js";
import { AttachSupport, fitResumable } from "./attach.js";
import { ChildRegistry, processStart } from "./children.js";
import { ClawClient, HttpError, RevokedError, TransportError } from "./claw-client.js";
import type { ConnectorConfig } from "./config.js";
import { GrantRevokedError, TransientAuthError } from "./credentials.js";
import { recordDisconnect } from "./health.js";
import { SnapshotFile, STATE_WRITE_WAIT_MS, within, writeWhole, type WriteReport } from "./statefile.js";
import { SessionManager, type Command } from "./manager.js";
import { Outbox } from "./outbox.js";
import {
  childrenFile, identityFile, identityKeepFile, logDir, outboxDir, pauseFile, pidFile, sessionsFile, type Dirs,
} from "./paths.js";
import { REMOTE_AGENT_LIMITS, REMOTE_AGENT_TIMING, type RemoteAgentDescriptor } from "./protocol.js";
import { redactDeep } from "./redact.js";
import { DEFAULT_SESSION_TIMING, type SessionEnv, type SessionTiming } from "./session.js";
import { SessionStore } from "./session-store.js";
import type { SseFrame } from "./sse.js";
import { backoffMs, errMessage, isObject, sleep, type Logger, type MayRun, type Verdict } from "./util.js";
import { agentHealth, RECHECK_MS, type AgentHealth, type Report } from "./doctor.js";

/**
 * `base` with `health` in it, dropping its last problems until the whole stays well inside the capabilities cap (the
 * rest of the cap is for the sessions an attach agent offers, which `fitResumable` fits after this).
 */
export function withHealth(base: Record<string, unknown>, health: AgentHealth | null, limit = REMOTE_AGENT_LIMITS.maxCapabilitiesBytes / 2): Record<string, unknown> {
  if (!health) return base;
  const size = (c: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(c)).length;
  const problems = [...health.problems];
  for (;;) {
    const caps = { ...base, health: { ...health, problems } };
    if (size(caps) <= limit) return caps;
    // Not even an empty report fits beside what the agent already says (a long list of roots): no health, as before it.
    if (problems.length === 0) return base;
    problems.pop();
  }
}

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
  /** The health checks run again this often. */
  healthMs: number;
  /** `recheckHealth` checks again at most this often. */
  healthMinGapMs: number;
  /** An attach agent's list of existing sessions is reused this long. */
  catalogMs: number;
  /**
   * How often the conversations on this machine are looked at, cheaply (file names and times; nothing is started), for a
   * change the phone should see now: a terminal that opened one, started waiting for its person, or finished. A change is
   * reported at once instead of at the next heartbeat.
   */
  sessionsWatchMs: number;
  /** How long the command that lists the open sessions may take before the check is refused as unanswerable. */
  attachCliMs: number;
  /** A session whose transcript was written this recently is still in someone's hands. */
  recentWriteMs: number;
  /**
   * Claw refused the credential (401 that is not `revoked`, or 403) this many times in a row, on the heartbeat or the
   * command stream: the key was deleted or lost its scope, and only a person can fix that. The run ends as
   * `auth_failed` instead of staying up and offline for good.
   */
  authFailLimit: number;
  /** ...and only once the refusals have gone on this long, so a burst (a gateway or identity-service hiccup) never ends a run. */
  authFailWindowMs: number;
  /**
   * A refusal that comes within this long of Claw failing in a way that passes by itself (no answer, 5xx, 429) is not
   * counted toward `authFailLimit`: while Claw or the identity service behind it is down, a 401 says nothing about the
   * credential (an API that could not ask SaFE has answered 401 for a key that was fine). The run keeps retrying instead.
   */
  authOutageQuietMs: number;
  /**
   * Claw refused to register one more connector for this person (409 `connector_limit_reached`): tried again this
   * often, not every few seconds by a supervisor, until a machine they no longer use is removed.
   */
  limitRetryMs: number;
  /** How often the stall clock ticks (`stallWatch`): the time between two ticks is how long this process could not run. */
  stallTickMs: number;
  /**
   * A gap this long between two ticks, on the monotonic clock or the wall clock, is a stall: the process was stopped (SIGSTOP, a
   * closed laptop) or the machine slept. A command frame may have sat in the socket's buffer meanwhile, while the person closed
   * its session or removed this machine and was told it would not run; so every command received within this long after a stall
   * is confirmed with Claw before it runs (`confirmLive`).
   */
  stallMs: number;
  /**
   * A command frame that took longer than this from Claw to this process (its `sent_at`, on Claw's clock as the stream's `ready`
   * and `ping` frames give it) is confirmed with Claw before it runs: the process kept running but the frame was held in the
   * network (Wi-Fi dropped, roaming, a VPN reconnecting) and TCP delivered it late, after the person may have closed its session or
   * removed this machine. The same delay on a heartbeat (`network`) makes every command read meanwhile and just after be confirmed.
   */
  transitMs: number;
  /**
   * How long Claw is asked, with the usual backoff, whether a command it delivered in time may still run, before it is dropped as
   * `unconfirmed`: a machine that wakes before its network is back must not lose what the person sent. Meanwhile the command stays
   * queued (its session waits). One that was already older than the live TTL when it came is asked about for only a few tries.
   */
  confirmRetryMs: number;
}

/** The least time between two reconnects made at once on a server's `event: reconnect` (`streamLoop`). */
const RESTART_RECONNECT_GAP_MS = 5_000;
/** What a phone shows for an agent whose sessions start read-only. */
export const READ_ONLY_HINT = `sessions of this agent start read-only: it answers and plans but changes no file. To let phone sessions write code, set approval = "never" for this agent in agents.toml on that machine and restart the connector`;

export const DEFAULT_TIMING: ConnectorTiming = {
  ...DEFAULT_SESSION_TIMING,
  heartbeatMs: REMOTE_AGENT_TIMING.heartbeatMs,
  watchdogMs: REMOTE_AGENT_TIMING.watchdogMs,
  batchMs: 150,
  batchMax: 20,
  backoffMinMs: 1_000,
  backoffMaxMs: 60_000,
  pausePollMs: 1_000,
  catalogMs: 120_000,
  sessionsWatchMs: 10_000,
  attachCliMs: 8_000,
  recentWriteMs: 10_000,
  authFailLimit: 4,
  authFailWindowMs: 120_000,
  authOutageQuietMs: 10 * 60_000,
  healthMs: RECHECK_MS,
  healthMinGapMs: 5_000,
  limitRetryMs: 10 * 60_000,
  stallTickMs: 1_000,
  stallMs: 5_000,
  transitMs: 3_000,
  confirmRetryMs: 10 * 60_000,
};

/**
 * The commands carried out late without asking: they only end things (a turn, a session), so running one that Claw no longer holds
 * cannot do anything the person was told would not happen. Everything else (`session.new`, `prompt`, `set_mode`, `resume`,
 * `decision`) makes an agent act, and is confirmed after a stall or past the live TTL.
 */
const ENDING_COMMANDS = new Set(["cancel", "close"]);
/**
 * Why a command is confirmed with Claw before it acts: read just after a stall (`stall`); read while the network was holding frames
 * back, or just after (`network`: a heartbeat answered late or not at all, a command stream that reconnected); a frame that took
 * longer than `transitMs` to arrive (`delayed`); older than the live TTL (`old`); or asked about by an earlier run that stopped
 * before the answer (`deferred`: `IdentityState.confirm_first`).
 */
type Lateness = "stall" | "network" | "delayed" | "old" | "deferred";

/** How many of the stream's latest clock readings (`ready`, then a `ping` every 25 s) Claw's clock is taken from: a few minutes. */
const CLOCK_SAMPLES = 8;

/** Tries at asking Claw about a command that was already past the live TTL when it came, before it is dropped as unconfirmed. */
const OLD_CONFIRM_ATTEMPTS = 4;

/**
 * Claw answered 404 with something other than its own `not_found` (which says this connector is not the caller's): the confirm
 * route does not exist there, a Claw from before it. The connector then does as it did before that route: it runs the command.
 */
const isRouteMissing = (e: unknown): boolean => e instanceof HttpError && (
  (e.status === 404 && e.code !== "not_found")
  // A Claw from before the route, asked with a paired connector's grant: it refuses a path it does not know as a connector route.
  || (e.status === 403 && e.code === "connector_grant_not_accepted"));

/** What to do about 409 `connector_limit_reached`, for the log, `status` and the run's own output. */
export const CONNECTOR_LIMIT_HINT = "Claw already holds the most connectors one person may have, so it will not register this machine: "
  + "remove machines you no longer use (in the chat: /agents, or claw-connector logout on that machine). This connector tries again every 10 minutes by itself.";

export const isConnectorLimit = (e: unknown): boolean => e instanceof HttpError && e.status === 409 && e.code === "connector_limit_reached";

interface IdentityState {
  server: string;
  connector_id: string;
  /** Highest command number fully handled, and the ids of the last few, so a replay after a restart is skipped. */
  cursor: number;
  handled: string[];
  /** Claw said this row was revoked (401 `revoked`). It stays revoked for good, so the next sign-in registers a new one. */
  revoked?: boolean;
  /**
   * Commands Claw was being asked about (`confirmLive`) and had not answered for when this was written: one delivered again to a
   * later run is asked about there too, whatever that run's stall clock says (the stall it was late for is not that run's).
   */
  confirm_first?: string[];
}

/** At most this many ids are kept in `confirm_first`; the oldest go first. */
const MAX_CONFIRM_FIRST = 200;

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
  /**
   * The machine's health checks (doctor.ts), run at start, every `healthMs`, and after `claw-connector doctor` wrote a
   * report. Each agent's descriptor carries the result as `capabilities.health`. Absent: no health is reported.
   */
  health?: (signal: AbortSignal) => Promise<Report>;
}

export type RunResult = "stopped" | "revoked" | "auth_failed";

/** Claw answered, and refused the credential itself (not a revocation of the row, which is {@link RevokedError}). */
export const isAuthRefusal = (e: unknown): boolean => e instanceof HttpError && (e.status === 401 || e.status === 403);

/**
 * A refusal Claw itself said in so many words: its JSON body names an error. A 401 or 403 with no such body came from
 * something in front of Claw (a gateway, a proxy's page) and says nothing about the credential.
 */
export const isDefinitiveRefusal = (e: unknown): boolean => isAuthRefusal(e) && !/^http_\d+$/.test((e as HttpError).code);

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
  private readonly attach = new Map<string, AttachSupport>();
  private ledger: CommandLedger = new CommandLedger();
  private cid = "";
  private revoked = false;
  /** The connector row itself was revoked (not just the sign-in): recorded in connector.json for `login`. */
  private rowRevoked = false;
  private paused = false;
  /** The credential was refused `authFailLimit` times in a row (see {@link ConnectorTiming.authFailLimit}). */
  private authFailed = false;
  private authFailures = 0;
  private authFirstAt = 0;
  private authWhy = "";
  /** When Claw last failed in a way that passes (see {@link ConnectorTiming.authOutageQuietMs}); 0: not in this run. */
  private outageAt = 0;
  /** The last event on the command stream, to tell why the server ended it (`superseded`, `token_expired`, a release). */
  private lastFrame = "";
  private wakeSender: (() => void) | null = null;
  private wakeHeartbeat: (() => void) | null = null;
  /** The last health report (null until the first check finishes, or when none is configured). */
  private healthReport: Report | null = null;
  private wakeHealth: (() => void) | null = null;
  private healthAsked = false;
  private lastHealthAsk = 0;
  private streamCtl: AbortController | null = null;
  private readonly ctl = new AbortController();
  /** The last tick of the stall clock, monotonic and wall (`stallWatch`). */
  private tickMono = performance.now();
  private tickWall = Date.now();
  /** Until this monotonic time every command (but a cancel or close) is confirmed with Claw first: a stall just ended. */
  private confirmUntil = -Infinity;
  /** Why `confirmUntil` was set last. */
  private confirmWhy: Lateness = "stall";
  /**
   * How many stalls (or spells of network trouble) this run has seen: a command read before one and still waiting to act is
   * confirmed when it acts. `epochWhy`: why the last one.
   */
  private stallEpoch = 0;
  private epochWhy: Lateness = "stall";
  /** `IdentityState.confirm_first`: asked about and not yet answered, here or by an earlier run. */
  private confirmFirst = new Set<string>();
  /**
   * Claw's clock minus this machine's monotonic one ({@link localNow}), from the command stream's `ready` and `ping` frames: the
   * largest of the last {@link CLOCK_SAMPLES} seen on this stream, since a frame that was held back makes it look smaller, never
   * larger (and an old sample ages out, so a clock that was stepped back is followed). Null until one is seen, and again after a
   * stall (the monotonic clock may not have run through a sleep).
   */
  private clockOffsetMs: number | null = null;
  private clockSamples: number[] = [];
  /**
   * The confirmations being asked, by session and command (`confirmLive`): a `close` of the session ends every one of them, and
   * a `cancel` those of its prompts, at once (they are dropped and said so), instead of waiting behind them.
   */
  private readonly asking = new Map<string, Map<string, { type: string; ctl: AbortController }>>();
  /** When the command stream was last asked for (monotonic): a `ready` that takes long to come was held in the network. */
  private streamAskedAt = 0;
  /** When the heartbeat in flight was sent (monotonic), or null. */
  private hbSince: number | null = null;
  /** The heartbeat in flight was seen late (`tick`). */
  private hbLate = false;
  /** connector.json, written off the event loop: a heartbeat never waits for the disk (see statefile.ts). */
  private readonly identityOut: SnapshotFile;

  constructor(private readonly d: ConnectorDeps) {
    this.timing = { ...DEFAULT_TIMING, ...d.timing };
    // Said once a slow write finishes, never while it is stuck: the log is usually a file on the same disk.
    // At most once a minute for each file: a disk that refuses every write (full) is retried every second.
    const said = new Map<string, number>();
    const report: WriteReport = (what, { ms, error }) => {
      const now = Date.now();
      if (now - (said.get(what) ?? 0) < 60_000) return;
      said.set(what, now);
      d.log.warn(error ? "a state write failed" : "a state write was slow (is the state directory on a network disk that stalled?)", { what, ms, ...(error ? { error } : {}) });
    };
    this.identityOut = new SnapshotFile(identityFile(d.dirs), report, true);
    this.outbox = new Outbox({ dir: outboxDir(d.dirs), report });
    this.registry = new ChildRegistry(childrenFile(d.dirs), { background: true, report });
    this.store = new SessionStore(sessionsFile(d.dirs), report);
    for (const a of d.config.agents) {
      if (!a.attach) continue;
      this.attach.set(a.id, new AttachSupport(a, {
        registry: this.registry, audit: d.audit, log: d.log, logDir: logDir(d.dirs), version: d.version, env: process.env,
        catalogMs: this.timing.catalogMs, cliTimeoutMs: this.timing.attachCliMs, recentWriteMs: this.timing.recentWriteMs,
        attachedRefs: () => this.manager.attachedRefs(a.id),
      }));
    }
    const env: SessionEnv = {
      config: d.config, audit: d.audit, registry: this.registry, store: this.store, attach: this.attach, timing: this.timing,
      logDir: logDir(d.dirs), version: d.version, log: d.log,
      emit: (sid, type, data, after) => this.emit(sid, type, data, after),
    };
    this.manager = new SessionManager(env);
  }

  /** Every event leaves through here: scrubbed of credential shapes, numbered, written to disk, then posted. */
  private emit(sessionId: string, type: string, data: Record<string, unknown>, after?: Promise<unknown>): void {
    this.outbox.append(sessionId, type, redactDeep(data), undefined, after);
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

  private async descriptors(): Promise<RemoteAgentDescriptor[]> {
    return Promise.all(this.d.config.agents.map(async (a) => {
      // `unattended`: sessions start in a mode that does not ask before a write or a command. `unattended_allowed`:
      // a phone may switch this agent to such a mode. A client shows the first so nobody is surprised by it.
      // `edits: false`: sessions start in a mode that cannot change files (Cursor asking), with the one-line fix for a phone to show.
      const readOnly = a.readOnlyModes.includes(a.askMode);
      const support = this.attach.get(a.id);
      // `watch_live`: a conversation open in a terminal can be opened read-only (session.ts `spectate`); a client offers that only then.
      // `terminal_input`: and one open in a tmux pane takes messages, typed into that terminal (`resumable[].input: "terminal"`).
      const base = withHealth({
        ask_mode: a.askMode, modes: a.safeModes, roots: a.roots.slice(0, 8), protocol: 1, unattended: a.unattended, unattended_allowed: a.allowUnsafeModes,
        ...(support ? { watch_live: true, ...(support.typesIntoTerminals() ? { terminal_input: true } : {}) } : {}),
        ...(a.readOnlyModes.length ? { read_only_modes: a.readOnlyModes } : {}),
        ...(readOnly ? { edits: false, edits_hint: READ_ONLY_HINT } : {}),
      }, this.healthReport ? agentHealth(this.healthReport, a.id) : null);
      // An attach agent also says which existing sessions it could take over, and whether anything holds them open now.
      // `takeover`: a conversation a terminal has open can be taken over when the person confirms it (`session.new` with
      // `takeover`), which ends the terminal's process; without it, such a conversation is only watched.
      const capabilities = support ? fitResumable({ ...base, takeover: true }, await support.resumable()) : base;
      return { agent_id: a.id, kind: a.kind, name: a.name, capabilities };
    }));
  }

  // --- identity -------------------------------------------------------------------

  /**
   * The connector id stored here: connector.json, or, when that file is there but cannot be read (a crash during its
   * write, a damaged disk), connector-id.json, which holds the id alone. Registering again in that case would give the
   * machine a second connector at Claw (the first revoked as a stale twin, its sessions closed with it). A missing
   * connector.json is a machine never registered here, or one `pair`/`logout` made forget its id: it registers.
   */
  private readIdentity(): (IdentityState & { fromKeep?: true }) | null {
    let text: string;
    try { text = fs.readFileSync(identityFile(this.d.dirs), "utf8"); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      return this.keptIdentity(errMessage(e));
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch (e) { return this.keptIdentity(`not JSON (${errMessage(e)})`); }
    if (!isObject(raw) || typeof raw.connector_id !== "string" || typeof raw.server !== "string") return this.keptIdentity("no connector id in it");
    // Stored for another Claw: not this server's row, and the fallback is not either.
    if (raw.server !== this.d.server) return null;
    return {
      server: raw.server, connector_id: raw.connector_id, cursor: typeof raw.cursor === "number" ? raw.cursor : 0,
      handled: Array.isArray(raw.handled) ? raw.handled.filter((x): x is string => typeof x === "string") : [],
      confirm_first: Array.isArray(raw.confirm_first) ? raw.confirm_first.filter((x): x is string => typeof x === "string").slice(-MAX_CONFIRM_FIRST) : [],
    };
  }

  /** connector-id.json, for a connector.json that cannot be read; null when it has no id for this server either. */
  private keptIdentity(why: string): (IdentityState & { fromKeep: true }) | null {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(identityKeepFile(this.d.dirs), "utf8"));
      if (isObject(raw) && raw.server === this.d.server && typeof raw.connector_id === "string") {
        this.d.log.warn("connector.json cannot be read; keeping the connector id from connector-id.json", { why, connector_id: raw.connector_id });
        return { server: raw.server, connector_id: raw.connector_id, cursor: 0, handled: [], fromKeep: true };
      }
    } catch { /* none (written by a version before it existed), or unreadable too */ }
    this.d.log.warn("connector.json cannot be read and no connector id is kept beside it; registering this machine again", { why });
    return null;
  }

  /**
   * Keep the id in connector-id.json too, flushed to the disk, when it is not there yet: on registration, and on the
   * first start of a version that keeps it (an id registered before). Waited for a bounded time, like connector.json.
   */
  private async keepIdentity(): Promise<void> {
    const file = identityKeepFile(this.d.dirs);
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isObject(raw) && raw.server === this.d.server && raw.connector_id === this.cid) return;
    } catch { /* not kept yet */ }
    const ok = await within(writeWhole(file, JSON.stringify({ server: this.d.server, connector_id: this.cid }), 0o600, true).then(() => true), STATE_WRITE_WAIT_MS, false);
    if (!ok) this.d.log.warn("connector-id.json is not written yet; going on");
  }

  /** Saves connector.json in the background; `identityOut.settled()` says whether it landed. */
  private writeIdentity(): void {
    const st: IdentityState = {
      server: this.d.server, connector_id: this.cid, cursor: this.ledger.cursor, handled: this.ledger.recentIds, ...(this.rowRevoked ? { revoked: true } : {}),
      ...(this.confirmFirst.size ? { confirm_first: [...this.confirmFirst] } : {}),
    };
    this.identityOut.save(JSON.stringify(st));
  }

  /** Use the connector id this machine already has, or register a new one. */
  private async identify(forceNew = false): Promise<void> {
    const have = forceNew ? null : this.readIdentity();
    if (have) {
      this.cid = have.connector_id;
      this.ledger = new CommandLedger(have.cursor, have.handled);
      this.confirmFirst = new Set(have.confirm_first ?? []);
      // connector.json written whole again, from the kept id.
      if (have.fromKeep) { this.writeIdentity(); await this.identityOut.settled(); }
      await this.keepIdentity();
      return;
    }
    this.cid = await this.d.client.register(this.d.config.name, this.d.version);
    this.ledger = new CommandLedger();
    this.writeIdentity();
    await this.keepIdentity();
    // Waited for (a bounded time): an id that never reached the disk is registered again by the next start.
    if (!(await this.identityOut.settled())) this.d.log.warn("connector.json is not written yet; going on (a restart before it is would register this machine again)");
    this.d.audit.record("connector_registered", { connector_id: this.cid, name: this.d.config.name });
  }

  private async heartbeat(): Promise<void> {
    const body = { version: this.d.version, agents: await this.descriptors(), cmd_cursor: this.ledger.cursor > 0 ? this.ledger.cursor : null };
    // How long the answer takes is watched (`tick`): one held back in the network says command frames may be held back too.
    const since = performance.now();
    this.hbSince = since;
    this.hbLate = false;
    let failed = false;
    try {
      await this.d.client.heartbeat(this.cid, body);
    } catch (e) {
      failed = e instanceof TransportError;
      throw e;
    } finally {
      const late = this.hbLate;
      this.hbSince = null;
      this.hbLate = false;
      // Answered late, or not at all: the window after it starts now, whatever order its answer and held frames come in.
      if (late || failed || performance.now() - since > this.timing.transitMs) this.netTrouble(failed ? "heartbeat_failed" : "heartbeat_late");
    }
  }

  /** The first heartbeat, answering "not found" once by registering afresh (the stored id may belong to another account). */
  private async firstHeartbeat(): Promise<void> {
    try {
      await this.heartbeat();
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        this.d.log.warn("Claw does not know the stored connector id (another account's, or removed); registering this machine again", { connector_id: this.cid });
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
   * answering 5xx or 429. A refused credential (401 that is not `revoked`, 403) is judged as it is later in the run
   * ({@link Connector.authRefused}): it ends the run as `auth_failed` only after a run of refusals from a Claw that is
   * otherwise answering. Anything else is a problem a retry will not fix and ends the run with its message.
   */
  private async startup(): Promise<"ok" | "stopped" | "revoked" | "auth_failed"> {
    let atLimit = false;
    for (let attempt = 0; !this.ctl.signal.aborted; attempt++) {
      try {
        await this.identify();
        await this.firstHeartbeat();
        return "ok";
      } catch (e) {
        if (this.isRevocation(e)) { await this.onRevoked(e); return "revoked"; }
        if (isConnectorLimit(e)) {
          // Not a failure a restart fixes, and not one to end on either: a supervisor would start it again every 5 s
          // for good. It waits here, slowly, and comes up by itself once a slot is free.
          if (!atLimit) {
            atLimit = true;
            this.d.log.error(CONNECTOR_LIMIT_HINT, { error: errMessage(e) });
            this.d.audit.record("connector_limit_reached", {});
            recordDisconnect(this.d.dirs, { reason: "connector_limit_reached", detail: CONNECTOR_LIMIT_HINT });
          }
          await sleep(this.timing.limitRetryMs, this.ctl.signal);
          // Paused meanwhile ("claw-connector pause"): not registered until it is resumed.
          while (!this.ctl.signal.aborted && fs.existsSync(pauseFile(this.d.dirs))) await sleep(this.timing.pausePollMs, this.ctl.signal);
          continue;
        }
        // A refused credential at start is judged as it is later: by a run of refusals from a Claw that answers, not by
        // one 401 from a Claw whose identity service is down (a supervisor restarts the run straight into an outage).
        if (isAuthRefusal(e)) {
          if (await this.authRefused(e)) return "auth_failed";
        } else if (!isTransient(e)) throw e;
        else {
          this.noteOutage(e);
          this.d.log.warn("cannot reach Claw yet; will retry", { error: errMessage(e), attempt });
        }
        await sleep(backoffMs(attempt, this.timing.backoffMinMs, this.timing.backoffMaxMs), this.ctl.signal);
      }
    }
    return "stopped";
  }

  // --- revocation and pause ----------------------------------------------------------

  /**
   * The owner disconnected this connector (or the identity service ended the sign-in): nothing may keep running.
   * No retry, no reconnect. A revoked connector row is also marked in connector.json, which is how `login` tells a
   * stored id that is dead from one a new sign-in should keep using; a revoked sign-in leaves the row alive, so it
   * is not marked. The id itself stays, so a restart cannot register a new connector with the same sign-in and
   * undo the owner's kill switch.
   */
  private async onRevoked(e: unknown): Promise<void> {
    if (this.revoked) return;
    this.revoked = true;
    const why = errMessage(e);
    this.d.log.error("revoked: stopping every agent", { why });
    this.d.audit.record("revoked", { why });
    if (e instanceof RevokedError && this.cid) {
      this.rowRevoked = true;
      // Not waited for here (the agents stop first); the end of `run` gives it a bounded time to land.
      this.writeIdentity();
    }
    this.ctl.abort();
    this.streamCtl?.abort();
    await this.manager.killAll("revoked");
  }

  /**
   * Claw, or the identity service behind it, failed in a way that passes by itself (no answer, 5xx, 429): a refusal
   * soon after it is not held against the credential. A command stream that broke after Claw had answered is not that.
   */
  private noteOutage(e: unknown): void {
    if (isTransient(e) && !(e instanceof TransportError && e.afterAnswer)) this.outageAt = Date.now();
  }

  /**
   * One more refusal of the credential; the run ends once `authFailLimit` come in a row. Returns whether it ended.
   * A refusal that is not Claw's own word, or that comes while Claw or its identity service is failing (an outage seen
   * within `authOutageQuietMs`), is not counted, and starts the count again: only a run of refusals from a Claw that is
   * otherwise answering means the credential is gone.
   */
  private async authRefused(e: unknown): Promise<boolean> {
    if (this.authFailed) return true;
    const outage = this.outageAt > 0 && Date.now() - this.outageAt < this.timing.authOutageQuietMs;
    if (outage || !isDefinitiveRefusal(e)) {
      this.authFailures = 0;
      this.d.log.warn(outage ? "Claw refused the sign-in while it was failing; not counted, will retry" : "a refusal that did not come from Claw; not counted, will retry", { error: errMessage(e) });
      return false;
    }
    if (this.authFailures++ === 0) this.authFirstAt = Date.now();
    if (this.authFailures < this.timing.authFailLimit || Date.now() - this.authFirstAt < this.timing.authFailWindowMs) return false;
    this.authFailed = true;
    this.authWhy = errMessage(e);
    this.d.log.error("Claw keeps refusing this sign-in: stopping every agent; run login again", { why: this.authWhy, refusals: this.authFailures });
    this.d.audit.record("auth_failed", { why: this.authWhy });
    this.ctl.abort();
    this.streamCtl?.abort();
    await this.manager.killAll("stopped");
    return true;
  }

  get authFailure(): string { return this.authWhy; }

  private isRevocation(e: unknown): boolean {
    return e instanceof RevokedError || e instanceof GrantRevokedError;
  }

  private async pauseWatcher(): Promise<void> {
    // One listener for the whole run (not one per look, which would pile up over days).
    const stopped = new Promise<null>((r) => {
      if (this.ctl.signal.aborted) r(null);
      else this.ctl.signal.addEventListener("abort", () => r(null), { once: true });
    });
    while (!this.ctl.signal.aborted) {
      // Looked at off the event loop: a state directory that stopped answering stalls this loop alone, not the heartbeat,
      // and a look that never returns does not keep `run` from stopping (the wait ends with the run's signal).
      const want = await Promise.race([fsp.access(pauseFile(this.d.dirs)).then(() => true, () => false), stopped]);
      if (want === null || this.ctl.signal.aborted) break;
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

  /**
   * Check the machine at start, every `healthMs`, and when asked (`recheckHealth`: `claw-connector doctor` signals a running
   * connector after it ran). A changed result is sent with an early heartbeat. A check that throws keeps the last report, and
   * a stop never waits for one: it must never take the connection down. Nothing here touches the file system itself (the
   * checks run in a child process: see commands.ts `runHealth`), so a stalled disk cannot reach this process.
   */
  private async healthWatcher(): Promise<void> {
    const check = this.d.health;
    if (!check) return;
    while (!this.ctl.signal.aborted) {
      this.healthAsked = false;
      try {
        const before = this.healthReport ? JSON.stringify(this.healthReport.problems) : null;
        let onAbort = () => {};
        const stopped = new Promise<null>((resolve) => {
          onAbort = () => resolve(null);
          if (this.ctl.signal.aborted) resolve(null);
          else this.ctl.signal.addEventListener("abort", onAbort, { once: true });
        });
        let report: Report | null;
        try { report = await Promise.race([check(this.ctl.signal), stopped]); } finally { this.ctl.signal.removeEventListener("abort", onAbort); }
        if (report === null) break;
        this.healthReport = report;
        if (JSON.stringify(this.healthReport.problems) !== before) {
          this.d.log.info("health", { problems: this.healthReport.problems.map((p) => `${p.agent ?? "machine"}:${p.code}`) });
          this.wakeHeartbeat?.();
        }
      } catch (e) { this.d.log.warn("health check failed", { error: errMessage(e) }); }
      if (this.healthAsked) continue;   // (asked again while that check ran)
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); this.wakeHealth = null; this.ctl.signal.removeEventListener("abort", done); resolve(); };
        const t = setTimeout(done, this.timing.healthMs);
        this.wakeHealth = done;
        this.ctl.signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  /** Check the machine again now (a `doctor` run asks; at most once per `healthMinGapMs`, so a burst of asks is one check). */
  recheckHealth(): void {
    const now = Date.now();
    if (now - this.lastHealthAsk < this.timing.healthMinGapMs) return;
    this.lastHealthAsk = now;
    this.healthAsked = true;
    this.wakeHealth?.();
  }

  // --- the loops -----------------------------------------------------------------------

  /** Post events in batches, one request at a time and in order, until everything is acknowledged. */
  private async sender(): Promise<void> {
    let failures = 0;
    while (!this.ctl.signal.aborted) {
      if (this.outbox.size === 0) {
        await new Promise<void>((resolve) => {
          // Whichever ends the wait removes the other: a listener left on the run-long signal for every wait would pile up for days.
          const done = () => { this.wakeSender = null; this.ctl.signal.removeEventListener("abort", done); resolve(); };
          this.wakeSender = done;
          this.ctl.signal.addEventListener("abort", done, { once: true });
        });
        continue;
      }
      if (this.outbox.size < this.timing.batchMax) await sleep(this.timing.batchMs, this.ctl.signal);
      if (this.ctl.signal.aborted) break;
      const batch = this.outbox.pending(this.timing.batchMax);
      // Queued but not written yet (the disk is slow): looked at again shortly.
      if (batch.length === 0) { await sleep(this.timing.batchMs, this.ctl.signal); continue; }
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
        if (this.isRevocation(e)) return void (await this.onRevoked(e));
        this.noteOutage(e);
        failures++;
        this.d.log.warn("posting events failed; will retry", { error: errMessage(e), pending: this.outbox.size });
        await sleep(backoffMs(failures - 1, this.timing.backoffMinMs, this.timing.backoffMaxMs), this.ctl.signal);
      }
    }
  }

  /** Report a change in the conversations on this machine (see {@link ConnectorTiming.sessionsWatchMs}) without waiting for the heartbeat. */
  private async sessionsWatcher(): Promise<void> {
    if (this.attach.size === 0) return;
    // The first look is taken at once, so that what changes between the list made at start and the next look is seen.
    while (!this.ctl.signal.aborted) {
      let changed = false;
      for (const support of this.attach.values()) {
        try { if (await support.poll()) changed = true; } catch (e) { this.d.log.warn("looking for changed sessions failed", { agent: support.agent.id, error: errMessage(e) }); }
      }
      if (changed && !this.paused) this.wakeHeartbeat?.();
      await sleep(this.timing.sessionsWatchMs, this.ctl.signal);
    }
  }

  private async heartbeater(): Promise<void> {
    while (!this.ctl.signal.aborted) {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(t); this.wakeHeartbeat = null; this.ctl.signal.removeEventListener("abort", done); resolve(); };
        const t = setTimeout(done, this.timing.heartbeatMs);
        this.wakeHeartbeat = done;
        this.ctl.signal.addEventListener("abort", done, { once: true });
      });
      if (this.ctl.signal.aborted) break;
      if (this.paused) continue;
      try {
        await this.heartbeat();
        this.authFailures = 0;
        this.writeIdentity();
      } catch (e) {
        if (this.isRevocation(e)) return void (await this.onRevoked(e));
        this.noteOutage(e);
        if (isAuthRefusal(e) && await this.authRefused(e)) return;
        this.d.log.warn("heartbeat failed", { error: errMessage(e) });
      }
    }
  }

  private onFrame(f: SseFrame, reconnect: boolean): void {
    if (f.event) this.lastFrame = f.event;
    switch (f.event) {
      case "ready":
        this.resetClock(); // a new stream: its replica's clock, measured afresh
        this.observeClock(f, "server_time");
        // A `ready` that came late was held back, and so were the frames right behind it, which its clock would make look prompt.
        if (!reconnect && performance.now() - this.streamAskedAt > this.timing.transitMs) this.netTrouble("ready_late");
        // A stream opened again after one was lost (or ended): frames may have been held in the network meanwhile, and the
        // `close` of a session may be among those sent again. Commands read now, and those waiting to act, are confirmed.
        if (reconnect) this.netTrouble("reconnect");
        // A card that was waiting when the connection dropped is shown again.
        if (reconnect) this.manager.resendPending();
        this.wakeHeartbeat?.();
        return;
      case "revoked":
        throw new RevokedError();
      case "command":
        return this.onCommand(f);
      case "ping":
        this.observeClock(f, "t");
        return;
      default:
        return; // ping, superseded, reconnect: the stream ends and the loop reconnects (`reconnect`: at once, `streamLoop`)
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
    // The command's `cmd_seq` (the frame's id) goes with it: a prompt's turn_end names it, and a number is never masked as a credential.
    const cmd = { ...data, cmd_seq: seq } as Command;
    if (this.ledger.seen(seq, cmd.cmd_id)) return; // delivered again after a reconnect; already done
    this.ledger.begin(seq, cmd.cmd_id);
    // Judged now, as the frame is read, not once it reaches the front of its session's queue: a frame read just after a stall
    // was in the socket's buffer through it.
    const old = this.isOld(cmd);
    const gate = ENDING_COMMANDS.has(cmd.type) ? undefined
      : this.gateFor(cmd, this.lateness(cmd) ?? (old ? "old" : this.confirmFirst.has(cmd.cmd_id) ? "deferred" : null), old);
    // Not awaited: the stream must keep being read while a slow command (starting an adapter) runs.
    // The command counts as handled when the manager says so (a prompt: when it reaches the adapter), and
    // only then can the cursor sent to the server pass it. A late one runs only if Claw says it is still live.
    // A cancel or close is never held up by a confirmation still being asked in its session: that ends (a close: every one; a
    // cancel: those of prompts, as a cancel drops queued prompts), and the cancel or close runs at once.
    const now = ENDING_COMMANDS.has(cmd.type) && this.endAsking(cmd.session_id, cmd.type);
    void this.manager.handle(cmd, () => {
      this.ledger.end(seq, cmd.cmd_id);
      this.writeIdentity();
    }, gate, now);
  }

  /** Ends the confirmations being asked in session `sid` that a `close` or `cancel` makes moot; whether any was being asked. */
  private endAsking(sid: string, type: string): boolean {
    const asking = this.asking.get(sid);
    if (!asking?.size) return false;
    for (const a of asking.values()) {
      if (type === "close") a.ctl.abort("session_closed");
      else if (a.type === "prompt") a.ctl.abort("cancelled");
    }
    return true;
  }

  /**
   * What is asked each time `cmd` is about to act: when it reaches the front of its session's commands, and again when a prompt
   * queued behind a running turn (or waiting for a terminal) reaches the agent. True at once, with no request, unless it was read
   * late (`late`) or a stall has happened since it was read or last confirmed: then Claw is asked (`confirmLive`). Once refused,
   * always refused.
   */
  private gateFor(cmd: Command, late: Lateness | null, receivedOld: boolean): MayRun {
    let seen = this.stallEpoch;
    let why: Lateness | null = late;
    let refused = false;
    return () => {
      if (refused) return "drop";
      this.tick();
      if (this.stallEpoch !== seen) why ??= this.epochWhy;
      if (!why) return "run";
      const asking = why;
      why = null;
      seen = this.stallEpoch;
      return this.confirmLive(cmd, asking, receivedOld).then((v) => {
        if (v === "drop") refused = true;
        if (v === "keep") why ??= asking; // asked again if it is ever about to act in this run
        return v;
      });
    };
  }

  /** One tick of the stall clock; a gap since the last one longer than `stallMs` is a stall that just ended. */
  private tick(): void {
    const mono = performance.now();
    const wall = Date.now();
    // Both clocks: the monotonic one goes on while the process is stopped (SIGSTOP), but on some systems not while the machine is
    // asleep; the wall clock jumps over a sleep. A wall clock set forward by hand only makes a command be confirmed, never run.
    const gap = Math.max(mono - this.tickMono, wall - this.tickWall);
    this.tickMono = mono;
    this.tickWall = wall;
    if (gap > this.timing.stallMs) {
      this.confirmUntil = mono + this.timing.stallMs;
      this.confirmWhy = "stall";
      this.stallEpoch++;
      this.epochWhy = "stall";
      this.resetClock(); // the monotonic clock may have stood still through a sleep: measured again from the next ping
      this.d.log.warn("this process could not run for a while (stopped, or the machine slept): commands received now are confirmed with Claw before they run", { gap_ms: Math.round(gap) });
      this.d.audit.record("stall_detected", { gap_ms: Math.round(gap) });
    }
    // A heartbeat that has had no answer for longer than a frame may take: the network is holding things back, frames on the
    // command stream too.
    if (this.hbSince !== null && !this.hbLate && mono - this.hbSince > this.timing.transitMs) {
      this.hbLate = true;
      this.netTrouble("heartbeat_late");
    }
  }

  /**
   * The network held frames back, or may have: a heartbeat answered late or not at all, or a command stream opened again. As after
   * a stall, commands read now and for `stallMs` after, and every one waiting to act, are confirmed with Claw first.
   */
  private netTrouble(reason: string): void {
    this.confirmUntil = Math.max(this.confirmUntil, performance.now() + this.timing.stallMs);
    this.confirmWhy = "network";
    this.stallEpoch++;
    this.epochWhy = "network";
    this.d.audit.record("network_trouble", { reason });
  }

  /** This machine's monotonic clock as ms since the epoch: a wall clock set by hand does not move it. */
  private localNow(): number { return performance.timeOrigin + performance.now(); }

  /** Claw's clock from a `ready` (`server_time`, ISO) or `ping` (`t`, ms) frame: the offset is the largest seen on this stream. */
  private observeClock(f: SseFrame, field: "server_time" | "t"): void {
    try {
      const raw = (JSON.parse(f.data ?? "null") as Record<string, unknown> | null)?.[field];
      const t = typeof raw === "number" ? raw : Date.parse(String(raw ?? ""));
      if (!Number.isFinite(t)) return;
      this.clockSamples.push(t - this.localNow());
      if (this.clockSamples.length > CLOCK_SAMPLES) this.clockSamples.shift();
      this.clockOffsetMs = Math.max(...this.clockSamples);
    } catch { /* no clock in it */ }
  }

  private resetClock(): void {
    this.clockOffsetMs = null;
    this.clockSamples = [];
  }

  /** Whether `cmd` was older than the live TTL as it came (`issued_at`, Claw's clock): such a command is `old`. */
  private isOld(cmd: Command): boolean {
    const issued = cmd.issued_at;
    if (typeof issued !== "number" || !Number.isFinite(issued)) return false;
    const now = this.clockOffsetMs === null ? Date.now() : this.localNow() + this.clockOffsetMs;
    return now - issued > REMOTE_AGENT_TIMING.liveCommandTtlMs;
  }

  /**
   * Why `cmd` must be confirmed before it runs, as it is read: a stall or network trouble just ended (`stall`, `network`), a heartbeat
   * has had no answer for too long (`network`), or its frame took longer than `transitMs` to come (`delayed`); or null. A frame with
   * no `sent_at` (a Claw from before it) is judged by the rest.
   */
  private lateness(cmd: Command): Lateness | null {
    this.tick();
    const mono = performance.now();
    if (mono <= this.confirmUntil) return this.confirmWhy;
    if (this.hbSince !== null && mono - this.hbSince > this.timing.transitMs) return "network";
    const sent = cmd.sent_at;
    if (typeof sent === "number" && Number.isFinite(sent)) {
      // Claw's clock unknown (since a stall, until the next ping): how long the frame took cannot be told, so it is asked about.
      if (this.clockOffsetMs === null) return "network";
      if (this.localNow() + this.clockOffsetMs - sent > this.timing.transitMs) return "delayed";
    }
    return null;
  }

  private async stallWatch(): Promise<void> {
    while (!this.ctl.signal.aborted) {
      this.tick();
      await sleep(this.timing.stallTickMs, this.ctl.signal);
    }
  }

  /**
   * Ask Claw whether `cmd`, received late, may still run: `run` only for `live`. Anything else (its session closed, cancelled,
   * expired, gone, this connector revoked, or no answer) drops it: audited, and said in its session, so whoever waits on it is told.
   * With no answer because this run is stopping (not revoked), `keep`: not run and not handled, so the next run gets it again.
   */
  private async confirmLive(cmd: Command, why: Lateness, receivedOld: boolean): Promise<Verdict> {
    // Written down before asking, and waited for (a bounded time): a run that stops before the answer leaves the next one a note
    // to ask again when Claw delivers the command to it, instead of taking it as fresh.
    if (!this.confirmFirst.has(cmd.cmd_id)) {
      this.confirmFirst.add(cmd.cmd_id);
      for (const id of [...this.confirmFirst].slice(0, Math.max(0, this.confirmFirst.size - MAX_CONFIRM_FIRST))) this.confirmFirst.delete(id);
      this.writeIdentity();
      await this.identityOut.settled(STATE_WRITE_WAIT_MS);
    }
    const ended = new AbortController();
    const inSession = this.asking.get(cmd.session_id) ?? new Map<string, { type: string; ctl: AbortController }>();
    this.asking.set(cmd.session_id, inSession);
    inSession.set(cmd.cmd_id, { type: cmd.type, ctl: ended });
    let verdict: Verdict;
    try {
      verdict = await this.askLive(cmd, why, receivedOld, ended.signal);
    } finally {
      inSession.delete(cmd.cmd_id);
      if (!inSession.size && this.asking.get(cmd.session_id) === inSession) this.asking.delete(cmd.session_id);
    }
    if (verdict !== "keep") { this.confirmFirst.delete(cmd.cmd_id); this.writeIdentity(); }
    return verdict;
  }

  /**
   * Claw's answer about `cmd`, asked again with the usual backoff while there is none (no network yet after a wake, Claw down) for
   * up to `confirmRetryMs` (only {@link OLD_CONFIRM_ATTEMPTS} tries for one past the live TTL as it came, which Claw would call
   * expired anyway): the command waits in its session meanwhile. `receivedOld` goes with the question: Claw calls a command
   * `expired` only when it came late, never one delivered in time that waited on this machine (queued behind a long turn).
   */
  private async askLive(cmd: Command, why: Lateness, receivedOld: boolean, ended: AbortSignal): Promise<Verdict> {
    let status: string | null = null;
    let error = "";
    let unsupported = false;
    const began = performance.now();
    for (let attempt = 0; status === null; attempt++) {
      if (this.revoked) { status = "connector_revoked"; break; }
      if (this.ctl.signal.aborted || ended.aborted) break;
      const sig = AbortSignal.any([this.ctl.signal, ended]);
      try {
        status = await this.d.client.confirmCommand(this.cid, cmd.cmd_id, { why, received_late: receivedOld }, sig);
      } catch (e) {
        if (this.isRevocation(e)) { status = "connector_revoked"; void this.onRevoked(e); break; }
        error = errMessage(e);
        if (isRouteMissing(e)) { unsupported = true; break; }
        // A refusal that is an answer (not a failure that passes by itself) is not asked again.
        if (e instanceof HttpError && e.status < 500 && e.status !== 429 && e.status !== 408) break;
        const left = receivedOld ? (attempt + 1 < OLD_CONFIRM_ATTEMPTS ? Infinity : 0) : this.timing.confirmRetryMs - (performance.now() - began);
        if (left <= 0) break;
        if (attempt === 0) this.d.log.warn("Claw cannot be asked yet whether a command received late may run; it waits and is asked again", { type: cmd.type, why, error });
        await sleep(Math.min(left, backoffMs(attempt, this.timing.backoffMinMs, this.timing.backoffMaxMs)), sig).catch(() => undefined);
      }
    }
    const seq = Number.isSafeInteger(cmd.cmd_seq) ? cmd.cmd_seq : undefined;
    // Revoked or stopping while the answer was on its way: not run, whatever Claw said before that. A close (or, for a prompt, a
    // cancel) of its session that came meanwhile ends it too, as Claw would have answered.
    if (this.revoked) status = "connector_revoked";
    else if (ended.aborted) { status = String(ended.reason); unsupported = false; error = ""; }
    else if (this.ctl.signal.aborted && (status === null || status === "live")) {
      this.d.audit.record("command_deferred", { type: cmd.type, cmd_id: cmd.cmd_id, cmd_seq: seq, why, reason: "stopping" });
      return "keep";
    }
    if (status === "live") {
      this.d.audit.record("command_confirmed", { type: cmd.type, cmd_id: cmd.cmd_id, cmd_seq: seq, why });
      return "run";
    }
    if (unsupported) {
      // A Claw from before the confirm route: it cannot say, so the command runs as it did before the question existed.
      this.d.log.warn("Claw cannot confirm a command received late (no confirm route there); running it as before", { type: cmd.type, cmd_seq: seq, why });
      this.d.audit.record("command_unconfirmable", { type: cmd.type, cmd_id: cmd.cmd_id, cmd_seq: seq, why, error: error.slice(0, 300) });
      return "run";
    }
    const said = status ?? "unconfirmed";
    this.d.log.warn("a command received late was dropped: Claw did not confirm it is still live", { type: cmd.type, cmd_seq: seq, status: said, why, ...(error ? { error } : {}) });
    this.d.audit.record("command_dropped", { reason: "not_live", status: said, why, type: cmd.type, cmd_id: cmd.cmd_id, cmd_seq: seq, ...(error ? { error: error.slice(0, 300) } : {}) });
    if (cmd.type === "session.new") this.emit(cmd.session_id, "session_closed", { reason: "command_not_live", status: said });
    else this.emit(cmd.session_id, "command_rejected", { type: cmd.type, cmd_id: cmd.cmd_id, reason: "command_not_live", status: said, ...(seq !== undefined ? { cmd_seq: seq } : {}) });
    return "drop";
  }

  private async streamLoop(): Promise<void> {
    let attempt = 0;
    let reconnect = false;
    let lastRestartAt = -Infinity;
    while (!this.ctl.signal.aborted) {
      if (this.paused) { await sleep(this.timing.pausePollMs, this.ctl.signal); continue; }
      this.streamCtl = new AbortController();
      this.streamAskedAt = performance.now();
      try {
        const sig = AbortSignal.any([this.ctl.signal, this.streamCtl.signal]);
        let got = false;
        this.lastFrame = "";
        let restart = false;
        for await (const f of this.d.client.commands(this.cid, { lastEventId: this.ledger.highestSeen || undefined, signal: sig, watchdogMs: this.timing.watchdogMs })) {
          if (!got) { got = true; attempt = 0; this.authFailures = 0; }
          this.onFrame(f, reconnect);
          if (f.event === "ready") reconnect = true;
          // The Claw replica serving this stream is shutting down (a release): leave it now, without waiting for the
          // end of the response (which a gateway may hold) or a backoff, and open the stream on another replica.
          if (f.event === "reconnect") { restart = true; break; }
        }
        // The server ended the stream on purpose: a Claw release or restart, another run of this connector
        // (`superseded`), or an access token that ran out (`token_expired`). Said once, so a log shows why.
        if (!this.ctl.signal.aborted && !this.paused) {
          const why = restart ? "restart" : this.lastFrame === "superseded" || this.lastFrame === "token_expired" ? this.lastFrame : "the server closed the stream (a Claw release or restart)";
          this.d.log.info("command stream ended by the server; reconnecting", { why });
          void recordDisconnect(this.d.dirs, { reason: "server_closed", detail: why });
          // At once, but only once in a while: a stream that lands on another replica that is also leaving gets the
          // usual backoff, so a release never turns into a burst of reconnects.
          if (restart && Date.now() - lastRestartAt >= RESTART_RECONNECT_GAP_MS) { lastRestartAt = Date.now(); attempt = 0; continue; }
        }
      } catch (e) {
        if (this.isRevocation(e)) return void (await this.onRevoked(e));
        if (this.ctl.signal.aborted) break;
        this.noteOutage(e);
        if (isAuthRefusal(e) && await this.authRefused(e)) return;
        void recordDisconnect(this.d.dirs, { reason: "stream_lost", detail: errMessage(e) });
        if (e instanceof HttpError && e.status === 404) {
          // The stored id is not this account's (or was removed): register again.
          try { await this.identify(true); await this.firstHeartbeat(); } catch (again) {
            if (this.isRevocation(again)) return void (await this.onRevoked(again));
            this.d.log.warn("could not register again", { error: errMessage(again) });
            if (isConnectorLimit(again)) {
              // As at start-up: said once, then tried again slowly instead of every few seconds.
              this.d.log.error(CONNECTOR_LIMIT_HINT, { error: errMessage(again) });
              recordDisconnect(this.d.dirs, { reason: "connector_limit_reached", detail: CONNECTOR_LIMIT_HINT });
              await sleep(this.timing.limitRetryMs, this.ctl.signal);
            }
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
    // How long the machine was away, from its last heartbeat (connector.json), read before this run writes it.
    let downForMs: number | null = null;
    try { downForMs = Math.max(0, Date.now() - fs.statSync(identityFile(this.d.dirs)).mtimeMs); } catch { /* never registered */ }
    const pidf = pidFile(this.d.dirs);
    // A pid file left behind means the previous run never reached its own clean-up: it was killed (SIGKILL, OOM),
    // crashed, or the machine went down under it. Its last heartbeat is when connector.json was last written.
    let leftover = false;
    try { fs.readFileSync(pidf); leftover = true; } catch { /* none: the previous run cleaned up, or there was none */ }
    if (leftover) {
      let last: string | undefined;
      try { last = fs.statSync(identityFile(this.d.dirs)).mtime.toISOString(); } catch { /* never registered */ }
      await recordDisconnect(this.d.dirs, { reason: "process_died", detail: `the previous run ended without shutting down (killed, crashed, or the machine restarted)${last ? `; last heartbeat ${last}` : ""}`, ...(last ? { at: last } : {}) });
    }
    fs.writeFileSync(pidf, JSON.stringify({ pid: process.pid, start: processStart(process.pid) ?? "" }), { mode: 0o600 });
    this.paused = fs.existsSync(pauseFile(this.d.dirs));
    let result: RunResult = "stopped";
    let failure = "";
    try {
      const up = await this.startup();
      if (up !== "ok") return (result = up);
      await this.manager.restoreReadOnly();
      // Signed in and not revoked: the turns the previous run left running end, or (one that was waiting for a person's
      // approval) go on and ask again, never while paused; the sessions used lately are told they are back.
      this.manager.recover({ downForMs, mayContinue: !this.paused && !fs.existsSync(pauseFile(this.d.dirs)) });
      this.d.audit.record("connector_online", {
        connector_id: this.cid, agents: this.d.config.agents.map((a) => a.id), paused: this.paused,
        unattended_agents: this.d.config.agents.filter((a) => a.unattended).map((a) => a.id),
      });
      // The stall clock starts now: the time start-up took (waiting for Claw, a sign-in) is not a stall.
      this.tickMono = performance.now();
      this.tickWall = Date.now();
      await Promise.all([
        this.sender(), this.heartbeater(), this.streamLoop(), this.pauseWatcher(), this.sessionsWatcher(), this.healthWatcher(),
        this.stallWatch().catch(() => undefined),
      ]);
      result = this.revoked ? "revoked" : this.authFailed ? "auth_failed" : "stopped";
    } catch (e) {
      failure = errMessage(e);
      throw e;
    } finally {
      // Stopped or restarted (not revoked, not refused): what is in flight is the next run's to end or carry on.
      await this.manager.killAll(this.revoked ? "revoked" : "stopped", !this.revoked && !this.authFailed).catch(() => undefined);
      const reason = this.revoked ? "revoked" : this.authFailed ? "auth_failed" : failure ? "failed" : this.paused ? "stopped_while_paused" : result;
      const disconnected = recordDisconnect(this.d.dirs, { reason, detail: this.authWhy || failure || undefined });
      // What is still being written gets a bounded time to land; a disk that does not answer does not keep the process.
      const landed = await within(Promise.all([
        this.identityOut.settled(STATE_WRITE_WAIT_MS), this.store.flushed(), this.registry.flushed(), this.outbox.flush(), this.d.audit.flush?.(), disconnected,
      ]).then(([id, st, reg]) => id && st && reg), STATE_WRITE_WAIT_MS, false);
      if (!landed) this.d.log.warn("the state directory did not take the last writes in time (connector.json may be behind)");
      fs.rmSync(pidf, { force: true });
    }
    return result;
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
