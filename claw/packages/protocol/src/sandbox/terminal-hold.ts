// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A short, self-expiring claim that a person is using a session's sandbox
 * through an interactive terminal.
 *
 * Why it exists. A sandbox is reclaimed on evidence of *agent* work: a turn in
 * flight, or user tasks registered through `/api/execute`. A shell opened in a
 * browser terminal is neither, so without a claim of its own the sandbox that
 * was just started for the terminal is stopped when the run that opened it
 * ends, and the terminal can almost never connect.
 *
 * What it is. One record per session, `termhold.<base32(sessionId)>`, in the
 * same bucket as the `hands.<session>` binding. `until` is an absolute epoch
 * millisecond bound. The writer (the API, on the owner's start/keepalive call)
 * sets it a short time ahead and renews it while the terminal is open; nobody
 * deletes it. A browser that vanishes therefore stops renewing, and the claim
 * lapses by itself: after `until` every reader treats it as absent, and the
 * bucket's own max age removes the key.
 *
 * Who honours it. The reclaim paths that would end the sandbox on idleness:
 * Brain's keepalive idle reclaim, the API's "last user finished" stop, and the
 * orphan-handle sweep. Explicit destruction (session delete, cancel) does not
 * consult it: an owner who deletes the session must always win.
 *
 * Unreadable is not absent. A reader that cannot tell holds the stop, which is
 * the direction every other unknown on those paths already takes.
 */

import { encodeKeyPart } from "./base32.js";

export const TERMINAL_HOLD_PREFIX = "termhold.";

/** Never matches `hands.*`: the part is base32, so it holds no dot. */
export function terminalHoldKey(sessionId: string): string {
  return TERMINAL_HOLD_PREFIX + encodeKeyPart(sessionId);
}

export interface TerminalHold {
  sessionId: string;
  /** Epoch ms after which the claim is void. */
  until: number;
  /** Epoch ms of the write that set it. */
  at: number;
}

/** The subset of a NATS KV the helpers need, so tests and both services can share them. */
export interface TerminalHoldKv {
  get(key: string): Promise<{ value: Uint8Array; operation?: string } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
}

export type TerminalHoldState =
  | { state: "held"; until: number }
  | { state: "none" }
  | { state: "unreadable"; reason: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Set or renew the claim to `now + ttlMs`. Plain put: nothing else writes this key. */
export async function putTerminalHold(
  kv: Pick<TerminalHoldKv, "put">, sessionId: string, ttlMs: number, now: number = Date.now(),
): Promise<TerminalHold> {
  const hold: TerminalHold = { sessionId, until: now + ttlMs, at: now };
  await kv.put(terminalHoldKey(sessionId), enc.encode(JSON.stringify(hold)));
  return hold;
}

/** Whether a claim is in force at `now`. Never throws. */
export async function readTerminalHold(
  kv: Pick<TerminalHoldKv, "get">, sessionId: string, now: number = Date.now(),
): Promise<TerminalHoldState> {
  let entry: Awaited<ReturnType<TerminalHoldKv["get"]>>;
  try {
    entry = await kv.get(terminalHoldKey(sessionId));
  } catch (e) {
    return { state: "unreadable", reason: e instanceof Error ? e.message : String(e) };
  }
  // A deleted key answers with a tombstone rather than null.
  if (!entry || entry.operation === "DEL" || entry.operation === "PURGE" || entry.value.length === 0) {
    return { state: "none" };
  }
  let parsed: Partial<TerminalHold>;
  try {
    parsed = JSON.parse(dec.decode(entry.value)) as Partial<TerminalHold>;
  } catch {
    return { state: "unreadable", reason: "terminal hold record is not JSON" };
  }
  if (!parsed || typeof parsed.until !== "number" || !Number.isFinite(parsed.until)) {
    return { state: "unreadable", reason: "terminal hold record is malformed" };
  }
  return parsed.until > now ? { state: "held", until: parsed.until } : { state: "none" };
}
