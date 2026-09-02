// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// review-p1-brain-fixes.test.ts
//
// Two review findings on the brain side. Both are cases where a distinction
// that existed in the data was thrown away before anyone could act on it.

import test from "node:test";
import assert from "node:assert/strict";
import { SandboxGoneError } from "../src/sandbox/errors.js";

test("a 404 from the control plane is a distinguishable answer, not a failed ping", () => {
  const e = new SandboxGoneError("workload absent (HTTP 404)");
  assert.equal((e as any).sandboxGone, true, "keepalive dispatches on this flag");
  assert.ok(e instanceof Error, "and it still behaves as an error everywhere else");
});

test("keepalive spends no further ticks once absence is established", async () => {
  // Before: a definite 404 spent the same five strikes as one dropped packet,
  // about five minutes during which the run still reads healthy. After: it
  // reaches the limit at once, while every other error keeps full tolerance.
  const src = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/sandbox/keepalive.ts", import.meta.url), "utf8"));
  assert.match(src, /sandboxGone === true/, "the flag must be consulted");
  assert.match(src, /Math\.max\(SANDBOX_KEEPALIVE_FAIL_LIMIT/,
    "and it must jump the counter to the limit rather than merely incrementing");
});

test("the exec path raises the typed error only for absence", async () => {
  const src = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/sandbox/safe-workload-provider.ts", import.meta.url), "utf8"));
  assert.match(src, /status === 404 \|\| resp\.status === 410\) throw new SandboxGoneError/,
    "404/410 only");
  assert.ok(src.includes("const msg = `sandboxExec failed: HTTP"),
    "and the message must stay identical: the container classifier parses this exact string, "
    + "so rewording it downgrades a definite 404 to merely unreachable");
});

test("a downgraded callback body caps failure_reason too", async () => {
  // The downgrade exists because the full body was already refused. Leaving
  // failure_reason uncapped -- on the script path it carries a failing step's
  // entire tool output -- meant the shed body could still be too large, so all
  // three attempts 413'd and every JetStream redelivery failed identically.
  const src = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/tasks/callback.ts", import.meta.url), "utf8"));
  const fn = src.slice(src.indexOf("function withoutPayload"), src.indexOf("function withoutPayload") + 900);
  assert.ok(fn.includes("failure_reason"), "the downgrade must touch failure_reason");
  assert.match(fn, /truncate\(body\.failure_reason, MAX_DOWNGRADED_REASON_BYTES/,
    "with a cap smaller than the one the full body already exceeded");
  const cap = /MAX_DOWNGRADED_REASON_BYTES = ([\d *]+);/.exec(src);
  const full = /MAX_FINAL_TEXT_BYTES = ([\d *]+);/.exec(src);
  assert.ok(cap && full, "both caps declared");
  assert.ok(eval(cap[1]) < eval(full[1]), "and strictly smaller than the final-text cap");
});
