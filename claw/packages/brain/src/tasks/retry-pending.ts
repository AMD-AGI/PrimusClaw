// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { StringCodec, type KV } from "nats";

const sc = StringCodec();

export const RETRY_PENDING_PREFIX = "retry-pending.";

export interface RetryPendingEntry {
  sessionId: string;
  messageId?: string;
  lockKey?: string;
  attempt?: number;
  reason?: string;
  reasonClass?: string;
  workloadId?: string;
  createdAtMs: number;
  deadlineMs: number;
  graceSec: number;
  brainId?: string;
  brainVersion?: string;
}

function sanitizeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

function retryPendingKey(sessionId: string, lockKey?: string): string {
  const suffix = lockKey ? `${sanitizeKeyPart(sessionId)}.${sanitizeKeyPart(lockKey)}` : sanitizeKeyPart(sessionId);
  return `${RETRY_PENDING_PREFIX}${suffix}`;
}

/**
 * Store a bounded retry-pending lease for keepalive cleanup.
 *
 * This is deliberately separate from the hands.<sessionId> KV entry: hands.*
 * says "there is a READY sandbox worth pinging", while retry-pending.* says
 * "the current attempt exited retryable and a replacement attempt must arrive
 * before deadlineMs". Keeping both records makes orphan keepalive bugs easy to
 * diagnose from NATS KV dumps and brain logs.
 */
export async function markRetryPending(kv: KV, entry: RetryPendingEntry): Promise<void> {
  await kv.put(retryPendingKey(entry.sessionId, entry.lockKey), sc.encode(JSON.stringify(entry)));
}

/**
 * Whether an attempt of this exact message has already run and exited
 * retryably, as opposed to the message never having got the lock at all.
 *
 * Both reach the poison guard with the same deliveryCount, and the lease is
 * the only durable trace of the difference: it is written when an attempt
 * exits retryable and cleared when the next one actually starts, so a task
 * whose every redelivery was a lock-contention nak never writes one. The key
 * is shared with any sibling contending for the same lock -- that is what
 * contention means -- which is what makes the messageId comparison
 * load-bearing rather than defensive.
 *
 * The lease lives on the bucket TTL, so it speaks for the most recent attempt
 * rather than for the whole history, which is the reading the guard wants: a
 * retryable exit comes back within seconds and its lease is still there, while
 * one left behind before a long wait on a lock has expired by the time the
 * guard asks, and by then the queue is the honest answer.
 *
 * Answers "yes" when the lease cannot be read or parsed. The caller spends a
 * delivery on the strength of a "no", so an unreadable bucket has to fall back
 * to the blunter behaviour instead of to a guess.
 */
export async function hasFailedAttempt(
  kv: KV,
  sessionId: string,
  lockKey: string,
  messageId: string,
): Promise<boolean> {
  let item;
  try {
    item = await kv.get(retryPendingKey(sessionId, lockKey));
  } catch {
    return true;
  }
  // A cleared lease reads back as a delete entry carrying an empty payload
  // rather than as a miss, and an empty payload is not a parse failure.
  if (!item || !item.value || item.value.length === 0) return false;
  try {
    const parsed = JSON.parse(sc.decode(item.value)) as RetryPendingEntry;
    return parsed?.sessionId === sessionId && (parsed.messageId ?? "") === messageId;
  } catch {
    return true;
  }
}

/** Clear the retry-pending lease once a redelivered attempt actually starts. */
export async function clearRetryPending(kv: KV, sessionId: string, lockKey?: string): Promise<void> {
  if (lockKey) {
    await kv.delete(retryPendingKey(sessionId, lockKey)).catch(() => {});
    return;
  }
  await kv.delete(retryPendingKey(sessionId)).catch(() => {});
}

async function decodeRetryPending(kv: KV, key: string, sessionId: string): Promise<RetryPendingEntry | null> {
  const item = await kv.get(key).catch(() => null);
  if (!item) return null;
  try {
    const parsed = JSON.parse(sc.decode(item.value)) as RetryPendingEntry;
    if (!parsed || parsed.sessionId !== sessionId || !Number.isFinite(parsed.deadlineMs)) {
      await kv.delete(key).catch(() => {});
      return null;
    }
    return parsed;
  } catch {
    await kv.delete(key).catch(() => {});
    return null;
  }
}

/** Read retry-pending metadata, deleting malformed entries. */
export async function getRetryPending(kv: KV, sessionId: string, lockKey?: string): Promise<RetryPendingEntry | null> {
  if (lockKey) return decodeRetryPending(kv, retryPendingKey(sessionId, lockKey), sessionId);

  const legacy = await decodeRetryPending(kv, retryPendingKey(sessionId), sessionId);
  if (legacy) return legacy;

  // `>` rather than `*`, because a gate key is not one subject token. It is
  // `ws.<workspaceId>` now, and encodeURIComponent leaves a dot alone, so the
  // key this scan has to find is `retry-pending.<sid>.ws.<id>` -- four tokens,
  // which `*` does not match at all. The scan then finds nothing, the entry is
  // read as absent, and the READY sandbox it was meant to reclaim stays
  // resident under keepalive with a GPU attached to it.
  const keys = await kv.keys(`${RETRY_PENDING_PREFIX}${sanitizeKeyPart(sessionId)}.>`).catch(() => null);
  if (!keys) return null;
  for await (const key of keys) {
    const entry = await decodeRetryPending(kv, key, sessionId);
    if (entry) return entry;
  }
  return null;
}

/** Return true after the retry grace window has elapsed. */
export function isRetryPendingExpired(entry: RetryPendingEntry, nowMs = Date.now()): boolean {
  return nowMs >= entry.deadlineMs;
}
