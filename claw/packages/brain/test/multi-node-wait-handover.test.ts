// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What an aborted multi-node wait does to the cluster, and what its start
// ceiling is by default. The run's signal also fires for a graceful restart and
// for a successor taking the run over; the redelivered or successor run adopts
// the cluster by message id, so only a cancel may delete it. And the ceiling that
// is right for a single sandbox would delete a healthy GPU cluster that is still
// pulling a large image or waiting for its role pods, so it is off here unless
// configured.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";
import type { WorkloadWaitDeps } from "../src/sandbox/workload-wait.js";

process.env.SAFE_API_URL = "http://safe.test";
const { SafeMultiNodeProvider } = await import("../src/sandbox/multi-node/safe-provider.js");
const { resolveTopology } = await import("../src/sandbox/multi-node/prompt-flags.js");
const { SandboxProvisionTerminalError } = await import("../src/sandbox/errors.js");

const spec = resolveTopology({
  prompt: "train --nodes 2 --mn-backend rayjob --mn-image img:1",
} as ExecuteRequest)!;

function recordSafe(t: TestContext, reply: (method: string) => Response) {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const method = String(init?.method ?? "GET");
    seen.push(method);
    return reply(method);
  }) as typeof globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  return seen;
}

function clock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      if (now > 100_000_000) throw new Error("wait did not end");
      now += ms;
    },
  };
}

const notReady = () => new Response(JSON.stringify({ phase: "NotReady", pods: [] }), { status: 200 });

function wait(opts: { signal?: AbortSignal; reclaimOnAbort?: () => boolean; sleepAborts?: AbortController; deps?: Partial<WorkloadWaitDeps> }) {
  const c = clock();
  let polls = 0;
  return new SafeMultiNodeProvider().waitForRunning(
    "sess", "msg", "mn-msg-rayjob", "key", "ws", spec, async () => {},
    {
      sleepImpl: async (ms) => {
        if (++polls === 2) opts.sleepAborts?.abort(new Error("stop"));
        await c.sleep(ms);
      },
      nowImpl: c.now, pollMs: 5000, unreadableTimeoutMs: 0, pendingTimeoutMs: 0, ...opts.deps,
    },
    opts.signal,
    opts.reclaimOnAbort,
  );
}

test("a cancel during the wait deletes the cluster", { timeout: 5000 }, async (t) => {
  const seen = recordSafe(t, (m) => (m === "DELETE" ? new Response("", { status: 204 }) : notReady()));
  const ctl = new AbortController();
  await assert.rejects(
    wait({ signal: ctl.signal, sleepAborts: ctl, reclaimOnAbort: () => true }),
    (e: unknown) => e instanceof SandboxProvisionTerminalError && e.reason === "sandbox_wait_interrupted",
  );
  assert.ok(seen.includes("DELETE"), `requests: ${seen.join(",")}`);
});

test("an abort that is not a cancel (restart or lease loss) leaves the cluster alone", { timeout: 5000 }, async (t) => {
  const seen = recordSafe(t, (m) => (m === "DELETE" ? new Response("", { status: 204 }) : notReady()));
  const ctl = new AbortController();
  await assert.rejects(
    wait({ signal: ctl.signal, sleepAborts: ctl, reclaimOnAbort: () => false }),
    (e: unknown) => e instanceof SandboxProvisionTerminalError && e.reason === "sandbox_wait_interrupted",
  );
  assert.ok(!seen.includes("DELETE"), `the cluster must not be deleted: ${seen.join(",")}`);
});

test("by default a multi-node cluster is not given up on for starting slowly", { timeout: 5000 }, async (t) => {
  // Three hours of NotReady, then Running: the sandbox ceiling's 15 minutes
  // must not apply to a GPU cluster.
  let polls = 0;
  const seen = recordSafe(t, (m) => {
    if (m === "DELETE") return new Response("", { status: 204 });
    return ++polls > 2160
      ? new Response(JSON.stringify({ phase: "Running", pods: [] }), { status: 200 })
      : notReady();
  });
  const detail = await wait({});
  assert.equal(detail.phase, "Running");
  assert.ok(!seen.includes("DELETE"));
});

test("a configured multi-node start ceiling still ends the wait, deleting the cluster", { timeout: 5000 }, async (t) => {
  const seen = recordSafe(t, (m) => (m === "DELETE" ? new Response("", { status: 204 }) : notReady()));
  await assert.rejects(
    wait({ deps: { startTimeoutMs: 600_000 } }),
    (e: unknown) => e instanceof SandboxProvisionTerminalError && e.reason === "sandbox_start_timeout",
  );
  assert.ok(seen.includes("DELETE"));
});
