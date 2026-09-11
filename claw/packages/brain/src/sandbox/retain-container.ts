// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Keeping a container that still holds live work, without keeping the session
 * bound to it.
 *
 * The session's binding is the container's only entry in the record the routing
 * and keepalive paths read, so the binding is moved rather than removed: into
 * the same keyspace the sweep already walks, under the reserved marker plus the
 * sandbox generation in unpadded base32, which the key-value client accepts for
 * every generation whatever bytes it holds.
 */

import pino from "pino";
import {
  HANDS_KEY_PREFIX, RETAINED_PREFIX, encodeKeyPart, isRetentionEntry,
} from "@claw/protocol";
import type { LiveWorkVerdict } from "./live-work-gate.js";

const logger = pino({ name: "sandbox-retention" });

/** The key a retention takes, which no session key can equal. */
export function retentionKey(generation: string): string {
  return `${HANDS_KEY_PREFIX}${RETAINED_PREFIX}${encodeKeyPart(generation)}`;
}

/**
 * The prefix the durable half of a retention lives under.
 *
 * Outside `hands.` on purpose. A pre-scheme replica writes `hands.<sessionId>`
 * for the whole length of a rolling upgrade, and for a session whose id begins
 * with the reserved marker that is a retention's key -- so the entry the sweep
 * walks can be replaced by a session binding at any moment, not only before the
 * retention was written. Nothing else writes this prefix, which is what makes
 * it the record and the `hands.` entry its projection.
 */
export const RETENTION_LEDGER_PREFIX = "retention.";

export function retentionLedgerKey(generation: string): string {
  return `${RETENTION_LEDGER_PREFIX}${encodeKeyPart(generation)}`;
}

/** The ledger filter a sweep walks, matching one whole key token. */
export const RETENTION_LEDGER_FILTER = `${RETENTION_LEDGER_PREFIX}*`;

/** The retention key an entry under `ledgerKey` projects to. */
export function retentionKeyForLedger(ledgerKey: string): string {
  return `${HANDS_KEY_PREFIX}${RETAINED_PREFIX}${ledgerKey.slice(RETENTION_LEDGER_PREFIX.length)}`;
}

/**
 * The ledger entry behind a projection, from the key the sweep walked rather
 * than from the entry's fields, which could disagree with it.
 */
export function ledgerKeyForRetention(key: string): string {
  return RETENTION_LEDGER_PREFIX
    + key.slice(HANDS_KEY_PREFIX.length + RETAINED_PREFIX.length);
}

/** Narrowed so this cannot reach anything else in the bucket. */
export interface RetentionStore {
  read(key: string): Promise<{ value: string; revision: number } | null>;
  /** False where the key already holds something. Never overwrites. */
  create(key: string, value: string): Promise<boolean>;
  /** Overwrite, conditioned on the revision that value was read at. */
  replace(key: string, value: string, expectedRevision: number): Promise<boolean>;
  delete(key: string): Promise<unknown>;
}

export interface RetentionRecord {
  /** Marks this entry as one the sweep must never probe, idle, or destroy. */
  protected: true;
  /** Operator-facing; it reaches no caller. */
  reason: LiveWorkVerdict;
  detail: string;
  retainedAt: string;
}

/** Raised where a session binding occupies the key this retention needs. */
export class RetentionKeyCollision extends Error {}

/**
 * Take the retention key, or refuse it to whatever already holds it.
 *
 * Created rather than written over. For the length of a rolling upgrade an old
 * replica goes on writing the pre-migration key of a session whose id begins
 * with the reserved marker, which is byte-for-byte a retention's key: an
 * unconditional write there replaces a live session's binding with this record,
 * and the sandbox that binding named is then reachable by nothing. A retention
 * already under the key is this generation's own -- one generation names one
 * sandbox -- so it is refreshed on the revision it was read at, that being the
 * retention resuming after a crash between the two writes rather than a
 * collision.
 *
 * @throws RetentionKeyCollision where a session binding holds the key, or where
 * the refresh lost its revision.
 */
async function takeRetentionKey(
  store: RetentionStore, key: string, value: string,
): Promise<void> {
  if (await store.create(key, value)) return;
  const existing = await store.read(key);
  if (existing === null) {
    throw new RetentionKeyCollision(
      `the retention key ${key} was taken and released again while this container `
      + "was being retained",
    );
  }
  if (!isRetentionEntry(JSON.parse(existing.value))) {
    throw new RetentionKeyCollision(
      `the retention key ${key} holds a session binding, which an old replica writes `
      + "under this name for the length of a rolling upgrade; the container was left "
      + "bound to its own session rather than overwriting one",
    );
  }
  if (!await store.replace(key, value, existing.revision)) {
    throw new RetentionKeyCollision(
      `the retention key ${key} changed while this container was being retained`,
    );
  }
}

/**
 * Move a session's binding into the retention namespace.
 *
 * The session key goes only after the retention key lands: the reverse order
 * leaves the container named by nothing if the second write does not happen.
 *
 * @throws RetentionKeyCollision where a session binding holds the retention
 * key. Nothing is written and the session keeps its binding.
 */
export async function retainContainer(input: {
  store: RetentionStore;
  sessionKey: string;
  generation: string;
  binding: Record<string, unknown>;
  verdict: LiveWorkVerdict;
  detail: string;
}): Promise<string> {
  const key = retentionKey(input.generation);
  const record: RetentionRecord & Record<string, unknown> = {
    ...input.binding,
    protected: true,
    reason: input.verdict,
    detail: input.detail,
    retainedAt: new Date().toISOString(),
  };
  const value = JSON.stringify(record);
  // The ledger first: it is what a later overwrite of the projection is
  // restored from, and a retention that lost its key before the ledger existed
  // would have nothing to restore it from.
  await writeLedger(input.store, retentionLedgerKey(input.generation), value);
  await takeRetentionKey(input.store, key, value);
  await input.store.delete(input.sessionKey);
  logger.warn(
    { key, generation: input.generation, verdict: input.verdict, detail: input.detail },
    "sandbox.container_retained",
  );
  return key;
}

/**
 * Give a retained container back to the ordinary lifetime machinery.
 *
 * By the key the caller walked rather than one recomputed from the entry's
 * fields: the two could disagree, and the one that was walked is the one that
 * exists. Never on a clock -- the work this protects has no bounded age.
 */
export async function releaseRetention(
  store: RetentionStore, key: string, ledgerKey: string,
): Promise<void> {
  // The ledger goes first: the projection alone is restored from it, so
  // removing the projection while the ledger stands would have the next sweep
  // put the retention straight back.
  await store.delete(ledgerKey);
  await store.delete(key);
  logger.info({ key }, "sandbox.retention_released");
}

/** Ours alone -- nothing else writes this prefix -- so it is written outright. */
async function writeLedger(
  store: RetentionStore, key: string, value: string,
): Promise<void> {
  if (await store.create(key, value)) return;
  const existing = await store.read(key);
  if (existing && !await store.replace(key, value, existing.revision)) {
    throw new RetentionKeyCollision(
      `the retention ledger entry ${key} changed while this container was being retained`,
    );
  }
}

export interface RetentionReassertion {
  restored: string[];
  /** Projections whose key is held by something that is not this retention. */
  blocked: string[];
}

/**
 * Put back every retention whose projection was replaced or removed.
 *
 * The one repair for a pre-scheme replica writing a session binding over a
 * live retention's key, which its own compare-and-set cannot prevent: that
 * write happens after the retention was created and by a process this
 * deployment does not control. Run every sweep, after the reserved-key
 * migration has moved such a binding to its canonical name, so the key is free
 * again by the time this looks.
 *
 * A key still held by a foreign binding is reported and left alone rather than
 * overwritten -- the rule the retention was created under does not stop
 * applying because the retention is the one being repaired.
 */
export async function reassertRetentions(
  store: RetentionStore & { keys(filter: string): Promise<string[]> },
): Promise<RetentionReassertion> {
  const result: RetentionReassertion = { restored: [], blocked: [] };
  for (const ledgerKey of await store.keys(RETENTION_LEDGER_FILTER)) {
    const held = await store.read(ledgerKey);
    if (!held) continue;
    const key = retentionKeyForLedger(ledgerKey);
    const projected = await store.read(key);
    if (projected && isRetentionEntry(JSON.parse(projected.value))) continue;
    if (projected) {
      result.blocked.push(key);
      continue;
    }
    if (await store.create(key, held.value)) result.restored.push(key);
  }
  if (result.restored.length || result.blocked.length) {
    logger.warn(result, "sandbox.retention_reasserted");
  }
  return result;
}
