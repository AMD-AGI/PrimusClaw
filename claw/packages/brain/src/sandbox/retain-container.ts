// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Keeping a container that still holds live work, without keeping the session
 * bound to it.
 *
 * The session's binding is the container's only entry in the record the routing
 * and keepalive paths read. Deleting it retains the container in name only:
 * nothing could route a poll, wait, or kill to it, and the sweep that keeps a
 * sandbox alive walks exactly that record -- so the container would fall out of
 * both and be reclaimed as idle. That is a delayed version of the destruction
 * this exists to prevent, and worse than an honest refusal, because the work is
 * reported protected while it is being lost.
 *
 * So the binding is moved rather than removed: into the same keyspace the sweep
 * already walks, under the reserved marker plus the sandbox generation in
 * unpadded base32, which lies inside the key-value client's accepted set for
 * every generation whatever bytes it holds. The caller is handed a freshly
 * provisioned sandbox by the ordinary path, exactly as a rebuild would have
 * handed it one -- so nothing a caller can observe varies with whether a
 * container was retained.
 */

import pino from "pino";
import { HANDS_KEY_PREFIX, RETAINED_PREFIX, encodeKeyPart } from "@claw/protocol";
import type { LiveWorkVerdict } from "./live-work-gate.js";

const logger = pino({ name: "sandbox-retention" });

/** The key a retention takes, which no session key can equal. */
export function retentionKey(generation: string): string {
  return `${HANDS_KEY_PREFIX}${RETAINED_PREFIX}${encodeKeyPart(generation)}`;
}

/**
 * The store a retention needs. Narrowed so a test can supply one, and so this
 * cannot reach anything else in the bucket.
 */
export interface RetentionStore {
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface RetentionRecord {
  /** Marks this entry as one the sweep must never probe, idle, or destroy. */
  protected: true;
  /** Why it is held. Operator-facing; it reaches no caller. */
  reason: LiveWorkVerdict;
  detail: string;
  retainedAt: string;
}

/**
 * Move a session's binding into the retention namespace.
 *
 * The value carried is the one the session binding carried -- endpoint,
 * credential, sandbox identity -- plus the reason, so a query naming a shell of
 * this generation resolves the container and reaches it over the ordinary Hands
 * routes. The session key is deleted only after the retention key is written: a
 * crash between the two leaves the session pointing at a live container, which
 * the next turn's health check handles, while the reverse order would leave the
 * container named by nothing at all.
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
 * Only ever on the evidence that caused the retention reaching zero, or on the
 * terminal evidence that retires a reference row -- never on a clock, since the
 * work this protects has no bounded age.
 */
export async function releaseRetention(store: RetentionStore, generation: string): Promise<void> {
  const key = retentionKey(generation);
  await store.delete(key);
  logger.info({ key, generation }, "sandbox.retention_released");
}
