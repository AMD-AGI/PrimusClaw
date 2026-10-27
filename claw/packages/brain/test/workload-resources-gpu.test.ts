// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An app run's sandbox spec names its GPUs `amd.com/gpu`; SaFE's workload API
 * wants `gpu` (and fills `gpuName` itself). The count must survive into the body
 * POSTed to SaFE, and a run without GPUs must not grow one.
 */
import "./sweeper-evict-env.js";

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { resourcesMapToWorkloadArray } from "../src/sandbox/params.js";
import { SafeWorkloadProvider } from "../src/sandbox/safe-workload-provider.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** The `resources` the provider POSTs to SaFE for a given resource map. */
async function postedResources(resources: Record<string, string>): Promise<unknown> {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return new Response("stop", { status: 400 });
  }) as typeof fetch;
  await assert.rejects(new SafeWorkloadProvider().create({
    sessionId: "s", namespace: "ws", image: "img:1", resources, env: {}, platformKey: "pk",
  } as never), /HTTP 400/);
  return body!.resources;
}

test("an app run with gpus=N sends gpu=N to SaFE, and no second GPU key", async () => {
  for (const n of ["1", "8"]) {
    const sent = await postedResources({ cpu: "4", memory: "16Gi", "amd.com/gpu": n });
    assert.deepEqual(sent, [{ cpu: "4", memory: "16Gi", gpu: n, replica: 1 }]);
  }
});

test("gpus=0 (no GPU key) sends no gpu", async () => {
  const sent = await postedResources({ cpu: "4", memory: "16Gi" });
  assert.deepEqual(sent, [{ cpu: "4", memory: "16Gi", replica: 1 }]);
});

test("Hands' own `gpu` form is unchanged, and wins over the alias", () => {
  assert.deepEqual(resourcesMapToWorkloadArray({ cpu: "12", memory: "128Gi", gpu: "1" }),
    [{ cpu: "12", memory: "128Gi", gpu: "1", replica: 1 }]);
  assert.deepEqual(resourcesMapToWorkloadArray({ gpu: "2", "amd.com/gpu": "1" }), [{ gpu: "2", replica: 1 }]);
});

test("other slash-named resources still pass through", () => {
  assert.deepEqual(resourcesMapToWorkloadArray({ cpu: "1", "example.com/x": "3" }),
    [{ cpu: "1", "example.com/x": "3", replica: 1 }]);
});
