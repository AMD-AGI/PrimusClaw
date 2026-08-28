// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Stable id generators for the task system (task-design.md §4 / §6.5.3).
 *
 * Format: <prefix>_<26-char Crockford ULID>. We use a tiny in-tree ULID
 * implementation so we don't pick up another dependency just for this.
 */
import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ALPHABET[mod] + out;
    now = (now - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

export function ulid(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}

export function newTaskId(): string {
  return `ktsk_${ulid()}`;
}

export function newBatchId(): string {
  return `kbat_${ulid()}`;
}

/** A workspace: the files a run works on, identified apart from any session. */
export function newWorkspaceId(): string {
  return `kws_${ulid()}`;
}
