// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Backend-side sandbox destruction (task-design.md §9.4 / §9.5).
 *
 * Backend is the *only* normal destroyer; Brain only rolls back sandboxes
 * it created when KV bookkeeping fails inside its own create path. Three
 * entry points feed this module:
 *
 *   1. agent_done callback handler: if the calling task is the last user of
 *      any handle (per DAG `handle_last_user`) AND no sibling node of that DAG
 *      is still live -- that map names the last node in topological order,
 *      which is not the last one to finish.
 *   2. cancelTask's DAG-root branch: tear every remaining handle of a DAG it
 *      actually cancelled. A root reaching terminal on its own does NOT run
 *      this -- the scheduler only writes status -- so those handles are the
 *      sweeper's.
 *   3. Sweeper: orphan handles whose DAG row no longer exists.
 *
 * Both KV destroy and SaFE workload stop are idempotent.
 */
import {
  DagHandleMap, HANDLE_MAP_PREFIX, setHandleEntry, type HandleInfo,
  HANDS_KEY_PREFIX,
  RETAINED_PREFIX,
  isRetentionEntry,
  handsSessionKey,
  legacyHandsKey,
  reuseWindowStart,
  usableSharedVerdict,
  type SharedVerdictFields,
} from "@claw/protocol";
import type { KVStore } from "@claw/utils";
import { createHash } from "node:crypto";
import pino from "pino";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { SAFE_API_URL } from "../config.js";
import { DAG_HANDLES_BUCKET, jsm, kv, kvDagHandles, nc } from "../infra/nats.js";
import { db } from "../infra/db.js";

const logger = pino({ name: "sandbox-stopper" });

/** Unchanged from before this file reported outcomes. */
const SAFE_STOP_TIMEOUT_MS = 15_000;

/**
 * Ceiling on establishing sole ownership before a stop.
 *
 * The check enumerates the registry and leader-reads it, and the SDK's ordered
 * consumer will rebuild and retry indefinitely when JetStream is unavailable
 * while the core connection stays healthy -- the iterator simply never ends.
 * Without a ceiling that hangs the cancel request, and with it the interrupt,
 * which the route publishes only after `cancelTask` returns: the row reads
 * cancelled while Brain is never told, which is a worse outcome than either
 * answer this check can give.
 *
 * Expiring is not a failure to report -- it is the same unknown as a failed
 * read, and takes the same conservative answer: decline to stop.
 *
 * Sized against the healthy cost, which is one leader read per other DAG: a
 * registry holding tens of DAGs settles far inside this, and one holding
 * thousands would not. That is the wrong way to find out, so if this starts
 * expiring the answer is the workload-keyed ownership record described on
 * `otherDagHolding`, not a larger number here -- expiry leaks (visibly), and
 * raising it trades that for hung cancels.
 */
const SHARED_CHECK_TIMEOUT_MS = 10_000;

/**
 * How many registry reads one ownership question keeps in flight.
 *
 * Both questions this module asks the registry -- "does another DAG hold this
 * workload" and "is this workload retained" -- are answered by reading every
 * candidate key, because the registry is keyed by DAG and by generation while
 * the question is keyed by workload. Issued one at a time, the cost of an
 * answer grows with the size of the registry until it crosses
 * `SHARED_CHECK_TIMEOUT_MS`, and past that point every cancel in the fleet
 * declines to stop anything: the conservative answer, given for a reason that
 * has nothing to do with ownership, while the workloads it declined to stop go
 * on holding their GPUs. The cancel that waited also holds its caller open,
 * and the interrupt with it, since `routes/tasks.ts` publishes that only after
 * `cancelTask` returns.
 *
 * The reads are independent and idempotent, so they are issued in parallel.
 * This does not reduce the total work and is not a substitute for the
 * workload-keyed ownership record described on `otherDagHolding` -- it buys
 * the room between "the registry got bigger" and "the fleet can no longer stop
 * a sandbox", which is the failure that arrives with no warning. Bounded
 * rather than unbounded so that one cancel cannot answer itself by flooding
 * the connection every other request shares.
 */
const REGISTRY_READ_CONCURRENCY = 16;

/**
 * How many times a handle removal re-reads a row that moved under it. Each
 * retry means a concurrent registration landed, which is rare and self-
 * limiting; a row that will not settle is a broken invariant, not a busy one,
 * and is raised rather than retried forever inside a cancel request.
 */
const CAS_ATTEMPTS = 5;

/**
 * A rejection is not required to be an `Error`, and every catch on this path
 * exists to keep a cancellation alive -- so reading `.message` off whatever
 * arrived, and throwing a TypeError out of the handler when it was `undefined`,
 * would defeat the containment at exactly the moment it is needed.
 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let _handleMap: DagHandleMap | null = null;

/** The part of the NATS KV surface this adapter uses. */
export interface KvLike {
  get(key: string): Promise<{ operation?: string; value: Uint8Array; revision: number } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  /** Revision-conditional put: rejects if the key moved since `revision`. */
  update(key: string, value: Uint8Array, revision: number): Promise<unknown>;
  delete(key: string, opts?: { previousSeq: number }): Promise<unknown>;
  keys(filter: string): Promise<AsyncIterable<string>>;
}

/** Build the DagHandleMap on demand using the existing NATS KV bucket. */
function handleMap(): DagHandleMap {
  _handleMap ??= new DagHandleMap(makeKvStore(kvDagHandles as unknown as KvLike));
  return _handleMap;
}

/**
 * Adapt a NATS KV bucket into the KVStore interface DagHandleMap expects,
 * using the same encoding contract Brain writes handle entries with: a JSON
 * object payload.
 *
 * Takes the bucket rather than closing over the module's own, because what it
 * decides -- which answers mean "absent", which mean "unknown" -- is now load
 * bearing for whether a DAG can be reported as holding nothing, and that
 * decision deserves to be exercised directly rather than only through a NATS
 * server.
 */
/**
 * Whether a JetStream error means the key is genuinely not there.
 *
 * `no message found` (10037) is absence and is an answer. `stream not found`
 * (10059) is the registry itself being unreachable, which is no evidence that
 * a workload was released -- and both arrive with `code: "404"` and messages
 * a text match cannot safely separate, so the structured code is the only
 * thing that distinguishes them.
 *
 * Exported because that distinction is the whole safety property here, and a
 * test that stubs the read around it proves nothing about it.
 */
export function isNoMessageFound(e: unknown): boolean {
  return (e as { api_error?: { err_code?: number } })?.api_error?.err_code === 10037;
}

export function makeKvStore(kv: KvLike): KVStore {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  return {
    // `null` means the key is not there. It used to also mean "the read
    // threw", which the teardown path below now has to be able to tell apart:
    // a bucket that cannot be read says nothing about what a DAG holds, and
    // classifying that as "holds nothing" is how an unreadable registry turns
    // into a confident `nothing_held` while a workload keeps its GPU. A
    // corrupt payload is the same kind of unknown, so it throws rather than
    // reading as absent. Callers that genuinely do not care still get one --
    // the sweeper tick already contains its sweeps.
    async get(key) {
      const entry = await kv.get(key);
      if (!entry) return null;
      // A deleted key is not an absent one to `kv.get`: it answers with the
      // tombstone, whose value is empty. The client filters DEL/PURGE on its
      // watch paths and deliberately not here, so this is where "deleted" has
      // to become "absent" -- and above all must not become "corrupt", which is
      // what an empty body parses as now that a parse failure throws. A DAG
      // whose last handle goes has its row deleted, so getting this wrong
      // reports that clean teardown as unreadable.
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      if (entry.value.length === 0) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(dec.decode(entry.value));
      } catch (e) {
        throw new Error(`handle map entry ${key} is not readable JSON: ${errText(e)}`);
      }
      // `JSON.parse` is happy with `null`, `false` and `7`, and the cast that
      // used to follow it was happy with all three. `DagHandleMap` then reads
      // them as a DAG holding no handles -- an unknown wearing the one answer
      // that must never be invented. Shape is as much of the contract as syntax.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`handle map entry ${key} is not a JSON object`);
      }
      return parsed as Record<string, unknown>;
    },
    async put(key, value) {
      await kv.put(key, enc.encode(JSON.stringify(value)));
    },
    async delete(key) {
      await kv.delete(key);
    },
    async scanPrefix(prefix) {
      const filter = prefix.endsWith(".") ? `${prefix}>` : `${prefix}.>`;
      // Drained before the first `get`. `kv.keys()` is an ordered-consumer
      // subscription and awaiting another JetStream request inside `for await`
      // stalls its pump, ending the consumer early with no error -- measured at
      // 1 key returned out of 21 live ones on the real bucket. See the same
      // note in @claw/utils' kv store, which had the identical shape.
      const keys: string[] = [];
      for await (const key of await kv.keys(filter)) {
        if (key.startsWith(prefix)) keys.push(key);
      }
      const out: Array<[string, Record<string, unknown>]> = [];
      for (const key of keys) {
        // Same three answers as `get`, and for the same reasons: a tombstone or
        // an empty value is a key that is gone, while an entry that will not
        // parse is an unknown. A scan that silently skipped the last of those
        // would hand the sweeper a short list of DAGs and call it complete.
        const entry = await kv.get(key);
        if (!entry) continue;
        if (entry.operation === "DEL" || entry.operation === "PURGE") continue;
        if (entry.value.length === 0) continue;
        out.push([key, JSON.parse(dec.decode(entry.value)) as Record<string, unknown>]);
      }
      return out;
    },
  };
}

/**
 * Remove one handle from a DAG's row without losing a handle registered
 * alongside it, and return the workload id it held.
 *
 * `DagHandleMap.destroy` is a read-modify-write of the whole row with no
 * revision on the write, and this module was its only caller anywhere: Brain
 * registers and looks up, never destroys. So the lost update it allows was
 * never reachable -- until this branch pointed the API at the bucket Brain
 * actually writes. That is what made it this branch's to avoid rather than to
 * note, and why the teardown path now goes through the conditional removal
 * below instead.
 *
 * The interleaving it allows costs a whole sandbox:
 *
 *   API      reads `{a: Wa}` and prepares to write the row without `a`
 *   Brain    registers `b`, writing `{a: Wa, b: Wb}`
 *   API      writes `{}` -- `b` is gone, and with it the only reference to Wb
 *
 * Nothing then knows Wb exists: not this cancel, not the record, not a later
 * sweep. It holds its GPU until something outside Claw notices. That is worse
 * than any misreport, because a misreport at least leaves the evidence intact.
 *
 * The write is therefore conditional on the revision the row was read at, and
 * a conflict re-reads and retries. Conditional on the row, not the handle,
 * because the row is what the KV versions. Implemented here rather than in
 * `DagHandleMap` because that class is shared with Brain: giving `KVStore` a
 * revision is the right fix and is a change to a contract two packages
 * implement, which belongs in its own review, not smuggled in under this one.
 *
 * Takes the bucket rather than closing over the module's own, for the same
 * reason `makeKvStore` does: what it guarantees is a property of the write it
 * issues, and a test that cannot supply a bucket with real revision semantics
 * cannot tell a conditional write from an unconditional one.
 */
export async function destroyHandleCas(
  kv: KvLike,
  dagRootTaskId: string,
  handleName: string,
  expectWorkloadId?: string,
): Promise<string | null> {
  const key = `${HANDLE_MAP_PREFIX}.${dagRootTaskId}`;
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get(key);
    if (!entry) return null;
    if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
    if (entry.value.length === 0) return null;

    const parsed: unknown = JSON.parse(dec.decode(entry.value));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`handle map entry ${key} is not a JSON object`);
    }
    const row = parsed as Record<string, unknown>;
    const held = row[handleName];
    // Brain writes a HandleInfo; a legacy entry is the bare workload id.
    const workloadId = typeof held === "string"
      ? held
      : (held as { workload_id?: unknown } | undefined)?.workload_id;
    if (typeof workloadId !== "string") return null;
    // Bound to the workload the caller recorded, not to whatever currently
    // answers to the name. A retry re-reads, and between reads a rebuild can
    // register a DIFFERENT workload under the same handle -- one this call
    // never pre-marked and never intends to stop. Removing that entry drops
    // the only reference to a live sandbox, which is the failure the revision
    // check was added to prevent, arriving through the retry instead.
    if (expectWorkloadId !== undefined && workloadId !== expectWorkloadId) {
      logger.warn(
        { dagRootTaskId, handleName, expected: expectWorkloadId, found: workloadId },
        "sandbox.handle_identity_changed",
      );
      return null;
    }

    delete row[handleName];
    try {
      if (Object.keys(row).length === 0) {
        await kv.delete(key, { previousSeq: entry.revision });
      } else {
        await kv.update(key, enc.encode(JSON.stringify(row)), entry.revision);
      }
      return workloadId;
    } catch (e) {
      // A conflict means the row moved under us -- which is exactly the case
      // worth losing a round trip over, since committing would have discarded
      // whatever moved it. Anything else is a real failure and is the caller's.
      if (!isRevisionConflict(e)) throw e;
      logger.info(
        { dagRootTaskId, handleName, attempt },
        "sandbox.handle_destroy_retry",
      );
    }
  }
  throw new Error(
    `handle map row for ${dagRootTaskId} kept changing under ${CAS_ATTEMPTS} attempts`,
  );
}

/**
 * NATS answers a failed `previousSeq` with a "wrong last sequence" API error.
 * Matched on text because the client surfaces it as a plain error; anything
 * unrecognised is deliberately NOT treated as a conflict, so a real failure is
 * raised rather than retried into the attempt limit and then raised anyway.
 */
function isRevisionConflict(e: unknown): boolean {
  return /wrong last sequence|conflict/i.test(errText(e));
}

/**
 * Seam over the handle registry, in the shape `events/consumer.ts` uses for the
 * tombstone bucket and for the same reason: `handleMap()` closes over the
 * module-scoped NATS KV, which is a live binding on a frozen module namespace
 * and so cannot be substituted. A plain object can be, and every registry call
 * on the teardown path goes through these methods, which is what makes the
 * outcomes below testable without a NATS server.
 */
/**
 * Brain's retention ledger prefix, restated rather than imported: it is declared
 * in `@claw/brain`, which this process does not depend on. A drift here reads as
 * "nothing is retained", which is why the reader below is asserted against a
 * real key shape rather than a stub.
 */
const RETENTION_LEDGER_PREFIX = "retention.";

/** The part of the NATS KV surface reading a session binding needs. */
export interface HandsReadKv {
  get(key: string): Promise<{ operation?: string; value: Uint8Array; revision: number } | null>;
}

/**
 * What a session's `hands.<session>` binding establishes about background work
 * still running inside a particular workload.
 *
 * Four answers, not two, because the caller's action differs for each and
 * collapsing any pair of them loses something:
 *
 *   - `running`  a verdict measured in THIS idle period found live shells.
 *   - `clear`    nothing on record says there is background work in this
 *                workload, for a reason that will not change by waiting.
 *   - `awaiting` no usable verdict yet, but the sandbox is still addressable
 *                and Brain's keepalive sweep is the thing that will publish
 *                one. A measurement that has not happened is not a measurement
 *                of zero.
 *   - `unreadable` the store or the entry could not be read. Not absence:
 *                classifying it as absence is how an unavailable bucket turns
 *                into a confident "nothing is running in there".
 */
export type SessionBackgroundWork =
  | { state: "running"; workloadId: string; running: number; at: number }
  | {
    state: "clear";
    reason: "no_workload" | "no_binding" | "other_sandbox" | "verdict_idle"
      | "no_idle_period" | "no_credentials";
    workloadId?: string;
    running?: number;
  }
  | { state: "awaiting"; workloadId: string; sinceMs: number }
  | { state: "unreadable"; reason: string };

/**
 * Read a session's binding through both names it can live under.
 *
 * Read-through for the same reason `readReusableEntry` in Brain does it: an
 * older replica in a rolling upgrade writes and reads only the legacy key, so
 * looking at the canonical one alone reads a live session as having no sandbox.
 * For an ordinary session id the two names are identical and this is one read.
 *
 * A deleted key is not an absent one to `kv.get` -- it answers with the
 * tombstone, whose value is empty -- so the walk goes past it rather than
 * stopping on it. A payload that will not parse throws: an unreadable entry is
 * an unknown, and the one answer it must never become is "no sandbox here".
 */
async function readHandsBinding(
  kv: HandsReadKv, sessionId: string,
): Promise<Record<string, unknown> | null> {
  const canonical = handsSessionKey(sessionId);
  const legacy = legacyHandsKey(sessionId);
  const dec = new TextDecoder();
  for (const key of canonical === legacy ? [canonical] : [canonical, legacy]) {
    const entry = await kv.get(key);
    if (!entry) continue;
    if (entry.operation === "DEL" || entry.operation === "PURGE") continue;
    if (entry.value.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dec.decode(entry.value));
    } catch (e) {
      throw new Error(`hands entry ${key} is not readable JSON: ${errText(e)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`hands entry ${key} is not a JSON object`);
    }
    return parsed as Record<string, unknown>;
  }
  return null;
}

/**
 * Whether a session is still carrying background work inside one of these
 * workloads.
 *
 * Background shells outlive the run that started them: ending a chat parks the
 * sandbox and keeps them alive deliberately. When Brain finishes with such a
 * container it writes a retention record, and `retained` above is what stops a
 * teardown from touching it -- but the ordinary end of a chat writes no such
 * record. It leaves the sandbox in the plain `hands.<session>` binding with
 * `keepalive: false`, and from that moment the only thing on record saying
 * "there is still work in here" is the background-work verdict Brain's
 * keepalive sweep publishes onto that same entry.
 *
 * So this reads it. The rules for believing it are `usableSharedVerdict`'s, in
 * `@claw/protocol`, shared with the sweep that writes it rather than restated
 * here -- `bgRunning > 0` on its own is a measurement from SOME idle period,
 * and a verdict about the period before this one is not evidence about this
 * one in either direction.
 *
 * The workload match is a precondition on the whole answer, not a detail of it:
 * one session key names one sandbox at a time, and a binding naming a
 * replacement sandbox says nothing whatsoever about the workload a stale handle
 * still points at. Without the match, a session that had rebuilt its sandbox
 * would hold its own dead workload's handle open forever.
 *
 * `workloadIds` is every workload the caller is about to stop together, and any
 * match defers all of them: they go down in one call, so the answer has to be
 * about the set. An empty or workload-less set is `no_workload` -- the
 * agent-sandbox path, which records no workload id and which this read cannot
 * speak about at all.
 */
export async function readSessionBackgroundWork(
  kv: HandsReadKv,
  sessionId: string,
  workloadIds: readonly string[],
  now: number = Date.now(),
): Promise<SessionBackgroundWork> {
  const wanted = new Set(workloadIds.filter((w) => !!w));
  if (!sessionId || wanted.size === 0) return { state: "clear", reason: "no_workload" };
  let info: Record<string, unknown> | null;
  try {
    info = await readHandsBinding(kv, sessionId);
  } catch (e) {
    return { state: "unreadable", reason: errText(e) };
  }
  if (!info) return { state: "clear", reason: "no_binding" };
  const workloadId = typeof info.workloadId === "string" ? info.workloadId : "";
  if (!workloadId || !wanted.has(workloadId)) {
    return { state: "clear", reason: "other_sandbox", workloadId };
  }
  const fields = info as SharedVerdictFields;
  const verdict = usableSharedVerdict(fields, now);
  if (verdict?.state === "running") {
    return { state: "running", workloadId, running: verdict.running, at: verdict.at };
  }
  if (verdict) {
    return { state: "clear", reason: "verdict_idle", workloadId, running: verdict.running };
  }
  // No verdict is usable. Whether that is worth waiting for is decided by
  // whether one could ever arrive, and there are two ways it could not.
  //
  // With no `idleSince` the entry has no idle period open on it, and
  // `measuredUnderThisIdlePeriod` rejects every verdict against such an entry
  // by its first line -- so waiting here is waiting for something the rule
  // itself will never accept. Every deployed writer stamps the field when it
  // parks a handle; an entry without it has not been parked.
  //
  // Without `handsUrl` and `token` nobody can probe the sandbox again, which is
  // not the same as the answer being no -- it is the same "no credentials and
  // nothing on record" that Brain's own `peekBackgroundWork` resolves to the
  // legacy idle behaviour, and it resolves it the same way here, AFTER the
  // verdict above has been read rather than before it.
  if (typeof fields.idleSince !== "number") {
    return { state: "clear", reason: "no_idle_period", workloadId };
  }
  if (!info.handsUrl || !info.token) {
    return { state: "clear", reason: "no_credentials", workloadId };
  }
  return {
    state: "awaiting",
    workloadId,
    sinceMs: Math.max(0, now - reuseWindowStart(fields)),
  };
}

export const handleRegistry = {
  destroy(
    dagRootTaskId: string,
    handleName: string,
    expectWorkloadId?: string,
  ): Promise<string | null> {
    return destroyHandleCas(
      kvDagHandles as unknown as KvLike, dagRootTaskId, handleName, expectWorkloadId,
    );
  },
  lookup(dagRootTaskId: string, handleName: string): Promise<HandleInfo | null> {
    return handleMap().lookup(dagRootTaskId, handleName);
  },
  listForDag(dagRootTaskId: string): Promise<Record<string, HandleInfo>> {
    return handleMap().listForDag(dagRootTaskId);
  },
  listAll(): Promise<Array<[string, Record<string, HandleInfo>]>> {
    return handleMap().listAll();
  },
  /**
   * Is this workload protected by a retention record?
   *
   * Brain writes these into the registry bucket beside the session entries,
   * keyed `hands.retained-<generation>`, when a container has background work
   * its DAG has finished with. From that moment the record IS the container's
   * reference and the DAG handle is released -- so a handle still naming a
   * retained container is a bookkeeping failure, not a licence to stop it.
   *
   * On the seam with the rest of the registry reads, for the reason given
   * above: it closes over a module-scoped live binding that cannot be
   * substituted, and every outcome below has to be reachable without NATS.
   */
  async retained(workloadId: string): Promise<boolean> {
    if (!workloadId) return false;
    const dec = new TextDecoder();
    // Both records, and neither filter is a prefix match.
    //
    // `hands.retained-*` is not a wildcard: NATS only treats `*` as one when it
    // is a whole token, so that filter is a literal nobody writes and the scan
    // came back empty every time -- a gate that never fired, on a path whose
    // tests stub this method and so could never have caught it.
    //
    // The ledger is the authority, not the projection: `retainContainer` writes
    // the ledger first and the projection is restored FROM it, so a ledger-only
    // moment is a container that is retained and a projection-only read that
    // misses it is the mistake Brain's own `retainedTaker` already avoids. The
    // projection is still read, because a replica that predates the ledger
    // writes only that one for the length of a rolling upgrade, and missing a
    // retention stops a container somebody's background work is running in.
    //
    // Both scans at once, and the reads inside each in parallel, for the reason
    // given on `REGISTRY_READ_CONCURRENCY`: this ran per handle per stop, one
    // read after another, over a bucket holding a key per live session. Its
    // cost was the fleet's size, its ceiling was the same ten seconds the
    // shared-holder check gets, and when it expired the catch above turned the
    // teardown into a no-op -- a real SaFE workload left running on the
    // strength of a scan that was merely slow. The answer is unchanged: every
    // key either scan would have read is still read, and an unreadable record
    // still rejects.
    const scan = async ([filter, prefix]: readonly [string, string]): Promise<boolean> => {
      const keys: string[] = [];
      for await (const key of await kv.keys(filter)) {
        if (key.startsWith(prefix)) keys.push(key);
      }
      const hit = await firstAnswer(keys, async (key) => {
        const entry = await kv.get(key);
        if (!entry || !entry.value?.length) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(dec.decode(entry.value));
        } catch (e) {
          // Unreadable is not absent. The caller turns a throw into
          // `unconfirmed`; swallowing it here would answer "not retained" about
          // a record that may say the opposite.
          throw new Error(`retention record ${key} is unreadable: ${errText(e)}`);
        }
        if (!isRetentionEntry(parsed)) return null;
        return (parsed as { workloadId?: string }).workloadId === workloadId ? key : null;
      });
      return hit !== null;
    };
    const found = await Promise.all([
      scan([`${RETENTION_LEDGER_PREFIX}*`, RETENTION_LEDGER_PREFIX]),
      scan([`${HANDS_KEY_PREFIX}*`, `${HANDS_KEY_PREFIX}${RETAINED_PREFIX}`]),
    ]);
    return found.some((retained) => retained);
  },
  /**
   * Is this session still carrying background work in one of these workloads?
   *
   * On the seam with `retained` and for the identical reason: it closes over a
   * module-scoped live binding that cannot be substituted, so every outcome
   * has to be reachable without a NATS server. The rules themselves live in
   * `readSessionBackgroundWork` above, which takes the bucket, so a test
   * exercises the real reader against a fake store rather than a stub of the
   * answer.
   *
   * Nothing on the cancel path calls this, and nothing on it may. The only
   * action this answer licenses is "not this time", which is a coherent thing
   * for a sweep that runs again in a minute to say and an incoherent thing for
   * a cancel to say: a cancel that defers never comes back, so deferring there
   * would mean never stopping at all.
   */
  backgroundWork(
    sessionId: string, workloadIds: readonly string[],
  ): Promise<SessionBackgroundWork> {
    return readSessionBackgroundWork(kv as unknown as HandsReadKv, sessionId, workloadIds);
  },
  /**
   * Every DAG the registry has a key for, readable or not.
   *
   * `listAll` goes through `scanPrefix`, which drops a row whose read came
   * back absent, tombstoned or empty -- correct for "what handles exist", and
   * wrong for "who might hold this workload", because a row dropped for an
   * unreadable read is exactly the row a stale replica produces. Anything that
   * has to leader-check every other DAG has to start from the keys, not from
   * the rows that survived being read.
   */
  async listDagRoots(): Promise<string[]> {
    const kv = kvDagHandles as unknown as KvLike;
    const iter = await kv.keys(`${HANDLE_MAP_PREFIX}.>`);
    const out: string[] = [];
    for await (const key of iter) {
      if (key.startsWith(`${HANDLE_MAP_PREFIX}.`)) out.push(key.slice(HANDLE_MAP_PREFIX.length + 1));
    }
    // `for await` completing is not the same as the enumeration being complete.
    // A connection that exhausts its reconnects and closes ends the iterator
    // the way exhaustion does -- no error, just fewer keys -- so a caller that
    // only checks for a throw reads a truncated list as the whole registry.
    // Here that means zero DAGs to leader-check and a stop issued over a
    // co-holder that was simply never delivered.
    //
    // This makes the failure loud. It does NOT make the enumeration verifiably
    // complete: a truncation that leaves the connection healthy would still
    // pass, and whether the server's consumer initialisation can drop a key is
    // unverified. The guarantee this guard needs is not available from a
    // registry keyed by DAG -- see the note on `otherDagHolding`.
    if (nc.isClosed()) {
      throw new Error("dag-handles enumeration ended on a closed connection");
    }
    return out;
  },
  /**
   * The same question as `listForDag`, asked of the stream leader.
   *
   * `kv.get` uses a direct read when the bucket allows one, and the client
   * documents those as possibly stale: on a multi-replica cluster a read can
   * land on a replica that has not yet seen a registration the writer already
   * had acknowledged. Everywhere else on this path that costs a retry or a
   * conservative `unconfirmed`. In one place it costs the answer -- the branch
   * that concludes a DAG holds nothing at all -- so that branch asks the
   * leader before saying so.
   */
  async listForDagConsistent(dagRootTaskId: string): Promise<Record<string, HandleInfo>> {
    const key = `${HANDLE_MAP_PREFIX}.${dagRootTaskId}`;
    let sm;
    try {
      sm = await jsm.streams.getMessage(`KV_${DAG_HANDLES_BUCKET}`, { last_by_subj: `$KV.${DAG_HANDLES_BUCKET}.${key}` });
    } catch (e) {
      if (isNoMessageFound(e)) return {};
      throw e;
    }
    if (!sm || sm.data.length === 0) return {};
    const parsed: unknown = JSON.parse(new TextDecoder().decode(sm.data));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`handle map entry ${key} is not a JSON object`);
    }
    const out: Record<string, HandleInfo> = {};
    for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const info = typeof raw === "string" ? { workload_id: raw } : raw;
      if (info && typeof info === "object") setHandleEntry(out, name, info as HandleInfo);
    }
    return out;
  },
};

/**
 * The record that survives a teardown, so a later call can tell "this DAG never
 * held anything" from "this DAG held something and letting go of it failed".
 *
 * Without it the second cancel of a DAG whose stop failed reads an empty handle
 * map -- emptied by the first cancel, before that stop was even attempted --
 * and reports `nothing_held`, which is the very inference this feature exists to
 * refuse, arriving through the back door. The same hole is reachable whenever
 * anything else got to the handles first: a concurrent cancel, the agent_done
 * path, or the sweeper.
 *
 * **It lives on the DAG root's `metadata`, not in the KV bucket beside the
 * handle map**, for three reasons that all point the same way:
 *
 *   - Lifetime. `BRAIN_REGISTRY` is short-lived coordination state with a
 *     bucket-wide TTL (`BRAIN_REGISTRY_TTL_MS`, five minutes by default, sized
 *     for `lock.<key>`). A leaked GPU outlives five minutes; evidence of one
 *     that expires on that schedule is evidence only for as long as nobody was
 *     going to look.
 *   - Concurrency. A JSON blob under one KV key is read-modify-write, and the
 *     adapter's `put` carries no revision, so two cancels racing lose a mark
 *     and the lost one is a workload reported as released. Each write here is
 *     one statement, atomic on the row, and merges rather than replaces.
 *   - Reach. `publicTaskRow` strips only the three credential fields, so
 *     anything on `metadata` is already readable through `GET /v1/tasks/:taskId`
 *     -- the caller can see *which* handle was not released and what workload it
 *     was, which is the part a `released: "unconfirmed"` alone cannot say.
 *
 * Written BEFORE the stop is attempted and cleared once a release for that
 * workload is established -- not written only on failure, which an earlier
 * version of this comment said. It is read when the handle map has nothing to
 * say, and again before a teardown that stopped everything it saw may answer
 * `confirmed`. A pre-write that FAILS stops THIS call's destroy; it is not
 * merely the next caller's problem. A pre-write that has nowhere to land is a
 * different fact and stops nothing -- see `NoRecordHome`.
 * A DAG whose handles were all released confirmed therefore leaves nothing
 * behind and answers `nothing_held` on a repeat call, which is accurate:
 * nothing is held and nothing escaped.
 */
/**
 * The key one outstanding entry is filed under: a digest, not a readable name.
 *
 * Two requirements meet here and only a digest satisfies both.
 *
 * Identity. A handle name is reused -- a rebuild registers a second workload
 * under the same name -- so keying by name alone lets one workload's outcome
 * overwrite or clear another's. An older stop succeeding and clearing a newer
 * one's failure is a confirmed release invented out of two unrelated events.
 * The key has to name the workload, not just the handle.
 *
 * Redaction. The record's whole point is to be readable through
 * `GET /v1/tasks/:taskId`, and `redactPublicJson` replaces the value under any
 * key that *contains a sensitive word* -- `isSensitiveKey` splits the key into
 * words and matches each. Handle names are chosen by whoever wrote the DAG, so
 * a DAG may legitimately declare one called `token` or `auth`, and any key
 * carrying that name as a word -- `token`, `w-1:token`, `handle_token` alike --
 * comes back `"[REDACTED]"`, taking the workload id with it. The caller is left
 * knowing a sandbox leaked and not which one, which is the half that mattered.
 *
 * So the key is `sha256(handle \0 workload)`, truncated: stable, unique per
 * workload instance, and made only of hex, which cannot spell any word the
 * redactor looks for. Both names live in the VALUE, where they are data --
 * `handle` and `workload_id` are not sensitive keys, which U8 pins.
 */
function entryKey(handleName: string, workloadId: string): string {
  return createHash("sha256")
    .update(`${handleName}\u0000${workloadId}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * There is nowhere for a record to live, which is not the same as failing to
 * write one.
 *
 * `mark` writes to the DAG root's `claw_tasks` row, and the record exists to
 * tell the NEXT reader of that row that a release was not established. A
 * statement that matched no row can mean two opposite things:
 *
 *   - the row is there and the write did not land. The evidence is missing
 *     while the thing it is evidence about is still reachable, so the mapping
 *     is the last reference and must not be dropped.
 *   - there is no row at all. Nobody will ever read a record about this DAG:
 *     `GET /v1/tasks/<id>` answers 404 and `unreleasedRecord.any` cannot read
 *     one either. Withholding the teardown protects no reader; it only leaves
 *     the workload running.
 *
 * Only the first is a reason to withhold. Conflating them made
 * `reapOrphanHandles` dead for its primary case: an orphan handle is BY
 * DEFINITION one whose DAG row no longer exists (`status = owner?.status ??
 * "missing"`), so every sweep of one hit this throw, took `false` back from
 * `rememberOutcome`, and issued no stop at all -- against a bucket created
 * with no TTL, so the dangling reference outlives Postgres and no later sweep
 * behaves any differently.
 *
 * The DAG-level answer for such a sweep stays `unconfirmed` all the same,
 * because `any` cannot read a row that is not there either. That is the same
 * conservative unknown every other unreadable thing on this path takes, and it
 * is a report: it withholds no stop and strands no workload.
 *
 * Still a throw, and still from `mark` alone. A caller that does not know the
 * difference sees an exception rather than a write that quietly succeeded, and
 * `clear` has no counterpart: a clear that matched no row means there is no
 * record to remove, which is the state it was asked to reach.
 */
export class NoRecordHome extends Error {}

export const unreleasedRecord = {
  async mark(dagRootTaskId: string, handleName: string, workloadId: string): Promise<void> {
    // Keyed on `task_id` alone. The predicate used to demand
    // `dag_node_id = '__dag_root__'`, which is not the owner row for every
    // handle: Brain registers under `dag_root_task_id ?? task_id`, so a
    // standalone task owns one under its own id and its `dag_node_id` is NULL.
    // For those the statement matched nothing, reported success, and the
    // mapping was then dropped on the strength of a record that does not
    // exist.
    // One statement, so two cancels racing cannot lose each other's mark the
    // way a read-then-write pair would. `||` merges at each level, so a sibling
    // key written between this statement's read and its write survives.
    const r = await db.query(
      `UPDATE claw_tasks
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'sandbox_release',
                COALESCE(metadata -> 'sandbox_release', '{}'::jsonb) || jsonb_build_object(
                  'unreleased',
                  COALESCE(metadata -> 'sandbox_release' -> 'unreleased', '{}'::jsonb)
                    || jsonb_build_object($2::text, $3::jsonb)
                ))
        WHERE task_id = $1`,
      [
        dagRootTaskId,
        entryKey(handleName, workloadId),
        JSON.stringify({
          handle: handleName,
          workload_id: workloadId,
          at: new Date().toISOString(),
        }),
      ],
    );
    // A write that matched no row is not a write. Silently succeeding here is
    // what lets `rememberOutcome` report a record that was never made, and the
    // caller then drops the mapping believing the evidence is safe.
    if ((r.rowCount ?? 0) === 0) {
      throw new NoRecordHome(`no task row ${dagRootTaskId} to record an unreleased handle on`);
    }
  },
  async clear(dagRootTaskId: string, handleName: string, workloadId: string): Promise<void> {
    await db.query(
      `UPDATE claw_tasks
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'sandbox_release',
                COALESCE(metadata -> 'sandbox_release', '{}'::jsonb) || jsonb_build_object(
                  'unreleased',
                  COALESCE(metadata -> 'sandbox_release' -> 'unreleased', '{}'::jsonb) - $2::text
                ))
        WHERE task_id = $1`,
      [dagRootTaskId, entryKey(handleName, workloadId)],
    );
  },
  async any(dagRootTaskId: string): Promise<boolean> {
    const r = await db.query(
      `SELECT COALESCE(metadata -> 'sandbox_release' -> 'unreleased', '{}'::jsonb)
                <> '{}'::jsonb AS outstanding
         FROM claw_tasks WHERE task_id = $1`,
      [dagRootTaskId],
    );
    // No root row is not "nothing outstanding": the row a mark would have been
    // written to is not there to be read, so this establishes nothing. The
    // caller turns that into `unconfirmed`, as it does every other unknown.
    if (r.rowCount === 0) throw new Error(`no dag root row for ${dagRootTaskId}`);
    return r.rows[0].outstanding === true;
  },
};

/**
 * What a caller is entitled to believe about a sandbox after a teardown ran.
 *
 * The three values are deliberately not a boolean. "the stop failed" and
 * "there was never anything to stop" both leave this task holding no handle,
 * yet mean opposite things to whoever is counting leaked GPUs -- in the first
 * a workload may well still be running -- and a caller that cannot tell them
 * apart is back where it started.
 *
 *   - `confirmed`   SaFE accepted the stop for every handle held (2xx, or a
 *                   404 saying it does not know the workload). Read
 *                   `safeStopWorkload` before leaning on this: SaFE's teardown
 *                   is asynchronous, so accepted is the strongest thing its API
 *                   can be asked, and it is weaker than "the GPU is free".
 *   - `unconfirmed` at least one handle's release was not established: a
 *                   non-2xx, a timeout, an unset `SAFE_API_URL`, a registry
 *                   that could not be read, or a handle this path cannot stop
 *                   at all.
 *   - `nothing_held` this DAG holds no handle and none is on record as having
 *                   escaped release. Nothing was leaked.
 *
 * `nothing_held` is deliberately NOT "the handle map is empty". The map is
 * emptied before the stop is attempted, so emptiness alone is consistent with a
 * release that failed on an earlier call; `unreleasedRecord` below is what keeps
 * those apart across calls.
 *
 * `unconfirmed` is the conservative answer and every uncertain case collapses
 * into it. It never means "definitely still running", nor "nothing is
 * running" -- only that this side did not establish the release.
 */
export type ReleaseOutcome = "confirmed" | "unconfirmed" | "nothing_held";

/**
 * Stop one SaFE workload and say whether SaFE accepted the stop.
 *
 * Every branch that used to `return` after a `logger.warn` now answers
 * `unconfirmed` instead, which is the point: the logging was already correct,
 * it just went somewhere no caller could read. Failure is still not thrown --
 * cleanup must not fail the cancellation that triggered it.
 *
 * A 404 counts as `confirmed`. SaFE does not know the workload, which is the
 * state the stop was reaching for.
 *
 * ## What `confirmed` does and does not establish
 *
 * It establishes that SaFE accepted the stop, which is the strongest thing this
 * API can be asked. It does NOT establish that the GPU is free at that instant,
 * and the difference is real rather than pedantic: `stopWorkload` sets the
 * Workload's phase and issues a Kubernetes delete, then returns, while the
 * job-manager tears the data-plane objects down afterwards -- requeuing every
 * 10s for as long as any remain and only then dropping `WorkloadFinalizer`. So
 * a 200 and a Pod still holding a GPU coexist on any normal controller latency.
 *
 * A round of review tried to close that gap here, by following an accepted stop
 * with a `GET /api/v1/workloads/<id>` and confirming only on a 404. That does
 * not work, and the reason is recorded so it is not tried again: the
 * apiserver's read is **database-backed**, not etcd-backed. `GetWorkload`
 * filters on `is_deleted = false`, and the stop path writes
 * `SetWorkloadStopped` -- phase, end_time, deletion_time -- and never
 * `is_deleted`. The read therefore answers 200 for a workload that stopped
 * perfectly normally, so wiring it in would have reported `unconfirmed` for
 * every successful cancellation in the fleet. A field that cries wolf
 * constantly is worse than the silence it replaces: the one real failure
 * becomes indistinguishable from the noise.
 *
 * The finalizer state that would actually answer the question lives on the CR
 * in etcd and no endpoint Claw can reach exposes it. Closing this properly
 * needs a data-plane-completion signal from SaFE. Until there is one,
 * `confirmed` means accepted, says so wherever it is documented, and the
 * failures it now surfaces -- a refused stop, a timeout, an unreachable SaFE,
 * an unconfigured one -- are exactly the ones that were silently dropped
 * before, which is what this change was asked for.
 */
async function safeStopWorkload(
  workloadId: string,
  platformKey: string,
): Promise<ReleaseOutcome> {
  // Defensive, and no longer the only guard: stopSandboxByHandle answers the
  // empty-workload-id case before reaching here, because it is the one caller
  // that can tell an unstoppable handle from an absent one. Kept so a future
  // caller cannot turn "no id to call with" into a silent success.
  if (!workloadId) return "unconfirmed";
  if (!SAFE_API_URL) {
    logger.warn({ workloadId }, "safe.stop_skipped_no_url");
    return "unconfirmed";
  }
  try {
    const resp = await fetch(`${SAFE_API_URL}/api/v1/workloads/${workloadId}/stop`, {
      method: "POST",
      headers: platformKey ? { Authorization: `Bearer ${platformKey}` } : {},
      signal: AbortSignal.timeout(SAFE_STOP_TIMEOUT_MS),
    });
    if (!resp.ok && resp.status !== 404) {
      const body = await resp.text();
      logger.warn({ workloadId, status: resp.status, body: body.slice(0, 200) }, "safe.stop_failed");
      return "unconfirmed";
    }
    return "confirmed";
  } catch (e) {
    logger.warn({ workloadId, err: errText(e) }, "safe.stop_exception");
    return "unconfirmed";
  }
}

async function loadPlatformKeyForSession(sessionId: string): Promise<string> {
  const r = await db.query(`SELECT config FROM claw_sessions WHERE session_id = $1`, [sessionId]);
  if (r.rowCount === 0) return "";
  return readTrustedSessionCredentials(r.rows[0].config).platformKey;
}

/**
 * Destroy one handle's mapping and stop the workload behind it, reporting
 * which of the two actually happened.
 *
 * The ordering below is load-bearing and is the reason this function has to
 * return anything at all: when `destroy` does run it runs BEFORE the stop, so a
 * stop that then fails leaves the mapping already gone. **An empty handle map
 * is evidence the attempt was made, not that it worked** -- nothing downstream
 * may infer release from it, which is why an outcome short of `confirmed` is
 * also written to `unreleasedRecord` before it is returned. The return value
 * answers this call; the record answers the next one.
 *
 * Which makes the order of the whole function one rule: read everything that
 * could forbid a stop before writing anything down, because a branch that
 * declines after the record is written leaves a leak report nothing will ever
 * clear. So the claims come first (retention, another DAG), then the record,
 * then the destroy, then the stop.
 *
 * `destroy` distinguishes two falsy results and so does this:
 *   - `null`  -- from the LOOKUP, this DAG holds no handle of that name:
 *                `nothing_held`. From the DESTROY it means something else:
 *                either the handle went while this call was deciding, or it
 *                is still there naming a DIFFERENT workload than the one
 *                recorded, which the identity check refuses to remove. Both
 *                answer `unconfirmed`, because in neither case did this call
 *                release what it set out to. Neither consults the record --
 *                the DAG-level aggregate does that, and folds a per-handle
 *                `nothing_held` into `unconfirmed` for a DAG that held
 *                anything.
 *   - `""`    -- a handle was registered with no SaFE workload id behind it.
 *                agent-sandbox handles are written this way (see Brain's
 *                ensureHands), and this path has never had a way to stop one.
 *                Something is held and this code did not release it, so the
 *                honest answer is `unconfirmed`, not `nothing_held` -- and the
 *                mapping stays, because it is the only reference to a sandbox
 *                nothing here can stop. That case never reaches `destroy` now,
 *                so this is the answer the LOOKUP gives.
 *
 * Nothing thrown from here escapes. A registry that will not answer, a session
 * whose credentials cannot be read, a KV write that fails -- each is a reason
 * this call established nothing, which is what `unconfirmed` says, and none is
 * a reason to abandon the remaining handles or to fail a cancellation whose
 * verdict is already written. That containment lives here rather than at the
 * caller so every entry point gets it: the cancel route, the agent_done path,
 * and the sweeper.
 */
export async function stopSandboxByHandle(
  dagRootTaskId: string,
  handleName: string,
  sessionId: string,
): Promise<ReleaseOutcome> {
  // Read before destroying, and record before destroying, because `destroy` is
  // the point of no return: it drops the mapping, and anything not written
  // down by then cannot be recovered from anywhere. Between the drop and the
  // first write there used to be a window in which the handle existed in
  // neither place, and a concurrent cancel landing in it read an empty map and
  // an empty record and answered `nothing_held` for a workload still running.
  // A process dying in that window left the same state permanently.
  //
  // The cost is one extra KV read per handle, on a path that is already making
  // an HTTP call to SaFE. The lookup failing is itself an unknown: it may mean
  // no such handle, and it may mean an unreachable bucket, so it does not get
  // to be `nothing_held`.
  let known: HandleInfo | null;
  try {
    known = await handleRegistry.lookup(dagRootTaskId, handleName);
  } catch (e) {
    logger.warn(
      { dagRootTaskId, handleName, err: errText(e) },
      "sandbox.handle_lookup_failed",
    );
    return "unconfirmed";
  }
  if (known === null) {
    // Missing on a direct read is not the same as never registered: it may be
    // a replica behind an acknowledged write, an old tombstone, or a mapping an
    // earlier failed teardown removed while leaving its record behind. The DAG
    // aggregate folds this into `unconfirmed` and `agent_done` discards it, so
    // nothing external reads it today -- but it is the same terminal-answer-on
    // -an-empty-read shape as the two branches above, and the next caller to
    // use this return value would inherit it.
    try {
      const authoritative = await handleRegistry.listForDagConsistent(dagRootTaskId);
      if (Object.prototype.hasOwnProperty.call(authoritative, handleName)) return "unconfirmed";
      return (await unreleasedRecord.any(dagRootTaskId)) ? "unconfirmed" : "nothing_held";
    } catch (e) {
      logger.warn(
        { dagRootTaskId, handleName, err: errText(e) },
        "sandbox.handle_lookup_failed",
      );
      return "unconfirmed";
    }
  }
  if (!known.workload_id) {
    // agent-sandbox handles are registered with `workload_id: ""` (Brain's
    // ensureHands), and this path has never had a way to stop one. Something
    // IS held and this code cannot release it, so `nothing_held` would assert
    // the opposite of what is true.
    //
    // The mapping is KEPT and no record is written, which is the opposite of
    // what this branch used to do. A record written here can never be
    // discharged: `clear` runs only for a CONFIRMED stop of the workload the
    // record names, the workload it names is the empty string, and no call
    // reaching this branch can ever stop that -- not this one and not a later
    // one. So the DAG answered `unconfirmed` for the rest of its life, long
    // after the sandbox was gone, and said nothing anybody could act on: the
    // entry's `workload_id` is "". That is a latch, not evidence.
    //
    // Keeping the handle states the same true thing without latching it. The
    // next caller reads a NON-empty map and so cannot answer `nothing_held`,
    // which is the one property the record was here to provide; a rebuild
    // writes over the entry under the same name (Brain's `replaceDagHandle`)
    // instead of adding a second piece of evidence beside the first; and the
    // reference disappears when whoever owns an agent-sandbox lets go of it.
    // Nothing on this side can, which is exactly why this side must not swap a
    // live reference for a note nobody can retract.
    //
    // What it costs is a row that outlives its DAG when nothing ever frees the
    // handle: the sweeper reaches that DAG each tick, declines again, and
    // counts it unreleased. That is the visible cost, and it is the one to
    // pay, because the alternative -- now that an orphan sweep really does
    // destroy mappings (see `NoRecordHome`) -- is dropping the last reference
    // to a sandbox this process cannot stop.
    logger.warn({ dagRootTaskId, handleName }, "sandbox.stop_unsupported_handle");
    return "unconfirmed";
  }

  // The two claims that forbid a stop are settled BEFORE anything is written
  // down and before the mapping is dropped.
  //
  // They used to be read after both, and neither branch cleaned up after
  // itself: the mark is written before the destroy, a retained or shared
  // workload returns without clearing it, and nothing revisits a handle that
  // is no longer in the map. So a container retention was legitimately
  // protecting, and a workload a second DAG legitimately holds, each left a
  // permanent `unreleased` entry on the DAG root -- a leak reported for a
  // sandbox that never leaked. A check that FAILED left the same mark for the
  // same reason. The record is evidence about a release this side did not
  // establish; neither of these is that, and an entry nothing will ever clear
  // is worse than no entry at all, because the field stops meaning anything.
  //
  // Asked about the workload the lookup named, which is the workload the
  // destroy below is bound to, so moving the reads earlier cannot change which
  // workload they answer about. `otherDagHolding` skips this DAG's own row by
  // id and never counted this DAG's entry, so it is unaffected by that entry
  // still being there when it runs. Neither check reads the record, so nothing
  // here depends on the mark having been written first.
  let heldElsewhere: string | null;
  try {
    heldElsewhere = await withDeadline(
      otherDagHolding(dagRootTaskId, known.workload_id),
      SHARED_CHECK_TIMEOUT_MS,
      `shared-holder check for ${known.workload_id}`,
    );
  } catch (e) {
    logger.warn(
      { dagRootTaskId, handleName, workloadId: known.workload_id, err: errText(e) },
      "sandbox.shared_check_failed",
    );
    return "unconfirmed";
  }
  // Retention is a claim too, and an older one than this handle.
  //
  // Handing a container to the retention store is how Brain keeps a sandbox
  // alive for background work its DAG has finished with, and that hand-over
  // frees the handle itself. A handle still naming a retained container means
  // only that the free did not land -- and whether a stop happens must not
  // depend on that. With the free landed, this cancel would never have seen the
  // workload at all; a failed bookkeeping write cannot be what shortens a
  // protected container's life.
  let retained: boolean;
  try {
    retained = await withDeadline(
      handleRegistry.retained(known.workload_id),
      SHARED_CHECK_TIMEOUT_MS,
      `retention check for ${known.workload_id}`,
    );
  } catch (e) {
    logger.warn(
      { dagRootTaskId, handleName, workloadId: known.workload_id, err: errText(e) },
      "sandbox.retention_check_failed",
    );
    return "unconfirmed";
  }
  if (retained) {
    logger.info(
      { dagRootTaskId, handleName, workloadId: known.workload_id },
      "sandbox.stop_skipped_retained",
    );
  } else if (heldElsewhere) {
    // Not a failure and not a release: this DAG has let go, and the workload
    // is still legitimately held. `unconfirmed` because nothing here
    // established that it is gone -- it demonstrably is not.
    logger.info(
      { dagRootTaskId, handleName, workloadId: known.workload_id, alsoHeldBy: heldElsewhere },
      "sandbox.stop_skipped_shared",
    );
  }
  // Set when the decline branch below has already removed this DAG's row, so
  // the code after it must neither destroy again nor behave as though the
  // mapping were still there to fall back on.
  let ownRowGone = false;
  if (retained || heldElsewhere) {
    // The mapping still goes, as it did when these checks ran after it: this
    // DAG is done with the workload either way. Dropping it with nothing
    // recorded is safe here and only here, because the rule it bends -- record
    // first, the mapping is the last reference -- is about a workload nobody
    // else is holding. Here somebody else is, by the very read that got us to
    // this branch: the retention ledger, or the other DAG's own handle.
    try {
      // `null` is not "removed": the entry was already gone, or it now names a
      // DIFFERENT workload and the identity check refused to remove it. In
      // neither case did THIS call drop a reference to the workload it looked
      // up, so it has not earned the right to re-ask -- whoever did remove the
      // row owns that question, and answering it from here would promote a
      // caller that took nothing away.
      ownRowGone = await handleRegistry.destroy(
        dagRootTaskId, handleName, known.workload_id,
      ) !== null;
    } catch (e) {
      logger.warn(
        { dagRootTaskId, handleName, workloadId: known.workload_id, err: errText(e) },
        "sandbox.handle_destroy_failed",
      );
    }
    // A retention is an older claim than this handle, not a race: nothing this
    // call does can discharge it, so there is nothing to re-ask. And a destroy
    // that did not commit leaves the mapping as the reference it always was,
    // which is the state every other declining exit relies on.
    if (retained || !ownRowGone) return "unconfirmed";

    // Otherwise the co-holder that sent us here may be releasing the SAME
    // workload at the same moment, and that is not a rare interleaving -- it
    // is what session reuse plus two entry points produces. Every read on this
    // path precedes every write:
    //
    //   t1  A reads the registry, sees dag-b naming w   -> heldElsewhere
    //   t2  B reads the registry, sees dag-a naming w   -> heldElsewhere
    //   t3  A drops dag-a's row, records nothing, declines
    //   t4  B drops dag-b's row, records nothing, declines
    //
    // The read that means "do not destroy" is about a DIFFERENT KEY than the
    // write that removes the last reference -- the registry is keyed by DAG,
    // the question is keyed by workload -- so no per-row CAS can order t1
    // against t4, and `destroyHandleCas` conditions on `dag-handles.<dagRoot>`,
    // a key the other side never touches. The branch's own justification
    // ("somebody else is holding it") is true at t1 and false at t4, and
    // before this re-check nothing re-established it in between. What came out
    // was a live SaFE workload with every reference to it deleted: both rows
    // gone, no record on either DAG, `stopAllHandlesForDag` answering
    // `nothing_held`, and `reapOrphanHandles` -- which starts from
    // `listAll()`, the mappings -- with no entry point left to find it from.
    //
    // This is what the ordering before this branch got for free and gave up.
    // With the checks AFTER the destroy, "both decline" required
    // A.destroy < A.read(B) < B.destroy < B.read(A) < A.destroy: a cycle, and
    // impossible. Moving them ahead of the destroy bought something real --
    // a legitimately shared or retained decline no longer leaves a permanent
    // `unreleased` marker on a container that never leaked -- and turned that
    // impossible interleaving into the ordinary one. So the decision follows
    // the act again here rather than the checks moving back: re-asked now that
    // THIS row is gone, whichever side removes its row last sees an empty
    // answer and is the last holder, and both sides seeing a holder is the
    // cycle again. The mutual-decline signature in the logs is two
    // `sandbox.stop_skipped_shared` lines naming each other.
    //
    // A raced release therefore issues the stop from BOTH sides. That is
    // deliberate: the module's own contract is that the KV destroy and the
    // SaFE stop are idempotent (a 404 counts as confirmed), and two idempotent
    // stops are strictly better than none.
    //
    // Leader-only -- see `OwnershipQuestion` for why a direct read must not
    // answer this one, and for what that costs.
    let stillHeld: string | null;
    try {
      stillHeld = await withDeadline(
        otherDagHolding(dagRootTaskId, known.workload_id, "after-own-row-gone"),
        SHARED_CHECK_TIMEOUT_MS,
        `last-holder re-check for ${known.workload_id}`,
      );
    } catch (e) {
      // The one declining exit with no mapping left to be its own evidence.
      // Everywhere else a check that fails keeps the handle registered and the
      // sweeper comes back to it; here the row is already gone, so `unreleased`
      // is the only place this workload can still be named. Not a false alarm
      // either: this call really did drop a reference without establishing
      // that anything else still holds one, which is precisely what the record
      // means. (`rememberOutcome` contains its own failures, and answers
      // `NoRecordHome` -- no DAG row, so no reader -- by reporting success.)
      logger.warn(
        { dagRootTaskId, handleName, workloadId: known.workload_id, err: errText(e) },
        "sandbox.last_holder_recheck_failed",
      );
      await rememberOutcome(dagRootTaskId, handleName, known.workload_id, "unconfirmed");
      return "unconfirmed";
    }
    if (stillHeld !== null) {
      // The ordinary shared release, and the property the ordering move bought:
      // it declines, and it leaves nothing behind to report.
      return "unconfirmed";
    }
    logger.info(
      { dagRootTaskId, handleName, workloadId: known.workload_id, wasHeldBy: heldElsewhere },
      "sandbox.last_holder_after_recheck",
    );
  }

  // On record first, so the window below is one this can be recovered from
  // rather than one that loses the handle. Cleared by a release that lands.
  //
  // And if that write did not land, the mapping stays. Recording first is only
  // protection if the destroy is conditional on it having worked: writing the
  // evidence, swallowing the failure, and dropping the mapping anyway loses the
  // handle exactly as completely as not recording at all -- a concurrent cancel
  // then reads an empty map and an empty record and answers `nothing_held`.
  // Keeping the mapping costs a sandbox that stays registered until something
  // retries, which the sweeper does; the alternative costs the only reference
  // to it. (The cancellation's own verdict is already written and unaffected --
  // this returns, it does not throw.)
  const recorded = await rememberOutcome(
    dagRootTaskId, handleName, known.workload_id, "unconfirmed",
  );
  if (!recorded && !ownRowGone) {
    logger.warn(
      { dagRootTaskId, handleName, workloadId: known.workload_id },
      "sandbox.teardown_skipped_unrecorded",
    );
    return "unconfirmed";
  }
  if (!recorded) {
    // Promoted to last holder by the re-check above, so the mapping this gate
    // exists to preserve is ALREADY gone. Withholding the stop now buys
    // nothing and costs everything -- the same reasoning `NoRecordHome` gives
    // one level down: with no reference left to protect, refusing to act just
    // leaves the workload running with nothing naming it at all. So the stop
    // goes ahead unrecorded, and this line is its only trace.
    logger.warn(
      { dagRootTaskId, handleName, workloadId: known.workload_id },
      "sandbox.teardown_unrecorded_row_already_gone",
    );
  }

  let wid: string | null;
  try {
    // Already destroyed by the decline branch when the re-check promoted this
    // call to last holder: the row is gone and its workload is the one the
    // lookup named, so asking again would answer `null` -- "the handle went
    // between the lookup and the destroy" -- and abandon the stop this call
    // was just established to owe.
    wid = ownRowGone
      ? known.workload_id
      : await handleRegistry.destroy(dagRootTaskId, handleName, known.workload_id);
  } catch (e) {
    // The delete may or may not have committed, and the stop was not attempted
    // either way. Both possibilities are already on record above, which is the
    // point of writing it first.
    logger.warn(
      { dagRootTaskId, handleName, workloadId: known.workload_id, err: errText(e) },
      "sandbox.handle_destroy_failed",
    );
    return "unconfirmed";
  }
  if (wid === null) {
    // Two ways to get here and neither is a release. The handle went between
    // the lookup and the destroy, or it is still there naming a DIFFERENT
    // workload than the one recorded -- the identity check refuses to remove
    // that one. Either way this call established nothing, and the mark written
    // above stays.
    //
    // A previous round retracted it, reasoning that the winner keeps their own
    // record. They do not: both callers derive the same key from the same
    // (handle, workload) pair, so there is one record, and clearing it here
    // deletes the winner's evidence when their stop failed. That turns an
    // unreleased workload into `nothing_held` -- precisely the answer this
    // whole change exists to stop inventing -- so the retraction was a worse
    // bug than the one it fixed, and is gone.
    //
    // What it leaves is the cost that motivated it: when the winner's stop
    // DID land, they clear the shared record and this mark is already gone
    // with it, so the common case self-heals. The case that does not is a
    // winner who cleared before this mark was written, leaving a standing
    // `unconfirmed` on a DAG that is fine. That is a false alarm, which is
    // visible and checkable; the alternative was a false clear, which is not.
    return "unconfirmed";
  }

  // A workload two DAGs hold, or one retention is protecting, was settled
  // above: both are claims that forbid a stop, and both are read before the
  // mapping is dropped so that declining leaves nothing behind. What remains
  // here is a workload this DAG held alone -- either it never had a co-holder,
  // or the re-check above found the co-holder had let go first and promoted
  // this call to last holder, in which case `ownRowGone` is already true and
  // the destroy below has happened.
  let released: ReleaseOutcome;
  try {
    const platformKey = await loadPlatformKeyForSession(sessionId);
    released = await safeStopWorkload(wid, platformKey);
  } catch (e) {
    // Reaching the credentials is part of issuing the stop; failing to is a
    // stop that did not happen, not an error for the cancel to raise.
    logger.warn(
      { dagRootTaskId, handleName, workloadId: wid, err: errText(e) },
      "sandbox.stop_precondition_failed",
    );
    released = "unconfirmed";
  }

  logger.info({ dagRootTaskId, handleName, workloadId: wid, released }, "sandbox.destroyed");
  await rememberOutcome(dagRootTaskId, handleName, wid, released);
  return released;
}

/**
 * Keep or drop this handle's entry in the record, without letting the
 * bookkeeping decide the answer.
 *
 * A failed write is reported, not thrown, and it is not inconsequential: the
 * pre-stop write returning `false` stops THIS call from destroying the
 * mapping, which is the point of writing first -- the mapping is the last
 * reference once the record is gone. Reporting rather than throwing keeps the
 * outcome this call did establish from being discarded along with it.
 *
 * `true` therefore means "the teardown may proceed", which is a different
 * claim from "a record was written", and the two part company in exactly one
 * place: `NoRecordHome`, where the DAG root row is gone. See the class -- with
 * no row there is no reader, so there is nothing for a record to protect and
 * nothing for withholding the stop to buy.
 */
async function rememberOutcome(
  dagRootTaskId: string,
  handleName: string,
  workloadId: string,
  released: ReleaseOutcome,
): Promise<boolean> {
  try {
    // Cleared by identity: this release confirms THIS workload, and says
    // nothing about another one a rebuild registered under the same name.
    if (released === "confirmed") {
      await unreleasedRecord.clear(dagRootTaskId, handleName, workloadId);
    } else {
      await unreleasedRecord.mark(dagRootTaskId, handleName, workloadId);
    }
    return true;
  } catch (e) {
    if (e instanceof NoRecordHome) {
      // Nowhere to file it, and so nobody to file it for. This is the orphan
      // the sweeper exists to reap: its DAG row is gone, which is what makes
      // it an orphan, and refusing to act on that would leave the workload
      // running with its only reference in a bucket that never expires.
      //
      // Not folded into the `false` below and not made silent: the teardown
      // goes ahead, and this line is the only trace that it went ahead on a
      // DAG that can no longer report anything about itself.
      logger.warn(
        { dagRootTaskId, handleName, workloadId, released },
        "sandbox.unreleased_record_no_row",
      );
      return true;
    }
    // Contained here so the caller can decide: `false` is how it learns not to
    // drop the mapping.
    //
    // `workloadId` deliberately: this warning is the only trace of a handle
    // whose record was not written, and without the id an operator has to
    // correlate it against a separate `sandbox.destroyed` line to learn which
    // workload to go and look for.
    logger.warn(
      { dagRootTaskId, handleName, workloadId, released, err: errText(e) },
      "sandbox.unreleased_record_write_failed",
    );
    return false;
  }
}

/**
 * The first non-null answer `probe` gives for any of `items`, with at most
 * `REGISTRY_READ_CONCURRENCY` probes in flight.
 *
 * "First" is first to answer, not first in `items`. Both callers ask a yes/no
 * question -- is there any holder at all -- and which of several holders is
 * named reaches a log field and nothing else.
 *
 * A probe that rejects rejects the whole call, deliberately: that is what
 * keeps a registry that cannot be read an unknown instead of a "nobody", which
 * is the one answer on this path that must never be invented. Each worker
 * stops at its own first rejection, so a registry that is failing outright
 * costs at most one read per worker rather than one per item, and every
 * rejection is settled by the `Promise.all` -- a sibling failing after the
 * first cannot surface as an unhandled rejection. Probes already in flight are
 * not cancelled: there is nothing to cancel a KV read with here, so this
 * bounds what the caller waits for, exactly as `withDeadline` does.
 */
async function firstAnswer<T, R>(
  items: readonly T[],
  probe: (item: T) => Promise<R | null>,
): Promise<R | null> {
  let next = 0;
  let found: R | null = null;
  const worker = async (): Promise<void> => {
    while (found === null) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const answer = await probe(items[index] as T);
      if (answer !== null && found === null) found = answer;
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(REGISTRY_READ_CONCURRENCY, items.length) }, worker),
  );
  return found;
}

/**
 * Reject if `work` has not settled within `ms`.
 *
 * The underlying operation is not cancelled -- there is nothing to cancel an
 * in-flight ordered consumer with here -- so this bounds what the CALLER waits
 * for, not what the cluster does. That is the property needed: a cancel must
 * not be held open by a registry scan, whatever the scan goes on doing.
 */
function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
      // Never hold the process open for this timer alone.
      timer.unref?.();
    }),
  ]);
}

/**
 * Which question this scan is being asked, because the two take opposite
 * answers from the same stale read.
 *
 * `"before-release"` is the check that PERMITS a stop: this DAG still holds
 * the workload, and a direct read showing somebody else holding it too is
 * conservative -- it declines.
 *
 * `"after-own-row-gone"` is the re-check that promotes a declining caller to
 * last holder once its own row is already destroyed. On that question a stale
 * direct read is the opposite of conservative: the row it shows may be the
 * co-holder's own row, deleted microseconds ago by the release that is racing
 * this one, and believing it is exactly how both sides decline and the
 * workload is lost. So that mode takes no answer from a direct read -- it
 * harvests CANDIDATES from the direct scan and settles every one of them
 * against the leader.
 *
 * What that costs, stated rather than glossed: the shipped "nobody holds it"
 * is an intersection -- the direct scan found nobody AND the leader scan found
 * nobody -- and this mode drops the first half. Its "nobody" therefore rests
 * on leader reads alone, which is strictly less conservative. What it does NOT
 * drop is the enumeration: the direct scan's keys are unioned into the set of
 * DAGs to leader-read, so a root that `listDagRoots`'s own `kv.keys()` call
 * silently truncated away (see its comment -- "this does NOT make the
 * enumeration verifiably complete") is still leader-read if either
 * enumeration saw it. The weakening is confined to the one thing that has to
 * weaken: a row's CONTENT read from a possibly-stale replica no longer gets to
 * answer on its own.
 */
type OwnershipQuestion = "before-release" | "after-own-row-gone";

/**
 * The first other DAG whose handles still name `workloadId`, or null.
 *
 * Only DAGs other than this one: this DAG's own entry is removed before the
 * stop, so its absence here is expected and its presence would be a stale read
 * rather than a second holder.
 */
async function otherDagHolding(
  dagRootTaskId: string,
  workloadId: string,
  question: OwnershipQuestion = "before-release",
): Promise<string | null> {
  if (!workloadId) return null;
  const rows = await handleRegistry.listAll();

  // A holder found on a direct read is enough: a stale read that SHOWS one
  // only makes this more conservative, and conservative here means declining
  // to stop. Not on the re-check -- see `OwnershipQuestion`, where the same
  // stale read is the lost stop rather than a careful one.
  if (question === "before-release") {
    for (const [dagRoot, handles] of rows) {
      if (dagRoot === dagRootTaskId) continue;
      for (const info of Object.values(handles)) {
        if (info.workload_id === workloadId) return dagRoot;
      }
    }
  }

  // Finding none is the load-bearing answer -- it is what permits a stop -- and
  // the scan under it is direct reads, which may be behind a registration that
  // was already acknowledged. So before concluding nobody else holds this
  // workload, every other DAG is re-read from the leader.
  //
  // From the KEYS, not from the rows above. `scanPrefix` drops a row whose read
  // came back absent, tombstoned or empty, which is precisely what a stale
  // replica produces -- so a co-holder can vanish from `rows` before any
  // re-check sees it, and iterating `rows` would leader-check everything except
  // the DAG that needed it.
  //
  // This is the expensive path and it runs whenever a stop is about to be
  // issued. It is accepted rather than optimised because of what the two wrong
  // answers cost: a missed holder stops a sandbox another DAG is running on,
  // while the cost here is leader reads on a path that runs at teardown. A
  // **This scan cannot be made fully correct, and should be replaced rather
  // than hardened further.** It asks "who holds this workload" of a registry
  // keyed by DAG, so the answer is assembled from an enumeration plus a read
  // per entry, and every layer of that can be incomplete in a way that reads
  // as "nobody". Two rounds of review have each found another such layer.
  //
  // A third is not incompleteness at all, and is the reason for the
  // `"after-own-row-gone"` mode: the scan's answer is not atomic with the
  // write it authorises. Two callers releasing the same workload each read a
  // holder and each then remove the row the other one read, so a correct
  // answer to a question asked about one key licences a write to another. No
  // amount of hardening the read fixes that, because the flaw is that the read
  // and the write are about different keys. The re-check closes the
  // reproduced interleaving; it does not close the class.
  //
  // The shape that answers it directly is ownership keyed BY WORKLOAD, with
  // holders and state in one transactional record -- the existing Postgres row
  // plus a holders table, coordinated under a workload row lock, so acquiring,
  // releasing and last-holder-exits are decided in one place rather than
  // inferred from a scan. A reverse index maintained by double-write, or a
  // co-holder array on each DAG entry, only moves the missing window.
  //
  // Until then this is conservative in the direction that matters: it declines
  // to stop when it cannot establish sole ownership, and an enumeration that
  // ends on a closed connection raises rather than reading as empty.
  //
  // In parallel, which is the difference between a check that gets slower as
  // the registry grows and one that stops working at a size nothing announces.
  // One leader read per other DAG, issued serially, is linear in a bucket
  // created with `ttl: 0` whose rows are removed only by the teardown paths --
  // and one of those, the orphan sweep, was itself unable to remove any (see
  // `NoRecordHome`), so the thing the scan walks was the thing that grew. Past
  // `SHARED_CHECK_TIMEOUT_MS` the deadline expires, every cancel declines, and
  // each handle adds that ceiling to the cancel's own latency.
  //
  // The set read is unchanged and so is the answer: every other DAG is still
  // leader-read before a stop is permitted, and a read that fails still
  // rejects rather than counting as "nobody". Raising the ceiling instead was
  // considered and rejected where the ceiling is defined.
  // Two enumerations of the same bucket, unioned rather than chosen between.
  // `listDagRoots` is the authoritative one and stays the reason this is
  // correct; `rows` is already in hand, and both go through a separate
  // `kv.keys()` call whose truncation mode is silent, so a key missing from
  // one is still leader-read if the other saw it. On the `"before-release"`
  // question this adds nothing the loop above did not already cover; on the
  // re-check it is the half that keeps the enumeration no weaker than the
  // shipped check's.
  const candidates = new Set(await handleRegistry.listDagRoots());
  for (const [dagRoot] of rows) candidates.add(dagRoot);
  const others = [...candidates].filter((dagRoot) => dagRoot !== dagRootTaskId);
  return await firstAnswer(others, async (dagRoot) => {
    const authoritative = await handleRegistry.listForDagConsistent(dagRoot);
    for (const info of Object.values(authoritative)) {
      if (info.workload_id === workloadId) return dagRoot;
    }
    return null;
  });
}

/**
 * Tear down every handle currently registered for the given DAG and aggregate
 * what that established.
 *
 * `confirmed` requires every handle to be confirmed, so one failing stop in a
 * DAG of many cannot be averaged away by its neighbours. A per-handle
 * `nothing_held` inside a DAG that did hold handles is also not confirmation:
 * it means the entry vanished between the snapshot and the destroy, so some
 * other destroyer took it and this call cannot vouch for what that one did.
 *
 * An empty snapshot is the case that needs the record rather than the map. It
 * is reached by a DAG that never held a handle and by one whose handles some
 * earlier call already removed -- including a first cancel whose stop failed --
 * and the map cannot tell those apart by construction. So `nothing_held` is
 * answered only when the record also has nothing outstanding, and a registry
 * that cannot be read answers neither.
 */


export async function stopAllHandlesForDag(
  dagRootTaskId: string,
  sessionId: string,
): Promise<ReleaseOutcome> {
  let handles: string[];
  try {
    handles = Object.keys(await handleRegistry.listForDag(dagRootTaskId));
  } catch (e) {
    logger.warn(
      { dagRootTaskId, err: errText(e) },
      "sandbox.handle_list_failed",
    );
    return "unconfirmed";
  }

  if (handles.length === 0) {
    // An empty snapshot is the one reading that decides an answer rather than
    // bounding one, so it is confirmed against the leader before being
    // believed. A direct read may be behind a registration the writer already
    // had acknowledged, and answering `nothing_held` on that is a workload
    // reported released with no stop ever issued.
    try {
      const authoritative = Object.keys(await handleRegistry.listForDagConsistent(dagRootTaskId));
      if (authoritative.length > 0) {
        logger.warn(
          { dagRootTaskId, handles: authoritative },
          "sandbox.stale_empty_handle_read",
        );
        return "unconfirmed";
      }
    } catch (e) {
      logger.warn({ dagRootTaskId, err: errText(e) }, "sandbox.handle_list_failed");
      return "unconfirmed";
    }
    try {
      return (await unreleasedRecord.any(dagRootTaskId)) ? "unconfirmed" : "nothing_held";
    } catch (e) {
      logger.warn(
        { dagRootTaskId, err: errText(e) },
        "sandbox.unreleased_record_read_failed",
      );
      return "unconfirmed";
    }
  }

  let allConfirmed = true;
  for (const handle of handles) {
    const released = await stopSandboxByHandle(dagRootTaskId, handle, sessionId);
    if (released !== "confirmed") allConfirmed = false;
  }
  if (!allConfirmed) return "unconfirmed";

  // Re-read, because the snapshot this loop walked is not the DAG. A handle
  // registered while the loop ran -- a rebuild, or a node that started after
  // the snapshot -- is a live sandbox this call neither stopped nor counted,
  // and the interrupt that would have stopped the work is not published until
  // after this returns. Confirming over the top of it is the same mistake as
  // confirming over an empty map, one step later.
  //
  // Only reached when every handle confirmed, so a handle the loop DECLINED to
  // release -- one naming no workload this path can stop -- never gets here;
  // it answered `unconfirmed` and the aggregate returned above. What is left
  // here really is a handle that arrived after the snapshot.
  //
  // This does not establish that provisioning has finished: a workload exists
  // before its handle is registered, so an empty re-read is not proof of
  // quiescence. It is a bound on what this call may claim, not a fix for the
  // race, and the race is recorded in the PR as needing cancel/provisioning
  // coordination that does not exist yet.
  try {
    const left = Object.keys(await handleRegistry.listForDag(dagRootTaskId));
    if (left.length > 0) {
      logger.warn(
        { dagRootTaskId, handles: left },
        "sandbox.handles_registered_during_teardown",
      );
      return "unconfirmed";
    }
    // Empty here is final too -- it is what lets this call answer `confirmed`
    // -- so it gets the same leader confirmation the `nothing_held` branch
    // does. A direct read can land on a replica whose newest version of this
    // row is older, or a tombstone from an earlier generation of it, while the
    // leader still holds a handle this teardown never saw and never stopped.
    const stillHeld = Object.keys(await handleRegistry.listForDagConsistent(dagRootTaskId));
    if (stillHeld.length > 0) {
      logger.warn(
        { dagRootTaskId, handles: stillHeld },
        "sandbox.stale_empty_handle_read",
      );
      return "unconfirmed";
    }
  } catch (e) {
    logger.warn({ dagRootTaskId, err: errText(e) }, "sandbox.handle_list_failed");
    return "unconfirmed";
  }

  // Confirming this call's own loop is not confirming the DAG. The snapshot
  // above is of the handles still registered *now*, and a handle that leaked
  // earlier is no longer among them: the agent_done path tears down a handle as
  // soon as its last user finishes, and the sweeper and a concurrent cancel
  // both reach the same handles by other routes. Each of those removes the
  // mapping and leaves its failure only in the record, so a later cancel that
  // released everything it could see would otherwise report `confirmed` over
  // the top of a workload nobody released.
  try {
    return (await unreleasedRecord.any(dagRootTaskId)) ? "unconfirmed" : "confirmed";
  } catch (e) {
    logger.warn(
      { dagRootTaskId, err: errText(e) },
      "sandbox.unreleased_record_read_failed",
    );
    return "unconfirmed";
  }
}
