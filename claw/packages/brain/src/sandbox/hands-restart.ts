// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Start Hands again inside a container that is still running.
 *
 * The case this exists for is a sandbox whose data-plane `exec` succeeds while
 * its MCP port answers nothing: the container is up, whatever the run started
 * in it is still going, and only the Hands process is gone. The recovery
 * available until now was a full rebuild, which stops the workload -- so the
 * one situation where the container is demonstrably worth keeping was met by
 * destroying it, and a Hyperloom or GPU job holding that pod died with it.
 *
 * Cheaper as well as less destructive: the binary is already in the container
 * from the first bootstrap, so this is a process start rather than a pod
 * schedule plus a 90MB download plus a workspace restore.
 *
 * The environment is deliberately not resent, and that holds only while every
 * pod is built for the request it serves. Such a pod carries the composed
 * environment in its spec, so the container has it and every shell the new
 * Hands spawns inherits it; resending would mean recomposing secrets nothing
 * needs touched.
 *
 * A pod claimed from the warm pool is the exception, and the reason
 * `restartPreservesEnvironment` exists. It was created before anyone knew whose
 * request it would take, so `overrides.environment` never reached its spec and
 * the environment arrived only through HANDS_ENV_FILE -- which Hands reads once
 * and unlinks. Restarting in place there would start a Hands holding the base
 * environment and none of `user_env`, `session_env` or the LLM keys, answer
 * /health, and run every later command without the user's credentials: the
 * exact "looks healthy and is missing the user's credentials" failure the env
 * file was added to remove (see sandbox/bootstrap.ts writeEnvFileCmd).
 *
 * Brain cannot tell a pooled pod from a purpose-built one after the fact, so
 * the test is whether the deployment has a pool at all. Raising
 * AGENT_SANDBOX_WARM_POOL_SIZE therefore turns in-place restart off for
 * agent-sandbox instead of silently stripping credentials; the refusal is
 * marked `refused` so the caller falls back to the rebuild it had before
 * rather than treating it as a container worth keeping. Making the two work together means
 * composing the environment again here and handing it to
 * `bootstrapHandsInSandbox`; that is the work to do before that knob is raised.
 */
import pino from "pino";
import { sleep } from "@claw/utils";
import {
  AGENT_SANDBOX_WARM_POOL_SIZE,
  LOCAL_MODE_HANDS_BINARY,
  SANDBOX_HANDS_RESTART_ENABLED,
  SANDBOX_HANDS_RESTART_EXEC_DEADLINE_MS,
  SANDBOX_HANDS_RESTART_INTERVAL_MS,
  SANDBOX_HANDS_RESTART_MAX_TRIES,
} from "../config.js";
import {
  bootstrapHandsInSandbox,
  HANDS_DOWNLOADED_BINARY,
  HANDS_IN_IMAGE_BINARY,
} from "./bootstrap.js";
import {
  execInSandbox,
  instanceFromEntry,
  readHandsProbeEntry,
  type HandsProbeEntry,
} from "./container-probe.js";
import { checkHandsHealth } from "./hands-health.js";
import { parseExecTimeoutMs, type SandboxInstance } from "./provider.js";

const logger = pino({ name: "sandbox-hands-restart" });

/** Port Hands listens on when the recorded URL does not name one. */
const DEFAULT_MCP_PORT = "9100";

/** Ceiling on the kill step; it is one signal and a one-second wait. */
const STOP_TIMEOUT = "30s";

/** Ceiling on one health poll, well inside the interval between polls. */
const HEALTH_TIMEOUT_MS = 1_500;

const HANDS_RESTART_DEADLINE = "hands_restart_deadline";

export interface HandsRestartAttempt {
  sessionId: string;
  /** MCP url of the sandbox, as the run has been using it. */
  handsUrl: string;
  /**
   * The token the sandbox was bootstrapped with. Reused rather than reissued:
   * the client that will talk to the restarted Hands is already holding it, and
   * a new one would have to be published everywhere that one came from.
   */
  token: string;
  /**
   * The sandbox's identity, when the caller holds it. Falls back to the
   * session's KV entry, which for a DAG node can name a sibling's sandbox --
   * see the note on probeSandboxContainer.
   */
  entry?: HandsProbeEntry;
  /**
   * How long to wait for the restarted Hands to answer, as a poll count and an
   * interval. Parameterised for the reason bootstrap's commands are: the
   * production bounds are sized for a real sandbox, and a test of the
   * never-answers path should not have to wait all of them out. Production
   * callers pass neither.
   */
  pollTries?: number;
  pollIntervalMs?: number;
  /**
   * Wall clock for kill + bootstrap. Tests of the hung-exec path pass a
   * short one; production callers pass none.
   */
  execDeadlineMs?: number;
  /** Cancels exec, health polling, and inter-poll waits for task shutdown. */
  signal?: AbortSignal;
}

export interface HandsRestartResult {
  ok: boolean;
  /** What happened, in the words a log line and a status event want. */
  detail: string;
  /**
   * True when nothing was attempted, as opposed to attempted and failed.
   *
   * The two want opposite handling and folding them together wedged sessions.
   * A restart that ran and did not work leaves a container worth keeping, so
   * the caller should keep it and report. A refusal -- the kill switch is off,
   * or the environment could not be reproduced -- says this deployment will
   * never repair this sandbox in place, so leaving it alone means every later
   * turn fails identically with no way out. The caller falls back to the
   * rebuild it would have done before the in-place path existed.
   */
  refused?: boolean;
}

function hideHandsBinaryInShell(path: string): string {
  return path.replaceAll("hands-binary", "hands-'bin'ary");
}

const SAFE_HANDS_BINARY_PATH = /^\/[A-Za-z0-9._/-]+$/;

/** Only absolute, shell-literal-safe paths may enter the generated scanner. */
export function isSafeHandsBinaryPath(path: string): boolean {
  return SAFE_HANDS_BINARY_PATH.test(path);
}

function knownHandsBinaryPaths(): string[] {
  return [HANDS_IN_IMAGE_BINARY, HANDS_DOWNLOADED_BINARY, LOCAL_MODE_HANDS_BINARY]
    .filter(isSafeHandsBinaryPath);
}

/**
 * Shell that clears the MCP port before a new Hands tries to bind it.
 *
 * A Hands that stopped answering has not necessarily stopped running, and one
 * that still holds the port makes every start attempt fail to bind -- turning
 * "Hands is wedged" into "Hands cannot be started", with the wedged process
 * still there. Only the three bootstrap paths are matched, as space-delimited
 * argv tokens (`/app/hands-binary`, the shared mount, `/tmp/.hands-binary`).
 *
 * SIGKILL, and never SIGTERM, which is the whole point of this function. Hands
 * installs a SIGTERM handler that deliberately takes every background shell
 * down with it, so that a pod eviction does not leave orphaned training runs
 * holding the sandbox (see hands/src/index.ts). Asking politely here would
 * therefore destroy exactly what restarting in place exists to preserve: a
 * wedged-but-live Hands would reap the Hyperloom job in the container on its
 * way out, and the caller would report "processes are still running" over the
 * corpse. SIGKILL cannot be handled, so the detached process groups are simply
 * reparented and keep running.
 *
 * Walk `/proc` rather than relying on `pkill`: the production sandbox image is
 * intentionally minimal and carries neither procps (`pkill` / `pgrep` / `ps`)
 * nor BusyBox's killall. `/proc/<pid>/cmdline` and the shell's `kill` builtin
 * are available in that image and are enough to identify the binary precisely.
 *
 * Match argv[0] against the three bootstrap paths, not an arbitrary argument
 * or substring: a holder whose cmdline merely mentions that name or path must
 * not be SIGKILL'd. Each path is assembled from quoted fragments so
 * the scanner's own `sh -c` argv does not contain the contiguous string --
 * the same self-match that an unbracketed `pkill -f` had.
 *
 * Exits zero throughout: nothing to kill is the normal case on a crash, and a
 * process that disappears between reading cmdline and killing it is harmless.
 */
export function stopStaleHandsCmdForPaths(candidates: readonly string[]): string {
  const paths = candidates.filter(isSafeHandsBinaryPath);
  // Nothing survived the filter, so there is nothing to match. Falling through
  // would emit `; self=$$; ... case "$argv0" in )` -- a leading separator and an
  // empty case list, which `sh -n` rejects outright, so the step would fail with
  // a syntax error rather than the "nothing to kill" it means. Unreachable from
  // stopStaleHandsCmd while the two in-image paths are constants, which is
  // exactly why it would go unnoticed if that changed.
  if (paths.length === 0) return "exit 0";
  const assigns = paths
    .map((p, i) => `p${i}='${hideHandsBinaryInShell(p)}'`)
    .join("; ");
  const cases = paths.map((_, i) => `"$p${i}"`).join("|");
  return `${assigns}; self=$$; `
    + "for proc in /proc/[0-9]*; do "
    + "pid=${proc##*/}; [ \"$pid\" = \"$self\" ] && continue; "
    + "tr '\\000' '\\n' < \"$proc/cmdline\" 2>/dev/null | "
    + "{ IFS= read -r argv0 || exit 0; "
    + `case "$argv0" in ${cases}) kill -KILL "$pid" 2>/dev/null || true;; esac; }; `
    + "done; "
    + "sleep 1; exit 0";
}

/** Production scanner using only configured, validated Hands binary paths. */
export function stopStaleHandsCmd(): string {
  return stopStaleHandsCmdForPaths(knownHandsBinaryPaths());
}

/**
 * Whether a restarted Hands would still hold the environment this one has.
 *
 * See the note at the top of this file: only for a pod created for its own
 * request, which is every pod while there is no warm pool. safe-workload has no
 * pool, so it is always safe.
 */
export function restartPreservesEnvironment(inst: SandboxInstance): boolean {
  return inst.provider !== "agent-sandbox" || AGENT_SANDBOX_WARM_POOL_SIZE === 0;
}

/** The port a Hands MCP url points at. */
export function mcpPortFromUrl(handsUrl: string): string {
  try {
    return new URL(handsUrl).port || DEFAULT_MCP_PORT;
  } catch {
    return DEFAULT_MCP_PORT;
  }
}

function timeoutWithinBudget(requested: string, remainingMs: number): string {
  const want = parseExecTimeoutMs(requested);
  const cap = Math.max(1_000, remainingMs);
  return `${Math.max(1, Math.ceil(Math.min(want, cap) / 1000))}s`;
}

/** Kill any stale Hands and start it again, bounded by execDeadlineMs. */
async function killAndRelaunch(
  attempt: HandsRestartAttempt,
  inst: SandboxInstance,
): Promise<void> {
  const deadlineMs = attempt.execDeadlineMs ?? SANDBOX_HANDS_RESTART_EXEC_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(attempt.signal?.reason);
  if (attempt.signal?.aborted) onCallerAbort();
  else attempt.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const deadlineTimer = setTimeout(
    () => controller.abort(new Error(HANDS_RESTART_DEADLINE)),
    deadlineMs,
  );
  const execCapped = async (cmd: string, timeout: string) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error(HANDS_RESTART_DEADLINE);
    const call = execInSandbox(
      inst,
      cmd,
      timeoutWithinBudget(timeout, remaining),
      controller.signal,
    );
    call.catch(() => {});
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new Error(HANDS_RESTART_DEADLINE));
          controller.signal.addEventListener("abort", onAbort, { once: true });
          if (controller.signal.aborted) onAbort();
        }),
      ]);
    } finally {
      if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
  };
  try {
    await execCapped(stopStaleHandsCmd(), STOP_TIMEOUT);
    await bootstrapHandsInSandbox(
      execCapped,
      attempt.sessionId,
      mcpPortFromUrl(attempt.handsUrl),
      attempt.token,
    );
  } finally {
    clearTimeout(deadlineTimer);
    attempt.signal?.removeEventListener("abort", onCallerAbort);
  }
}

async function sleepUntilNextPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) throw new Error("restart_aborted");
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("restart_aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Restarts in flight, keyed by the sandbox they are repairing.
 *
 * The scanner SIGKILLs every process whose argv[0] is a Hands binary, which is
 * the right rule for one restart and the wrong one for two: the second one's
 * kill step cannot tell the Hands the first just launched from the wedged one
 * it was meant to clear, so it kills it, and the first is left polling a port
 * nothing is behind. Both then report failure for a container that is fine.
 *
 * Two restarts overlap easily -- task-runner's recovery and a DAG sibling's
 * reuse repair address the same sandbox through different paths, and a
 * `left_alone` verdict brings the next batch straight back. Sharing the first
 * one's result is also the right answer on the merits: they would run the same
 * commands against the same container and want the same verdict.
 *
 * Keyed by sandbox rather than session, because a DAG's nodes share a session
 * and their sandboxes must be repairable at the same time.
 */
const inFlight = new Map<string, Promise<HandsRestartResult>>();

/** Returned when the joiner's own signal fires before the owner is finished. */
const JOIN_ABORTED = Symbol("join_aborted");

/**
 * Wait for the owner's repair, but no longer than our own cancellation.
 *
 * Every other wait in this module observes the caller's signal --
 * killAndRelaunch registers onCallerAbort, sleepUntilNextPoll rejects on
 * abort, checkHandsHealth is handed the signal. The join was the one that did
 * not, so a cancelled joiner stayed blocked for the whole of someone else's
 * budget: the exec deadline plus a final health poll, or the full poll ladder.
 * Its task could not finish shutting down until another node's repair gave up.
 *
 * Abandoning the await cannot orphan a rejection: the owner holds its own
 * `await attemptRun` for the life of the promise.
 */
function joinUntilAborted(
  running: Promise<HandsRestartResult>,
  signal: AbortSignal | undefined,
): Promise<HandsRestartResult | typeof JOIN_ABORTED> {
  if (!signal) return running;
  if (signal.aborted) return Promise.resolve(JOIN_ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(JOIN_ABORTED);
    signal.addEventListener("abort", onAbort, { once: true });
    const done = () => signal.removeEventListener("abort", onAbort);
    running.then((v) => { done(); resolve(v); }, (e) => { done(); reject(e); });
  });
}

function restartKey(inst: SandboxInstance): string {
  return inst.provider === "agent-sandbox"
    ? `agent:${inst.namespace}:${inst.sandboxName}:${inst.id}`
    : `safe:${inst.id}`;
}

/**
 * Restart Hands in the session's existing container and wait for it to answer.
 *
 * Never throws: every caller is already on a recovery path and needs a verdict
 * to choose between this and leaving the container alone, not a second failure
 * to handle.
 */
export async function restartHandsInSandbox(
  attempt: HandsRestartAttempt,
): Promise<HandsRestartResult> {
  const { sessionId, handsUrl } = attempt;
  // Checked here rather than at the call sites, because only one of the three
  // was checking it: the two in ensure-hands restarted Hands regardless, so
  // turning the flag off disabled a third of the feature and left an operator
  // reaching for a rollback lever that does not roll anything back.
  if (!SANDBOX_HANDS_RESTART_ENABLED) {
    return { ok: false, detail: "restart_disabled", refused: true };
  }
  try {
    const entry = attempt.entry ?? await readHandsProbeEntry(sessionId);
    if (!entry) return { ok: false, detail: "no_sandbox_identity" };
    const inst = instanceFromEntry(sessionId, entry);
    if (!inst) return { ok: false, detail: "identity_unusable" };
    const key = restartKey(inst);
    const running = inFlight.get(key);
    // Join the restart already repairing this sandbox rather than starting a
    // second one that would kill the Hands the first just started.
    if (running) {
      logger.info({ sessionId }, "sandbox.hands_restart.joined_in_flight");
      // The owner's cancellation is not ours. Reporting "aborted" to a caller
      // that was never cancelled reads as "this run is over" and spends its
      // recovery budget on someone else's shutdown, so say what actually
      // happened to us: the repair did not complete, and not because of us.
      //
      // An owner abort leaves by two doors, and guarding only one left the
      // other doing exactly what this guard exists to stop: the kill/relaunch
      // catch RESOLVES with `aborted`, while an abort during an inter-poll wait
      // REJECTS with `restart_aborted`.
      const mine = () => !!attempt.signal?.aborted;
      let shared: HandsRestartResult | typeof JOIN_ABORTED;
      try {
        shared = await joinUntilAborted(running, attempt.signal);
      } catch (err) {
        if (mine()) throw err;
        logger.info(
          { sessionId, err: String((err as Error)?.message ?? err).slice(0, 120) },
          "sandbox.hands_restart.owner_left",
        );
        return { ok: false, detail: "owner_aborted" };
      }
      if (shared === JOIN_ABORTED) {
        // Our own cancellation, not the owner's: the repair may still succeed
        // for whoever else is waiting on it, so it is left running.
        logger.info({ sessionId }, "sandbox.hands_restart.join_aborted");
        return { ok: false, detail: "aborted" };
      }
      if (shared.detail === "aborted" && !mine()) {
        return { ok: false, detail: "owner_aborted" };
      }
      return shared;
    }
    if (!restartPreservesEnvironment(inst)) {
      // Refusing costs the container; going ahead would cost the user's
      // credentials silently, and a sandbox running without them looks healthy
      // from every angle the run can see.
      logger.warn({ sessionId }, "sandbox.hands_restart.env_not_reproducible");
      return { ok: false, detail: "env_not_reproducible", refused: true };
    }

    const attemptRun = (async (): Promise<HandsRestartResult> => {
    // A deadline here abandons the *exec*, not the launch. `setsid` has already
    // detached the process the command started, so a control plane that stopped
    // answering mid-call leaves a Hands that may be seconds from binding its
    // port. Reporting failure without asking sent the caller off to destroy a
    // container that was about to be fine, which is the trade this whole module
    // exists to avoid -- so the deadline falls through to the poll and only the
    // poll decides. A caller that aborted wants neither.
    let launchDetail = "";
    try {
      await killAndRelaunch(attempt, inst);
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (attempt.signal?.aborted) return { ok: false, detail: "aborted" };
      if (msg !== HANDS_RESTART_DEADLINE) throw err;
      logger.warn({ sessionId }, "sandbox.hands_restart.exec_deadline_polling");
      launchDetail = "exec_deadline";
    }

    // One check after a deadline, not the full ladder. The ladder is sized for
    // a launch we know started; here we do not know that, and this sits on the
    // tool-batch path where the agent loop is stopped for the duration. One ask
    // catches the case worth catching -- Hands bound its port while the exec was
    // being abandoned -- and a slower one is caught by the next attempt, which
    // costs a budget unit rather than the container: an unsuccessful restart
    // reports `left_alone` and destroys nothing.
    const maxTries = launchDetail
      ? 1
      : attempt.pollTries ?? SANDBOX_HANDS_RESTART_MAX_TRIES;
    const intervalMs = attempt.pollIntervalMs ?? SANDBOX_HANDS_RESTART_INTERVAL_MS;
    for (let tries = 0; tries < maxTries; tries++) {
      const health = await checkHandsHealth(handsUrl, HEALTH_TIMEOUT_MS, attempt.signal);
      if (health.ok) {
        logger.info(
          { sessionId, tries: tries + 1, launchDetail },
          "sandbox.hands_restart.healthy",
        );
        return { ok: true, detail: launchDetail ? "healthy_after_deadline" : "healthy" };
      }
      // No sleep after the last check: it delays the verdict by a whole
      // interval and nothing observes the gap.
      if (tries + 1 < maxTries) await sleepUntilNextPoll(intervalMs, attempt.signal);
    }
    logger.warn({ sessionId, handsUrl, launchDetail }, "sandbox.hands_restart.never_healthy");
    return { ok: false, detail: launchDetail || "started_but_unhealthy" };
    })();
    inFlight.set(key, attemptRun);
    try {
      return await attemptRun;
    } finally {
      inFlight.delete(key);
    }
  } catch (err) {
    const msg = (err as Error)?.message || "restart_failed";
    // A caller that went away is not an infrastructure failure, and reporting
    // it as one spends a recovery budget on a task that is already over.
    const detail = attempt.signal?.aborted
      ? "aborted"
      : msg === HANDS_RESTART_DEADLINE
        ? "exec_deadline"
        : msg.slice(0, 200);
    logger.warn({ err: detail, sessionId }, "sandbox.hands_restart.failed");
    return { ok: false, detail };
  }
}
