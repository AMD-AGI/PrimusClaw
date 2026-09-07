// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Stop surfaces a client actually calls, driven as HTTP.
 *
 * A direct call to `interruptSessionRuns` proves the statement and nothing
 * about whether any route reaches it: an owner check that refuses too much, an
 * ordering that deletes the queued delivery before the live run is settled, or
 * a best-effort NATS publish that throws ahead of the durable half all leave
 * the unit test green and the row wedged. Each case here injects the real
 * endpoint against the real schema and reads back the rows and the response.
 * NATS is down throughout, which is the state in which the durable half matters
 * most -- and the last group takes that half away too, because a Stop that
 * reached neither half must not be answered as one that did.
 */

import "./reconcile-on-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import type { UserInfo } from "../src/auth/models.js";
import { registerAdminRoutes } from "../src/routes/admin.js";
import { registerAnthropicManagedAgentsRoutes } from "../src/routes/anthropic-managed-agents.js";
import { db } from "../src/infra/db.js";
import { registry } from "../src/infra/metrics.js";
import { chatRunPorts } from "../src/tasks/chat-run.js";
import {
  startHarness, seedSession, seedRun, runRow, sessionRow, type Harness,
} from "./scenario-harness.js";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
};

const ADMIN_INTERRUPT = (sid: string) => `/v1/chat/sessions/${sid}/interrupt`;
const ANTHROPIC_EVENTS = (sid: string) => `/anthropic/v1/sessions/${sid}/events`;
const ANTHROPIC_ARCHIVE = (sid: string) => `/anthropic/v1/sessions/${sid}/archive`;
const STOPPED = "cancelled_before_dispatch_confirmed";
const STOPPED_MESSAGE = "the user stopped this turn before any worker took a lease on it";
const EXITED = "claw_api_run_queue_exited_total";

let h: Harness;

before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

async function appAs(
  register: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = OWNER;
  });
  await register(app);
  await app.ready();
  return app;
}

function sample(text: string, name: string, labels: Record<string, string>): number {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    const head = line.slice(0, line.lastIndexOf(" "));
    if (!wanted.every((pair) => head.includes(pair))) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return 0;
}

/** What one product action moved on a series, as a reader of `/metrics` sees it. */
async function delta(
  act: () => Promise<unknown>,
  name: string,
  labels: Record<string, string>,
): Promise<number> {
  const before = sample(await registry.metrics(), name, labels);
  await act();
  return sample(await registry.metrics(), name, labels) - before;
}

function compensation(row: Record<string, unknown>): Record<string, unknown> | undefined {
  return (row.metadata as Record<string, Record<string, unknown>>).dispatch_compensation;
}

async function gateWaiter(sessionId: string, taskId: string, messageId: string): Promise<void> {
  await seedRun(h, taskId, sessionId, {
    status: "preparing", dispatch: "fat", leaseOwner: null, messageId,
  });
}

test("the admin interrupt endpoint terminalizes the fat row nobody holds", async () => {
  await seedSession(h, "s1");
  await gateWaiter("s1", "gate-waiter", "m-1");
  const app = await appAs(registerAdminRoutes);
  try {
    const res = await app.inject({ method: "POST", url: ADMIN_INTERRUPT("s1") });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    const row = await runRow(h, "gate-waiter");
    assert.equal(row.status, "cancelled");
    assert.equal(row.failure_reason, STOPPED);
    assert.equal(row.error_message, STOPPED_MESSAGE);
    assert.notEqual(row.completed_at, null);
    assert.equal(compensation(row)?.version, 1);
    assert.equal(compensation(row)?.state, "terminal");
    assert.equal(compensation(row)?.failure_reason, STOPPED);
  } finally {
    await app.close();
  }
});

test("the admin interrupt endpoint leaves a held fat row to its handshake", async () => {
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "running", dispatch: "fat", messageId: "m-1",
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });
  const app = await appAs(registerAdminRoutes);
  try {
    const res = await app.inject({ method: "POST", url: ADMIN_INTERRUPT("s1") });

    assert.equal(res.statusCode, 200);
    const row = await runRow(h, "held");
    assert.equal(row.status, "cancelling");
    assert.equal(row.failure_reason, null);
    assert.equal(row.completed_at, null);
    assert.equal(compensation(row), undefined);
  } finally {
    await app.close();
  }
});

test("the admin interrupt endpoint refuses a session the caller may not write", async () => {
  await seedSession(h, "s1", { userId: "u-someone-else" });
  await seedRun(h, "not-yours", "s1", {
    status: "preparing", dispatch: "fat", leaseOwner: null,
  });
  const app = await appAs(registerAdminRoutes);
  try {
    const res = await app.inject({ method: "POST", url: ADMIN_INTERRUPT("s1") });

    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.json(), { ok: false, error: "access denied" });
    assert.equal((await runRow(h, "not-yours")).status, "preparing");
  } finally {
    await app.close();
  }
});

test("the admin interrupt endpoint answers 404 for a session that is not there", async () => {
  const app = await appAs(registerAdminRoutes);
  try {
    const res = await app.inject({ method: "POST", url: ADMIN_INTERRUPT("nope") });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), { ok: false, error: "not found" });
  } finally {
    await app.close();
  }
});

test("the Anthropic user.interrupt event applies the same durable cancellation", async () => {
  await seedSession(h, "s1");
  await gateWaiter("s1", "gate-waiter", "m-1");
  const app = await appAs(registerAnthropicManagedAgentsRoutes);
  try {
    const res = await app.inject({
      method: "POST", url: ANTHROPIC_EVENTS("s1"),
      payload: { events: [{ type: "user.interrupt" }] },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { data: Array<Record<string, unknown>> };
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].type, "user.interrupt");
    assert.match(String(body.data[0].id), /^evt_\d+$/);
    assert.equal(typeof body.data[0].processed_at, "string");
    const row = await runRow(h, "gate-waiter");
    assert.equal(row.status, "cancelled");
    assert.equal(row.failure_reason, STOPPED);
    assert.equal(compensation(row)?.state, "terminal");
  } finally {
    await app.close();
  }
});

test("a user.interrupt event settles both halves of a Stop and counts one queue exit", async () => {
  await seedSession(h, "s1");
  await seedRun(h, "unstarted", "s1", {
    status: "queued", dispatch: "doorbell", messageId: "m-q", queuedAgoSec: 5,
  });
  await gateWaiter("s1", "gate-waiter", "m-f");
  const app = await appAs(registerAnthropicManagedAgentsRoutes);
  try {
    const moved = await delta(
      () => app.inject({
        method: "POST", url: ANTHROPIC_EVENTS("s1"),
        payload: { events: [{ type: "user.interrupt" }] },
      }),
      EXITED, { outcome: "cancelled" },
    );

    assert.equal(moved, 1, "only the queued row was on the queue to leave it");
    const unstarted = await runRow(h, "unstarted");
    assert.equal(unstarted.status, "cancelled");
    assert.equal(unstarted.failure_reason, "cancelled");
    assert.equal(unstarted.error_message, "interrupted before a worker claimed the run");
    const fat = await runRow(h, "gate-waiter");
    assert.equal(fat.status, "cancelled");
    assert.equal(fat.failure_reason, STOPPED);
    assert.equal(
      (await sessionRow(h, "s1")).agent_status, "running",
      "the fat row was still preparing when the gate was tested, so the gate stays shut until it is terminal",
    );
  } finally {
    await app.close();
  }
});

test("a user.interrupt for someone else's session changes nothing", async () => {
  await seedSession(h, "s1", { userId: "u-someone-else" });
  await seedRun(h, "not-yours", "s1", {
    status: "preparing", dispatch: "fat", leaseOwner: null,
  });
  const app = await appAs(registerAnthropicManagedAgentsRoutes);
  try {
    const res = await app.inject({
      method: "POST", url: ANTHROPIC_EVENTS("s1"),
      payload: { events: [{ type: "user.interrupt" }] },
    });

    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.json(), {
      type: "error", error: { type: "not_found_error", message: "session not found" },
    });
    assert.equal((await runRow(h, "not-yours")).status, "preparing");
  } finally {
    await app.close();
  }
});

/**
 * Make the durable half of a Stop fail the way an unreachable database does.
 *
 * @returns a restore function; a substitution left in place would make every
 *   later case fail for this case's reason.
 */
function breakDurableStop(): () => void {
  const query = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    if (/UPDATE claw_tasks/.test(text)) throw new Error("connection terminated");
    return query(text, params);
  }) as typeof db.query;
  return () => { db.query = query; };
}

/** A wire half that works, so only the durable half is missing. */
function healthyInterruptPublisher(): () => void {
  const publish = chatRunPorts.publishInterrupt;
  chatRunPorts.publishInterrupt = () => { /* delivered */ };
  return () => { chatRunPorts.publishInterrupt = publish; };
}

for (const [half, arrange] of [
  ["the durable half fails while NATS is healthy", () => {
    const wire = healthyInterruptPublisher();
    const durable = breakDurableStop();
    return () => { durable(); wire(); };
  }],
  ["both halves fail", () => breakDurableStop()],
] as Array<[string, () => () => void]>) {
  test(`the admin interrupt endpoint refuses to answer ok when ${half}`, async () => {
    await seedSession(h, "s1");
    await gateWaiter("s1", "gate-waiter", "m-1");
    const restore = arrange();
    const app = await appAs(registerAdminRoutes);
    try {
      const res = await app.inject({ method: "POST", url: ADMIN_INTERRUPT("s1") });

      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.json(), { ok: false, error: "interrupt_not_recorded" });
    } finally {
      restore();
      await app.close();
    }
    assert.equal(
      (await runRow(h, "gate-waiter")).status, "preparing",
      "the row really was not cancelled, which is what the refusal reports",
    );
  });

  test(`the Anthropic interrupt event refuses to answer ok when ${half}`, async () => {
    await seedSession(h, "s1");
    await gateWaiter("s1", "gate-waiter", "m-1");
    const restore = arrange();
    const app = await appAs(registerAnthropicManagedAgentsRoutes);
    try {
      const res = await app.inject({
        method: "POST", url: ANTHROPIC_EVENTS("s1"),
        payload: { events: [{ type: "user.interrupt" }] },
      });

      assert.equal(res.statusCode, 503);
      assert.equal((res.json() as { type: string }).type, "error");
    } finally {
      restore();
      await app.close();
    }
    assert.equal((await runRow(h, "gate-waiter")).status, "preparing");
  });
}

test("an archive whose cancellation fails keeps the queued delivery it would have dropped", async () => {
  await seedSession(h, "s1");
  await gateWaiter("s1", "gate-waiter", "m-1");
  await h.sql(
    "INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, $2, $3)",
    ["s1", "u-1", "queued turn"],
  );
  const restore = breakDurableStop();
  const app = await appAs(registerAnthropicManagedAgentsRoutes);
  try {
    assert.equal((await app.inject({ method: "POST", url: ANTHROPIC_ARCHIVE("s1") })).statusCode, 503);
  } finally {
    restore();
    await app.close();
  }
  assert.equal(
    Number((await h.sql(
      "SELECT count(*)::int AS n FROM claw_pending_messages WHERE session_id = $1", ["s1"],
    ))[0].n),
    1,
    "a run left live keeps its delivery, or a worker takes an archived session with none",
  );
  assert.notEqual((await sessionRow(h, "s1")).status, "archived");
});

test("the Anthropic archive endpoint settles the fat row before it drops the queued delivery", async () => {
  await seedSession(h, "s1");
  await gateWaiter("s1", "gate-waiter", "m-1");
  await h.sql(
    "INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, $2, $3)",
    ["s1", "u-1", "queued turn"],
  );
  const app = await appAs(registerAnthropicManagedAgentsRoutes);
  try {
    const res = await app.inject({ method: "POST", url: ANTHROPIC_ARCHIVE("s1") });

    assert.equal(res.statusCode, 200);
    const body = res.json() as Record<string, unknown>;
    assert.equal(body.id, "s1");
    assert.equal(body.type, "session");
    assert.equal(body.status, "terminated");
    assert.notEqual(body.archived_at, null);
    const row = await runRow(h, "gate-waiter");
    assert.equal(row.status, "cancelled");
    assert.equal(row.failure_reason, STOPPED);
    assert.equal(compensation(row)?.state, "terminal");
    assert.equal(
      Number((await h.sql(
        "SELECT count(*)::int AS n FROM claw_pending_messages WHERE session_id = $1", ["s1"],
      ))[0].n),
      0,
      "the delivery an archived session would otherwise hand a worker is gone",
    );
    assert.equal((await sessionRow(h, "s1")).status, "archived");

    const sql = h.statements;
    const cancel = sql.findIndex((s) => /SET status = CASE WHEN .* THEN 'cancelling' ELSE 'cancelled' END/.test(s));
    const drop = sql.findIndex((s) => /DELETE FROM claw_pending_messages WHERE session_id = \$1/.test(s));
    assert.ok(cancel >= 0 && drop >= 0);
    assert.ok(cancel < drop, "a run left live past the archive can still be drained onto it");
  } finally {
    await app.close();
  }
});
