// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An app run stopped while its sandbox is still being made leaves no sandbox
 * behind.
 *
 * The case this was found on: a run was submitted, its session was deleted 13 s
 * later, and the workload SaFE had queued for it was Running 3 minutes after
 * that, with nothing left that would stop it. The cancel reached the run while
 * its tick was waiting for the workload to be Running, and the wait did not
 * hear it; `finishNow` waited for that tick, and the API renews no lease on a
 * cancelled task, so by the time the tick returned the lease was gone and the
 * write that starts the finish was refused (`not_holder`). The sandbox ran on
 * to its 24 h workload timeout.
 *
 * Everything here is the real path -- the AppRunner, the SaFE wiring
 * (`realAppSandbox`), `ensureAppSandbox` and the SaFE workload provider with its
 * wait loop -- against an in-memory SaFE behind `fetch`, a run store that
 * fences writes on the lease exactly as the API does (45 s past the last
 * renewal, no renewal once the task is closed), and node's mocked clock, so a
 * 197 s queue costs nothing to wait out. The cancel is placed at the points of
 * the first 15 s after submission where the run can be: before it starts,
 * during the lookup for an existing workload, during the create, and at several
 * seconds into the queue.
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.SAFE_API_URL = "http://safe.test";

const { AppRunner } = await import("../src/apps/app-runner.js");
const { realAppSandbox } = await import("../src/apps/app-runner-wiring.js");
const { AppRunWriteRefused } = await import("../src/apps/app-run-store.js");
const { MANIFEST } = await import("./support/app-runner-world.js");

import type { AppRunPatch, AppRunRecord, AppRunState, AppRunStore } from "../src/apps/app-run-store.js";
import type { TestContext } from "node:test";

type MockTimers = TestContext["mock"]["timers"];

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const RUN = "app-run-1";
/** How long the queued workload takes to be Running: the case this was found on. */
const RUNNING_AFTER_MS = 196_800;
const LEASE_TTL_MS = 45_000;
const HEARTBEAT_MS = 15_000;

/** An in-memory SaFE: list, create, detail and stop of Sandbox workloads. */
class FakeSafe {
  workloads: Array<{
    id: string; env: Record<string, string>; labels: Record<string, string>;
    createdAt: number; runningAfterMs: number; stoppedAt: number | null;
  }> = [];
  stops: Array<{ id: string; at: number }> = [];
  creates = 0;
  runningAfterMs = RUNNING_AFTER_MS;
  /** Runs inside the lookup, before it answers. */
  onList: (() => void) | null = null;
  /** Runs inside the create, before it answers. */
  onCreate: (() => void) | null = null;

  phaseOf(w: FakeSafe["workloads"][number]): string {
    if (w.stoppedAt !== null) return "Stopped";
    return Date.now() - w.createdAt >= w.runningAfterMs ? "Running" : "Pending";
  }

  live(): string[] {
    return this.workloads.filter((w) => this.phaseOf(w) !== "Stopped").map((w) => w.id);
  }

  /** A queued workload of the run, as an earlier holder's create would have left it. */
  queued(runId: string, createdAt = T0): string {
    const id = `claw-${this.workloads.length + 1}`;
    this.workloads.push({
      id, env: { CLAW_APP_RUN_ID: runId },
      labels: { "primus-claw/component": "app", "primus-claw/app-run-id": runId },
      createdAt, runningAfterMs: this.runningAfterMs, stoppedAt: null,
    });
    return id;
  }

  fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const answer = (status: number, body: unknown) => ({
      ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
    });
    if (url.pathname === "/api/v1/workloads" && method === "GET") {
      this.onList?.();
      const items = [...this.workloads].reverse()
        .filter((w) => w.env[url.searchParams.get("envKey") ?? ""] === url.searchParams.get("envValue"))
        .map((w) => ({ workloadId: w.id, phase: this.phaseOf(w), groupVersionKind: { kind: "Sandbox" }, labels: w.labels }));
      return answer(200, { totalCount: items.length, items });
    }
    if (url.pathname === "/api/v1/workloads" && method === "POST") {
      this.onCreate?.();
      this.creates++;
      const body = JSON.parse(init!.body!) as { env: Record<string, string>; labels: Record<string, string> };
      const id = `claw-${this.workloads.length + 1}`;
      this.workloads.push({
        id, env: body.env, labels: body.labels, createdAt: Date.now(), runningAfterMs: this.runningAfterMs, stoppedAt: null,
      });
      return answer(200, { workloadId: id });
    }
    const stop = /^\/api\/v1\/workloads\/([^/]+)\/stop$/.exec(url.pathname);
    if (stop && method === "POST") {
      const w = this.workloads.find((x) => x.id === stop[1]);
      if (!w) return answer(404, {});
      w.stoppedAt ??= Date.now();
      this.stops.push({ id: w.id, at: Date.now() });
      return answer(200, {});
    }
    const detail = /^\/api\/v1\/workloads\/([^/]+)$/.exec(url.pathname);
    if (detail && method === "GET") {
      const w = this.workloads.find((x) => x.id === detail[1]);
      return w ? answer(200, { workloadId: w.id, phase: this.phaseOf(w) }) : answer(404, {});
    }
    throw new Error(`the fake SaFE does not know ${method} ${url.pathname}`);
  }) as unknown as typeof globalThis.fetch;
}

/**
 * The run's row as the API keeps it, with the API's write fence: a write lands
 * only inside the lease, which the holder renews every 15 s for 45 s while the
 * task is open, and which nothing renews once the task is closed.
 */
class FencedStore implements AppRunStore {
  rec: AppRunRecord;
  /** When the task was closed (a deleted session: straight to cancelled); null while open. */
  closedAt: number | null = null;
  refused: string[] = [];

  constructor(over: Partial<AppRunRecord> = {}) {
    this.rec = {
      run_id: RUN, session_id: "sess-1", state: "provisioning", restarts: 0, last_exit: null, events_cursor: {},
      state_dir: null, sandbox_workload_id: null, manifest: MANIFEST, grant_id: null, grant_limits: null,
      grant_templates: null, grant_expires_at: null, grant_revoked_at: null, created_at: new Date(T0).toISOString(),
      input: {}, workspace_id: "ws-1",
      sandbox_spec: { handle: "app", image: "img:1", resources: { cpu: "4", memory: "16Gi" }, timeout: 86_400 } as never,
      ...over,
    };
  }

  leaseLive(): boolean {
    const renewedUntil = this.closedAt ?? Date.now();
    const lastRenewal = T0 + Math.floor((renewedUntil - T0) / HEARTBEAT_MS) * HEARTBEAT_MS;
    return Date.now() < lastRenewal + LEASE_TTL_MS;
  }

  load = async (): Promise<AppRunRecord> => structuredClone(this.rec);
  patch = async (_id: string, patch: AppRunPatch, expect?: AppRunState): Promise<AppRunRecord> => {
    if (!this.leaseLive()) { this.refused.push(patch.state ?? Object.keys(patch).join(",")); throw new AppRunWriteRefused("not_holder", this.rec.state); }
    if (this.rec.state === "ended") throw new AppRunWriteRefused("ended", "ended");
    if (expect && this.rec.state !== expect) throw new AppRunWriteRefused("state_mismatch", this.rec.state);
    const { grant_revoked: _r, grant_keys: _k, ...fields } = patch;
    this.rec = { ...this.rec, ...fields } as AppRunRecord;
    return structuredClone(this.rec);
  };
  secrets = async () => ({ mcp_token: "cmt_token", grant_keys: null });
  putMcp = async () => undefined;
  deleteMcp = async () => undefined;
}

/** Let every promise that can settle settle; setImmediate is not mocked. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Move the mocked clock to `atMs` after T0, a little at a time, letting the code run between steps. */
async function advanceTo(timers: MockTimers, atMs: number): Promise<void> {
  await settle();
  while (Date.now() - T0 < atMs) {
    timers.tick(Math.min(250, atMs - (Date.now() - T0)));
    await settle();
  }
}

/** Advance until `p` settles or the clock passes `limitMs`; returns what it settled with. */
async function race<T>(timers: MockTimers, p: Promise<T>, limitMs: number): Promise<{ value?: T; error?: unknown; settled: boolean }> {
  const out: { value?: T; error?: unknown; settled: boolean } = { settled: false };
  p.then((v) => { out.value = v; out.settled = true; }, (e) => { out.error = e; out.settled = true; });
  await settle();
  while (!out.settled && Date.now() - T0 < limitMs) {
    timers.tick(250);
    await settle();
  }
  return out;
}

type Where = "before_start" | "lookup" | "create" | number;

/**
 * Submit at T0 and stop the run at `where`, as the task runner does: the run's
 * signal fires; a cancel (here, the session deleted) closes the task and then
 * finishes the run, a drain leaves it.
 */
function scenario(t: TestContext, opts: { where: Where; handOver?: boolean; store?: FencedStore; safe?: FakeSafe }) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: T0 });
  const safe = opts.safe ?? new FakeSafe();
  const realFetch = globalThis.fetch;
  globalThis.fetch = safe.fetch;
  const store = opts.store ?? new FencedStore();
  const ctrl = new AbortController();
  const handOver = opts.handOver === true;
  const stop = (): void => {
    if (ctrl.signal.aborted) return;
    if (!handOver) store.closedAt = Date.now();
    ctrl.abort(handOver ? Symbol("sigterm") : undefined);
  };
  if (opts.where === "lookup") safe.onList = () => { safe.onList = null; stop(); };
  if (opts.where === "create") safe.onCreate = () => { safe.onCreate = null; stop(); };
  if (typeof opts.where === "number") setTimeout(stop, opts.where);
  if (opts.where === "before_start") stop();
  const runner = new AppRunner(RUN, "ak-platform-key", { store, sandbox: realAppSandbox(store) });
  const run = runner.run(ctrl.signal, { reclaimOnAbort: () => !handOver });
  return { safe, store, ctrl, runner, run, restore: () => { globalThis.fetch = realFetch; } };
}

const STOP_POINTS: Array<{ where: Where; label: string }> = [
  { where: "before_start", label: "0 s, before the run looks for a sandbox" },
  { where: "lookup", label: "during the lookup for an existing workload" },
  { where: "create", label: "while SaFE is accepting the create" },
  { where: 1_000, label: "1 s in, queued" },
  { where: 5_000, label: "5 s in, queued" },
  { where: 13_500, label: "13.5 s in, queued (the case this was found on)" },
  { where: 15_000, label: "15 s in, queued, at a lease renewal" },
];

for (const { where, label } of STOP_POINTS) {
  test(`session deleted ${label}: the run ends inside its lease and no sandbox is left`, async (t) => {
    const s = scenario(t, { where });
    try {
      const ran = await race(t.mock.timers, s.run, 30_000);
      assert.equal(ran.settled, true);
      assert.deepEqual(ran.value, { kind: "aborted" });
      const stoppedAt = Date.now() - T0;
      // The task runner's next step for a run that was not handed over.
      const finished = await race(t.mock.timers, s.runner.finishNow("cancelled"), 400_000);
      assert.equal(finished.settled, true, "finishNow returned");
      assert.equal(finished.error, undefined,
        `finishNow failed (${String((finished.error as Error)?.message ?? finished.error)}): its writes were refused because the lease ran out while it waited (${s.store.refused.join(" ")})`);
      assert.equal(s.store.rec.state, "ended", "the run row is ended, not left in provisioning");
      assert.deepEqual(s.store.refused, [], "no write was refused");
      assert.deepEqual(s.safe.live(), [], "no workload of the run is left live");
      for (const w of s.safe.workloads) {
        assert.ok(w.stoppedAt !== null && w.stoppedAt - w.createdAt < w.runningAfterMs,
          `${w.id} was stopped while still queued, not after it came up`);
        assert.ok(w.stoppedAt! - T0 <= stoppedAt + 1_000, `${w.id} was stopped at once, not ${(w.stoppedAt! - T0) / 1000}s in`);
      }
      assert.ok(Date.now() - T0 < stoppedAt + LEASE_TTL_MS, "the whole finish fitted in what was left of the lease");
    } finally {
      s.restore();
    }
  });
}

test("a run stopped during the lookup creates no workload at all", async (t) => {
  const s = scenario(t, { where: "lookup" });
  try {
    await race(t.mock.timers, s.run, 30_000);
    await race(t.mock.timers, s.runner.finishNow("cancelled"), 60_000);
    assert.equal(s.safe.creates, 0, "the create is not sent once the run has been stopped");
    assert.equal(s.store.rec.state, "ended");
  } finally {
    s.restore();
  }
});

test("a drain while the workload is queued leaves it for the next holder, who adopts it rather than making another", async (t) => {
  const s = scenario(t, { where: 5_000, handOver: true });
  try {
    const ran = await race(t.mock.timers, s.run, 30_000);
    assert.deepEqual(ran.value, { kind: "aborted" });
    await advanceTo(t.mock.timers, 10_000);
    assert.deepEqual(s.safe.stops, [], "a hand-over stops nothing");
    assert.equal(s.safe.live().length, 1, "the queued workload is still there");
    assert.equal(s.store.rec.state, "provisioning");
    const queued = s.safe.live()[0]!;
    assert.equal(s.store.rec.sandbox_workload_id, queued, "and its id is on the row for whoever takes the run");

    // The Brain that takes the run over (the lease is renewed: the task is open).
    const next = new AppRunner(RUN, "ak-platform-key", { store: s.store, sandbox: realAppSandbox(s.store) });
    const ctrl = new AbortController();
    const running = next.run(ctrl.signal, { reclaimOnAbort: () => true });
    await advanceTo(t.mock.timers, RUNNING_AFTER_MS + 10_000);
    assert.equal(s.store.rec.state, "starting", "the successor's run moved on once the workload was Running");
    assert.equal(s.store.rec.sandbox_workload_id, queued);
    assert.equal(s.safe.creates, 1, "the queued workload was adopted, not made again");
    ctrl.abort(Symbol("sigterm"));
    await race(t.mock.timers, running, RUNNING_AFTER_MS + 60_000);
  } finally {
    s.restore();
  }
});

test("a run taken over while its workload is queued, then drained: the adopted workload is left for the next holder", async (t) => {
  const safe = new FakeSafe();
  const queued = safe.queued(RUN);
  const store = new FencedStore({ sandbox_workload_id: queued });
  const s = scenario(t, { where: 8_000, store, safe, handOver: true });
  try {
    const ran = await race(t.mock.timers, s.run, 30_000);
    assert.deepEqual(ran.value, { kind: "aborted" });
    await advanceTo(t.mock.timers, 20_000);
    assert.deepEqual(safe.stops, [], "a hand-over stops nothing");
    assert.deepEqual(safe.live(), [queued]);
    assert.equal(store.rec.sandbox_workload_id, queued);
  } finally {
    s.restore();
  }
});

test("a run taken over while its workload is queued, then cancelled: the adopted workload is stopped at once", async (t) => {
  const safe = new FakeSafe();
  // An earlier holder created and recorded it, then went away.
  const queued = safe.queued(RUN);
  const store = new FencedStore({ sandbox_workload_id: queued });
  const s = scenario(t, { where: 8_000, store, safe });
  try {
    const ran = await race(t.mock.timers, s.run, 30_000);
    assert.deepEqual(ran.value, { kind: "aborted" });
    const finished = await race(t.mock.timers, s.runner.finishNow("cancelled"), 400_000);
    assert.equal(finished.error, undefined, `finishNow failed: ${String((finished.error as Error)?.message ?? finished.error)}`);
    assert.equal(store.rec.state, "ended");
    assert.equal(safe.creates, 0, "nothing new was made");
    assert.deepEqual(safe.live(), []);
    assert.ok(safe.stops.length > 0 && safe.stops[0]!.at - T0 <= 9_000, "the adopted workload was stopped when the cancel came, not after it came up");
  } finally {
    s.restore();
  }
});
