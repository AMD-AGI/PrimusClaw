// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a pod should do with one `brain.min_version` value.
 *
 * This lives outside index.ts only so it can be tested: index.ts calls main()
 * at import time, so a test that imported it would start a Brain.
 */
export type VersionDrainAction =
  /** Blank/whitespace value — no signal. Draining on it would stop the fleet. */
  | "ignore_blank"
  /** This pod is the version the operator wants. Keep taking work. */
  | "current"
  /** This pod is not that version. Stop taking new work. */
  | "drain";

/**
 * Identity, not order.
 *
 * This was `brainVersion < wanted` — a JS string comparison, i.e. lexicographic
 * by code unit. That only means "older" when the tag is a fixed-width
 * big-endian timestamp and nothing else. Deployed tags are
 * `<prefix>-<sha>-<timestamp>`, so the comparison is decided by the prefix and
 * then by a random hex sha, and the timestamp — the only part encoding recency
 * — is never reached.
 *
 * The question the caller means is "am I the current one?", which is what this
 * answers, and it is total over any naming scheme. It also fails safe: a value
 * this pod does not recognise stops new work rather than quietly keeping it.
 */
export function versionDrainAction(brainVersion: string, rawWanted: string): VersionDrainAction {
  const wanted = rawWanted.trim();
  if (!wanted) return "ignore_blank";
  return wanted === brainVersion ? "current" : "drain";
}

/**
 * The two reasons a pod stops taking work, kept apart on purpose.
 *
 * They were one boolean, and the signal handler's re-entrancy guard was that
 * boolean. During an upgrade the version drain often lands first — upgrade.sh
 * writes the KV key once the new pods are Ready, and the old pods are being
 * terminated around the same moment, so which arrives first is a race that the
 * drain wins some of the time. Whenever it did, the flag was already set when
 * SIGTERM arrived, the handler returned at its guard, and the pod never aborted
 * its sessions, never flushed its deferred claims and never exited. It sat
 * until SIGKILL, and its in-flight runs lost the checkpoint
 * `handleSigtermAbort` writes, because the abort reason that path keys on is
 * set by the handler that never ran.
 *
 * So: shutdown re-entrancy is guarded by the shutdown flag alone, and
 * `beginShutdown()` must still return true for a pod that has already
 * version-drained. That is the invariant the tests pin.
 */
export class DrainState {
  private shutdown = false;
  private version = false;

  /** True once this pod should stop accepting new work, for either reason. */
  get draining(): boolean {
    return this.shutdown || this.version;
  }

  /**
   * True once shutdown has begun — the terminal reason, as opposed to the
   * version drain, which `endVersionDrain()` can undo.
   *
   * Anything that stops for good on a drain has to ask this rather than
   * {@link draining}, because a version drain is not permission to stop for
   * good. `claim-next-loop` is the case that matters: its polling loop exits
   * on shutdown and is never restarted, so gating it on the combined
   * predicate meant one version drain ended claim-next for the pod's whole
   * life, including after the drain was released.
   */
  get shuttingDown(): boolean {
    return this.shutdown;
  }

  /** Why, for /health. Shutdown wins: it is the one that ends the process. */
  get reason(): "shutdown" | "version" | null {
    if (this.shutdown) return "shutdown";
    if (this.version) return "version";
    return null;
  }

  /**
   * Enter shutdown. Returns false only if shutdown was *already* under way, so
   * a second SIGTERM is ignored — but a prior version drain never is.
   */
  beginShutdown(): boolean {
    if (this.shutdown) return false;
    this.shutdown = true;
    return true;
  }

  /** Enter the version drain. Returns false if it was already entered. */
  beginVersionDrain(): boolean {
    if (this.version) return false;
    this.version = true;
    return true;
  }

  /**
   * Leave the version drain, because the key now names this pod's version.
   * Returns false if it was not in one. Shutdown is untouched: a pod on its
   * way out never comes back.
   *
   * This has to be reversible, and it is the whole reason the version drain
   * does not stop the consumer.
   *
   * A pod can drain on a value that is merely *stale* rather than newer than
   * it. The key is written at the end of an upgrade, so a pod that boots while
   * the previous upgrade's value is still there sees a tag that is not its own
   * and drains — before the tag it is actually part of has been written. Under
   * the ordering test that was survivable, because it only tripped when the
   * two tags happened to sort the wrong way; under an identity test it trips
   * on any mismatch, and it would trip on every replica at once.
   *
   * So the correct value arriving afterwards must be able to undo it. If it
   * could not, the drain would fail closed: an upgrade would report success
   * with a fleet that takes no work and reports itself healthy.
   */
  endVersionDrain(): boolean {
    if (!this.version) return false;
    this.version = false;
    return true;
  }
}
