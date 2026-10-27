// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The AppRunner: runs a hosted application as a task of mode `app`
 * (hosting design 5.3.2).
 *
 * `reconcile()` is the whole machine. Called every few seconds under the run's
 * lease, it reads the run's row, looks at the sandbox and the process, and makes
 * at most one move. It keeps nothing that matters in memory: the state, the
 * restart count, the state directory and the sandbox id are in `claw_app_runs`,
 * so a Brain that takes the run over runs the same `reconcile()` and carries on.
 *
 *   provisioning -> starting -> running -> finishing -> ended
 *                       ^           |
 *                       +-restarting+      (process exited without `final`)
 *   a lost sandbox, in any state, goes back to provisioning and counts as a restart
 *
 * Three rules carry the safety of it, each of them in one place:
 *
 *  - The restart decision reads `exit.json` `final` and nothing else
 *    ({@link AppRunner.onProcessExit}). `final: true` ends the run, whatever the
 *    return code, and is never restarted; a missing `final` restarts while
 *    `restarts < max_restarts` and ends the run as failed after that. A read that
 *    could not be made is not "no `final`": the tick ends and tries again.
 *  - A restart is always counted before it is acted on, and the count is bounded
 *    by `max_restarts` on every road into provisioning or restarting
 *    ({@link AppRunner.countedRestart}).
 *  - A second process is never started beside a live one: ticks do not overlap,
 *    the probe runs before every start, and the start command checks again inside
 *    the sandbox ({@link startCommand}).
 *
 * Ending from outside the machine (hosting design 5.3.2, "any state -> finishing"):
 * a cancel, a deleted session and a run past `limits.max_runtime_sec` all go to
 * `finishing`, whose step 1 sends SIGTERM to the application and waits up to
 * `stop_grace_sec` for it to exit, so an application that writes `final` within
 * the grace keeps its own result. The wait spans ticks and its start is on the
 * row (`last_exit.stop_at`), as is every finished step (`last_exit.finish_done`):
 * a Brain that takes a finishing run over carries on instead of starting over.
 *
 * Seams for work that is not in this change are the optional members of
 * {@link AppRunnerSeams}: event tailing and MCP registration.
 */
import pino from "pino";
import { APP_MANIFEST_DEFAULTS, type AppManifestV1, type AppSandboxRole } from "@claw/protocol";
import type {
  SandboxExecOptions, SandboxExecResult, SandboxInstance, SandboxStatus,
} from "../sandbox/provider.js";
import { provisionTerminalOf } from "../sandbox/errors.js";
import type { AppSandbox, AppSandboxRun } from "./app-sandbox.js";
import {
  AppRunWriteRefused,
  type AppLastExit, type AppRunPatch, type AppRunRecord, type AppRunState, type AppRunStore,
} from "./app-run-store.js";
import {
  EXIT_ABSENT, INPUT_FILE, buildAppEnv, expandStateDirCommand, generationTag, isUsableStateDir,
  parseProbe, probeCommand, readExitCommand, scrub, secretValuesOf, startCommand, stopCommand, writeFileCommand,
  type ProbeVerdict,
} from "./app-env.js";

const logger = pino({ name: "app-runner" });

export const RECONCILE_INTERVAL_MS = 5_000;
/** How long the `ended` announcement is waited for before the run goes on without it. */
export const STATUS_PUBLISH_TIMEOUT_MS = 5_000;
const EXEC_TIMEOUT = "30s";
/** Consecutive failed launches in one sandbox before it counts as the application failing. */
const START_FAILURES_BEFORE_RESTART = 3;
/** Consecutive unreadable `exit.json` reads before it is taken as having no `final`. */
const UNPARSEABLE_EXIT_READS = 3;
/** Attempts at each finishing step before it is given up on, so a run is never held open for ever. */
const FINISH_STEP_ATTEMPTS = 5;
/** Consecutive failed ticks, with the store or SaFE unreachable, before finishNow gives up. */
const FINISH_NOW_MAX_FAILURES = 60;
const TEXT_MAX = 300;
/**
 * Hard ceiling on the SIGTERM grace, whatever the manifest asks for: the wait
 * keeps the run's lock and its sandbox, so an application cannot name an hour
 * count of its own.
 */
export const MAX_STOP_GRACE_SEC = 3600;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** What the grant hooks are told about a run. */
export interface AppGrantRun {
  runId: string;
  sessionId: string;
  grantId: string | null;
  manifest: AppManifestV1;
}

/** What a grant adds to the application's environment. */
export interface AppGrantEnv {
  keys?: Partial<Record<AppSandboxRole, string>>;
  limits?: Record<string, unknown>;
}

/**
 * Grant hook points (sandbox-layering #4). `env` runs at `starting`, `revoke`
 * at `finishing` step 3; both default to doing nothing. `issue` is the API's, at
 * run creation: the runner never issues a grant, so a run taken over with its
 * `grantId` already on the row cannot be given a second one. `revoke` is called
 * once per run end, and once more only if a Brain dies between the call and the
 * write that records it, so an implementation must tolerate a repeat.
 *
 * `extend` asks the grant to last until `expiresAt` (ISO time, later than the
 * grant's current expiry) and answers the time it actually granted, which may
 * be earlier than asked. It is called by {@link AppRunner.extendGrant}, never
 * for a revoked grant or a time that is not later than the current one.
 */
export interface AppGrantRunHooks {
  env(run: AppGrantRun): Promise<AppGrantEnv>;
  revoke(run: AppGrantRun): Promise<void>;
  extend(run: AppGrantRun, expiresAt: string): Promise<{ expiresAt: string }>;
}

export const noopAppGrant: AppGrantRunHooks = {
  env: async () => ({}),
  revoke: async () => undefined,
  extend: async (_run, expiresAt) => ({ expiresAt }),
};

/** What a seam is told. `instance` is null before a sandbox exists. */
export interface AppRunContext {
  record: AppRunRecord;
  instance: SandboxInstance | null;
  /**
   * `text` with the run's secret values replaced; for anything that reads what the application wrote.
   * Absent until the secrets have loaded: a seam that needs it waits for it.
   */
  scrub?(text: string): string;
}

/**
 * Work that belongs to other changes, named here so each has one place to plug
 * in. None is required.
 */
export interface AppRunnerSeams {
  /** While running: read new events (C2-09). */
  tailEvents?(ctx: AppRunContext): Promise<void>;
  /** While running: register the application's MCP once it answers (C2-10). */
  registerMcp?(ctx: AppRunContext): Promise<void>;
  /** Finishing step 2: read the events that are left (C2-09). */
  drainEvents?(ctx: AppRunContext): Promise<void>;
  /** Finishing step 4: unregister the session-level MCP (C2-10). */
  unregisterMcp?(ctx: AppRunContext): Promise<void>;
  /** The run's state moved (5.7: published as `appStatus`). Best effort: a failure is logged and the machine goes on. */
  stateChanged?(record: AppRunRecord): Promise<void>;
}

/** The sandbox, as the runner uses it. The real one is {@link realAppSandbox}. */
export interface AppSandboxOps {
  /** An existing live sandbox of the run, or a new one, Running; records its id. */
  ensure(run: AppSandboxRun): Promise<AppSandbox>;
  instance(run: Pick<AppSandboxRun, "workspaceId" | "platformKey">, workloadId: string): SandboxInstance;
  status(inst: SandboxInstance): Promise<SandboxStatus>;
  exec(inst: SandboxInstance, command: string, timeout: string, opts?: SandboxExecOptions): Promise<SandboxExecResult>;
  stop(inst: SandboxInstance): Promise<void>;
  /** Ids of the run's live sandboxes by label, including one never recorded on the row. */
  liveIds(runId: string, platformKey: string): Promise<string[]>;
  nodeName(workloadId: string, platformKey: string): Promise<string | null>;
}

export interface AppRunnerDeps {
  store: AppRunStore;
  sandbox: AppSandboxOps;
  grant?: AppGrantRunHooks;
  seams?: AppRunnerSeams;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  tickMs?: number;
  statusTimeoutMs?: number;
}

export interface AppRunOutcome {
  success: boolean;
  /** Short, free of secrets; goes into the run's failure reason. */
  reason: string;
  /** For the run's `captures` (5.3.2 finishing step 6): `session_dir` and `stop_reason`. */
  captures?: Record<string, string>;
}

/** The application ended the run as failed. Terminal: the run's row already says `ended`. */
export class AppRunFailedError extends Error {
  constructor(reason: string, readonly captures?: Record<string, string>) {
    super(reason);
    this.name = "AppRunFailedError";
  }
}

/** The state directory could not be expanded in the sandbox: a configuration fault, not a transient one. */
class StateDirError extends Error {}

export type TickResult = { done: false } | { done: true; outcome: AppRunOutcome };

export type AppRunResult =
  | { kind: "ended"; outcome: AppRunOutcome }
  /** The signal fired; the caller decides whether to {@link AppRunner.finishNow}. */
  | { kind: "aborted" }
  /** Another worker holds the run now. */
  | { kind: "superseded" };

type ExitRead =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "exit"; final: boolean; returncode: number | null; stop_reason?: string; error?: string };

const clip = (s: string): string => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}...` : s);

/** Succeeded means `exit.json` said `final` with return code 0, and nothing less. */
export function outcomeOf(exit: AppLastExit | null, stateDir: string | null = null): AppRunOutcome {
  const captures: Record<string, string> = {};
  if (stateDir) captures.session_dir = stateDir;
  const stop = exit?.stop_reason ?? (exit && exit.cause !== "exit" ? exit.cause : undefined);
  if (stop) captures.stop_reason = clip(stop);
  const withCaptures = Object.keys(captures).length > 0 ? { captures } : {};
  if (exit?.final === true && exit.returncode === 0) return { success: true, reason: "app finished", ...withCaptures };
  if (!exit) return { success: false, reason: "app run ended without an exit record", ...withCaptures };
  const detail = exit.cause === "exit"
    ? `app exited final with return code ${exit.returncode ?? "unknown"}`
    : `app run ended: ${exit.cause.replace(/_/g, " ")}`;
  return {
    success: false,
    reason: exit.stop_reason ? `${detail} (${clip(exit.stop_reason)})` : detail,
    ...withCaptures,
  };
}

/** The runner was told to let go of the run (lease released, drain): it must not write or start anything more. */
class RunnerHalted extends Error {
  constructor() { super("app runner halted"); this.name = "RunnerHalted"; }
}

/** What a finishing step returns to say "not yet": the step is retried on the next tick. */
const STEP_PENDING = Symbol("step_pending");

/** Seconds to wait before restart number `restarts` (1-based): backoff_sec[min(n - 1, length - 1)]. */
export function backoffMs(manifest: AppManifestV1, restarts: number): number {
  const list = manifest.restart?.backoff_sec ?? [];
  if (list.length === 0) return 0;
  return list[Math.min(Math.max(restarts - 1, 0), list.length - 1)]! * 1000;
}

const maxRestarts = (m: AppManifestV1): number => m.restart?.max_restarts ?? 0;

export interface GrantExtension {
  extended: boolean;
  /** The expiry now stored, when extended. */
  expiresAt?: string;
  /** Why not, when not extended; no hook was called for `revoked`, `no_grant`, `no_expiry`, `finishing` and `not_later`. */
  reason?: "revoked" | "no_grant" | "no_expiry" | "finishing" | "not_later" | "failed";
}

export class AppRunner {
  private rec!: AppRunRecord;
  private inflight: Promise<TickResult> | null = null;
  private startFailures = 0;
  private unparseableExits = 0;
  private readonly finishAttempts = new Map<string, number>();
  private readonly finishDone = new Set<string>();
  /** Set when the signal given to `run` fires; cleared by `finishNow`, which ends the run on purpose. */
  private halted = false;
  /**
   * Seeded with the platform key, which is a constructor argument and needs no
   * read: it is in the set from the first moment, whatever the store does.
   */
  private secrets: string[];
  private secretsLoaded = false;
  private readonly grant: AppGrantRunHooks;
  private readonly seams: AppRunnerSeams;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly tickMs: number;

  constructor(
    private readonly runId: string,
    private readonly platformKey: string,
    private readonly deps: AppRunnerDeps,
  ) {
    this.secrets = secretValuesOf({ mcpToken: "", grantKeys: {}, platformKey });
    this.grant = deps.grant ?? noopAppGrant;
    this.seams = deps.seams ?? {};
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.tickMs = deps.tickMs ?? RECONCILE_INTERVAL_MS;
  }

  // ---- driving ------------------------------------------------------------

  /**
   * Reconcile until the run ends, the signal fires, or another worker takes the
   * run. When the signal fires (the lease is being released, the Brain is
   * draining) the runner stops for good: a tick still in flight may finish the
   * call it is in, but it writes nothing to the row and starts nothing, so the
   * Brain that takes the run over is the only one moving it.
   */
  async run(signal: AbortSignal): Promise<AppRunResult> {
    this.halted = signal.aborted;
    const halt = (): void => { this.halted = true; };
    signal.addEventListener("abort", halt, { once: true });
    try {
      while (!signal.aborted) {
        try {
          const tick = await abortable(this.reconcile(), signal);
          if (tick === ABORTED) break;
          if (tick.done) return { kind: "ended", outcome: tick.outcome };
        } catch (err) {
          if (err instanceof RunnerHalted) break;
          if (err instanceof AppRunWriteRefused && err.superseded) return { kind: "superseded" };
          this.warnTickFailure(err);
        }
        await this.sleep(this.tickMs, signal);
      }
      return { kind: "aborted" };
    } finally {
      signal.removeEventListener("abort", halt);
    }
  }

  /**
   * One reconciliation. Ticks never overlap: a call made while one is running
   * gets that tick's answer, so two callers cannot both decide to start the app.
   */
  reconcile(): Promise<TickResult> {
    if (this.inflight) return this.inflight;
    const tick = this.tick().finally(() => { this.inflight = null; });
    this.inflight = tick;
    return tick;
  }

  /**
   * Extend the run's grant to `expiresAt`, for the run's own deadline having
   * been extended. Nothing in the app-run path moves that deadline today
   * (`limits.max_runtime_sec` counts from creation), so no caller exists yet:
   * whoever adds one calls this, and the run's own extension must not wait on
   * or fail with it (this never throws).
   *
   * Refused without calling the hook when the grant is revoked, the run is
   * finishing or ended, the grant has no expiry, `expiresAt` is
   * not a time, or it is not later than the stored expiry. A hook that throws,
   * answers something that is not a later time, or a row write that fails,
   * leaves the stored expiry as it was and is logged as a warning.
   */
  async extendGrant(expiresAt: string): Promise<GrantExtension> {
    const kept = (reason: GrantExtension["reason"]): GrantExtension => ({ extended: false, reason });
    let rec: AppRunRecord;
    try {
      rec = await this.deps.store.load(this.runId);
    } catch (err) {
      logger.warn({ runId: this.runId, err: this.safeText(err) }, "app_run.grant_extend_failed");
      return kept("failed");
    }
    const asked = Date.parse(expiresAt);
    if (rec.grant_revoked_at) return kept("revoked");
    if (!rec.grant_id) return kept("no_grant");
    // A run that is winding up has revoked (or is about to revoke) its grant: it is
    // never extended, whether or not the row has recorded the revoke yet.
    if (rec.state === "finishing" || rec.state === "ended") return kept("finishing");
    // No expiry means the grant does not lapse: any finite time would shorten it.
    if (!rec.grant_expires_at) return kept("no_expiry");
    const current = Date.parse(rec.grant_expires_at);
    if (!Number.isFinite(asked) || !(asked > current)) return kept("not_later");
    const run: AppGrantRun = { runId: this.runId, sessionId: rec.session_id, grantId: rec.grant_id, manifest: rec.manifest };
    try {
      const granted = await this.grant.extend(run, expiresAt);
      const at = Date.parse(granted?.expiresAt);
      if (!Number.isFinite(at) || !(at > current)) {
        logger.warn({ runId: this.runId, grantId: rec.grant_id }, "app_run.grant_extend_not_later");
        return kept("failed");
      }
      await this.deps.store.patch(this.runId, { grant_expires_at: granted.expiresAt });
      return { extended: true, expiresAt: granted.expiresAt };
    } catch (err) {
      logger.warn({ runId: this.runId, grantId: rec.grant_id, err: this.safeText(err) }, "app_run.grant_extend_failed");
      return kept("failed");
    }
  }

  /**
   * End the run now, from outside the machine: a cancel, the deadline, or a run
   * row that went terminal. Moves the row to `finishing` and drives the finishing
   * steps to `ended`, which for a cancel includes SIGTERM and the
   * `stop_grace_sec` wait (the ticks here are what poll it).
   *
   * Throws {@link AppRunWriteRefused} when another worker holds the run: this
   * one must not go on finishing what it no longer owns.
   */
  async finishNow(cause: "cancelled" | "deadline" | "row_terminal"): Promise<AppRunOutcome> {
    // A tick the caller stopped waiting for may still be running; it finishes
    // first, or its write could land on top of the one below.
    await this.inflight?.catch(() => undefined);
    this.halted = false;
    this.rec = await this.deps.store.load(this.runId);
    if (this.rec.state !== "finishing" && this.rec.state !== "ended") {
      await this.commit({ state: "finishing", last_exit: { at: this.iso(), cause, final: false } });
    }
    for (let failures = 0; ; ) {
      try {
        const tick = await this.reconcile();
        if (tick.done) return tick.outcome;
        failures = 0;
      } catch (err) {
        // Another worker holds the run now: there is nothing left here to finish,
        // and retrying a write that cannot succeed only holds the caller.
        if (err instanceof AppRunWriteRefused && err.superseded) throw err;
        if (++failures >= FINISH_NOW_MAX_FAILURES) throw err;
        this.warnTickFailure(err);
      }
      await this.sleep(this.tickMs);
    }
  }

  /**
   * Close the run's row as ended without running the finishing steps, for a run
   * that cannot be driven at all (no platform key to reach SaFE with). Nothing
   * is stopped: the caller says so. A refusal (another worker holds the run, or it
   * already ended) is returned as false, not thrown.
   */
  async markEnded(error: string): Promise<boolean> {
    try {
      await this.commit({ state: "ended", last_exit: { at: this.iso(), cause: "start_failed", final: false, error: clip(error) } });
      return true;
    } catch (err) {
      if (err instanceof AppRunWriteRefused) return false;
      throw err;
    }
  }

  // ---- the machine --------------------------------------------------------

  private async tick(): Promise<TickResult> {
    if (this.halted) throw new RunnerHalted();
    this.rec = await this.deps.store.load(this.runId);
    await this.loadSecrets();
    if (this.pastDeadline()) {
      // Any state but the last two: the same road a cancel takes, so the
      // application gets its SIGTERM and its grace, and the grant is revoked.
      await this.move({ state: "finishing", last_exit: { at: this.iso(), cause: "deadline", final: false } }, this.rec.state);
      return { done: false };
    }
    switch (this.rec.state) {
      case "provisioning": return this.inProvisioning();
      case "starting": return this.inStarting();
      case "running": return this.inRunning();
      case "restarting": return this.inRestarting();
      case "finishing": return this.inFinishing();
      case "ended": return { done: true, outcome: outcomeOf(this.rec.last_exit, this.rec.state_dir) };
    }
  }

  /** `limits.max_runtime_sec` counts from the run's creation, so a takeover keeps the same deadline. */
  private pastDeadline(): boolean {
    if (this.rec.state === "finishing" || this.rec.state === "ended") return false;
    const max = this.rec.manifest.limits?.max_runtime_sec;
    if (typeof max !== "number" || !(max > 0)) return false;
    const created = Date.parse(this.rec.created_at);
    return Number.isFinite(created) && this.now() >= created + max * 1000;
  }

  /**
   * The run's secret values, for scrubbing what this worker logs and stores. Not
   * only at launch: a worker that takes over a run already running, or restarts,
   * never launches, and would print an application's error text unscrubbed. A
   * failure is not fatal (the tick goes on, the next one asks again).
   */
  private async loadSecrets(): Promise<void> {
    if (this.secretsLoaded) return;
    try {
      const stored = await this.deps.store.secrets(this.runId);
      this.secrets = secretValuesOf({ mcpToken: stored.mcp_token, grantKeys: stored.grant_keys ?? {}, platformKey: this.platformKey });
      this.secretsLoaded = true;
    } catch (err) {
      logger.warn({ runId: this.runId, err: clip(scrub(err instanceof Error ? err.message : String(err), this.secrets)) }, "app_run.secrets_unavailable_for_scrub");
    }
  }

  private async inProvisioning(): Promise<TickResult> {
    let sandbox: AppSandbox;
    try {
      sandbox = await this.deps.sandbox.ensure(this.sandboxRun());
    } catch (err) {
      // A workload that ended while it was being created is a lost sandbox; any
      // other failure (SaFE unreachable) is transient and the next tick retries,
      // which cannot duplicate a sandbox because ensure adopts a live one.
      if (provisionTerminalOf(err)) return this.countedRestart("sandbox_lost");
      throw err;
    }
    await this.move({ state: "starting", sandbox_workload_id: sandbox.workloadId }, "provisioning");
    return { done: false };
  }

  private async inStarting(): Promise<TickResult> {
    const lost = await this.sandboxLost();
    if (lost) return lost;
    const inst = this.instance()!;
    let stateDir: string;
    try {
      stateDir = await this.ensureStateDir(inst);
    } catch (err) {
      // A directory that cannot be expanded is the same on every tick: counted like
      // a launch that keeps failing, so the run reaches the restart bound and ends
      // instead of sitting in starting for ever. A transport failure (the exec
      // itself) is not this, and is retried.
      if (err instanceof StateDirError) return this.onStartFailure(err);
      throw err;
    }
    const verdict = await this.probe(inst, stateDir);
    if (verdict === "alive") {
      this.startFailures = 0;
      await this.move({ state: "running" }, "starting");
    } else if (verdict === "dead") {
      return this.onProcessExit(inst, stateDir);
    } else if (verdict === "none") {
      return this.launch(inst, stateDir);
    }
    return { done: false };
  }

  private async inRunning(): Promise<TickResult> {
    const lost = await this.sandboxLost();
    if (lost) return lost;
    const inst = this.instance()!;
    const stateDir = this.rec.state_dir;
    if (!stateDir) {
      await this.move({ state: "starting" }, "running");
      return { done: false };
    }
    const verdict = await this.probe(inst, stateDir);
    if (verdict === "dead") return this.onProcessExit(inst, stateDir);
    if (verdict === "none") {
      // Nothing was started for this generation: back to starting, which starts it.
      await this.move({ state: "starting" }, "running");
      return { done: false };
    }
    if (verdict === "alive") await this.runningSeams(this.seamContext(inst));
    return { done: false };
  }

  private async inRestarting(): Promise<TickResult> {
    const lost = await this.sandboxLost();
    if (lost) return lost;
    const exitedAt = Date.parse(this.rec.last_exit?.at ?? "");
    const wait = backoffMs(this.rec.manifest, this.rec.restarts);
    if (Number.isFinite(exitedAt) && this.now() < exitedAt + wait) return { done: false };
    await this.move({ state: "starting" }, "restarting");
    return { done: false };
  }

  // ---- starting -----------------------------------------------------------

  /** Expand `state_dir` inside the sandbox once and keep the result on the row. */
  private async ensureStateDir(inst: SandboxInstance): Promise<string> {
    if (this.rec.state_dir) return this.rec.state_dir;
    const r = await this.deps.sandbox.exec(
      inst, expandStateDirCommand(this.rec.manifest.state_dir, this.runId), EXEC_TIMEOUT, { untracked: true },
    );
    const dir = r.stdout.trim();
    if (r.exitCode !== 0 || !isUsableStateDir(dir)) {
      throw new StateDirError(`state_dir could not be expanded in the sandbox (exit ${r.exitCode})`);
    }
    this.rec = await this.deps.store.patch(this.runId, { state_dir: dir });
    return dir;
  }

  private async probe(inst: SandboxInstance, stateDir: string): Promise<ProbeVerdict | "unknown"> {
    try {
      const r = await this.deps.sandbox.exec(inst, probeCommand(stateDir, this.tag()), EXEC_TIMEOUT, { untracked: true });
      // Anything but a clear answer is "unknown", which changes nothing: "could
      // not look" is never read as "dead" (a restart) or "none" (a second start).
      return r.exitCode === 0 ? (parseProbe(r.stdout) ?? "unknown") : "unknown";
    } catch (err) {
      logger.warn({ runId: this.runId, err: this.safeText(err) }, "app_run.probe_failed");
      return "unknown";
    }
  }

  private async launch(inst: SandboxInstance, stateDir: string): Promise<TickResult> {
    // A run whose application already finished must not be started again. This
    // is how a sandbox lost right after `final` ends the run instead of
    // repeating it: the state directory outlives the sandbox.
    const prior = await this.readExit(inst, stateDir);
    if (prior.kind === "unreadable") return { done: false };
    if (prior.kind === "exit" && prior.final) return this.finishFromExit(prior);
    if (this.rec.last_exit?.recovery === true) {
      // The budget was spent when the sandbox went, and nothing final is there:
      // the run ends as the failure it was already going to be.
      await this.move({ state: "finishing", last_exit: { at: this.iso(), cause: "restarts_exhausted", final: false } });
      return { done: false };
    }

    // The environment comes from the platform (the API's secrets, the grant
    // service, SaFE): a failure there is the platform's, not the application's. It
    // is thrown, so the tick fails and the next one tries again, and it never
    // counts toward the restart budget.
    const env = await this.applicationEnv(stateDir);
    try {
      this.assertActive();
      await this.writeFiles(inst, stateDir);
      this.assertActive();
      await this.startApplication(inst, stateDir, env);
    } catch (err) {
      if (err instanceof RunnerHalted) throw err;
      return this.onStartFailure(err);
    }
    this.startFailures = 0;
    logger.info({ runId: this.runId, workloadId: this.rec.sandbox_workload_id, restarts: this.rec.restarts }, "app_run.started");
    return { done: false };
  }

  /** `input.json`, the bootstrap file, and (in the start command) the events directory. */
  private async writeFiles(inst: SandboxInstance, stateDir: string): Promise<void> {
    const put = async (rel: string, content: Buffer, mode: string): Promise<void> => {
      this.assertActive();
      const r = await this.deps.sandbox.exec(
        inst, writeFileCommand(`${stateDir}/${rel}`, mode), EXEC_TIMEOUT,
        { untracked: true, env: { CLAW_FILE_B64: content.toString("base64") } },
      );
      if (r.exitCode !== 0) throw new Error(`writing ${rel} failed (exit ${r.exitCode})`);
    };
    await put(INPUT_FILE, Buffer.from(JSON.stringify(this.rec.input), "utf8"), "600");
    const bootstrap = this.rec.manifest.bootstrap;
    if (bootstrap) await put(bootstrap.file, Buffer.from(bootstrap.content_b64, "base64"), "700");
  }

  private async startApplication(inst: SandboxInstance, stateDir: string, env: Record<string, string>): Promise<void> {
    // The lookups above can outlast the signal; a runner told to let go starts nothing.
    this.assertActive();
    const r = await this.deps.sandbox.exec(
      inst, startCommand(this.rec.manifest, stateDir, this.tag()), EXEC_TIMEOUT, { env },
    );
    if (r.exitCode !== 0) throw new Error(`start command failed (exit ${r.exitCode}): ${clip(this.scrubbed(r.stderr))}`);
  }

  private async applicationEnv(stateDir: string): Promise<Record<string, string>> {
    const rec = this.rec;
    const run: AppGrantRun = { runId: this.runId, sessionId: rec.session_id, grantId: rec.grant_id, manifest: rec.manifest };
    const [stored, granted, nodeName] = await Promise.all([
      this.deps.store.secrets(this.runId),
      this.grant.env(run),
      this.deps.sandbox.nodeName(rec.sandbox_workload_id!, this.platformKey).catch(() => null),
    ]);
    const sources = {
      runId: this.runId,
      sessionId: rec.session_id,
      createdAt: rec.created_at,
      manifest: rec.manifest,
      stateDir,
      mcpToken: stored.mcp_token,
      grantKeys: { ...(stored.grant_keys ?? {}), ...(granted.keys ?? {}) },
      grantLimits: granted.limits ?? rec.grant_limits,
      nodeName,
    };
    this.secrets = secretValuesOf({ ...sources, platformKey: this.platformKey });
    this.secretsLoaded = true;
    if (!nodeName) logger.warn({ runId: this.runId }, "app_run.node_name_unavailable");
    return buildAppEnv(sources);
  }

  /** A launch that keeps failing is the application failing: it takes the restart road. */
  private async onStartFailure(err: unknown): Promise<TickResult> {
    this.startFailures += 1;
    logger.warn({ runId: this.runId, attempt: this.startFailures, err: this.safeText(err) }, "app_run.start_failed");
    if (this.startFailures < START_FAILURES_BEFORE_RESTART) return { done: false };
    this.startFailures = 0;
    return this.countedRestart("start_failed");
  }

  // ---- exits and restarts -------------------------------------------------

  private async readExit(inst: SandboxInstance, stateDir: string): Promise<ExitRead> {
    let r: SandboxExecResult;
    try {
      r = await this.deps.sandbox.exec(inst, readExitCommand(stateDir), EXEC_TIMEOUT, { untracked: true });
    } catch (err) {
      logger.warn({ runId: this.runId, err: this.safeText(err) }, "app_run.exit_read_failed");
      return { kind: "unreadable" };
    }
    if (r.exitCode === EXIT_ABSENT) return { kind: "absent" };
    if (r.exitCode !== 0) return { kind: "unreadable" };
    const parsed = parseExit(r.stdout);
    if (parsed) { this.unparseableExits = 0; return parsed; }
    // A half-written file reads as garbage for a moment; a file that stays
    // garbage is, in the end, an exit without `final`.
    this.unparseableExits += 1;
    if (this.unparseableExits < UNPARSEABLE_EXIT_READS) return { kind: "unreadable" };
    this.unparseableExits = 0;
    return { kind: "absent" };
  }

  /**
   * The process is gone. THE restart decision: `exit.json` `final` and nothing else.
   */
  private async onProcessExit(inst: SandboxInstance, stateDir: string): Promise<TickResult> {
    const exit = await this.readExit(inst, stateDir);
    if (exit.kind === "unreadable") return { done: false };
    if (exit.kind === "exit" && exit.final) return this.finishFromExit(exit);
    const last: AppLastExit = exit.kind === "exit"
      ? this.exitRecord(exit, "exit")
      : { at: this.iso(), cause: "exit", final: false };
    return this.countedRestart("exit", last);
  }

  private async finishFromExit(exit: Extract<ExitRead, { kind: "exit" }>): Promise<TickResult> {
    await this.move({ state: "finishing", last_exit: this.exitRecord(exit, "exit") });
    return { done: false };
  }

  /**
   * The one road to `restarting` or back to `provisioning`: counted, and bounded
   * by `max_restarts`. At the bound the run is finishing, as failed -- after one
   * look for a `final` that a lost sandbox may have hidden.
   */
  private async countedRestart(
    cause: "exit" | "sandbox_lost" | "start_failed",
    last?: AppLastExit,
  ): Promise<TickResult> {
    const rec = this.rec;
    const lastExit: AppLastExit = last ?? { at: this.iso(), cause, final: false };
    if (rec.restarts >= maxRestarts(rec.manifest)) {
      // A sandbox lost with the budget spent may have taken a finished run with
      // it: `final` is on shared storage and cannot be read without a sandbox.
      // Failing the run here would report a success as a failure, so one more
      // sandbox is made, once, to look (`launch` reads it and starts nothing).
      if (cause === "sandbox_lost" && rec.state_dir && rec.last_exit?.recovery !== true) {
        await this.move({ state: "provisioning", sandbox_workload_id: null, last_exit: { ...lastExit, recovery: true } });
        return { done: false };
      }
      await this.move({ state: "finishing", last_exit: { ...lastExit, cause: "restarts_exhausted" } });
      return { done: false };
    }
    const restarts = rec.restarts + 1;
    if (cause === "exit" || cause === "start_failed") {
      await this.move({ state: "restarting", restarts, last_exit: lastExit });
    } else {
      await this.move({ state: "provisioning", restarts, sandbox_workload_id: null, last_exit: lastExit });
    }
    return { done: false };
  }

  // ---- the sandbox --------------------------------------------------------

  /**
   * Whether the sandbox is gone. Null when it is fine or cannot be told (an
   * unreadable status is not a lost sandbox: that would start a second one).
   */
  private async sandboxLost(): Promise<TickResult | null> {
    const inst = this.instance();
    if (!inst) {
      // The row says it is past provisioning and names no sandbox; go and make one.
      await this.move({ state: "provisioning" });
      return { done: false };
    }
    let status: SandboxStatus;
    try {
      status = await this.deps.sandbox.status(inst);
    } catch {
      return null;
    }
    if (status.state !== "terminal" && status.state !== "absent") return null;
    logger.warn({ runId: this.runId, workloadId: inst.id, state: status.state, reason: status.reason }, "app_run.sandbox_lost");
    return this.countedRestart("sandbox_lost");
  }

  /** False only when SaFE says the workload is terminal or absent; a status that cannot be read throws, and the step retries. */
  private async sandboxPresent(inst: SandboxInstance): Promise<boolean> {
    const status = await this.deps.sandbox.status(inst);
    return status.state !== "terminal" && status.state !== "absent";
  }

  private instance(): SandboxInstance | null {
    const id = this.rec.sandbox_workload_id;
    return id ? this.deps.sandbox.instance(this.sandboxRun(), id) : null;
  }

  private sandboxRun(): AppSandboxRun {
    const rec = this.rec;
    return {
      runId: this.runId,
      sessionId: rec.session_id,
      sandboxSpec: rec.sandbox_spec as AppSandboxRun["sandboxSpec"],
      workspaceId: rec.workspace_id ?? undefined,
      sandboxWorkloadId: rec.sandbox_workload_id,
      platformKey: this.platformKey,
    };
  }

  // ---- running ------------------------------------------------------------

  private seamContext(instance: SandboxInstance | null): AppRunContext {
    // `scrub` exists only once the run's secret values are known: a seam that reads
    // what the application wrote must not forward it while it cannot clean it.
    return { record: this.rec, instance, ...(this.secretsLoaded ? { scrub: (text: string) => this.scrubbed(text) } : {}) };
  }

  private async runningSeams(ctx: AppRunContext): Promise<void> {
    for (const [name, seam] of [["tail_events", this.seams.tailEvents], ["register_mcp", this.seams.registerMcp]] as const) {
      if (!seam) continue;
      try { await seam(ctx); } catch (err) { logger.warn({ runId: this.runId, seam: name, err: this.safeText(err) }, "app_run.seam_failed"); }
    }
  }

  // ---- finishing ----------------------------------------------------------

  /**
   * The finishing steps, in the design's order. Each is retried a few ticks and
   * then given up, and each that is done is written to the row, so a Brain that
   * takes a finishing run over starts at the step the last one stopped at.
   */
  private async inFinishing(): Promise<TickResult> {
    const rec = this.rec;
    const inst = this.instance();
    const ctx = this.seamContext(inst);
    const run: AppGrantRun = { runId: this.runId, sessionId: rec.session_id, grantId: rec.grant_id, manifest: rec.manifest };
    const cause = rec.last_exit?.cause ?? "exit";
    const cancelled = cause === "cancelled" || cause === "deadline" || cause === "row_terminal";

    if (cancelled && !(await this.step("stop_application", () => this.stopApplication(inst)))) return { done: false };
    await this.step("drain_events", async () => {
      if (!this.seams.drainEvents) return;
      // A sandbox that is gone cannot be read: say what was left, do not spend the step's attempts on it.
      if (inst && !(await this.sandboxPresent(inst))) {
        logger.warn({ runId: this.runId, workloadId: inst.id, cursor: rec.events_cursor }, "app_run.events_not_drained_sandbox_gone");
        return;
      }
      await this.seams.drainEvents(ctx);
    });
    await this.step("revoke_grant", async () => {
      await this.grant.revoke(run);
      // Recorded on the row as well, so extendGrant refuses it from here on (and
      // from any Brain that takes the run over). Only for a run that had a grant.
      if (rec.grant_id && !this.rec.grant_revoked_at) await this.move({ grant_revoked: true });
    });
    await this.step("unregister_mcp", () => this.seams.unregisterMcp?.(ctx));
    await this.step("stop_sandbox", () => this.stopSandboxes(inst));

    await this.move({ state: "ended" });
    logger.info({ runId: this.runId, cause, restarts: this.rec.restarts }, "app_run.ended");
    return { done: true, outcome: outcomeOf(this.rec.last_exit, this.rec.state_dir) };
  }

  /**
   * Finishing step 1: SIGTERM, then up to `stop_grace_sec` for the application
   * to exit, which it may use to write `exit.json` with `final: true` (that
   * result is kept). The wait is polled, one look per tick, so it never holds
   * a tick open. After the grace, or once the process is gone, the run goes on
   * and step 5 stops the sandbox. Returns {@link STEP_PENDING} while waiting.
   */
  private async stopApplication(inst: SandboxInstance | null): Promise<typeof STEP_PENDING | undefined> {
    const stateDir = this.rec.state_dir;
    // Never got as far as a sandbox and a state directory: nothing to signal.
    if (!inst || !stateDir) return undefined;
    const graceMs = Math.min(
      this.rec.manifest.stop_grace_sec ?? APP_MANIFEST_DEFAULTS.stop_grace_sec, MAX_STOP_GRACE_SEC,
    ) * 1000;
    const sentAt = Date.parse(this.rec.last_exit?.stop_at ?? "");
    const signalled = Number.isFinite(sentAt);

    let status: SandboxStatus | null = null;
    try { status = await this.deps.sandbox.status(inst); } catch { /* cannot tell: look at the process */ }
    const sandboxGone = status !== null && (status.state === "terminal" || status.state === "absent");

    if (!sandboxGone) {
      const verdict = await this.probe(inst, stateDir);
      if (!signalled) {
        if (verdict === "unknown") throw new Error("could not tell whether the application is running");
        if (verdict === "alive") {
          this.assertActive();
          await this.sendTerm(inst, stateDir);
          const last = this.rec.last_exit ?? { at: this.iso(), cause: "cancelled" as const, final: false };
          await this.move({ last_exit: { ...last, stop_at: this.iso() } });
          logger.info({ runId: this.runId, graceSec: graceMs / 1000 }, "app_run.sigterm_sent");
          return STEP_PENDING;
        }
      } else if (verdict !== "dead" && verdict !== "none" && this.now() < sentAt + graceMs) {
        return STEP_PENDING;
      }
    }
    // The process exited, never ran, or the grace is over: an application that
    // wrote `final` keeps its own return code and stop reason.
    return this.adoptFinalExit(inst, stateDir, sandboxGone);
  }

  /**
   * The sandbox is gone but the state directory is not: it is shared storage. The
   * only way to read `exit.json` from it is a sandbox, so one is made, once (the
   * `recovery` mark on the row says it was done, across takeovers), as the restart
   * path does for a lost sandbox: the application may have written `final` in its
   * grace just before the sandbox went, and not reading it would report a finished
   * run as the cancel it was. The sandbox is stopped by the finishing step that
   * stops every sandbox of the run.
   */
  private async readFinalFromSharedStorage(stateDir: string): Promise<Extract<ExitRead, { kind: "exit" }> | null> {
    if (this.rec.last_exit?.recovery === true) return null;
    const reader = await this.deps.sandbox.ensure(this.sandboxRun());
    const exit = await this.readExit(reader.instance, stateDir);
    // A read that failed (the sandbox could not be made, the file could not be
    // read) is retried by the finishing step and is NOT marked done: the mark says
    // "the shared storage was looked at", and only a look that happened earns it.
    if (exit.kind === "unreadable") throw new Error("exit.json could not be read");
    if (exit.kind === "exit") return exit;
    const last = this.rec.last_exit ?? { at: this.iso(), cause: "cancelled" as const, final: false };
    await this.move({ last_exit: { ...last, recovery: true } });
    return null;
  }

  private async sendTerm(inst: SandboxInstance, stateDir: string): Promise<void> {
    const r = await this.deps.sandbox.exec(inst, stopCommand(stateDir, this.tag()), EXEC_TIMEOUT, { untracked: true });
    if (r.exitCode !== 0) throw new Error(`SIGTERM command failed (exit ${r.exitCode})`);
  }

  /**
   * Take the application's own `final` result as the run's, over the cancel's.
   * A sandbox that is gone can still leave one: the state directory is shared.
   */
  private async adoptFinalExit(inst: SandboxInstance, stateDir: string, sandboxGone: boolean): Promise<undefined> {
    let exit: ExitRead | null;
    if (sandboxGone) {
      exit = await this.readFinalFromSharedStorage(stateDir);
      if (exit === null) return undefined;
    } else {
      exit = await this.readExit(inst, stateDir);
    }
    if (exit.kind === "unreadable") throw new Error("exit.json could not be read");
    if (exit.kind !== "exit" || !exit.final) return undefined;
    const done = this.rec.last_exit?.finish_done;
    await this.move({ last_exit: { ...this.exitRecord(exit, "exit"), ...(done ? { finish_done: done } : {}) } });
    return undefined;
  }

  private doneSteps(): Set<string> {
    return new Set([...(this.rec.last_exit?.finish_done ?? []), ...this.finishDone]);
  }

  /** Record finished steps on the row; a no-op when the row already has them all. */
  private async persistDone(): Promise<void> {
    const have = new Set(this.rec.last_exit?.finish_done ?? []);
    if ([...this.finishDone].every((n) => have.has(n))) return;
    const last = this.rec.last_exit ?? { at: this.iso(), cause: "exit" as const, final: false };
    await this.move({ last_exit: { ...last, finish_done: [...this.doneSteps()] } });
  }

  /**
   * The recorded sandbox and any other live one of this run. A create that was
   * accepted but never recorded (the Brain died, or the tick was abandoned
   * between the two) would otherwise keep its GPUs for the workload's whole
   * time limit.
   */
  private async stopSandboxes(recorded: SandboxInstance | null): Promise<void> {
    const ids = new Set(await this.deps.sandbox.liveIds(this.runId, this.platformKey));
    if (recorded) ids.add(recorded.id);
    const failures: unknown[] = [];
    for (const id of ids) {
      try {
        await this.deps.sandbox.stop(this.deps.sandbox.instance(this.sandboxRun(), id));
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  /** Run a finishing step once; false while it asks to be retried on the next tick. */
  private async step(name: string, fn: () => Promise<unknown> | undefined): Promise<boolean> {
    // No persist here: the end of the previous step already wrote what it finished.
    if (this.doneSteps().has(name)) return true;
    this.assertActive();
    try {
      if ((await fn()) === STEP_PENDING) return false;
      this.finishDone.add(name);
    } catch (err) {
      if (err instanceof RunnerHalted || (err instanceof AppRunWriteRefused)) throw err;
      const attempts = (this.finishAttempts.get(name) ?? 0) + 1;
      this.finishAttempts.set(name, attempts);
      logger.warn({ runId: this.runId, step: name, attempt: attempts, err: this.safeText(err) }, "app_run.finish_step_failed");
      if (attempts < FINISH_STEP_ATTEMPTS) throw err;
      logger.error({ runId: this.runId, step: name }, "app_run.finish_step_abandoned");
      this.finishDone.add(name);
    }
    await this.persistDone();
    return true;
  }

  // ---- row writes and small helpers ---------------------------------------

  /** Persist a transition, compare-and-set on `from` when given. */
  private async move(patch: AppRunPatch, from?: AppRunState): Promise<void> {
    this.assertActive();
    await this.commit(patch, from);
    logger.info(
      { runId: this.runId, state: this.rec.state, restarts: this.rec.restarts, cause: patch.last_exit?.cause },
      "app_run.transition",
    );
  }

  /**
   * The one place a write to the row becomes `this.rec`: every state change,
   * from `move` and from `finishNow` and `markEnded`, goes through here, and
   * a changed state is announced to the `stateChanged` seam from here. The
   * announcement is not awaited (a slow event stream must not slow the machine)
   * and its failure is only logged.
   */
  private async commit(patch: AppRunPatch, from?: AppRunState): Promise<void> {
    const before = this.rec?.state;
    this.rec = await this.deps.store.patch(this.runId, patch, from);
    const seam = this.seams.stateChanged;
    if (!seam || this.rec.state === before) return;
    const record = this.rec;
    const announce = Promise.resolve().then(() => seam(record)).catch((err) => {
      logger.warn({ runId: this.runId, seam: "state_changed", err: this.safeText(err) }, "app_run.seam_failed");
    });
    // The last state is waited for (bounded): the caller goes on to finish the task,
    // and a client that follows `appStatus` must see `ended` before that completion,
    // not instead of it. Every other change is announced without waiting.
    if (record.state === "ended") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([announce, new Promise<void>((resolve) => { timer = setTimeout(resolve, this.deps.statusTimeoutMs ?? STATUS_PUBLISH_TIMEOUT_MS); })]);
      clearTimeout(timer);
    }
  }

  private exitRecord(exit: Extract<ExitRead, { kind: "exit" }>, cause: AppLastExit["cause"]): AppLastExit {
    return {
      at: this.iso(), cause, final: exit.final, returncode: exit.returncode,
      ...(exit.stop_reason ? { stop_reason: clip(this.scrubbed(exit.stop_reason)) } : {}),
      ...(exit.error ? { error: clip(this.scrubbed(exit.error)) } : {}),
    };
  }

  private assertActive(): void {
    if (this.halted) throw new RunnerHalted();
  }

  private tag(): string {
    return generationTag(this.rec.sandbox_workload_id ?? "", this.rec.restarts);
  }

  private iso(): string { return new Date(this.now()).toISOString(); }

  /**
   * Until the run's own secrets (MCP token, grant keys) have been read the set is
   * incomplete, and text from the application is not forwarded at all rather than
   * forwarded partly scrubbed.
   */
  private scrubbed(text: string): string {
    return this.secretsLoaded ? scrub(text, this.secrets) : "[withheld: scrub set incomplete]";
  }

  private safeText(err: unknown): string {
    return clip(this.scrubbed(err instanceof Error ? err.message : String(err)));
  }

  private warnTickFailure(err: unknown): void {
    logger.warn({ runId: this.runId, err: this.safeText(err) }, "app_run.reconcile_failed");
  }
}

/** `exit.json`, reduced to the fields the runner uses; null when it is not an object. */
export function parseExit(text: string): Extract<ExitRead, { kind: "exit" }> | null {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return null; }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  const rc = d.returncode;
  return {
    kind: "exit",
    // Strictly boolean true. Anything else, absent included, is "not final".
    final: d.final === true,
    returncode: typeof rc === "number" && Number.isInteger(rc) ? rc : null,
    ...(typeof d.stop_reason === "string" ? { stop_reason: d.stop_reason } : {}),
    ...(typeof d.error === "string" ? { error: d.error } : {}),
  };
}

const ABORTED = Symbol("aborted");

/** `p`, or ABORTED as soon as the signal fires. `p` itself keeps going. */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) { p.catch(() => {}); return Promise.resolve(ABORTED); }
  return new Promise((resolve, reject) => {
    const onAbort = () => { p.catch(() => {}); resolve(ABORTED); };
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });
}
