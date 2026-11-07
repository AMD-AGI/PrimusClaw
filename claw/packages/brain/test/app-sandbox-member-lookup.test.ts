// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The app sandbox lookup for a key that is not an admin's.
 *
 * SaFE answers a workload list that names no workspace with 403 for every key but an admin's. The run's
 * lookup (`findLiveAppSandboxes`, before every create and in the finishing stop) used to ask exactly that,
 * so a member's app run never got past provisioning: every reconcile ended "app sandbox lookup failed:
 * HTTP 403". These tests run the lookup against a SaFE that enforces the rule.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  appSandboxWorkspaces, ensureAppSandbox, findLiveAppSandboxes, type AppSandboxRun,
} from "../src/apps/app-sandbox.js";
import { realAppSandbox } from "../src/apps/app-runner-wiring.js";
import type { AppRunStore } from "../src/apps/app-run-store.js";
import type { SandboxInstance } from "../src/sandbox/provider.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

interface Workload { id: string; workspace: string; runId: string; phase: string }

/**
 * A SaFE that refuses an unscoped list to a member. `refuse` names workspaces the key may not list (403),
 * `fail` workspaces whose list is down (503). `self` is `users/self`'s workspace list.
 */
function memberSafe(opts: { admin?: boolean; self?: string[]; refuse?: string[]; fail?: string[] } = {}) {
  const workloads: Workload[] = [];
  const calls: string[] = [];
  const fetch = (async (input: unknown) => {
    const url = new URL(String(input), "http://safe.test");
    calls.push(`${url.pathname}${url.search ? `?ws=${url.searchParams.get("workspaceId") ?? "*"}` : ""}`);
    if (url.pathname === "/api/v1/users/self") {
      return new Response(JSON.stringify({ id: "u-1", workspaces: (opts.self ?? []).map((id) => ({ id })) }), { status: 200 });
    }
    const ws = url.searchParams.get("workspaceId");
    if (!ws && !opts.admin) return new Response(JSON.stringify({ errorCode: "Primus.00003", errorMessage: "forbidden" }), { status: 403 });
    if (ws && opts.refuse?.includes(ws)) return new Response("forbidden", { status: 403 });
    if (ws && opts.fail?.includes(ws)) return new Response("unavailable", { status: 503 });
    const items = workloads
      .filter((w) => (!ws || w.workspace === ws) && w.runId === url.searchParams.get("envValue"))
      .map((w) => ({ workloadId: w.id, phase: w.phase, workspaceId: w.workspace, groupVersionKind: { kind: "Sandbox" } }));
    return new Response(JSON.stringify({ totalCount: items.length, items }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { workloads, calls, fetch };
}

function run(over: Partial<AppSandboxRun> = {}): AppSandboxRun {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    workspaceId: "ws-app",
    platformKey: "pk-member",
    sandboxSpec: { handle: "app", image: "registry.example/app:1", resources: { cpu: "4", memory: "16Gi" }, timeout: 600 },
    ...over,
  };
}

/** ensureAppSandbox with a create that lands in SaFE's list, in the namespace it was given. */
function deps(safe: ReturnType<typeof memberSafe>) {
  const created: string[] = [];
  return {
    created,
    deps: {
      fetch: safe.fetch,
      recordWorkloadId: async () => {},
      waitRunning: async () => {},
      create: (async (p: { namespace: string; env: Record<string, string>; onProvisioned?: (id: string) => Promise<void> }) => {
        const id = `wl-${safe.workloads.length + 1}`;
        safe.workloads.push({ id, workspace: p.namespace, runId: p.env.CLAW_APP_RUN_ID!, phase: "Running" });
        created.push(p.namespace);
        await p.onProvisioned?.(id);
        return { provider: "safe-workload", id, sandboxName: id, namespace: p.namespace, handsBaseUrl: "", platformKey: "pk-member" } as SandboxInstance;
      }) as never,
    },
  };
}

test("a member's app run is provisioned: the refused unscoped list moves the lookup to the run's workspace", async () => {
  const safe = memberSafe();
  const d = deps(safe);
  const first = await ensureAppSandbox(run(), d.deps);
  assert.equal(first.created, true);
  assert.deepEqual(d.created, ["ws-app"], "created in the run's workspace");
  assert.deepEqual(safe.calls, ["/api/v1/workloads?ws=*", "/api/v1/workloads?ws=ws-app"],
    "the unscoped list, then the run's workspace; users/self is not needed when the run names one");

  // The lookup really finds what it created: a retry adopts it instead of creating a second sandbox.
  const again = await ensureAppSandbox(run({ sandboxWorkloadId: first.workloadId }), d.deps);
  assert.equal(again.created, false);
  assert.equal(again.workloadId, first.workloadId);
  assert.equal(d.created.length, 1);
});

test("an admin's lookup is unchanged: one unscoped list, which also sees a sandbox in another workspace", async () => {
  const safe = memberSafe({ admin: true });
  safe.workloads.push({ id: "wl-elsewhere", workspace: "ws-other", runId: "run-1", phase: "Running" });
  const d = deps(safe);
  const out = await ensureAppSandbox(run(), d.deps);
  assert.equal(out.created, false);
  assert.equal(out.workloadId, "wl-elsewhere");
  assert.deepEqual(safe.calls, ["/api/v1/workloads?ws=*"], "no workspace-scoped list, no users/self");
});

test("a run with no recorded workspace reads the key's workspaces, and a 403 in one does not hide the others", async () => {
  const safe = memberSafe({ self: ["ws-a", "ws-b", "ws-c"], refuse: ["ws-a"] });
  safe.workloads.push({ id: "wl-b", workspace: "ws-b", runId: "run-1", phase: "Running" });
  safe.workloads.push({ id: "wl-other-run", workspace: "ws-c", runId: "run-2", phase: "Running" });
  const found = await findLiveAppSandboxes("run-1", "pk-member", safe.fetch, []);
  assert.deepEqual(found, [{ id: "wl-b", phase: "running" }]);
  assert.deepEqual(safe.calls, [
    "/api/v1/workloads?ws=*", "/api/v1/users/self", "/api/v1/workloads?ws=ws-a", "/api/v1/workloads?ws=ws-b", "/api/v1/workloads?ws=ws-c",
  ]);
});

test("a 403 in the run's own workspace does not hide the sandbox in the other one it names", async () => {
  const safe = memberSafe({ refuse: ["ws-app"] });
  safe.workloads.push({ id: "wl-ns", workspace: "ws-ns", runId: "run-1", phase: "Running" });
  const r = run({ sandboxSpec: { ...run().sandboxSpec, namespace: "ws-ns" } as AppSandboxRun["sandboxSpec"] });
  assert.deepEqual(appSandboxWorkspaces(r), ["ws-app", "ws-ns"]);
  const found = await findLiveAppSandboxes("run-1", "pk-member", safe.fetch, appSandboxWorkspaces(r));
  assert.deepEqual(found.map((w) => w.id), ["wl-ns"]);
});

test("could not look is never none: a 403 with nothing found elsewhere, or any other failure in one workspace, fails the lookup", async () => {
  await assert.rejects(
    findLiveAppSandboxes("run-1", "pk-member", memberSafe({ refuse: ["ws-app"] }).fetch, ["ws-app"]),
    /HTTP 403 in workspace ws-app/,
  );
  // The run names a workspace the key has since lost, and the one it would create in now is empty: the
  // sandbox may be in the lost one, so the lookup fails rather than reading "none" and creating a second.
  const moved = memberSafe({ refuse: ["ws-old"] });
  moved.workloads.push({ id: "wl-old", workspace: "ws-old", runId: "run-1", phase: "Running" });
  const r = run({ sandboxSpec: { ...run().sandboxSpec, namespace: "ws-old" } as AppSandboxRun["sandboxSpec"] });
  const md = deps(moved);
  await assert.rejects(ensureAppSandbox(r, md.deps), /HTTP 403 in workspace ws-old/);
  assert.deepEqual(md.created, [], "no second sandbox");
  const down = memberSafe({ self: ["ws-a", "ws-b"], fail: ["ws-b"] });
  down.workloads.push({ id: "wl-a", workspace: "ws-a", runId: "run-1", phase: "Running" });
  await assert.rejects(findLiveAppSandboxes("run-1", "pk-member", down.fetch, []), /HTTP 503/);
  // And a create is never attempted on a lookup that failed.
  const d = deps(memberSafe({ refuse: ["ws-app"] }));
  await assert.rejects(ensureAppSandbox(run(), d.deps), /HTTP 403/);
  assert.deepEqual(d.created, []);
});

test("a member who belongs to no workspace owns no app sandbox: the lookup is empty, not failed", async () => {
  const safe = memberSafe({ self: [] });
  assert.deepEqual(await findLiveAppSandboxes("run-1", "pk-member", safe.fetch, []), []);
});

test("the finishing stop's live-id lookup reads the run's workspace as well", async () => {
  const safe = memberSafe();
  safe.workloads.push({ id: "wl-unrecorded", workspace: "ws-app", runId: "run-1", phase: "Pending" });
  globalThis.fetch = safe.fetch;
  const ops = realAppSandbox({} as AppRunStore);
  assert.deepEqual(await ops.liveIds("run-1", "pk-member", run()), ["wl-unrecorded"]);
  assert.deepEqual(safe.calls, ["/api/v1/workloads?ws=*", "/api/v1/workloads?ws=ws-app"]);
});
