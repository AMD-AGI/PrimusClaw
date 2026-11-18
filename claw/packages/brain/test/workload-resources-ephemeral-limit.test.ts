// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox is scheduled on its ephemeral-storage request and may grow to a
 * larger limit when the resource row names `ephemeralStorageLimit`. SaFE only
 * sees the limit if it survives into the body POSTed to it.
 */
import "./sweeper-evict-env.js";

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { resourcesMapToWorkloadArray } from "../src/sandbox/params.js";
import { resourcesJsonToWorkloadArray } from "../src/sandbox/workload-resources.js";
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

const ROW = { cpu: "4", gpu: "0", memory: "16Gi", ephemeralStorage: "20Gi", ephemeralStorageLimit: "100Gi" };

test("a resource row's ephemeralStorageLimit reaches SaFE next to the request", async () => {
  const [entry] = resourcesJsonToWorkloadArray(ROW)!;
  assert.deepEqual(entry, {
    cpu: "4", gpu: "0", memory: "16Gi", ephemeralStorage: "20Gi", ephemeralStorageLimit: "100Gi", replica: 1,
  });
  const map = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== "replica").map(([k, v]) => [k, String(v)]));
  const sent = await postedResources(map);
  assert.deepEqual(sent, [{
    cpu: "4", gpu: "0", memory: "16Gi", ephemeralStorage: "20Gi", ephemeralStorageLimit: "100Gi", replica: 1,
  }]);
});

test("the kubernetes spelling of the request keeps its limit", () => {
  const sent = resourcesMapToWorkloadArray({ cpu: "4", memory: "16Gi", "ephemeral-storage": "20Gi", ephemeralStorageLimit: "100Gi" });
  assert.deepEqual(sent, [{ cpu: "4", memory: "16Gi", ephemeralStorage: "20Gi", ephemeralStorageLimit: "100Gi", replica: 1 }]);
});

test("without a limit the body is what it was", () => {
  const sent = resourcesMapToWorkloadArray({ cpu: "4", memory: "16Gi", ephemeralStorage: "100Gi" });
  assert.deepEqual(sent, [{ cpu: "4", memory: "16Gi", ephemeralStorage: "100Gi", replica: 1 }]);
});

test("a limit with no request is dropped and is not a quota on its own", () => {
  assert.deepEqual(resourcesMapToWorkloadArray({ cpu: "4", memory: "16Gi", ephemeralStorageLimit: "100Gi" }),
    [{ cpu: "4", memory: "16Gi", replica: 1 }]);
  assert.deepEqual(resourcesMapToWorkloadArray({ ephemeralStorageLimit: "100Gi" }), []);
});
