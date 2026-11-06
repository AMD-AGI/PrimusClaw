// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Restarting a Claw component does not cost the turns that are running.
 *
 * Real processes throughout -- Postgres, nats-server with JetStream, the API
 * and Brain entry points production runs -- with a model that takes its time,
 * so every disruption below lands in the middle of a turn. Each scenario is one
 * of the ways a component goes away in production:
 *
 *   C1 API rolling update, twice, mid-turn: the turn never notices (one model
 *      call), and a client on the event stream is moved to the new pod without
 *      being replayed history it already had
 *   C2 Brain rolling update (SIGTERM) mid-turn: another brain resumes it
 *   C3 Brain crash (SIGKILL) mid-turn, container restarted in place: the
 *      restarted process takes it back at once instead of after the lease and
 *      reaper grace (eleven minutes on 2026-11-06)
 *   C4 JetStream stalls for twenty seconds mid-turn (2026-11-06's trigger): the
 *      turn waits it out -- no failure, no stand-down, no crashed brain
 *   C5 Brain lost with its node (SIGKILL, never restarted under its name): a
 *      surviving brain takes the turn over within two minutes, at production
 *      timings -- where it used to wait out the lease, the lock TTL and the
 *      reaper's grace (eleven minutes)
 *
 * Every scenario asserts the turn completed, exactly once (one `exec_complete`
 * event, one row), and within 60 seconds of the disruption (C5: 120 seconds).
 *
 * Needs a nats-server binary (CLAW_CHAOS_NATS_SERVER) and a Postgres server it
 * may create a database on (DATABASE_URL); skipped without them, and run by
 * its own CI job, which provides both.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  api, eventCounts, runRow, sleep, startCluster, startTurn, until, waitTerminal, type Cluster,
} from "./chaos-harness.js";

const NATS_SERVER = process.env.CLAW_CHAOS_NATS_SERVER ?? "";
const ADMIN_DB = process.env.DATABASE_URL ?? "";
const STALL_BUDGET_MS = 60_000;

const skip = !NATS_SERVER || !ADMIN_DB
  ? "needs CLAW_CHAOS_NATS_SERVER and DATABASE_URL (the rolling-restart CI job sets both)"
  : false;

/** An EventSource-like client: reconnects when the stream ends, sending Last-Event-ID. */
function followEvents(c: Cluster, sessionId: string) {
  const ids: string[] = [];
  const names: string[] = [];
  let connections = 0;
  let lastId = "";
  let stopped = false;
  let current: http.ClientRequest | null = null;
  const connect = () => {
    if (stopped) return;
    connections++;
    current = http.get(`${c.front.url}/v1/sessions/${sessionId}/events?stream=true`, {
      agent: false,
      headers: { accept: "text/event-stream", ...(lastId ? { "last-event-id": lastId } : {}) },
    }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const id = /^id: (.*)$/m.exec(frame)?.[1];
          const name = /^event: (.*)$/m.exec(frame)?.[1];
          if (id) { ids.push(id); lastId = id; }
          if (name) names.push(name);
        }
      });
      res.on("end", () => setTimeout(connect, 1_000));
      res.on("error", () => setTimeout(connect, 1_000));
    });
    current.on("error", () => setTimeout(connect, 1_000));
  };
  connect();
  return {
    ids, names,
    get connections() { return connections; },
    stop() { stopped = true; current?.destroy(); },
  };
}

async function assertCompletedOnce(
  c: Cluster, sessionId: string, runId: string, disruptedAt: number, label: string, budgetMs = STALL_BUDGET_MS,
) {
  const row = await waitTerminal(c, runId, budgetMs + 60_000).catch((e) => {
    throw new Error(`${label}: ${(e as Error).message}\n${c.logs()}`);
  });
  assert.equal(row.status, "completed", `${label}: ${row.status} (${row.failure_reason})\n${c.logs()}`);
  assert.equal(row.failure_reason, null);
  const tookMs = row.completed_at!.getTime() - disruptedAt;
  assert.ok(tookMs < budgetMs, `${label}: completed ${tookMs}ms after the disruption`);
  // Exactly once: the completion event is what the event consumer turns into
  // the session's terminal state and what downstream readers count as the
  // answer, so two of them is a duplicated turn.
  await until(`${label}: exec_complete persisted`, async () => (await eventCounts(c, sessionId)).exec_complete === 1, 30_000);
  const counts = await eventCounts(c, sessionId);
  assert.equal(counts.exec_complete, 1, `${label}: ${JSON.stringify(counts)}`);
  assert.equal(counts.ResultMessage, 1, `${label}: ${JSON.stringify(counts)}`);
  const runs = await c.db.query("SELECT count(*)::int AS n FROM claw_tasks WHERE session_id = $1", [sessionId]);
  assert.equal(runs.rows[0].n, 1, `${label}: one row for one turn`);
  return { row, tookMs };
}

test("rolling restarts do not cost the turns that are running", { skip, timeout: 15 * 60_000 }, async (t) => {
  const c = await startCluster({ natsServer: NATS_SERVER, adminDbUrl: ADMIN_DB });
  try {
    await c.startApi("api-1");
    // Production dispatches chat through the run doorbell; assert the fleet supports it.
    await api(c, "POST", "/v1/internal/brain/doorbell-semantics", { semantics: 1 }, { authorization: "Bearer chaos-internal-token" });
    await c.startBrain("brain-a");

    await t.test("C1 API rolling update, twice, mid-turn", async () => {
      c.model.holdMs = 45_000;
      const callsBefore = c.model.calls;
      const { sessionId, runId } = await startTurn(c, "c1");
      const events = followEvents(c, sessionId);
      try {
        await until("C1 model streaming", async () => c.model.calls > callsBefore, 60_000);
        const dispatch = await c.db.query("SELECT metadata->>'dispatch' AS d FROM claw_tasks WHERE task_id = $1", [runId]);
        assert.equal(dispatch.rows[0].d, "doorbell", "the production dispatch path");
        const disruptedAt = Date.now();
        await c.rollApi("api-1", "api-2");
        await c.rollApi("api-2", "api-3");
        assert.equal(c.apis.get("api-1")!.proc.exited?.code, 0, "the old pod drained and exited cleanly");
        assert.equal(c.apis.get("api-2")!.proc.exited?.code, 0);
        await assertCompletedOnce(c, sessionId, runId, disruptedAt, "C1");
        assert.equal(c.model.calls - callsBefore, 1, "the turn was never interrupted: one model call");
        assert.ok(c.brains.get("brain-a")!.alive, "brain-a is still running");
        await until("C1 the follower saw the end", async () => events.names.includes("ResultMessage") || events.names.some((n) => /result|complete|finished/i.test(n)), 20_000).catch(() => null);
        assert.ok(events.connections >= 2, "the event stream was moved off the draining pod");
        assert.equal(new Set(events.ids).size, events.ids.length, `no event delivered twice across reconnects: ${events.ids.join(",")}`);
      } finally {
        events.stop();
      }
    });

    await t.test("C2 Brain rolling update (SIGTERM) mid-turn", async () => {
      c.model.holdMs = 8_000;
      const callsBefore = c.model.calls;
      const { sessionId, runId } = await startTurn(c, "c2");
      await until("C2 model streaming", async () => c.model.calls > callsBefore, 60_000);
      const owner = (await runRow(c, runId))!.lease_owner!;
      assert.equal(owner, "brain-a");
      await c.startBrain("brain-b");
      const disruptedAt = Date.now();
      await c.brains.get("brain-a")!.stop("SIGTERM");
      assert.equal(c.brains.get("brain-a")!.exited?.code, 0);
      const { row } = await assertCompletedOnce(c, sessionId, runId, disruptedAt, "C2");
      assert.ok(row.claim_count >= 2, "resumed by a second claim");
    });

    await t.test("C3 Brain crash (SIGKILL) mid-turn, restarted in place", async () => {
      c.model.holdMs = 8_000;
      const callsBefore = c.model.calls;
      const { sessionId, runId } = await startTurn(c, "c3");
      await until("C3 model streaming", async () => c.model.calls > callsBefore, 60_000);
      assert.equal((await runRow(c, runId))!.lease_owner, "brain-b");
      const disruptedAt = Date.now();
      await c.brains.get("brain-b")!.stop("SIGKILL");
      // The kubelet restarts the container under the same pod name.
      await c.startBrain("brain-b");
      const { row } = await assertCompletedOnce(c, sessionId, runId, disruptedAt, "C3");
      assert.ok(row.claim_count >= 2);
      assert.ok(c.brains.get("brain-b")!.grep(/brain\.previous_incarnation\.reclaimed/).length > 0,
        "taken back by the restarted process, not by the reaper");
    });

    await t.test("C4 JetStream stalls for twenty seconds mid-turn", async () => {
      c.model.holdMs = 6_000;
      const callsBefore = c.model.calls;
      const { sessionId, runId } = await startTurn(c, "c4");
      await until("C4 model streaming", async () => c.model.calls > callsBefore, 60_000);
      const brain = c.brains.get("brain-b")!;
      const disruptedAt = Date.now();
      // What a storage node rebooting under the R3 streams looked like from the
      // clients: connections open, nothing answered.
      c.nats.signal("SIGSTOP");
      await sleep(20_000);
      c.nats.signal("SIGCONT");
      await assertCompletedOnce(c, sessionId, runId, disruptedAt, "C4");
      assert.ok(brain.alive, `the brain survived the stall\n${brain.tail()}`);
      assert.equal(brain.grep(/process\.unhandled_rejection|process\.uncaught_exception/).length, 0);
      assert.equal(brain.grep(/task\.lease_lost\.stood_down/).length, 0, "no healthy run stood down");
      assert.equal(c.model.calls - callsBefore, 1, "the turn was not restarted either");
    });
  } finally {
    await c.close();
  }
});

/**
 * C5: a node goes down with a brain on it. The pod is rescheduled under a new
 * name, so nothing ever restarts as the dead process's BRAIN_ID and C3's
 * hand-back cannot happen. Before this, the turn waited for its lease, the
 * dead holder's `lock.<key>` to age out of the registry bucket (five minutes)
 * and the reaper's grace on top -- 675 s measured on 2026-11-06. Production
 * timings throughout (lease, heartbeat, sweeper tick, lock TTL): the harness
 * overrides none of them, so the two minutes asserted here is what a real
 * fleet gets.
 */
test("a brain lost with its node is taken over by another brain within two minutes", { skip, timeout: 10 * 60_000 }, async () => {
  const LOST_NODE_BUDGET_MS = 120_000;
  const c = await startCluster({ natsServer: NATS_SERVER, adminDbUrl: ADMIN_DB });
  try {
    await c.startApi("api-1");
    await api(c, "POST", "/v1/internal/brain/doorbell-semantics", { semantics: 1 }, { authorization: "Bearer chaos-internal-token" });
    await c.startBrain("brain-a");
    await c.startBrain("brain-b");
    // Long enough that the dead brain's lease and lock are both renewed several
    // times before it dies, as a real run's are.
    c.model.holdMs = 40_000;
    const callsBefore = c.model.calls;
    const { sessionId, runId } = await startTurn(c, "c5");
    await until("C5 model streaming", async () => c.model.calls > callsBefore, 60_000);
    await sleep(25_000);
    const owner = (await runRow(c, runId))!.lease_owner!;
    assert.ok(owner === "brain-a" || owner === "brain-b", `owner ${owner}`);
    const survivor = owner === "brain-a" ? "brain-b" : "brain-a";
    // From here the turn is short, so the time measured is the takeover's.
    c.model.holdMs = 4_000;
    const disruptedAt = Date.now();
    await c.brains.get(owner)!.stop("SIGKILL");
    const { row, tookMs } = await assertCompletedOnce(c, sessionId, runId, disruptedAt, "C5", LOST_NODE_BUDGET_MS);
    assert.ok(row.claim_count >= 2, "resumed by a second claim");
    assert.ok(c.brains.get(survivor)!.alive, "the survivor is still running");
    assert.ok(
      c.brains.get(survivor)!.grep(/lock\.dead_holder_taken_over/).length > 0,
      `the survivor took the dead holder's lock over\n${c.logs()}`,
    );
    process.stdout.write(`# C5 recovered ${tookMs}ms after the brain was lost (owner ${owner}, survivor ${survivor})\n`);
  } finally {
    await c.close();
  }
});
