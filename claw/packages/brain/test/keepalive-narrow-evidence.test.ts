// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Three places that decided a sandbox was idle on evidence narrower than the
 * question, and the rule each now follows.
 *
 * A sibling review of the Hands side found the same shape five times over --
 * "the leader is read where the group is meant, the registry where the world is
 * meant". These are the Brain's version of it. In all three the correction is
 * the same: only positive evidence of work holds a binding, and evidence that
 * is merely unavailable must never hold one, or a failed read strands every pod
 * this reclaim path exists to free.
 *
 * Asserted through the source rather than through a tick, because each is a
 * decision made between two I/O calls that this package's fakes cannot
 * interleave; what is pinned is the shape of the decision, and each assertion
 * names the statement it would fail on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(
  fileURLToPath(new URL("../src/sandbox/keepalive.ts", import.meta.url)),
  "utf8",
);

/** The body of one function, from its declaration to the next at column zero. */
function bodyOf(name: string): string {
  const at = SRC.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} is gone; this test is about it`);
  const after = SRC.slice(at);
  const end = after.indexOf("\n}\n");
  return after.slice(0, end > 0 ? end : after.length);
}

test("missing probe credentials do not erase a witnessed running verdict", () => {
  // Credentials gone means this replica cannot ask again. It does not mean the
  // answer is no, and a verdict another replica established is still evidence.
  // No credential is consulted where the verdict is read, so there is nothing
  // left that can answer "idle" on the strength of an address being absent.
  const body = bodyOf("peekBackgroundWork");
  const cachedRead = body.indexOf("usableCachedVerdict(");
  const sharedRead = body.indexOf("usableSharedVerdict(");
  const firstReturn = body.indexOf("return {");
  assert.ok(cachedRead >= 0 && cachedRead < firstReturn, "the cached verdict is read first");
  assert.ok(sharedRead >= 0 && sharedRead < firstReturn, "so is the shared one");
  assert.doesNotMatch(body, /handsUrl|token/, "no credential gates the read");
  // Whether this replica can ask at all is a separate question, asked where the
  // idle clock is advanced rather than where the verdict is read.
  assert.match(
    bodyOf("collectIdleTarget"), /canProbeJobs\(info, sessionId\)/,
    "the ability to probe gates the clock, not the evidence",
  );
});

test("incomplete probe credentials renew the KV TTL without reclaiming", () => {
  // Returning true without a write let BRAIN_REGISTRY_TTL_MS erase the handle
  // while idle-GC stayed off, so the Pod leaked until ShutdownTime.
  const body = bodyOf("collectIdleTarget");
  const gate = body.indexOf("!canProbeJobs(info, sessionId) && bgWork !== \"gone\"");
  assert.ok(gate >= 0, "the no-probe gate is still the decision point");
  const branch = body.slice(gate, gate + 280);
  assert.match(branch, /kv\.update\(key, value, e\.revision\)/,
    "the handle is renewed so Brain does not forget it");
  assert.doesNotMatch(branch, /refreshIdleSince/,
    "idle clocks must not slide while the roster cannot be confirmed");
});

test("expiry CAS is not self-bumped by jobs identity persistence", () => {
  // persistJobsIdentity during the destructive probe advanced the enrollment
  // revision the closing write conditioned on, so the first expiry always
  // self-collided and reclaim slipped a full sweep.
  assert.match(
    bodyOf("expireIdleTarget"),
    /persistIdentity:\s*false/,
    "the destructive probe skips identity binding",
  );
  assert.match(
    bodyOf("probeUserProcesses"),
    /persistIdentity !== false/,
    "background probes still bind identity by default",
  );
});

test("idle destroy re-checks the run lease after the jobs probe", () => {
  // A turn that starts during the (bounded) probe must not lose its sandbox.
  const body = bodyOf("expireIdleTarget");
  const probe = body.indexOf("probeUserProcesses(");
  const claim = body.indexOf("claimIdleStop(");
  assert.ok(probe >= 0 && claim > probe,
    "claimIdleStop runs on the success path after the sync jobs probe");
});

test("terminal idle reclaim writes terminalReason and closing in one CAS", () => {
  // Splitting reportTerminalFailure from claimIdleStop bumped the enrollment
  // revision so the closing write always lost to itself and destroy never ran.
  const expire = bodyOf("expireIdleTarget");
  assert.doesNotMatch(
    expire,
    /reportTerminalFailure/,
    "expiry must not write terminalReason in a separate update",
  );
  assert.match(
    bodyOf("claimIdleStop"),
    /terminalReason/,
    "claimIdleStop records terminalReason on the same closing CAS",
  );
  assert.match(
    bodyOf("reportTerminalFailure"),
    /status:\s*"closing"/,
    "background/ping terminal writes also close in the same update",
  );
});

test("an expired retry separates a failed lock read from an absent lock", () => {
  // `.catch(() => null)` made a KV hiccup indistinguishable from "nobody holds
  // this", and the unregister then ran on the strength of an error.
  const body = bodyOf("shouldSkipExpiredRetry");
  // Matched on the branch that acts, not on the name being present: deleting
  // the guard leaves its variable declared, and an earlier version of this
  // test passed against exactly that mutation.
  assert.match(
    body, /if \(lockReadFailed\)\s*\{[^}]*return false;/,
    "a failed read returns before anything is released",
  );
});

test("an expired retry stops the sandbox before dropping the hands pointer", () => {
  // After sandbox idle-GC was removed, deleting only the KV entry left the
  // workload (and any MN cluster) with no Brain pointer until workload TTL.
  // The stop is owed by the walk but not run inside it: the walk is serial and
  // a stop carries retries and sleeps, so it is queued for the budgeted phase
  // and its bookkeeping travels with it, to run only once the stop succeeded.
  const body = bodyOf("shouldSkipExpiredRetry");
  assert.doesNotMatch(
    body, /await destroyHands\(/,
    "the serial walk must not await a teardown",
  );
  const queued = body.indexOf("census.teardowns.push(");
  const drop = body.indexOf("deleteExpiredRetryRecord(");
  assert.ok(queued >= 0 && drop > queued,
    "the record is dropped by the queued item, not by the walk");
  assert.match(
    body.slice(queued),
    /after:\s*async \(\) => \{[\s\S]*deleteExpiredRetryRecord\(/,
    "dropping the pointer belongs to the after-stop callback",
  );
  const runner = bodyOf("collectTargets");
  assert.match(
    runner,
    /destroyHands\(item\.sessionId, item\.info, item\.token\)\s*\.then\([\s\S]*item\.after\?\.\(\)/,
    "the queued bookkeeping runs only after the stop resolved",
  );
  // Which record is acted on is decided by identity, not by whichever key
  // answers first: during a rolling upgrade the canonical key can hold a
  // different, live generation of the same session, and stopping that one
  // strands a running workload.
  assert.match(
    body, /recordNamingSandbox\(deps\.kv, sessionId, entry\)/,
    "the record to stop is the one naming this generation",
  );
  assert.doesNotMatch(
    body, /readHandsEntry\(/,
    "a canonical-first read cannot tell two generations apart",
  );
  assert.match(
    body, /pending\.workloadId !== entry\.workloadId\)\s*\{\s*return false;/,
    "a record naming another workload is not this retry's to stop",
  );
});

test("idle verdict re-stamps quiescedAt when the anchor was cleared", () => {
  // refreshIdleSince / clearIdleMarkers can drop quiescedAt while a fresh
  // shared idle verdict remains; refusing to re-stamp then left the reuse
  // window permanently open.
  const body = bodyOf("persistVerdict");
  assert.match(
    body,
    /quiescedAt:\s*info\.quiescedAt\s*\?\?\s*quiescedAt/,
    "an idle write must fill a missing quiescedAt",
  );
  assert.doesNotMatch(
    body,
    /usableSharedVerdict\(info\)\?\.state\s*!==\s*"idle"/,
    "already-idle must not block re-anchoring",
  );
});
