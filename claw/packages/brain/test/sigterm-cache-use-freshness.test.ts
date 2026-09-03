// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A SIGTERM inside a tool batch must not age the run's cache entry.
 *
 * The agent loop learns that a turn used the prefix cache from that turn's
 * response, and persists the fact at the NEXT turn boundary. Between those two
 * moments lies the turn's whole tool batch, which can be half an hour of one
 * bash call. A SIGTERM landing there writes the PREVIOUS turn's timestamp, and
 * the resumed run measures a gap overstated by the length of the batch --
 * biasing the diagnosis towards "over_ttl" on exactly the runs where a tool
 * call ran long, which is where a real cache loss is most expensive to
 * misattribute.
 *
 * The fix deliberately adds no write. The loop notifies the runner in memory
 * the moment the cache is used, and the SIGTERM path -- already about to
 * persist a checkpoint -- persists a fresher number in it. The periodic
 * checkpoint cadence is untouched.
 *
 * The three ways the freshened value could still fail to reach KV -- a resumed
 * run with no checkpoint of its own yet, a run that never opened a sandbox, and
 * a compaction the runner was never told about -- are driven through the runner
 * in sigterm-cache-use-lifecycle. This file is the overlay and the wiring.
 *
 * Residual, accepted: a run SIGTERMed during its FIRST tool batch has
 * `turns_completed === 0` and the SIGTERM path writes no checkpoint at all, so
 * there is nothing to freshen. That run resumes with no timestamp, which reads
 * as "no evidence an entry exists" -- the detector's under-reporting default,
 * not a false loss.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { __test__ } from "../src/tasks/runner.js";
import type { CheckpointState } from "../src/agent/index.js";

const { freshenCacheUse } = __test__;

const LOOP = readFileSync(
  fileURLToPath(new URL("../src/agent/agent-loop.ts", import.meta.url)), "utf8",
);
const RUNNER = readFileSync(
  fileURLToPath(new URL("../src/tasks/runner.ts", import.meta.url)), "utf8",
);
const ENGINE = readFileSync(
  fileURLToPath(new URL("../src/agent/engine.ts", import.meta.url)), "utf8",
);

function state(over: Partial<CheckpointState> = {}): CheckpointState {
  return {
    turns_completed: 4,
    messages: [],
    ...over,
  } as CheckpointState;
}

test("a timestamp from inside the running turn replaces the turn boundary's", () => {
  const boundary = state({ last_cache_use_at: 1_000 });
  const fresher = freshenCacheUse(boundary, 5_000);
  assert.equal(fresher.last_cache_use_at, 5_000);
  // The checkpoint is otherwise untouched -- this is an overlay, not a rewrite.
  assert.equal(fresher.turns_completed, 4);
  assert.notEqual(fresher, boundary);
});

test("a checkpoint with no timestamp gains one", () => {
  assert.equal(freshenCacheUse(state(), 5_000).last_cache_use_at, 5_000);
});

test("the timestamp never moves backwards", () => {
  // A resumed run's checkpoint carries a timestamp from a previous attempt.
  // That is evidence too, and it is older than anything this attempt saw only
  // because this attempt has not hit the cache yet.
  const resumed = state({ last_cache_use_at: 9_000 });
  assert.equal(freshenCacheUse(resumed, 5_000), resumed);
  assert.equal(freshenCacheUse(resumed, 9_000), resumed);
});

test("nothing to say costs nothing: the same object comes back", () => {
  const s = state({ last_cache_use_at: 1_000 });
  assert.equal(freshenCacheUse(s, undefined), s);
});

test("the loop reports cache use at the moment it records it", () => {
  // Not at the next checkpoint: the point of the callback is the window
  // between the response and that checkpoint.
  assert.ok(
    /this\.lastCacheUseAt = turnStart;[\s\S]{0,400}?this\.opts\.onCacheUse\?\.\(turnStart\)/
      .test(LOOP),
    "onCacheUse must fire alongside the in-memory timestamp update, with the "
      + "same value that would be checkpointed",
  );
});

test("the notification is wired from the loop through to the SIGTERM path", () => {
  assert.ok(
    /onCacheUse: extras\?\.onCacheUse/.test(ENGINE),
    "the engine must forward it into the agent loop",
  );
  assert.ok(
    /onCacheUse: this\.onCacheUse/.test(RUNNER),
    "the runner must supply it",
  );
  assert.ok(
    /sigtermCheckpointState\(\s*this\.latestCheckpointState, this\.pendingResumeCkpt, this\.latestCacheUseAt,?\s*\)/
      .test(RUNNER),
    "and the SIGTERM checkpoint must be the freshened one -- a callback whose "
      + "value never reaches a write is the same as no callback. What that "
      + "write then contains is asserted end to end in "
      + "sigterm-cache-use-lifecycle.",
  );
});
