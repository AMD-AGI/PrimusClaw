// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { connect, type NatsConnection, type JetStreamClient, type JetStreamManager, type KV, StorageType, RetentionPolicy, StringCodec, type ConnectionOptions } from "nats";
import {
  NATS_URL, NATS_USER, NATS_PASSWORD,
  TASK_MAX_DELIVER, TASK_MAX_ACK_PENDING,
  BRAIN_REGISTRY_TTL_MS,
  BRAIN_REGISTRY_REPLICAS, BRAIN_CHECKPOINTS_REPLICAS, SYSTEM_ENV_REPLICAS,
  TASK_STREAM_REPLICAS, EVENT_STREAM_REPLICAS, DISPATCH_STREAM_REPLICAS,
  DISPATCH_SUBJECT_PREFIX,
} from "../config.js";
import {
  TASK_CONSUMER_ACK_WAIT_NS, TASK_CONSUMER_NAME, TASK_STREAM_NAME,
  resolveTaskStreamMaxAgeNs, resolveTombstoneTtlMs, taskSubject,
} from "@claw/protocol";
import pino from "pino";

const logger = pino({ name: "nats" });
export const sc = StringCodec();

export let nc: NatsConnection;
export let js: JetStreamClient;
export let jsm: JetStreamManager;
export let kv: KV;
export let kvCkpt: KV;
export let kvSystemEnv: KV;
export let kvTombstones: KV;

// Stream + subject names are stable across environments. Multi-account
// isolation at the NATS server level keeps each environment's messages
// in a separate namespace, so no DEV_ID-based prefixing is needed here.
export const EVENT_STREAM = "PRIMUS_CLAW_EVENTS";
// From @claw/protocol because brain names the same stream when it attaches to
// the durable living on it, and a second literal is a second thing to edit.
export const TASK_STREAM = TASK_STREAM_NAME;
/**
 * A dispatch control plane's terminal events.
 *
 * Claw hosts the bus and owns the stream; a dispatcher above it publishes, and
 * nothing here reads. It exists so a consumer can be added later without a
 * migration -- and so the retention is a decision somebody made rather than
 * whatever a first publish happens to create.
 *
 * The prefix is versioned, and configurable because the publisher names it: a
 * deployment whose dispatcher publishes under some other prefix sets
 * DISPATCH_SUBJECT_PREFIX rather than running a stream that matches nothing it
 * sends. Both halves have to agree, and only one of them is this repo.
 */
export const DISPATCH_STREAM = "PRIMUS_DISPATCH_EVENTS";

// KV bucket names (Plan Y v2). Must match brain/src/config.ts mirror values.
// Authority for bucket lifecycle is initNats() below; brain pods attach the
// already-existing stream and inherit whatever config api set.
export const BRAIN_REGISTRY_BUCKET = "BRAIN_REGISTRY";
export const BRAIN_CHECKPOINTS_BUCKET = "BRAIN_CHECKPOINTS";
// System-level env distribution (system-env-design.md §5.2). API decrypts and
// publishes the global env map here; brain watches it (brain never holds the
// master key). Must match brain/src/config.ts mirror value.
export const SYSTEM_ENV_BUCKET = "SYSTEM_ENV";
// Deletion tombstones. Their own bucket because the registry's five-minute
// TTL is chosen for `lock.<key>`, which wants to expire quickly, while a
// tombstone has to outlive every message that could still ask about the
// session -- a task the queue can still redeliver, and every event still held
// on the event stream, whichever of the two windows is the longer.
export const BRAIN_TOMBSTONES_BUCKET = "BRAIN_TOMBSTONES";

// KV bucket config (Plan Y v2). Local consts; brain/src/config.ts mirrors
// these so a future @claw/shared-config package has one grep target. The
// replica counts and the registry's TTL are the exceptions: they come from
// config.ts so one setting reaches both sides. For the TTL that is because
// `lock.<key>`
// lives in this bucket, which makes it the lifetime of a dead worker's claim
// and therefore an input to when the lease reaper may declare a run dead. It
// was also the one value here that ignored the env var brain honours.
const BRAIN_CHECKPOINTS_TTL_MS = 24 * 60 * 60 * 1000;
const BRAIN_CHECKPOINTS_MAX_VALUE_BYTES = 16 * 1024 * 1024;
const BRAIN_CHECKPOINTS_COMPRESSION = true;
// SYSTEM_ENV holds a single key ("current") = JSON map of the global env.
// Persistent (ttl=0, no expiry) since it is a durable config mirror of the DB;
// removal happens via DELETE + republish, not TTL. Replicas default to 3 for
// HA and come from config.ts, which lets a single-node NATS set them to 1.
const SYSTEM_ENV_TTL_MS = 0;

/**
 * The shortest the event stream is allowed to keep an event.
 *
 * A lower bound rather than the retention. `ensureStream` only ever widens, so
 * this is what a cluster gets when nobody has said otherwise, and an operator
 * who edited the stream for an audit window keeps the wider window while this
 * number stays where it is. Anything that has to cover the stream therefore asks
 * the stream -- see `readEventStreamRetentionMs` -- because sizing it from here
 * would size it for a window the stream stopped having.
 */
export const EVENT_STREAM_RETENTION_MS = 24 * 3600 * 1000;
/**
 * Retention for the dispatch stream: the pair agreed with the dispatcher owner.
 *
 * A troubleshooting window, not a delivery guarantee. Seven days is long enough
 * to reconstruct what was dispatched across a weekend; 100k messages bounds a
 * runaway publisher on a fileStore shared with the streams carrying real
 * traffic. With no subscriber yet, trimming the tail costs nothing -- which is
 * what makes both limits safe to set now rather than after someone depends on
 * them.
 */
export const DISPATCH_STREAM_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const DISPATCH_STREAM_MAX_MSGS = 100_000;

/** What the event stream keeps, and whether the server said so. */
export interface EventStreamRetention {
  /** Milliseconds, or `null` when the stream never expires. */
  retentionMs: number | null;
  /**
   * False when the stream could not be read and `retentionMs` is the bound this
   * code enforces rather than the stream's own answer. Carried as far as the
   * bucket's own line, so that the TTL and the provenance of the number it was
   * computed from are one line rather than two: the read's warning is issued
   * before the bucket exists, and an assumed retention is the one way that mark
   * comes out too short. Nothing consumes it past that line.
   */
  measured: boolean;
}

/**
 * Read what the event stream is actually keeping.
 *
 * There is no environment variable for the event stream's retention, so editing
 * the stream is the only way to widen it, and `ensureStream` leaves a widened
 * one alone on purpose. That makes the server the only place the real number
 * exists, and it is read back after the stream has been ensured rather than
 * inferred from the constant it was created with.
 *
 * A stream that cannot be read falls back to the bound the start-up has just
 * enforced, which is the retention on every cluster nobody has widened. The
 * fallback is therefore only short on a cluster that was deliberately widened,
 * and it says so -- an unreadable stream and a 24-hour one must not be
 * indistinguishable to whoever has to explain a tombstone that expired early.
 */
export async function readEventStreamRetentionMs(
  mgr: JetStreamManager,
): Promise<EventStreamRetention> {
  try {
    const { max_age: maxAgeNs } = (await mgr.streams.info(EVENT_STREAM)).config;
    // Zero is how NATS spells "never expire", so it is the widest retention
    // there is and reading it as a duration would read it as the narrowest.
    return { retentionMs: maxAgeNs === 0 ? null : maxAgeNs / 1_000_000, measured: true };
  } catch (err) {
    logger.warn(
      { stream: EVENT_STREAM, err: (err as Error)?.message, assumingMs: EVENT_STREAM_RETENTION_MS },
      "nats.event_stream_retention_unreadable",
    );
    return { retentionMs: EVENT_STREAM_RETENTION_MS, measured: false };
  }
}

/**
 * How long a session's deletion tombstone is kept.
 *
 * Two independent things can still ask about a deleted session, and the mark has
 * to outlive the longer of them. `resolveTombstoneTtlMs` covers the first, a
 * task the queue can still redeliver; @claw/protocol owns that budget and is
 * deliberately not told about the second, which is the event stream this package
 * provisions. The api consumer asks the bucket about every message it takes off
 * that stream, so a mark that expires first leaves the tail of the retention
 * window unguarded, and an api backlog or outage that reaches into it writes a
 * deleted session's conversation content back into the database -- the one thing
 * the tombstone exists to prevent.
 *
 * `eventRetentionMs` is what the stream actually keeps rather than the constant
 * it is created with, because that constant is only a floor. On a cluster whose
 * event stream was widened to a month for an audit window, a tombstone sized
 * from the constant is gone for twenty-nine days of the window in which it is
 * the only thing standing between a deleted session and its own events.
 *
 * The redelivery term is a floor and not a dial. `TASK_MAX_DELIVER` is clamped
 * at 100 and each delivery is worth at most seven minutes, so even the largest
 * value the clamp permits comes to under twelve hours and the event stream's
 * retention decides on every configuration this code can be handed. It stays in
 * the expression because it is the term that would decide if the event stream
 * were ever narrowed below it, and because the relation it states -- the mark
 * outlives the redeliveries -- has to survive either number being retuned.
 *
 * A stream that never expires (`null`) has no window for a TTL to cover, and no
 * finite answer covers it. The bucket keeps the widest bound this code can
 * justify and the caller says out loud what is not covered past it. Making the
 * bucket unbounded to match would trade a stated gap for a bucket that grows by
 * one key per deleted session for the life of the cluster, which the `widenOnly`
 * policy this bucket is reconciled under could then never bring back down.
 */
export function tombstoneTtlMs(
  maxDeliver: number,
  eventRetentionMs: number | null,
): number {
  return Math.max(
    resolveTombstoneTtlMs(maxDeliver),
    eventRetentionMs ?? EVENT_STREAM_RETENTION_MS,
  );
}

/**
 * Whether a failed publish certainly did not reach the stream.
 *
 * A JetStream publish is a request and a reply: the message goes out, the
 * server stores it, and the ack comes back. A timeout means the ack did not
 * arrive, which is not the same as the message not arriving -- the stream may
 * well be holding it. Callers that republish under a message id have to tell
 * the two apart, because the stream drops the second copy of a message it
 * already has: whatever the first copy is going to do it is going to do, and
 * anything the caller tore down on the way out is torn down under it.
 *
 * Only two answers are certain, and both come from the server having answered.
 * `503` is nobody answering at all, so nothing was stored; an `api_error` is
 * the server declining, and it says why. Everything else -- timeouts, a
 * connection that went away mid-request -- is unknown, and is reported as
 * unknown rather than guessed, because the two guesses are not symmetric: one
 * leaves a spare row behind, the other loses the message.
 */
export function publishCertainlyFailed(err: unknown): boolean {
  const e = err as { code?: string; api_error?: unknown } | null;
  return e?.code === "503" || e?.api_error !== undefined;
}

export async function initNats(): Promise<void> {
  const opts: ConnectionOptions = { servers: NATS_URL };
  if (NATS_USER) {
    opts.user = NATS_USER;
    opts.pass = NATS_PASSWORD;
  }
  nc = await connect(opts);
  js = nc.jetstream();
  jsm = await nc.jetstreamManager();

  await ensureStream(
    jsm, EVENT_STREAM, ["events.>"], EVENT_STREAM_RETENTION_MS * 1_000_000,
    0, EVENT_STREAM_REPLICAS, 0,
  );
  // Read back here, ahead of the bucket that is sized from it, because no later
  // start corrects a bucket sized from the constant instead. What would be wrong
  // is the desired value: every start would compute the same too-short TTL, find
  // the bucket already at it, and reconcile nothing -- there is no gap for any
  // policy to see. On a cluster whose event stream is wider than the constant
  // that is a tombstone expiring inside the window it exists to cover, for the
  // life of the cluster.
  const eventRetention = await readEventStreamRetentionMs(jsm);
  // Retention is derived from the redelivery budget rather than set to a round
  // number: at the previous flat one hour the stream deleted tasks the durable
  // could still redeliver, so the poison guard never fired and they vanished
  // without an event. See resolveTaskStreamMaxAgeNs.
  // The duplicate window is the same span as the retention, and for the same
  // reason the retention is that span: it is how long a task published once
  // can still be in play. A replayed queued message is republished under the
  // id of the queue row it came from, so within this window the stream
  // recognises the second publish as the first one and drops it -- which is
  // what stops a drain that failed after publishing from running the turn a
  // second time. The default is two minutes, which is shorter than a single
  // redelivery.
  const taskRetentionNs = resolveTaskStreamMaxAgeNs(TASK_MAX_DELIVER);
  await ensureStream(
    jsm, TASK_STREAM, ["tasks.>"], taskRetentionNs, taskRetentionNs, TASK_STREAM_REPLICAS, 0,
  );
  // The dispatcher's own terminal events. Claw hosts the bus and owns the
  // stream; it neither publishes nor subscribes here, which is why this is the
  // one stream with no consumer created beside it.
  //
  // Retention is the pair agreed with the dispatcher owner and is a
  // troubleshooting window, not a delivery guarantee: 7 days is long enough to
  // reconstruct what was dispatched across a weekend, and 100k messages bounds
  // a runaway publisher on a fileStore shared with the streams that carry real
  // traffic. There is no subscriber yet -- the events exist so one can be added
  // without a migration -- so nothing breaks if either limit trims the tail.
  await ensureStream(
    jsm, DISPATCH_STREAM, [`${DISPATCH_SUBJECT_PREFIX}.>`],
    DISPATCH_STREAM_RETENTION_MS * 1_000_000, 0,
    DISPATCH_STREAM_REPLICAS, DISPATCH_STREAM_MAX_MSGS,
  );
  await ensureTaskConsumer();

  const buckets = await ensureKvBuckets(eventRetention);
  kv = buckets.registry;
  kvCkpt = buckets.checkpoints;
  kvTombstones = buckets.tombstones;
  kvSystemEnv = buckets.systemEnv;

  logger.info(
    {
      natsUrl: NATS_URL,
      account: NATS_USER || "(default)",
      EVENT_STREAM,
      TASK_STREAM,
      DISPATCH_STREAM,
      BRAIN_REGISTRY_BUCKET,
      BRAIN_CHECKPOINTS_BUCKET,
      SYSTEM_ENV_BUCKET,
    },
    "nats.connected",
  );
}

/**
 * How a bucket is brought into being, so that a caller can be handed a fake.
 *
 * `ensureKvBucket` reaches a live NATS server on every path through it, which
 * puts the whole of the wiring below out of reach of a unit test; what that
 * wiring decides -- which bucket is given which TTL, and which one is allowed to
 * refuse a narrowing -- is exactly the part a mistake hides in.
 */
export type EnsureKvBucket = (name: string, opts: EnsureKvBucketOpts) => Promise<KV>;

/** The buckets this process provisions, in the order it provisions them. */
export interface KvBuckets {
  registry: KV;
  checkpoints: KV;
  tombstones: KV;
  systemEnv: KV;
}

/**
 * Provision every KV bucket this process owns.
 *
 * Apart from `initNats` so that the settings each bucket is created with can be
 * asserted against a fake. The TTL policy is the reason: `exact` is the default
 * and is what a TTL that is a setting needs, `widenOnly` belongs to the
 * tombstone bucket alone (see KvTtlPolicy), and a second bucket quietly given
 * `widenOnly` is a bucket whose TTL a shortened setting can no longer reach --
 * with nothing failing, and nothing in a start-up log to say so.
 */
export async function ensureKvBuckets(
  retention: EventStreamRetention,
  ensure: EnsureKvBucket = ensureKvBucket,
): Promise<KvBuckets> {
  return {
    // Brain Registry KV: short-lived coordination state.
    registry: await ensure(BRAIN_REGISTRY_BUCKET, {
      ttl: BRAIN_REGISTRY_TTL_MS,
      replicas: BRAIN_REGISTRY_REPLICAS,
    }),
    // Brain Checkpoints KV: task state payloads (Plan Y v2 main path).
    checkpoints: await ensure(BRAIN_CHECKPOINTS_BUCKET, {
      ttl: BRAIN_CHECKPOINTS_TTL_MS,
      replicas: BRAIN_CHECKPOINTS_REPLICAS,
      maxValueSize: BRAIN_CHECKPOINTS_MAX_VALUE_BYTES,
      compression: BRAIN_CHECKPOINTS_COMPRESSION,
    }),
    // Deletion tombstones: kept for as long as either stream can still produce a
    // message that asks about the session; see tombstoneTtlMs.
    tombstones: await ensureTombstoneBucket(retention, ensure),
    // System Env KV: decrypted global env map for brain ops-fallback merge.
    systemEnv: await ensure(SYSTEM_ENV_BUCKET, {
      ttl: SYSTEM_ENV_TTL_MS,
      replicas: SYSTEM_ENV_REPLICAS,
    }),
  };
}

/**
 * Provision the tombstone bucket for the streams this cluster actually has.
 *
 * The unbounded case is reported rather than passed over because it is the one
 * configuration in which the tombstone cannot do its whole job, and nothing
 * downstream would show it: events keep being suppressed, correctly, right up to
 * the moment the mark expires, and the first sign of the gap is a deleted
 * session's conversation content back in the database with no error anywhere. At
 * error level because an operator cannot discover it any other way -- there is no
 * request that fails and no metric that moves -- and because the fix is theirs
 * to choose, being either a bounded retention on the stream or accepting that
 * suppression ends when the mark does.
 *
 * The bucket's own line carries whether the retention was measured, because an
 * unreadable stream produces the same kind of invisibly-short mark: the fallback
 * is the retention on every cluster nobody widened, so it is wrong exactly where
 * the answer would have been larger. The reader has already warned by then, so
 * what this adds is only that the TTL and the provenance of the number behind it
 * are one line instead of two lines to be correlated.
 *
 * `ensure` is a parameter so that the TTL this computes can be checked against a
 * fake. That number is the whole point of reading the stream back, `initNats` is
 * the only production caller and needs a real server, and a regex over this file
 * cannot tell whether the retention or the constant is what arrives here.
 */
export async function ensureTombstoneBucket(
  retention: EventStreamRetention,
  ensure: EnsureKvBucket = ensureKvBucket,
): Promise<KV> {
  const ttl = tombstoneTtlMs(TASK_MAX_DELIVER, retention.retentionMs);
  if (retention.retentionMs === null) {
    logger.error(
      {
        bucket: BRAIN_TOMBSTONES_BUCKET,
        stream: EVENT_STREAM,
        suppressedForMs: ttl,
        pastThat: "a replayed event is written back under the deleted session",
      },
      "nats.tombstone_cannot_cover_unbounded_event_stream",
    );
  }
  logger.info(
    {
      bucket: BRAIN_TOMBSTONES_BUCKET,
      ttlMs: ttl,
      eventRetentionMs: retention.retentionMs,
      retentionMeasured: retention.measured,
    },
    "nats.tombstone_bucket_ttl",
  );
  return await ensure(BRAIN_TOMBSTONES_BUCKET, {
    ttl,
    replicas: BRAIN_REGISTRY_REPLICAS,
    ttlPolicy: "widenOnly",
  });
}

/**
 * Create the stream, or widen its retention if the existing one is too narrow.
 *
 * This used to return as soon as `info` succeeded, which left `max_age` frozen
 * at whatever the stream was first created with — so a corrected retention
 * reached new environments only, and every cluster already running kept the old
 * one with nothing to indicate it. That is the same drift `ensureKvBucket`
 * below already reconciles, and it matters more here: the task stream's
 * retention has to cover the durable's redelivery budget, and when it does not
 * the stream deletes tasks the durable is still entitled to retry.
 *
 * The correction only ever widens, and that asymmetry is the point. What this
 * code knows is a lower bound the stream has to satisfy; it does not know the
 * operator's reason for exceeding it, and for the event stream there is no
 * environment variable to express one, so editing the stream is the only way to
 * keep a session's history for an audit window. Narrowing is also the
 * destructive direction: the server drops everything past the new `max_age` as
 * soon as it is applied, with nothing to restore it from. A stream already
 * wider than required is therefore left alone, and the duplicate window is
 * treated the same way -- a longer window only recognises more replays as
 * replays, which is never the unsafe direction.
 *
 * Exported for unit tests; production calls it only from `initNats` above.
 */
export async function ensureStream(
  mgr: JetStreamManager,
  name: string,
  subjects: string[],
  maxAgeNs: number,
  duplicateWindowNs: number,
  replicas: number,
  /**
   * Message ceiling, or 0 for none.
   *
   * Widened rather than reconciled, like max_age and unlike replicas: lowering
   * it discards messages that are inside the retention an operator chose, and a
   * process that starts with a stale constant must not do that on its own.
   *
   * Required, with no default, for the reason the replica count is: a defaulted
   * parameter is one a new call site never has to think about, and that is how
   * PRIMUS_CLAW_TASKS came to be created at one replica.
   */
  maxMsgs: number,
): Promise<void> {
  let existing: Awaited<ReturnType<JetStreamManager["streams"]["info"]>> | null = null;
  try {
    existing = await mgr.streams.info(name);
  } catch { /* not found, create below */ }

  // Deliberately outside the try above, so a failed correction surfaces instead
  // of falling through to `add` and being absorbed by the already-exists branch.
  if (existing) {
    const widened: Record<string, number> = {};
    // A zero max_age is not the narrowest retention but the widest: it is how
    // NATS spells "never expire", so comparing it as a number would read a
    // stream an operator deliberately made unbounded as the one most in need
    // of correction, and cut it back to hours.
    if (existing.config.max_age !== 0 && existing.config.max_age < maxAgeNs) {
      widened.max_age = maxAgeNs;
    }
    if (duplicateWindowNs && existing.config.duplicate_window < duplicateWindowNs) {
      widened.duplicate_window = duplicateWindowNs;
    }
    // Same reading of zero as max_age above: -1 and 0 both spell "unlimited"
    // for max_msgs, and a stream an operator made unbounded must not be cut
    // back to a constant compiled in here.
    const existingMaxMsgs = existing.config.max_msgs;
    if (maxMsgs && existingMaxMsgs > 0 && existingMaxMsgs < maxMsgs) {
      widened.max_msgs = maxMsgs;
    }
    // Replicas are reconciled to the exact figure rather than only widened,
    // which is the rule the KV buckets have always followed, and safe here for
    // the reason it is safe there: changing a replica count moves copies of the
    // log between servers, it never drops a message. The direction that matters
    // is up. A stream created before this argument existed sits at one replica
    // and nothing else in the process would ever raise it, so without this the
    // fix would hold only for clusters provisioned after it, and the streams
    // that actually broke would stay broken until someone edited them by hand.
    if (existing.config.num_replicas !== replicas) {
      widened.num_replicas = replicas;
    }
    if (Object.keys(widened).length) {
      await mgr.streams.update(name, widened as Parameters<
        JetStreamManager["streams"]["update"]
      >[1]);
      logger.warn(
        {
          name,
          widened,
          wasMaxAgeNs: existing.config.max_age,
          wasReplicas: existing.config.num_replicas,
        },
        "nats.stream_config_reconciled",
      );
    }
    return;
  }
  try {
    await mgr.streams.add({
      name,
      subjects,
      storage: StorageType.File,
      max_age: maxAgeNs,
      ...(maxMsgs ? { max_msgs: maxMsgs } : {}),
      retention: RetentionPolicy.Limits,
      num_replicas: replicas,
      ...(duplicateWindowNs ? { duplicate_window: duplicateWindowNs } : {}),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("subjects overlap") || msg.includes("already in use")) {
      logger.warn({ name, subjects, err: msg }, "nats.stream_overlap_ignored");
      return;
    }
    throw err;
  }
}

/**
 * Create or reconcile the durable every brain pod pulls tasks from.
 *
 * Here rather than in brain because it is one shared object and this is the
 * one process that provisions the stream it lives on. When each brain pod
 * reconciled it on start, the fleet's ceiling was set by whichever pod
 * restarted last, and a pod configured lower lowered it for every replica
 * already running under the higher value -- passing its own check while doing
 * so, since that check compared the durable only against the pod that had just
 * written it. Brain now verifies and refuses to start on a durable below its
 * expectations, but never writes one.
 *
 * Reconciling rather than only creating: `add` does not update an existing
 * durable, so without this the server would keep whatever max_deliver the
 * consumer was first created with, silently breaking the ordering that stops
 * tasks being dropped without an event.
 */
async function ensureTaskConsumer(): Promise<void> {
  // Only the fields NATS lets an existing durable change, kept apart from the
  // create-only ones so the update path cannot ask for an immutable one.
  const mutable = {
    ack_wait: TASK_CONSUMER_ACK_WAIT_NS,
    max_deliver: TASK_MAX_DELIVER,
    max_ack_pending: TASK_MAX_ACK_PENDING,
  };
  try {
    await jsm.consumers.add(TASK_STREAM, {
      durable_name: TASK_CONSUMER_NAME,
      filter_subject: taskSubject(),
      deliver_policy: "all" as never,
      ack_policy: "explicit" as never,
      ...mutable,
    });
    logger.info({ consumer: TASK_CONSUMER_NAME, ...mutable }, "nats.task_consumer_created");
    return;
  } catch {
    // Not an exceptional path: `add` always sends action:"create", which the
    // server rejects for an existing durable even when the config is
    // byte-identical, so every start after the first lands here.
  }
  try {
    await jsm.consumers.update(TASK_STREAM, TASK_CONSUMER_NAME, mutable);
    logger.info({ consumer: TASK_CONSUMER_NAME, ...mutable }, "nats.task_consumer_reconciled");
  } catch (err) {
    // Fatal on purpose. Brain refuses to start against a durable it cannot
    // verify, so leaving one in an unknown state here only moves the failure
    // to a pod that has less context to report it with.
    logger.error({ err, consumer: TASK_CONSUMER_NAME, ...mutable }, "nats.task_consumer_reconcile_failed");
    throw new Error(
      `failed to reconcile consumer ${TASK_CONSUMER_NAME}; `
      + "refusing to run with an unknown delivery configuration",
      { cause: err },
    );
  }
}

/**
 * Whether a bucket's TTL keeps a key for less time than the desired one asks.
 *
 * Zero means "never expire" on both sides, so it is the widest setting there is
 * rather than the smallest number: a bucket already at zero is never narrow, and
 * a desired zero is wider than anything finite.
 */
export function kvTtlTooNarrow(currentMaxAgeNs: number, desiredMaxAgeNs: number): boolean {
  if (currentMaxAgeNs === 0) return false;
  return desiredMaxAgeNs === 0 || currentMaxAgeNs < desiredMaxAgeNs;
}

/**
 * What a start-up may do to a bucket's existing TTL.
 *
 * `exact` reconciles in both directions, which is what a TTL that is a setting
 * needs. `BRAIN_REGISTRY_TTL_MS` is the one that matters: `lock.<key>` lives in
 * that bucket, so the TTL is how long a dead worker's claim survives it, and the
 * lease reap grace and the lock-blocked takeover deadlines are re-derived from
 * the same number. An operator who shortens it and leaves the bucket at the old,
 * longer `max_age` gets every derived deadline shortened while the locks keep
 * their old lifetime -- the reaper declares a run dead with the dead pod's lock
 * still held, and the replacement never gets it. Refusing that narrowing costs
 * more than applying it, too, and across everything the default governs rather
 * than that one bucket: what a shortened `max_age` drops is the keys older than
 * the TTL the configuration now asks for, so each one it takes is a key the
 * desired setting says should already have expired, and everything inside the
 * new window stays. That holds for the checkpoint payloads and the system env
 * map as much as for the registry's locks, because none of these buckets holds a
 * record of something having happened: every key in them is state that a live
 * path rewrites, re-derives or does without.
 *
 * `widenOnly` is the tombstone bucket alone. Its TTL has to cover whatever the
 * event stream actually keeps, and there is no environment variable for either,
 * so an operator who lengthened it by hand is correcting this code rather than
 * drifting from it -- reconciled both ways, the correction was undone on the next
 * start, and no configuration existed in which a widened event stream and a
 * tombstone that covered it could coexist. Narrowing is also destructive here in
 * a way it is nowhere else: the keys dropped at the new `max_age` are the only
 * record that those sessions were deleted.
 */
export type KvTtlPolicy = "exact" | "widenOnly";

/**
 * What to do about the gap between a bucket's TTL and the desired one.
 *
 * "refused" is a third answer rather than a second kind of "none" because it is
 * the one nobody can see from the outside: the bucket goes on running with a
 * `max_age` this process did not ask for, which under `widenOnly` is the intended
 * outcome only for as long as somebody is told it happened.
 */
export function kvTtlAction(
  currentMaxAgeNs: number,
  desiredMaxAgeNs: number,
  policy: KvTtlPolicy,
): "none" | "apply" | "refused" {
  if (currentMaxAgeNs === desiredMaxAgeNs) return "none";
  if (policy === "exact" || kvTtlTooNarrow(currentMaxAgeNs, desiredMaxAgeNs)) return "apply";
  return "refused";
}

/**
 * The fields a refused narrowing has to be reported with, or `null` when there
 * is nothing to report.
 *
 * The condition and the payload together, because the refusal is the one
 * outcome that changes nothing observable: reached only through a live server,
 * it was pinned by a regex over this file, which a `=== "apply"` here would have
 * satisfied just as well -- warning on every widening and staying silent on
 * every refusal. Both numbers are in it because which of the two is wrong is the
 * operator's decision, and reading the bucket's real `max_age` is the step they
 * cannot take from a log that only quotes the value this process wanted.
 */
export function kvTtlRefusal(
  name: string,
  currentMaxAgeNs: number,
  desiredMaxAgeNs: number,
  policy: KvTtlPolicy,
): Record<string, unknown> | null {
  if (kvTtlAction(currentMaxAgeNs, desiredMaxAgeNs, policy) !== "refused") return null;
  return { name, maxAgeNs: currentMaxAgeNs, desiredMaxAgeNs, ttlPolicy: policy };
}

export interface EnsureKvBucketOpts {
  ttl: number;            // milliseconds; bucket-level max_age
  replicas: number;       // 1 | 3
  maxValueSize?: number;  // bytes; default = NATS server default (1 MiB)
  compression?: boolean;  // s2 stream compression
  /** How an existing TTL is reconciled. Defaults to `exact`; see KvTtlPolicy. */
  ttlPolicy?: KvTtlPolicy;
}

/**
 * Idempotent create-or-update for a NATS JetStream KV bucket.
 * - If bucket missing: create with the given config.
 * - If bucket present but underlying stream config drifted from desired
 *   (replicas / max_msg_size / compression): patch via streams.update.
 *   Replicas changes are server-coordinated and may be no-op in a single-
 *   replica dev cluster; that's fine — the call still succeeds.
 * - The TTL is reconciled as `opts.ttlPolicy` says; see KvTtlPolicy.
 * - Returns a KV handle bound to the (now-correct) bucket.
 *
 * The underlying stream name follows the NATS KV convention `KV_<bucket>`;
 * we drive updates via jsm.streams.update so we can correct drift that
 * js.views.kv() (which is attach-only on existing buckets) cannot fix.
 */
export async function ensureKvBucket(
  name: string,
  opts: EnsureKvBucketOpts,
): Promise<KV> {
  const streamName = `KV_${name}`;
  let exists = false;
  try {
    await jsm.streams.info(streamName);
    exists = true;
  } catch { /* stream not found; create below */ }

  if (!exists) {
    await js.views.kv(name, {
      ttl: opts.ttl,
      replicas: opts.replicas,
      ...(opts.maxValueSize !== undefined ? { maxValueSize: opts.maxValueSize } : {}),
      ...(opts.compression !== undefined ? { compression: opts.compression } : {}),
      storage: StorageType.File,
    });
    logger.info({ name, ...opts }, "nats.kv_bucket_created");
    return await js.views.kv(name);
  }

  // Bucket exists; check + correct drift. NATS server-side bucket TTL is
  // applied via stream max_age (ms→ns); replicas/max_msg_size/compression
  // are direct stream fields.
  const info = await jsm.streams.info(streamName);
  const cfg = info.config;
  const desiredMaxAgeNs = opts.ttl * 1_000_000;
  const driftReplicas = cfg.num_replicas !== opts.replicas;
  const driftMaxMsg = opts.maxValueSize !== undefined && cfg.max_msg_size !== opts.maxValueSize;
  const driftCompression = opts.compression !== undefined
    && (cfg.compression ?? "none") !== (opts.compression ? "s2" : "none");
  const policy = opts.ttlPolicy ?? "exact";
  const applyTtl = kvTtlAction(cfg.max_age, desiredMaxAgeNs, policy) === "apply";
  // The one outcome that leaves the bucket knowingly out of step with this
  // process while changing nothing, so without this line a start-up with no
  // other drift reports no problems for a configuration that has one.
  const refusal = kvTtlRefusal(name, cfg.max_age, desiredMaxAgeNs, policy);
  if (refusal) logger.warn(refusal, "nats.kv_bucket_ttl_narrowing_refused");

  if (driftReplicas || driftMaxMsg || driftCompression || applyTtl) {
    await jsm.streams.update(streamName, {
      num_replicas: opts.replicas,
      ...(opts.maxValueSize !== undefined ? { max_msg_size: opts.maxValueSize } : {}),
      ...(opts.compression !== undefined ? { compression: opts.compression ? "s2" : "none" } : {}),
      ...(applyTtl ? { max_age: desiredMaxAgeNs } : {}),
    } as Parameters<JetStreamManager["streams"]["update"]>[1]);
    logger.warn(
      {
        name, driftReplicas, driftMaxMsg, driftCompression, ttlUpdated: applyTtl,
        wasMaxAgeNs: cfg.max_age, ...opts,
      },
      "nats.kv_bucket_drift_corrected",
    );
  }

  return await js.views.kv(name);
}
