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
import { HANDS_KEY_PREFIX, RETAINED_PREFIX, encodeKeyPart } from "@claw/protocol";
import type { LiveWorkVerdict } from "./live-work-gate.js";

const logger = pino({ name: "sandbox-retention" });

/** The key a retention takes, which no session key can equal. */
export function retentionKey(generation: string): string {
  return `${HANDS_KEY_PREFIX}${RETAINED_PREFIX}${encodeKeyPart(generation)}`;
}

/** Narrowed so this cannot reach anything else in the bucket. */
export interface RetentionStore {
  put(key: string, value: string): Promise<unknown>;
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

/**
 * Move a session's binding into the retention namespace.
 *
 * The session key goes only after the retention key lands: the reverse order
 * leaves the container named by nothing if the second write does not happen.
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
  await input.store.put(key, JSON.stringify(record));
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
 * Never on a clock: the work this protects has no bounded age.
 */
export async function releaseRetention(store: RetentionStore, generation: string): Promise<void> {
  const key = retentionKey(generation);
  await store.delete(key);
  logger.info({ key, generation }, "sandbox.retention_released");
}
