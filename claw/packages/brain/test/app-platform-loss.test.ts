// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A sandbox the platform takes away is not the application failing.
 *
 * 2026-11-09: a hosted smoke run ended "app run ended: restarts exhausted" while its
 * site was down (134 of 219 nodes down, then none usable). The app was moved about six
 * times in an hour -- node after node lost, then sandboxes no node would take -- and
 * every move spent one of its `max_restarts`, though the application never crashed.
 *
 *   L1 node losses and waits for a node that ran out do not spend `max_restarts`; once
 *      the site is back the app runs again, and its own crash budget is whole
 *   L2 platform losses are bounded on their own, so a site that never comes back still
 *      ends the run, and says why
 *   L3 the application's own container failing still counts; a disruption wins over
 *      what the container's exit looked like
 *   L4 a Brain that takes the run over keeps the platform-loss count
 *   L5 SaFE's workload detail: a disrupted pod is told apart from a failed container, from a pod evicted for what it
 *      used itself, and from a stale top-level message
 *   L6 a manifest that allows no restart is never started again, whoever lost its sandbox
 */
import test from "node:test";
import assert from "node:assert/strict";

const { AppRunner, PLATFORM_LOSSES_MAX, platformLoss } = await import("../src/apps/app-runner.js");
const { SandboxProvisionTerminalError, workloadDisrupted } = await import("../src/sandbox/errors.js");
const { World, MANIFEST, RUN_ID } = await import("./support/app-runner-world.js");

import type { AppManifestV1 } from "@claw/protocol";

const PLATFORM_KEY = "ak-platform-key-0123456789";

function harness(manifest: AppManifestV1 = MANIFEST) {
  const world = new World(manifest);
  const runner = () => new AppRunner(RUN_ID, PLATFORM_KEY, {
    store: world.store, sandbox: world.sandbox, now: world.now, sleep: world.sleep, tickMs: 5000,
  });
  return { world, runner: runner(), newRunner: runner };
}
type H = ReturnType<typeof harness>;

async function until(h: H, state: string, max = 12, runner = h.runner) {
  for (let i = 0; i < max && h.world.rec.state !== state; i++) await runner.reconcile();
  assert.equal(h.world.rec.state, state, `never reached ${state}`);
}

/** The next `n` sandbox creates give up the way a wait for a node does on a site with none. */
function noNodeFor(h: H, n: number, reason = "sandbox_start_timeout") {
  const ensure = h.world.sandbox.ensure;
  let left = n;
  h.world.sandbox.ensure = async (run, opts) => {
    if (left > 0) {
      left -= 1;
      throw new SandboxProvisionTerminalError(reason, `workload was scheduled but did not become ready (${reason})`);
    }
    return ensure(run, opts);
  };
}

const NODE_LOST = { reason: "sandbox_workload_terminal", disrupted: true } as const;

test("L1 a site outage moves the app many times without spending max_restarts, and the app runs again after", async () => {
  const h = harness(); // max_restarts: 2
  await until(h, "running");
  // Three nodes lost under the app, one after another, as the site went down.
  for (const ending of [NODE_LOST, { reason: "sandbox_workload_terminal" }, {}]) {
    h.world.killWorkload(h.world.liveWorkload(), "terminal", ending);
    await h.runner.reconcile();
    assert.equal(h.world.rec.state, "provisioning");
    assert.equal(h.world.rec.restarts, 0, "a node lost is not the application failing");
    await until(h, "running");
  }
  // A workload that vanished, then waits for a node that no node took.
  h.world.killWorkload(h.world.liveWorkload(), "absent");
  await h.runner.reconcile();
  noNodeFor(h, 2);
  noNodeFor(h, 1, "sandbox_pending_timeout");
  noNodeFor(h, 1, "sandbox_unschedulable");
  for (let i = 0; i < 4; i++) {
    await h.runner.reconcile();
    assert.equal(h.world.rec.state, "provisioning", `wait ${i + 1} for a node`);
  }
  assert.equal(h.world.rec.restarts, 0);
  assert.equal(h.world.rec.last_exit?.cause, "sandbox_lost");
  assert.equal(h.world.rec.last_exit?.platform_losses, 8);

  // The site is back: the app runs again, by itself.
  await until(h, "running");
  assert.equal(h.world.rec.restarts, 0);

  // Its own crash budget is whole: two crashes restart it, as max_restarts says.
  for (let crash = 1; crash <= 2; crash++) {
    h.world.appExits(h.world.liveWorkload());
    await h.runner.reconcile();
    assert.equal(h.world.rec.state, "restarting", `crash ${crash}`);
    assert.equal(h.world.rec.restarts, crash);
    assert.equal(h.world.rec.last_exit?.platform_losses, 8, "the platform-loss count is carried");
    h.world.clock += 60_000;
    await until(h, "running");
  }
  h.world.appExits(h.world.liveWorkload());
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing", "the third crash is past max_restarts");
  assert.equal(h.world.rec.last_exit?.cause, "restarts_exhausted");
});

test("L2 a site that never comes back still ends the run, after PLATFORM_LOSSES_MAX losses, saying why", async () => {
  const h = harness();
  await until(h, "running");
  noNodeFor(h, PLATFORM_LOSSES_MAX + 5);
  h.world.killWorkload(h.world.liveWorkload(), "terminal", NODE_LOST);
  for (let i = 0; i < PLATFORM_LOSSES_MAX + 3 && h.world.rec.state !== "finishing"; i++) await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
  assert.equal(h.world.rec.restarts, 0);
  assert.equal(h.world.rec.last_exit?.cause, "restarts_exhausted");
  assert.equal(h.world.rec.last_exit?.platform_losses, PLATFORM_LOSSES_MAX);
  const r = await h.runner.reconcile();
  assert.equal(r.done && r.outcome.success, false);
  assert.match(r.done ? r.outcome.reason : "", new RegExp(`restarts exhausted \\(the platform lost the app's sandbox ${PLATFORM_LOSSES_MAX} times\\)`));
});

test("L3 the application's own container failing still counts; a disruption does not, whatever the container showed", async () => {
  const h = harness({ ...MANIFEST, restart: { max_restarts: 1, backoff_sec: [1] } });
  await until(h, "running");
  h.world.killWorkload(h.world.liveWorkload(), "terminal", { reason: "sandbox_container_failed", disrupted: true });
  await h.runner.reconcile();
  assert.equal(h.world.rec.restarts, 0, "the node was lost: the container's failure was its consequence");
  await until(h, "running");
  h.world.killWorkload(h.world.liveWorkload(), "terminal", { reason: "sandbox_container_failed" });
  await h.runner.reconcile();
  assert.equal(h.world.rec.restarts, 1);
  await until(h, "running");
  h.world.killWorkload(h.world.liveWorkload(), "terminal", { reason: "sandbox_container_failed" });
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
  assert.equal(h.world.rec.last_exit?.cause, "restarts_exhausted");

  // A container that exited before it was ready may be the image: it counts too.
  const g = harness({ ...MANIFEST, restart: { max_restarts: 0, backoff_sec: [] } });
  noNodeFor(g, 1, "sandbox_exited_before_ready");
  await g.runner.reconcile();
  assert.equal(g.world.rec.state, "finishing");
});

test("L3b which endings are the platform's", () => {
  for (const r of ["sandbox_unschedulable", "sandbox_pending_timeout", "sandbox_start_timeout", "sandbox_status_unreadable", "sandbox_gone", "sandbox_workload_terminal", undefined]) {
    assert.equal(platformLoss(r), true, String(r));
  }
  for (const r of ["sandbox_container_failed", "sandbox_envd_exited", "sandbox_timed_out", "sandbox_exited_before_ready", "sandbox_workspace_forbidden"]) {
    assert.equal(platformLoss(r), false, r);
    assert.equal(platformLoss(r, true), true, `${r}, disrupted`);
  }
});

test("L4 a Brain that takes the run over keeps the platform-loss count and the bound", async () => {
  const h = harness();
  await until(h, "running");
  h.world.killWorkload(h.world.liveWorkload(), "terminal", NODE_LOST);
  await h.runner.reconcile();
  const b = h.newRunner();
  noNodeFor(h, 1);
  await b.reconcile();
  assert.equal(h.world.rec.last_exit?.platform_losses, 2);
  await until(h, "running", 12, b);
  assert.equal(h.world.rec.restarts, 0);
  assert.equal(h.world.rec.last_exit?.platform_losses, 2);
});

test("L5 SaFE's detail: a disrupted or node-lost pod is disrupted; a container that failed by itself is not", async () => {
  const disrupted = [
    { conditions: [{ type: "AdminFailed", message: "Pod phase is Failed, details: [{\"pod\":\"p\",\"node\":\"v3-185\",\"message\":\"DisruptionTarget: DeletionByTaintManager (2026-11-09T08:12:00Z): Taint manager: deleting due to NoExecute taint key node.kubernetes.io/unreachable\"}]" }] },
    { conditions: [{ type: "AdminFailed", message: "pod p was taken away by a disruption, DisruptionTarget: PreemptionByScheduler: preempted" }] },
    { conditions: [{ type: "AdminFailed", message: "Pod phase is Failed, details: [{\"pod\":\"p\",\"message\":\"NodeLost, Node v3-106 which was running pod p is unresponsive\"}]" }] },
    { conditions: [{ type: "AdminFailed", message: "DisruptionTarget: TerminationByKubelet: Pod was terminated in response to imminent node shutdown." }] },
    { conditions: [{ type: "AdminFailed", message: "DisruptionTarget: EvictionByEvictionAPI: Eviction API: evicting (node drain)" }] },
  ];
  for (const info of disrupted) assert.equal(workloadDisrupted(info), true, JSON.stringify(info));
  const own = [
    { conditions: [{ type: "AdminFailed", message: "Pod phase is Failed, details: [{\"container\":{\"name\":\"main\",\"reason\":\"OOMKilled\",\"exitCode\":137}}]" }] },
    { conditions: [{ type: "AdminStopped", message: "the workload has timed out" }] },
    { conditions: [{ type: "AdminFailed", message: "the app was evicted from its cache, node lost its mind" }] },
    { message: "In queue - insufficient resources" },
    {},
    // Evicted for what the pod used itself: the application's doing.
    { conditions: [{ type: "AdminFailed", message: "Evicted, Pod ephemeral local storage usage exceeds the total limit of containers 10Gi." }] },
    { conditions: [{ type: "AdminFailed", message: "DisruptionTarget: TerminationByKubelet: Container main exceeded its local ephemeral storage limit \"1Gi\"." }] },
    { conditions: [{ type: "AdminFailed", message: "Evicted, The node was low on resource: memory. Container main was using 60Gi, request is 8Gi, has larger consumption of memory." }] },
    // A stale top-level "Preempted" and a pod record do not make a container failure a disruption: only the terminal condition is read.
    { message: "Preempted by a higher-priority workload", pods: [{ failedMessage: "Preempted" }],
      conditions: [{ type: "AdminFailed", message: "Pod phase is Failed, details: [{\"container\":{\"reason\":\"OOMKilled\",\"exitCode\":137}}]" }] },
  ];
  for (const info of own) assert.equal(workloadDisrupted(info), false, JSON.stringify(info));

  // And the provider says so on the status it answers.
  const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
  const realFetch = globalThis.fetch;
  try {
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
    const provider = new SafeWorkloadProvider();
    const inst = { provider: "safe-workload", id: "wl-x", sandboxName: "wl-x", namespace: "ws", handsBaseUrl: "", platformKey: "pk" } as const;
    body = { phase: "Failed", ...disrupted[0] };
    assert.deepEqual(await provider.get(inst), { running: false, healthy: false, state: "terminal", reason: "sandbox_container_failed", disrupted: true });
    body = { phase: "Failed", ...own[0] };
    assert.deepEqual(await provider.get(inst), { running: false, healthy: false, state: "terminal", reason: "sandbox_container_failed" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

for (const [label, manifest] of [
  ["max_restarts 0", { ...MANIFEST, restart: { max_restarts: 0, backoff_sec: [] } }],
  ["no restart block", { ...MANIFEST, restart: undefined }],
] as const) {
  test(`L6 ${label}: a node lost, a vanished workload or a wait for a node that ran out ends the run; nothing is started again`, async () => {
    for (const lose of [
      (h: H) => h.world.killWorkload(h.world.liveWorkload(), "terminal", NODE_LOST),
      (h: H) => h.world.killWorkload(h.world.liveWorkload(), "absent"),
      (h: H) => h.world.killWorkload(h.world.liveWorkload(), "terminal"),
    ]) {
      const h = harness(manifest as AppManifestV1);
      await until(h, "running");
      lose(h);
      await h.runner.reconcile();
      assert.equal(h.world.rec.state, "finishing");
      assert.equal(h.world.rec.last_exit?.cause, "restarts_exhausted");
      assert.equal(h.world.rec.last_exit?.platform_losses, undefined, "not counted as a platform loss either");
      assert.equal(h.world.created.length, 1, "no second sandbox");
      assert.equal(h.world.starts.length, 1, "the application is never started again");
    }
    const g = harness(manifest as AppManifestV1);
    noNodeFor(g, 1);
    await g.runner.reconcile();
    assert.equal(g.world.rec.state, "finishing");
    assert.equal(g.world.starts.length, 0);
  });
}
