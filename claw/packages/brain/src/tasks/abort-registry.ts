// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Process-level registry of in-flight task abort controllers, keyed by the
 * gate key the run holds (see pickLockKey in tasks/lock.ts). Multi-user safe by
 * design: one entry per concurrently-running task on this Brain pod.
 *
 * Keyed by the gate key and nothing else, because two other things read this
 * map for exactly that: task-dispatch tests it to refuse a second handler for
 * a key already in flight, and index.ts reports its size as the number of
 * running tasks. Addresses a run also answers to live in the index below.
 *
 * Extracted out of index.ts so a caller outside the Brain entrypoint could
 * reach abortSession() without importing it. Keepalive was that caller and no
 * longer is: session-level abort cancels every DAG node sharing the session,
 * including healthy siblings, so eviction stops the one sandbox instead. That
 * leaves abortSession() with no production caller -- kept because the job it
 * did, unblocking a loop parked in an MCP call, still has no replacement.
 */
export const activeAbort = new Map<string, AbortController>();

/**
 * The other names a running task answers to.
 *
 * A gate key says which runs may overlap; it is not an address. Those were the
 * same string for as long as the gate was keyed on the session or the DAG root,
 * which is what everyone publishes an interrupt to -- so nothing recorded that
 * they had to stay equal, and keying the gate on the workspace instead made
 * every interrupt in the system miss in silence. A miss is indistinguishable
 * from the normal case here: an interrupt is broadcast to every pod and all but
 * one of them are supposed to find nothing.
 *
 * So the addresses are held separately from the key. A run registers the names
 * its callers know it by -- its session, its DAG root -- and whoever changes
 * the gate key next changes nothing about how a run is reached.
 *
 * One address can name several runs. It names at most one today, since every
 * run of a session binds that session's workspace and therefore queues on it,
 * but that is a consequence of one workspace per session rather than a rule,
 * and "stop this session" means all of them either way.
 */
/**
 * Runs that were told to stop and are winding down on purpose, for longer than
 * the interrupt handler's force-release timeout: an app run's SIGTERM grace
 * (`stop_grace_sec`, minutes). Not stuck, so not released by force.
 */
export const gracefulStop = new WeakMap<AbortController, number>();

/** The longest a graceful stop may hold a run's lock past the interrupt: the app grace at its maximum, plus room to finish. */
export const GRACEFUL_STOP_MAX_MS = (3600 + 600) * 1000;

/** Mark `ctrl` as winding down on purpose, until `now + maxMs`. */
export function markGracefulStop(ctrl: AbortController, now: number = Date.now(), maxMs: number = GRACEFUL_STOP_MAX_MS): void {
  gracefulStop.set(ctrl, now + maxMs);
}

/**
 * How long the interrupt handler should wait before force-releasing the lock of
 * `ctrl`: 0 when it is not winding down gracefully, or its graceful time is up;
 * otherwise what is left of it. A run that is stuck in its finish therefore does
 * not hold the session's lock for ever.
 */
export function gracefulStopRemainingMs(ctrl: AbortController, now: number = Date.now()): number {
  const until = gracefulStop.get(ctrl);
  return until === undefined ? 0 : Math.max(0, until - now);
}

const lockKeysByAddress = new Map<string, Set<string>>();
const lockKeysBySessionEnd = new Map<string, Set<string>>();
const addressesByLockKey = new Map<string, { named: string[]; sessionEnd: string[] }>();

function addTo(index: Map<string, Set<string>>, address: string, lockKey: string): void {
  const keys = index.get(address) ?? new Set<string>();
  keys.add(lockKey);
  index.set(address, keys);
}

/**
 * Record the names an in-flight run can be reached by, alongside its gate key.
 *
 * `addresses` are the names an interrupt is published to. `sessionEnd` are names
 * that stop the run only when the whole session goes away (a deletion): they are
 * resolved by {@link resolveSessionEndTargets} and never by an interrupt. An
 * application running beside a conversation needs the difference: a Stop of the
 * conversation is `interrupt.<sessionId>` and must not end it, while deleting the
 * session must.
 *
 * Undefined and duplicate names are dropped, as is the gate key itself: it is
 * already an address by virtue of being the map key, and storing it twice would
 * only give resolveAbortTargets two ways to say the same thing.
 */
export function registerRunAddresses(
  lockKey: string,
  addresses: Array<string | undefined>,
  sessionEnd: Array<string | undefined> = [],
): void {
  const clean = (list: Array<string | undefined>) => [...new Set(list.filter((a): a is string => !!a && a !== lockKey))];
  const named = clean(addresses);
  const ending = clean(sessionEnd);
  if (!named.length && !ending.length) return;
  addressesByLockKey.set(lockKey, { named, sessionEnd: ending });
  for (const address of named) addTo(lockKeysByAddress, address, lockKey);
  for (const address of ending) addTo(lockKeysBySessionEnd, address, lockKey);
}

/**
 * What dispatch registers for a run it starts. A chat turn or a DAG node answers
 * to its session and DAG root. An app run is addressed by its own task id (the
 * API's cancel publishes that) and ends with its session, but a Stop of the
 * session's conversation is not addressed to it.
 */
export function registerRunAddressesFor(
  lockKey: string,
  request: { mode?: string; task_id?: string; session_id: string; dag_root_task_id?: string },
): void {
  if (request.mode === "app") registerRunAddresses(lockKey, [request.task_id], [request.session_id]);
  else registerRunAddresses(lockKey, [request.session_id, request.dag_root_task_id]);
}

/** Forget a finished run's addresses. Safe to call for a run that had none. */
export function forgetRunAddresses(lockKey: string): void {
  const entry = addressesByLockKey.get(lockKey);
  if (!entry) return;
  addressesByLockKey.delete(lockKey);
  for (const [index, list] of [[lockKeysByAddress, entry.named], [lockKeysBySessionEnd, entry.sessionEnd]] as const) {
    for (const address of list) {
      const keys = index.get(address);
      if (!keys) continue;
      keys.delete(lockKey);
      if (!keys.size) index.delete(address);
    }
  }
}

/**
 * The gate keys of the runs an address refers to, on this pod.
 *
 * Returns keys rather than controllers because the callers that abort a run
 * also have to clean up after it -- releasing `lock.<key>` when a run ignores
 * its abort -- and that is the key's job, not the address's.
 *
 * An address that is itself a gate key resolves to that run directly, which is
 * what keeps a deployment running RUN_GATE_KEY=session working unchanged.
 */
export function resolveAbortTargets(address: string): string[] {
  if (activeAbort.has(address)) return [address];
  const keys = lockKeysByAddress.get(address);
  if (!keys) return [];
  return [...keys].filter((key) => activeAbort.has(key));
}

/**
 * Abort reason passed to AbortController.abort() on graceful drain (see
 * index.ts installSignalHandlers). Shared between index.ts (which raises
 * it) and tasks/runner.ts (which checks abortCtrl.signal.reason to pick the
 * SIGTERM-checkpoint catch branch over the generic user-interrupt one) —
 * lives here instead of either file to avoid a circular import.
 */
export const SIGTERM_ABORT_REASON = Symbol("sigterm");

/**
 * Abort reason raised when this replica's periodic lock renewal loses its CAS,
 * meaning another replica now holds the lease for this task and is running it.
 *
 * Distinct from SIGTERM and from a user interrupt because the correct response
 * is different from both: the run has to stop touching the sandbox and the
 * workspace, but it must not report a terminal state, delete the checkpoint or
 * tear anything down — those all belong to the replica that holds the lease
 * now, and doing them from here destroys a live run's state.
 */
export const LEASE_LOST_ABORT_REASON = Symbol("lease_lost");

/**
 * Abort reason raised when the run's row has gone terminal underneath it --
 * reaped by the sweeper, or cancelled by the user -- while this replica is
 * still the one holding the task.
 *
 * The opposite situation to LEASE_LOST, despite looking like it from inside the
 * run: there, another replica owns everything and touching any of it destroys a
 * live run's state. Here nobody else owns anything. Standing down quietly
 * leaves the sandbox pinned until the idle collector notices and leaves the
 * message unsettled, so it comes back every ack_wait to provision a sandbox and
 * abort again until the delivery budget is gone. What this run has to do is
 * hand back what it holds and stop the message coming back, without reporting a
 * terminal state for a row that already has one.
 */
export const RUN_ROW_TERMINAL_ABORT_REASON = Symbol("run_row_terminal");

/**
 * Abort reason raised when a run reaches the `deadline_at` the API stamped on
 * it, i.e. when its active budget is spent.
 *
 * Distinct from a user interrupt, which it would otherwise be indistinguishable
 * from: a run the user stopped and a run that ran out of budget need different
 * text in the transcript and different failure reasons on the task row, and
 * conflating them is what made "why did this stop?" unanswerable. Unlike
 * LEASE_LOST this run still owns everything it holds, so it reports terminally
 * and tears down normally.
 */
export const DEADLINE_EXCEEDED_ABORT_REASON = Symbol("deadline_exceeded");

/**
 * Whether an abort reason is a user's cancel, as against a reason the run settles
 * on its own: a handover (graceful restart, a successor taking over -- the next
 * run adopts what this one was provisioning) or the run's own ending (deadline,
 * terminal row -- the failure path reads the platform's account of the sandbox
 * before it reaps it). Only a cancel may have a sandbox wait reclaim what it was
 * waiting on.
 */
export function isUserCancelReason(reason: unknown): boolean {
  return reason !== SIGTERM_ABORT_REASON
    && reason !== LEASE_LOST_ABORT_REASON
    && reason !== RUN_ROW_TERMINAL_ABORT_REASON
    && reason !== DEADLINE_EXCEEDED_ABORT_REASON;
}

/**
 * Externally abort the in-flight task for a session, if any. Used by
 * sandbox-keepalive when consecutive ping failures indicate the Hands
 * sandbox is gone — without this the agent loop happily blocks for up to
 * 1h on the dead MCP request before recovering. Returns true if an active
 * task was found and aborted.
 *
 * The session is an address, so this reaches a run whatever its gate key is.
 * It used to be a direct lookup and therefore missed every DAG-rooted task,
 * which was written down as acceptable for the fan-out path -- the loop
 * unblocked on the next MCP retry timeout instead, up to an hour later.
 */
export function abortSession(sessionId: string, reason?: unknown): boolean {
  let aborted = false;
  for (const lockKey of resolveAbortTargets(sessionId)) {
    const ctrl = activeAbort.get(lockKey);
    if (!ctrl) continue;
    try { ctrl.abort(reason); } catch { /* ignore */ }
    aborted = true;
  }
  return aborted;
}

/**
 * The gate keys of every run a deleted session takes down: the runs an interrupt
 * to the session would reach, and the ones that answer to it only when it ends.
 */
export function resolveSessionEndTargets(sid: string): string[] {
  const ending = [...(lockKeysBySessionEnd.get(sid) ?? [])].filter((key) => activeAbort.has(key));
  return [...new Set([...resolveAbortTargets(sid), ...ending])];
}
