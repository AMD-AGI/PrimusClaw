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
const lockKeysByAddress = new Map<string, Set<string>>();
const addressesByLockKey = new Map<string, string[]>();

/**
 * Record the names an in-flight run can be reached by, alongside its gate key.
 *
 * Undefined and duplicate names are dropped, as is the gate key itself: it is
 * already an address by virtue of being the map key, and storing it twice would
 * only give resolveAbortTargets two ways to say the same thing.
 */
export function registerRunAddresses(
  lockKey: string,
  addresses: Array<string | undefined>,
): void {
  const named = [...new Set(addresses.filter((a): a is string => !!a && a !== lockKey))];
  if (!named.length) return;
  addressesByLockKey.set(lockKey, named);
  for (const address of named) {
    const keys = lockKeysByAddress.get(address) ?? new Set<string>();
    keys.add(lockKey);
    lockKeysByAddress.set(address, keys);
  }
}

/** Forget a finished run's addresses. Safe to call for a run that had none. */
export function forgetRunAddresses(lockKey: string): void {
  const named = addressesByLockKey.get(lockKey);
  if (!named) return;
  addressesByLockKey.delete(lockKey);
  for (const address of named) {
    const keys = lockKeysByAddress.get(address);
    if (!keys) continue;
    keys.delete(lockKey);
    if (!keys.size) lockKeysByAddress.delete(address);
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
