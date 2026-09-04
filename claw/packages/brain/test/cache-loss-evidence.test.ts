// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The cache-loss counter may only fire on evidence.
 *
 * It reports a defect, and a defect counter that invents hits is worse than no
 * counter -- the first investigation goes to the wrong place, which is exactly
 * what happened when the anchor breakpoint was folded into the rolling-gap
 * maximum.
 *
 * Three guards keep it honest, and the third is the one this file exists for.
 * Markers must have gone out (`cacheReport.enabled`), the provider must have
 * *said* zero rather than omitted usage (`reported` includes cache_read), and
 * an entry must have existed to lose. That last one was briefly inferred from
 * `initialTurn > 0`, on the reasoning that a redelivery arrives with nothing in
 * memory. The inference routed around both other guards: a resumed run that had
 * compacted -- where the timestamp is cleared precisely because the entry is
 * gone -- and one whose markers had been refused before the interruption were
 * both counted as losses. It is answered with a persisted timestamp now.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOOP = readFileSync(
  fileURLToPath(new URL("../src/agent/agent-loop.ts", import.meta.url)), "utf8",
);
const OPENAI = readFileSync(
  fileURLToPath(new URL("../src/llm/openai-provider.ts", import.meta.url)), "utf8",
);
const STATE = readFileSync(
  fileURLToPath(new URL("../src/agent/index.ts", import.meta.url)), "utf8",
);

test("turn count is not used as a substitute for having written to the cache", () => {
  // Matched as the disjunct it was, not as a bare mention: initialTurn is a
  // legitimate loop bound elsewhere in this file, and the comment recording
  // why the disjunct went away names it too.
  assert.ok(
    !/\|\|\s*this\.initialTurn\s*>\s*0/.test(LOOP),
    "a high turn count says the run is old, not that a cache entry exists; "
      + "compaction and refused markers both produce one with nothing to lose",
  );
});

test("the cache timestamp is persisted and restored, so a resume has real evidence", () => {
  assert.ok(
    /last_cache_use_at\?: number/.test(STATE),
    "CheckpointState must carry the timestamp",
  );
  assert.ok(
    /last_cache_use_at:\s*this\.lastCacheUseAt/.test(LOOP),
    "the checkpoint must be written with it",
  );
  assert.ok(
    /this\.lastCacheUseAt\s*=\s*resumeFrom\?\.last_cache_use_at/.test(LOOP),
    "and a resume must restore it -- otherwise the guard below can never pass "
      + "after a redelivery, which is the case the whole detector was extended for",
  );
});

test("the loss branch is gated on the timestamp alone", () => {
  const guard = LOOP.indexOf("&& this.lastCacheUseAt !== undefined");
  assert.notEqual(guard, -1, "the evidence guard is gone");
  const call = LOOP.indexOf("metrics.onCacheEntryLost(");
  assert.ok(guard < call && call - guard < 1200, "the guard must enclose the increment");
});

test("both providers attach the headers that identify the upstream", () => {
  // The OpenAI path captured them and then dropped them: a deployment on
  // LLM_API_STYLE=openai set LLM_DEBUG_RESPONSE_HEADERS, got nothing, and had
  // no error to explain why.
  assert.ok(
    /upstreamHeaders:\s*capture\.headers/.test(OPENAI),
    "openai-provider must put the captured headers into its cacheReport",
  );
});
