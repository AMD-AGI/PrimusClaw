// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Run the holder-release retry as the only thing on the event loop.
 *
 * A child process, because that is the only place the property is observable:
 * inside the test runner other handles keep the loop alive, so an unref'd
 * backoff timer still gets to fire and the bug hides. Here nothing else is
 * pending, so a timer that does not hold the loop ends the process instead --
 * node reports "unsettled top-level await" and exits 13 without printing.
 */
process.env.INTERNAL_BACKEND_URL = "http://api.example";

const statuses: number[] = [];
globalThis.fetch = (async () => {
  const status = statuses.length < 1 ? 500 : 409;
  statuses.push(status);
  return new Response(JSON.stringify({ ok: false }), {
    status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const { failClaimedRun } = await import("../../src/clients/run-claim.js");
await failClaimedRun("ktsk_1");
console.log(`RETRIED ${statuses.join(",")}`);
