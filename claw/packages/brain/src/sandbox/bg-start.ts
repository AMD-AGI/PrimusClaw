// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What to do with a background start that may be a replay, and how to address
 * an existing shell on a sandbox that partitions by owner alone.
 *
 * Two windows, closed by different evidence. A crash after the durable
 * `dispatched` write and before the request reached the transport leaves a row
 * for a send that never went out; deciding from the row alone would strand it
 * as permanently unknown for work that in fact never ran. A crash after the
 * spawn leaves a shell whose id must never be started a second time. The rule
 * separating them is positive in both directions and never rests on absence
 * alone: a readable subtree beneath a readable epoch marker holding no record
 * says no claim landed, because the claim precedes the spawn and nothing
 * deletes a record while its sandbox lives.
 */

import { encodeKeyPart } from "@claw/protocol";
import type { BgHandleRow } from "./bg-handle-rows.js";

/** What a read of the sandbox's own record subtree returned. */
export type RecordProbe =
  | { kind: "record_present" }
  /** Marker readable, subtree readable, no record for this address. */
  | { kind: "determinately_absent" }
  /** Subtree or epoch marker unreadable, or no marker for the running process. */
  | { kind: "indeterminate" };

export interface StartResolution {
  /**
   * `dispatch` sends the start; `retransmit` re-sends the identical one, an
   * unfinished send finished rather than a second intent; the rest send nothing.
   */
  action: "dispatch" | "retransmit" | "resolve" | "refuse";
  reported: "first_call" | "deduplicated" | "unknown" | "retry_expired";
  /** The class the caller is told, where the answer carries one. */
  shellClass?: "lost" | "unknown";
  reason: string;
}

const DISPATCH: StartResolution = {
  action: "dispatch", reported: "first_call",
  reason: "the request never reached the transport, so nothing ran under any generation",
};

/**
 * Decide a start from the reference row and, where the row demands it, a read
 * of the sandbox's records.
 *
 * `row` is the value read; `rowReadable` false means the read itself failed,
 * which is never guessed at. `probe` is consulted only on the branches that
 * need it, and it starts nothing on any Hands of any version.
 */
export async function resolveStart(input: {
  row: BgHandleRow | null;
  rowReadable: boolean;
  currentGeneration: string | null;
  /**
   * Whether the answering sandbox files durable records at all. A process that
   * files none has no record route to ask, so waiting for one to answer is
   * waiting forever.
   */
  sandboxFilesRecords: boolean;
  probe: () => Promise<RecordProbe>;
}): Promise<StartResolution> {
  const { row, rowReadable, currentGeneration, sandboxFilesRecords, probe } = input;

  if (!rowReadable) {
    return {
      action: "refuse", reported: "unknown", shellClass: "unknown",
      reason: "the reference row could not be read, and an unreadable row is not an absent one",
    };
  }
  if (!row || row.state === "issued") return DISPATCH;

  // A sandbox destroyed and not replaced has no current generation, so a
  // surviving row is necessarily under a prior one.
  const priorGeneration = currentGeneration === null || row.generation !== currentGeneration;
  if (priorGeneration) {
    return row.state === "spawn_confirmed"
      ? {
        action: "resolve", reported: "deduplicated", shellClass: "lost",
        reason: "the sandbox that ran this command has been replaced",
      }
      : {
        action: "refuse", reported: "unknown", shellClass: "unknown",
        reason: "the crash between the request leaving and its confirmation, read "
          + "against a sandbox that can no longer be asked",
      };
  }

  // A replay is never sent as a start to a sandbox that files no records, and
  // the row's state answers it instead. Retransmitting there looks safe and is
  // not: such a process arbitrates a duplicate name only from an in-process map
  // that loses the entry when the shell is reaped and loses every entry when it
  // restarts, so the same send starts a second process against a shell that is
  // still running -- which is what the row exists to prevent.
  if (!sandboxFilesRecords) {
    return row.state === "spawn_confirmed"
      ? {
        action: "resolve", reported: "deduplicated", shellClass: "lost",
        reason: "the row attests a shell on a sandbox that keeps no record of it",
      }
      : {
        action: "refuse", reported: "unknown", shellClass: "unknown",
        reason: "no arbiter answers on a sandbox that files no records, so whether "
          + "this start reached it cannot be determined",
      };
  }

  const observed = await probe();
  if (row.state === "spawn_confirmed") {
    return observed.kind === "record_present"
      ? { action: "resolve", reported: "deduplicated", reason: "this intent already produced a shell" }
      : observed.kind === "determinately_absent"
        ? {
          action: "resolve", reported: "deduplicated", shellClass: "lost",
          reason: "the row attests a shell, so the record demonstrably existed and is gone",
        }
        : {
          action: "refuse", reported: "unknown", shellClass: "unknown",
          reason: "the absence is not determinate and nothing about this shell was observed",
        };
  }

  // `dispatched` under the current generation: the one send window that is
  // finished rather than decided from the row.
  if (observed.kind === "record_present") {
    return { action: "resolve", reported: "deduplicated", reason: "the send did land" };
  }
  if (observed.kind === "determinately_absent") {
    return {
      action: "retransmit", reported: "first_call",
      reason: "no claim landed, so the identical start is re-sent; the sandbox's "
        + "exclusive create arbitrates a send that may nonetheless have gone out",
    };
  }
  return {
    action: "refuse", reported: "unknown", shellClass: "unknown",
    reason: "no arbiter answers where the marker or the subtree cannot be read",
  };
}

/**
 * The id to put on the wire for a sandbox that resolves by owner scope and id
 * alone.
 *
 * Such a process would leave the run half of the address unenforced for as long
 * as it answers, and there is no mixed-version exemption from that. A reference
 * row cannot supply the missing half however it is maintained: an id is freed
 * when its shell is reaped, a second run may then be given the same one, and
 * the first run's row still names it. So the boundary is folded into the id
 * itself, by a total injective transform two run identities can never collide
 * under. The public id is untouched -- this is applied at the wire boundary and
 * only there, and nothing is truncated, because truncation costs injectivity.
 */
export function runQualifiedShellId(runIdentity: string, publicShellId: string): string {
  return `${encodeKeyPart(runIdentity)}.${encodeKeyPart(publicShellId)}`;
}

/** The calls whose `shell_id` names an existing shell, and a start that fixes one. */
export function isShellAddressingCall(name: string, args: Record<string, unknown>): boolean {
  if (name === "bash_output" || name === "kill_shell" || name === "wait") return true;
  return name === "bash" && args.run_in_background === true;
}

/**
 * Put the model's own id back into a result that echoes the wire form.
 *
 * The qualified id exists between Brain and one sandbox and nowhere else. Left
 * in the text, it becomes the id the model sends back -- and Brain would then
 * qualify it a second time, addressing a shell that does not exist.
 */
export function restorePublicShellId(
  text: string, wireId: unknown, publicId: unknown,
): string {
  if (typeof wireId !== "string" || typeof publicId !== "string" || wireId === publicId) {
    return text;
  }
  return text.split(wireId).join(publicId);
}

/**
 * The same restoration inside a tool's structured answer.
 *
 * The text is not the only place the id comes back: a start echoes it as a
 * field, a script step keeps that result, and a later step interpolates the
 * shell id from it. Left qualified there, the next read or kill qualifies an
 * already-qualified id and addresses a shell that does not exist -- a failure
 * that only appears on the script route and only against an older sandbox.
 */
export function restoreStructuredShellId(
  structured: unknown, wireId: unknown, publicId: unknown,
): unknown {
  if (typeof wireId !== "string" || typeof publicId !== "string" || wireId === publicId) {
    return structured;
  }
  if (!structured || typeof structured !== "object") return structured;
  const out: Record<string, unknown> = { ...(structured as Record<string, unknown>) };
  for (const [field, value] of Object.entries(out)) {
    if (typeof value === "string") out[field] = value.split(wireId).join(publicId);
  }
  return out;
}
