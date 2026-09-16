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
