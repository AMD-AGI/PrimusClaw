// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The version drain decides whether a Brain pod keeps taking new work.
 *
 * It used to be `brainVersion < wanted`, a lexicographic string compare, and it
 * failed silently: there is no else branch, and upgrade.sh only checks that the
 * KV write succeeded and that the rollout completed -- neither of which has
 * anything to do with whether a pod actually drained. So the cases below are
 * the three tag shapes build.sh produces, each of which the old comparison got
 * wrong on a pair that was actually deployed. Every case asserts the old
 * comparison's result first, so if anyone restores an ordering test these go
 * red rather than silently passing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DrainState, versionDrainAction } from "../src/infra/drain-state.js";

// A `<prefix>-<sha>-<timestamp>` tag, the shape build.sh emits. The sha's
// leading digit is deliberately mid-range: the cases below put a lower and a
// higher one against it, which is what made the old compare a coin flip.
const DEPLOYED = "main-7d91c40a-202608250431";

test("a bare-timestamp tag drains a prefixed one (build.sh's own default format)", () => {
  // 'm' (0x6d) > '2' (0x32), so `DEPLOYED < wanted` was false and the pod
  // kept pulling work while it was being terminated.
  const wanted = "202608251230";
  assert.equal(DEPLOYED < wanted, false, "precondition: the old compare got this wrong");
  assert.equal(versionDrainAction(DEPLOYED, wanted), "drain");
});

test("a same-prefix tag drains regardless of the sha's leading hex digit", () => {
  // The sha sits before the timestamp, so this was a coin flip per deploy.
  const lowSha = "main-0abc1234-202608251230";
  assert.equal(DEPLOYED < lowSha, false, "precondition: the old compare got this wrong");
  assert.equal(versionDrainAction(DEPLOYED, lowSha), "drain");

  const highSha = "main-fabc1234-202608251230";
  assert.equal(DEPLOYED < highSha, true, "the old compare happened to get this one right");
  assert.equal(versionDrainAction(DEPLOYED, highSha), "drain");
});

test("a differently-prefixed branch tag drains", () => {
  // Two feature builds in a row: the prefix decides the compare, so whether a
  // pod drains depends on the branch names rather than on which is newer.
  const deployed = "verify-1a2b3c4d-202608251203";
  const wanted = "patch-b6e2f108-202608251154";
  assert.equal(deployed < wanted, false, "precondition: the old compare got this wrong");
  assert.equal(versionDrainAction(deployed, wanted), "drain");
});

test("the current version keeps taking work", () => {
  assert.equal(versionDrainAction(DEPLOYED, DEPLOYED), "current");
});

test("surrounding whitespace does not make a pod drain itself", () => {
  assert.equal(versionDrainAction(DEPLOYED, `  ${DEPLOYED}\n`), "current");
});

test("a blank value is not a drain signal", () => {
  // Not hypothetical. brain.min_version lives in BRAIN_REGISTRY, a bucket
  // created with a 5 minute TTL ("short-lived coordination state"), so the key
  // expires shortly after the upgrade that wrote it and the watch delivers a
  // DEL marker carrying an empty value. An empty value is not this pod's
  // version, so an identity test with no guard here would drain the entire
  // fleet a few minutes after every upgrade. index.ts also filters on
  // entry.operation; this is the second line of that defence.
  assert.equal(versionDrainAction(DEPLOYED, ""), "ignore_blank");
  assert.equal(versionDrainAction(DEPLOYED, "   \n"), "ignore_blank");
});

test("an older tag still drains a newer pod, so a rollback is not ignored", () => {
  // The documented gap in the ordering scheme: rolling back to a lower tag
  // never drained the higher-tagged pods, so they kept serving alongside.
  const older = "main-11111111-202608010000";
  assert.equal(DEPLOYED < older, false);
  assert.equal(versionDrainAction(DEPLOYED, older), "drain");
});

// ── the shutdown / version-drain split ──────────────────────────────────────
//
// These pin the bug that made the ordering bug dangerous to fix. The signal
// handler's re-entrancy guard used to be the same flag the version drain set,
// so a version-drained pod returned from SIGTERM immediately and skipped its
// whole shutdown sequence. Fixing the ordering compare without this would have
// turned a drain that usually misfired into one that reliably fired -- and so
// turned a latent bug into one that hit every upgrade.

test("a version-drained pod still runs its shutdown when SIGTERM arrives", () => {
  const s = new DrainState();
  assert.equal(s.beginVersionDrain(), true);
  assert.equal(s.draining, true);
  // The regression: this returned false, and the handler returned at its guard
  // without aborting sessions, flushing deferred claims, or exiting.
  assert.equal(s.beginShutdown(), true, "SIGTERM must not be swallowed by a prior version drain");
});

test("a second SIGTERM is still ignored", () => {
  const s = new DrainState();
  assert.equal(s.beginShutdown(), true);
  assert.equal(s.beginShutdown(), false);
});

test("a repeated version-drain signal is ignored", () => {
  const s = new DrainState();
  assert.equal(s.beginVersionDrain(), true);
  assert.equal(s.beginVersionDrain(), false);
});

test("shutdown after a version drain reports shutdown as the reason", () => {
  const s = new DrainState();
  assert.equal(s.reason, null);
  s.beginVersionDrain();
  assert.equal(s.reason, "version");
  s.beginShutdown();
  assert.equal(s.reason, "shutdown", "the reason that ends the process wins");
});

test("a fresh pod is neither draining nor reporting a reason", () => {
  const s = new DrainState();
  assert.equal(s.draining, false);
  assert.equal(s.reason, null);
});

// ── shuttingDown is narrower than draining, and has to stay that way ────────
//
// Callers that stop for good on a drain must ask shuttingDown. claim-next-loop
// is the one that matters: it exits on shutdown and is never restarted, so
// gating it on `draining` cost the pod claim-next for the rest of its life the
// first time it version-drained -- including after the drain was released.

test("a version drain is draining but not shutting down", () => {
  const s = new DrainState();
  s.beginVersionDrain();
  assert.equal(s.draining, true, "it must still stop new work");
  assert.equal(s.shuttingDown, false, "but it is not terminal, so nothing may exit on it");
});

test("shutdown reports both, and a released version drain does not clear it", () => {
  const s = new DrainState();
  assert.equal(s.shuttingDown, false);
  s.beginVersionDrain();
  s.beginShutdown();
  assert.equal(s.shuttingDown, true);
  s.endVersionDrain();
  assert.equal(s.shuttingDown, true, "shutdown is one-way");
});

// ── releasing a drain taken on a stale value ────────────────────────────────
//
// The version drain must be reversible, and this is why. upgrade.sh writes the
// key at the END of an upgrade, so every replica of the new version boots while
// the PREVIOUS upgrade's value is still there, sees a tag that is not its own,
// and drains -- before the tag it belongs to has been written at all. The
// ordering test survived that by accident (it only tripped when the two tags
// sorted the wrong way); an identity test trips on every mismatch, and trips on
// all replicas at once. If the later, correct write could not undo it, an
// upgrade would report success over a fleet that takes no work and, because the
// readiness probe only looks at /health returning 200, still reports healthy.

test("a pod drained on a stale value resumes when the key names it", () => {
  const s = new DrainState();
  assert.equal(s.beginVersionDrain(), true);
  assert.equal(s.draining, true);
  assert.equal(s.endVersionDrain(), true, "the correct value must be able to undo a stale drain");
  assert.equal(s.draining, false, "and the pod must actually take work again");
  assert.equal(s.reason, null);
});

test("releasing a drain that was never entered is a no-op", () => {
  const s = new DrainState();
  assert.equal(s.endVersionDrain(), false);
  assert.equal(s.draining, false);
});

test("a released pod can drain again on a later version", () => {
  const s = new DrainState();
  s.beginVersionDrain();
  s.endVersionDrain();
  assert.equal(s.beginVersionDrain(), true, "release must not latch the pod open either");
  assert.equal(s.draining, true);
});

test("releasing the version drain never revives a pod that is shutting down", () => {
  // A pod on its way out must not start taking work again because a KV write
  // happened to name its version mid-shutdown.
  const s = new DrainState();
  s.beginVersionDrain();
  s.beginShutdown();
  assert.equal(s.draining, true);
  s.endVersionDrain();
  assert.equal(s.draining, true, "shutdown outlives the version drain");
  assert.equal(s.reason, "shutdown");
});
