// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A multi-node failure has to name the cluster it may have left behind.
 *
 * The failure event is the only place a GPU cluster's handle reaches anyone: on
 * this path the run is over, so whatever is still holding nodes is found by
 * reading `workload_name` out of that event and deleting it by hand. An event
 * that names nothing costs whatever the cluster costs until someone goes
 * looking through SaFE for it.
 *
 * Two things can be true at once here: no id was returned, and a cluster
 * exists. A create that answers 2xx with no `workloadId`, a conflict whose
 * cleanup and retry both fail, a POST that throws after the request arrived --
 * each of them leaves nothing to report and something to delete. SaFE addresses
 * these clusters by the message id, so the message id is the handle, and the
 * question the event answers is whether a create was asked for rather than
 * whether one came back.
 *
 * The other direction -- a failure before any create, which must name nothing
 * rather than invent a handle -- is pinned by the shared-root test, where the
 * refusal arrives with both name fields empty.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";

// Read when the provider module loads.
process.env.SAFE_API_URL = "http://safe.test";
const { SafeMultiNodeProvider } = await import("../src/sandbox/multi-node/safe-provider.js");

const REQUEST = {
  session_id: "sess-mn",
  message_id: "msg-mn",
  workspace_id: "ws-mn",
  platform_key: "safe-key",
  prompt: "optimize --nodes 2 --mn-backend rayjob --mn-image img:1",
} as ExecuteRequest;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Answer SaFE from the method and path, so a create can land without answering. */
function stubSafe(t: TestContext, reply: (method: string, url: string) => Response): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    reply(String(init?.method ?? "GET"), String(input))) as typeof globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
}

/** Run an ensure that is expected to fail, and return the one failure event. */
async function failureEvent(
  t: TestContext,
  expected: RegExp,
  reply: (method: string, url: string) => Response,
): Promise<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  stubSafe(t, reply);
  await assert.rejects(
    () => new SafeMultiNodeProvider().ensure(
      "sess-mn", REQUEST, async (e) => { events.push(e as Record<string, unknown>); },
    ),
    expected,
  );
  const failed = events.filter((e) => String(e.status).endsWith("_failed"));
  assert.equal(failed.length, 1, "a failed ensure sends exactly one failure event");
  return failed[0]!;
}

test("a cluster that answered with an id is named by it when it then fails", async (t) => {
  const event = await failureEvent(t, /terminal phase/, (method, url) => {
    if (method === "POST") return json({ workloadId: "w1" });
    if (url.endsWith("/msg-mn")) return json({ message: "not found" }, 404);
    return json({ phase: "Failed" });
  });

  assert.equal(event.phase, "terminal");
  assert.deepEqual([event.ray_job_name, event.workload_name], ["w1", "w1"],
    "the id the create returned is the handle, and the failure carries it");
});

test("a create that landed without answering names the cluster by message id", async (t) => {
  // A 2xx with no `workloadId` in it: the POST was accepted, so SaFE may well be
  // starting the cluster, and the id the provider would have reported never
  // arrived. Reporting nothing here left a run's worth of GPUs with no handle.
  const event = await failureEvent(t, /no workloadId/, (method) => {
    if (method === "POST") return json({});
    return json({ message: "not found" }, 404);
  });

  assert.equal(event.phase, "create");
  assert.deepEqual([event.ray_job_name, event.workload_name], ["msg-mn", "msg-mn"],
    "which is what adoptExisting looks up and deleteWorkload deletes");
});
