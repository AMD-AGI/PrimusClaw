// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A holder action on a pod that has no cluster API base to post it to.
 *
 * The shape is a fat-only deployment: `RUN_DOORBELL_DISPATCH` is on but
 * INTERNAL_BACKEND_URL is empty, which is a configuration the brain warns about
 * and then runs. Its fat pre-gate takes each lease through the `run_lease.url`
 * the API put on the wire, and gives it back through `settleClaimedRun`, which
 * addresses this pod's own INTERNAL_BACKEND_URL -- so every release is a no-op.
 *
 * Driven in a child process because the only evidence is a log record, and pino
 * writes to fd 1 through sonic-boom: neither `process.stdout.write` nor
 * `fs.writeSync` sees it from inside the test. Same reason as
 * deadline-log-turns.
 */
process.env.INTERNAL_BACKEND_URL = "";

const { settleClaimedRun } = await import("../../src/clients/run-claim.js");

// Exactly the call the pre-gate's `release` makes, generation and all.
await settleClaimedRun("ktsk_fat", 3, undefined, true, { attempts: 1 });

// Reached only if the release returned rather than threw. The drain branch in
// delivery/dispatch.ts naks immediately after it and documents that the release
// "reports its own failures rather than raising them, so the nak always
// follows": made loud must not become made fatal.
console.log("FIXTURE released");
