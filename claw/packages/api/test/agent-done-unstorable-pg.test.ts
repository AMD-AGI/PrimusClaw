// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run's result the database cannot store, through Brain's real task path and
 * the real `agent_done` route on a real Postgres.
 *
 * U+0000 in a run's output (a script printing a C string, a model echoing a
 * binary file) failed the `claw_tasks` write with SQLSTATE 22021, the route
 * answered 500, and Brain resent the same body three times per delivery and
 * then naked the delivery -- for every delivery the message had, after which
 * the poison guard reported the run as failed. Nothing about the resend could
 * change the answer. Now the API makes the text storable at the write boundary
 * (U+0000 and lone surrogates become U+FFFD), answers 422 when the database
 * still refuses the values, and Brain answers a 422 with a failure that carries
 * none of the result, then sets the result aside if that is refused too.
 *
 * Each delivery runs `runHandleTask` (the brain entry point after the lock)
 * on a script task with no sandbox, so the outbox, the callback, the ack and
 * the outbox cleanup are the production code; only the script's own output is
 * supplied. The callback goes over HTTP to the route, which writes the row.
 * Skipped without DATABASE_URL; a skip is not a pass.
 *
 * Coverage:
 *   P0 the premise: this Postgres refuses each of the values the fix handles
 *   P1 six tasks on one queue, in order: a result with U+0000 and lone
 *      surrogates lands completed with U+FFFD and everything else intact; a
 *      result the database still refuses (a count out of range) is failed with
 *      `result_unstorable` on its first delivery; a result refused twice is
 *      quarantined with a durable record; every one is acked once, none is
 *      naked, and the tasks after each of them complete
 *   P2 a result left in the outbox by an earlier delivery is replayed, made
 *      storable, and lands
 *   P3 a replayed result refused twice is quarantined the same way
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, before } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import type { JsMsg, KV } from "nats";
import type pg from "pg";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";

import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { postgresSkipReason } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
const SESSION = "sess-unstorable";
const USER = "user-unstorable";
const REPLACEMENT = "�";

let harness: AdmissionCluster;
let client: pg.Client;
let app: FastifyInstance;
let baseUrl: string;
let brain: typeof import("../../brain/src/tasks/runner.js");
let brainMetrics: typeof import("../../brain/src/infra/metrics.js");
let apiMetrics: typeof import("../src/infra/metrics.js");
/** What each task's script produced, by task id: the one input the test supplies. */
const outputs = new Map<string, ExecuteResult>();
/** Task ids whose callbacks are refused outright, as by a field nothing can make storable. */
const refuseAll = new Set<string>();
const store = new Map<string, Uint8Array>();
const enc = new TextEncoder();
const dec = new TextDecoder();

const kvCkpt = {
  async get(key: string) {
    const value = store.get(key);
    return value ? { key, value, operation: "PUT" } : null;
  },
  async put(key: string, value: Uint8Array | string) {
    store.set(key, typeof value === "string" ? enc.encode(value) : value);
    return 1;
  },
  async delete(key: string) { store.delete(key); },
} as unknown as KV;

before(async () => {
  if (skip) return;
  harness = await startAdmissionCluster({});
  client = await harness.connect();
  apiMetrics = harness.app.metrics;
  const { registerInternalTaskRoutes } = await import("../src/routes/internal-tasks.js");
  app = Fastify({ bodyLimit: 4 * 1024 * 1024 });
  app.addHook("preHandler", async (req, reply) => {
    const taskId = (req.params as { taskId?: string } | undefined)?.taskId;
    if (taskId && refuseAll.has(taskId)) {
      return reply.status(422).send({ ok: false, error: "unstorable_result", sqlstate: "22P05" });
    }
  });
  await registerInternalTaskRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  brain = await import("../../brain/src/tasks/runner.js");
  brainMetrics = await import("../../brain/src/infra/metrics.js");
  brain.bindTaskRunnerDeps({
    kv: kvCkpt,
    kvCkpt,
    emitter: { async emit() {} } as never,
    engine: { async execute() { throw new Error("a script task without a sandbox never reaches the engine"); } } as never,
    sideEffects: {
      runScript: (async (request: ExecuteRequest) => {
        const out = outputs.get(request.task_id ?? "");
        if (!out) throw new Error(`no output for ${request.task_id}`);
        return out;
      }) as never,
      releaseTaskLock: (async () => {}) as never,
    },
  });
  await client.query(`INSERT INTO claw_sessions (session_id, user_id, name) VALUES ($1, $2, 'unstorable')`, [SESSION, USER]);
});

after(async () => {
  if (skip) return;
  await app?.close();
  await harness?.stop();
});

/** A dispatched script task, as the dispatcher leaves it: running, with its own callback token. */
async function seedTask(taskId: string): Promise<ExecuteRequest> {
  const token = `token-${taskId}`;
  const callbackUrl = `${baseUrl}/v1/internal/tasks/${taskId}`;
  await client.query(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, mode, callback_url, internal_token_hash)
     VALUES ($1, $2, $1, 'running', 'task', 'script', $3, $4)`,
    [taskId, SESSION, callbackUrl, createHash("sha256").update(token).digest("hex")],
  );
  // The fields `buildExecuteRequest` puts on a script task with no sandbox.
  return {
    task_id: taskId, session_id: SESSION, message_id: taskId,
    callback_url: callbackUrl, backend_internal_token: token,
    run_lease: { url: `${callbackUrl}/lease`, token },
    mode: "script", sandbox_spec: "none", platform_key: "", user_id: USER,
    history: [], memory_enabled: false, user_skills_enabled: false,
    script: { steps: [{ kind: "bash", command: "./report" }] },
  } as unknown as ExecuteRequest;
}

/** What a script task's run returns, in the shape `runScript` reports it. */
function scriptResult(text: string, over: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    finalText: text,
    captures: { report: text },
    artifacts: [{ path: "out/report.txt", note: text }],
    tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
    turns: 1,
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 1, error_calls: 0, by_tool: { bash: 1 } },
    elapsedMs: 40,
    abortReason: "completed",
    ...over,
  } as ExecuteResult;
}

/** One JetStream delivery of `request` to this brain; returns how the message was settled. */
async function deliver(request: ExecuteRequest): Promise<string[]> {
  const verdicts: string[] = [];
  const msg = {
    seq: 1, redelivered: false, info: { deliveryCount: 1 },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? ""}`); },
    term() { verdicts.push("term"); },
    working() {},
  } as unknown as JsMsg;
  await brain.runHandleTask(
    msg, request, SESSION, `task:${request.task_id}`, request.message_id ?? "", USER, new AbortController(),
  );
  return verdicts;
}

async function row(taskId: string): Promise<Record<string, unknown>> {
  const r = await client.query(`SELECT * FROM claw_tasks WHERE task_id = $1`, [taskId]);
  return r.rows[0] as Record<string, unknown>;
}

async function metricValue(
  registry: { getMetricsAsJSON(): Promise<Array<{ name: string; values: Array<{ value: number; labels: Record<string, unknown> }> }>> },
  name: string, labels: Record<string, string> = {},
): Promise<number> {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  const value = metric?.values.find((v) => Object.entries(labels).every(([k, l]) => v.labels[k] === l));
  return Number(value?.value ?? 0);
}

test("P0 the premise: this Postgres refuses each of the values the fix handles", { skip }, async () => {
  const refused = async (sql: string, params: unknown[]) => {
    const err = await client.query(sql, params).then(() => null, (e: { code?: string }) => e);
    return err?.code ?? "stored";
  };
  assert.equal(await refused(`SELECT $1::text`, ["a\u0000b"]), "22021");
  assert.equal(await refused(`SELECT $1::jsonb`, [JSON.stringify({ k: "a\u0000b" })]), "22P05");
  assert.equal(await refused(`SELECT $1::jsonb`, [JSON.stringify({ k: "a\uD800b" })]), "22P02");
  assert.equal(await refused(`SELECT $1::jsonb`, [JSON.stringify({ ["a\u0000"]: 1 })]), "22P05");
  assert.equal(await refused(`SELECT $1::int`, [3_000_000_000]), "22003");
});

test("P1 a result the database cannot store does not hold up the tasks behind it", { skip }, async () => {
  const sanitizedBefore = await metricValue(apiMetrics.registry, "claw_api_agent_done_sanitized_total");
  const refusedBefore = await metricValue(apiMetrics.registry, "claw_api_agent_done_refused_total", { sqlstate: "22003" });
  const quarantinedBefore = await metricValue(brainMetrics.registry, "claw_brain_agent_done_quarantined_total", { reason: "refused" });

  // A script that printed a C string, a lone surrogate and an emoji.
  const nulText = "exit 0\u0000\u0000 tail \uD800 ok \u{1F600}";
  const nulStored = `exit 0${REPLACEMENT}${REPLACEMENT} tail ${REPLACEMENT} ok \u{1F600}`;
  const plan: Array<{ id: string; out: ExecuteResult; refuse?: boolean }> = [
    {
      id: "t-nul",
      out: scriptResult(nulText, {
        failureMessage: undefined,
        toolStats: { total_calls: 1, error_calls: 0, by_tool: { ["bash\u0000"]: 1 } },
      }),
    },
    { id: "t-after-nul", out: scriptResult("plain output") },
    { id: "t-out-of-range", out: scriptResult("fine text", { turns: 3_000_000_000 }) },
    { id: "t-after-range", out: scriptResult("plain output") },
    { id: "t-refused-twice", out: scriptResult("kept for whoever recovers it"), refuse: true },
    { id: "t-after-quarantine", out: scriptResult("plain output") },
  ];
  for (const step of plan) {
    const request = await seedTask(step.id);
    outputs.set(step.id, step.out);
    if (step.refuse) refuseAll.add(step.id);
    assert.deepEqual(await deliver(request), ["ack"], `${step.id}: settled once, never naked`);
    assert.equal(store.has(`task-result.${step.id}`), false, `${step.id}: the outbox is cleared`);
  }

  const nul = await row("t-nul");
  assert.equal(nul.status, "completed");
  assert.equal(nul.output, nulStored, "only the unstorable characters are replaced");
  assert.deepEqual(nul.captures, { report: nulStored });
  assert.deepEqual(nul.artifacts, [{ path: "out/report.txt", note: nulStored }]);
  assert.deepEqual((nul.tool_stats as { by_tool: unknown }).by_tool, { [`bash${REPLACEMENT}`]: 1 });
  assert.equal(nul.turns, 1);

  const range = await row("t-out-of-range");
  assert.equal(range.status, "failed", "refused once, then reported as a failure on the same delivery");
  assert.equal(range.failure_reason, "result_unstorable");
  assert.match(String(range.error_message), /SQLSTATE 22003/);

  const twice = await row("t-refused-twice");
  assert.equal(twice.status, "running", "left for the sweeper, which fails a run that never reports");
  const record = JSON.parse(dec.decode(store.get("task-quarantine.t-refused-twice")!)) as Record<string, unknown>;
  assert.equal(record.task_id, "t-refused-twice");
  assert.equal(record.http_status, 422);
  assert.equal(record.sqlstate, "22P05");
  assert.equal((record.result as { finalText: string }).finalText, "kept for whoever recovers it",
    "the result is kept, not dropped");

  for (const id of ["t-after-nul", "t-after-range", "t-after-quarantine"]) {
    const later = await row(id);
    assert.equal(later.status, "completed", `${id} completes behind the one that could not be stored`);
    assert.equal(later.output, "plain output");
  }

  assert.equal(await metricValue(apiMetrics.registry, "claw_api_agent_done_sanitized_total"), sanitizedBefore + 1);
  assert.equal(
    await metricValue(apiMetrics.registry, "claw_api_agent_done_refused_total", { sqlstate: "22003" }), refusedBefore + 1,
  );
  assert.equal(
    await metricValue(brainMetrics.registry, "claw_brain_agent_done_quarantined_total", { reason: "refused" }),
    quarantinedBefore + 1,
  );
  assert.equal(brainMetrics.agentDoneConsecutiveFailures(), 0, "the last task delivered, so nothing is failing now");
  assert.equal(brainMetrics.oldestAgentDonePendingSeconds(), 0, "and nothing is waiting");
});

test("P2 a result left in the outbox is replayed, made storable, and lands", { skip }, async () => {
  const request = await seedTask("t-replay");
  outputs.delete("t-replay");
  // What an earlier delivery stored before its pod went away mid-callback.
  store.set("task-result.t-replay", enc.encode(JSON.stringify({
    ...scriptResult("left behind\u0000"), outbox_since_ms: Date.now() - 60_000,
  })));
  assert.deepEqual(await deliver(request), ["ack"]);
  const replayed = await row("t-replay");
  assert.equal(replayed.status, "completed");
  assert.equal(replayed.output, `left behind${REPLACEMENT}`);
  assert.equal(store.has("task-result.t-replay"), false);
});

test("P3 a replayed result refused twice is quarantined, not naked", { skip }, async () => {
  const request = await seedTask("t-replay-refused");
  outputs.delete("t-replay-refused");
  refuseAll.add("t-replay-refused");
  store.set("task-result.t-replay-refused", enc.encode(JSON.stringify({
    ...scriptResult("stored by the delivery before"), outbox_since_ms: Date.now() - 60_000,
  })));
  assert.deepEqual(await deliver(request), ["ack"]);
  assert.equal(store.has("task-result.t-replay-refused"), false);
  const record = JSON.parse(dec.decode(store.get("task-quarantine.t-replay-refused")!)) as Record<string, unknown>;
  assert.equal((record.result as { finalText: string }).finalText, "stored by the delivery before");
  assert.equal((await row("t-replay-refused")).status, "running");
});
