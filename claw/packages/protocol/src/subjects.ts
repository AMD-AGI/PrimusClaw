// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// NATS subject builders. After NATS multi-account isolation (each
// environment connects with its own account), subjects no longer need
// per-developer prefixes — account boundaries handle isolation.

export function taskSubject(): string {
  return "tasks.execute";
}

export function eventSubject(sessionId: string): string {
  return `events.${sessionId}`;
}

export function interruptSubject(sessionId: string): string {
  return `interrupt.${sessionId}`;
}

export function cleanupSubject(sessionId: string): string {
  return `cleanup.${sessionId}`;
}

/** What a `cleanup.<sessionId>` message carries. */
export interface CleanupPayload {
  /**
   * The SaFE key the teardown authenticates with. Sent rather than looked up,
   * because the only place to look it up is the session's `hands.<sid>` KV entry,
   * which is deleted from two directions while the teardown runs -- and without
   * a key the session's GPU clusters cannot be reclaimed.
   */
  platformKey?: string;
}

/** Serialize a cleanup payload for `nc.publish`. */
export function encodeCleanupPayload(payload: CleanupPayload): string {
  return JSON.stringify(payload);
}

/**
 * Read a cleanup payload back.
 *
 * Every unusable shape — empty, malformed, wrong types, or a publisher old
 * enough to send no payload at all — collapses to `{}` rather than throwing.
 * The consumer falls back to its own lookup in that case, so a bad message
 * must not be the thing that fails a teardown.
 */
export function decodeCleanupPayload(raw: string | undefined | null): CleanupPayload {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const key = (parsed as CleanupPayload).platformKey;
    return typeof key === "string" ? { platformKey: key } : {};
  } catch {
    return {};
  }
}
