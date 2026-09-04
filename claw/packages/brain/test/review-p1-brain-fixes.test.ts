// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// review-p1-brain-fixes.test.ts
//
// Two review findings on the brain side. Both are cases where a distinction
// that existed in the data was thrown away before anyone could act on it.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  SandboxExecRouteUnavailableError,
  SandboxGoneError,
} from "../src/sandbox/errors.js";
import { SafeWorkloadProvider } from "../src/sandbox/safe-workload-provider.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const INSTANCE = {
  provider: "safe-workload" as const,
  id: "wl-1",
  sandboxName: "wl-1",
  namespace: "ns",
  handsBaseUrl: "",
  platformKey: "pk-1",
};

test("a 404 from the control plane is a distinguishable answer, not a failed ping", () => {
  const e = new SandboxGoneError("workload absent (HTTP 404)");
  assert.equal((e as any).sandboxGone, true, "keepalive dispatches on this flag");
  assert.ok(e instanceof Error, "and it still behaves as an error everywhere else");
});

test("a Router 404 cannot call a running workload gone", async () => {
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) {
      return { ok: false, status: 404, text: async () => "route not found" } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ phase: "Running" }) } as Response;
  }) as typeof globalThis.fetch;

  await assert.rejects(
    () => new SafeWorkloadProvider().exec(INSTANCE, "true", "1s"),
    SandboxExecRouteUnavailableError,
  );
});

test("the exec path raises the typed gone error only after independent confirmation", async () => {
  globalThis.fetch = (async () =>
    ({ ok: false, status: 404, text: async () => "not found" }) as Response
  ) as typeof globalThis.fetch;

  await assert.rejects(
    () => new SafeWorkloadProvider().exec(INSTANCE, "true", "1s"),
    SandboxGoneError,
  );
});

test("terminated is a conclusive workload phase", async () => {
  globalThis.fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ phase: "Terminated" }) }) as Response
  ) as typeof globalThis.fetch;

  assert.deepEqual(
    await new SafeWorkloadProvider().get(INSTANCE),
    { running: false, healthy: false, state: "terminal" },
  );
});

test("the shipped chart does not opt every sandbox into automatic eviction", async () => {
  const values = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../../../deploy/charts/claw/values.yaml", import.meta.url), "utf8"));
  assert.match(values, /sandboxKeepaliveFailLimit:\s*"0"/);
});

test("a downgraded callback body caps failure_reason too", async () => {
  // The downgrade exists because the full body was already refused. Leaving
  // failure_reason uncapped -- on the script path it carries a failing step's
  // entire tool output -- meant the shed body could still be too large, so all
  // three attempts 413'd and every JetStream redelivery failed identically.
  const src = await import("node:fs/promises")
    .then((fs) => fs.readFile(new URL("../src/tasks/callback.ts", import.meta.url), "utf8"));
  // To the end of the function, not a fixed number of characters from its
  // start: the cap is a property of the whole downgrade, and a window measured
  // in bytes silently stops covering it the moment the function grows.
  const from = src.indexOf("function withoutPayload");
  const fn = src.slice(from, src.indexOf("\n}", from));
  assert.ok(fn.includes("failure_reason"), "the downgrade must touch failure_reason");
  assert.match(fn, /truncate\(body\.failure_reason, MAX_DOWNGRADED_REASON_BYTES/,
    "with a cap smaller than the one the full body already exceeded");
  const cap = /MAX_DOWNGRADED_REASON_BYTES = ([\d *]+);/.exec(src);
  const full = /MAX_FINAL_TEXT_BYTES = ([\d *]+);/.exec(src);
  assert.ok(cap && full, "both caps declared");
  assert.ok(eval(cap[1]) < eval(full[1]), "and strictly smaller than the final-text cap");
});
