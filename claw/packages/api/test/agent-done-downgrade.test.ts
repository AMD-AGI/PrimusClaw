// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import type { ExecuteRequest, ExecuteResult, RunTimeLedgerEntry, RunTimeReport } from "@claw/protocol";
import { postAgentDone } from "../../brain/src/tasks/callback.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { startHarness, seedRun, seedSession, runRow, type Harness } from "./scenario-harness.js";

const TOKEN = "callback-downgrade-token";
const SESSION = "callback-downgrade-session";
const TASK = "callback-downgrade-run";
const BRAIN = "current-brain";
const BODY_LIMIT = 4 * 1024 * 1024;
const originalToken = process.env.AUTH_INTERNAL_TOKEN;
const originalFetch = globalThis.fetch;
let h: Harness;
let app: FastifyInstance;
let callbacks: Array<{ status: number; bytes: number; body: Record<string, unknown> }>;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  h = await startHarness();
  app = Fastify({ bodyLimit: BODY_LIMIT });
  await registerInternalTaskRoutes(app);
  await app.ready();
  globalThis.fetch = (async (url: string | URL | Request, init: RequestInit) => {
    const payload = init.body as string;
    const response = await app.inject({
      method: "POST", url: new URL(String(url)).pathname,
      headers: init.headers as Record<string, string>, payload,
    });
    callbacks.push({ status: response.statusCode, bytes: Buffer.byteLength(payload), body: JSON.parse(payload) });
    return new Response(response.body, { status: response.statusCode });
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalToken;
  await app.close();
  await h.close();
});

beforeEach(async () => {
  callbacks = [];
  await h.reset();
  await seedSession(h, SESSION);
  await seedRun(h, TASK, SESSION, {
    status: "running", origin: "task", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: 45,
  });
});

function report(attemptId = "attempt-current", deliveryCount = 2): RunTimeReport {
  return {
    key: TASK, attemptId, claimCount: 0, deliverySeq: 10, deliveryCount,
    basis: { kind: "same_domain", domain: "brain" }, cumulativeStateMs: { executing: 20 },
  };
}

function post(action: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST", url: `/v1/internal/tasks/${TASK}/${action}`,
    headers: { authorization: `Bearer ${TOKEN}` }, payload,
  });
}

function renew(current: RunTimeReport) {
  return post("lease", {
    brain_id: BRAIN, lease_seconds: 45, phase: "executing",
    attempt_id: current.attemptId, claim_count: current.claimCount,
    delivery_seq: current.deliverySeq, delivery_count: current.deliveryCount,
  });
}

function deliverOversized(runTime?: RunTimeReport) {
  const request = {
    task_id: TASK, session_id: SESSION, callback_url: `http://api.test/v1/internal/tasks/${TASK}`,
    backend_internal_token: TOKEN,
  } as ExecuteRequest;
  const result = {
    finalText: "finished result", turns: 1, pendingMemories: [], pendingSkills: [], skillsUsed: {},
    errorCount: 0, abortReason: "completed", captures: { output: "x".repeat(BODY_LIMIT + 1024) },
  } as ExecuteResult;
  return postAgentDone(request, result, runTime);
}

function assertShedRetry() {
  assert.deepEqual(callbacks.map((callback) => callback.status), [413, 200]);
  assert.ok(callbacks[0].bytes > BODY_LIMIT);
  assert.ok(callbacks[1].bytes < 32 * 1024);
}

test("an oversized stale callback cannot end its successor through the actual 413 retry", async () => {
  const current = report();
  assert.equal((await renew(current)).statusCode, 200);
  const live = await runRow(h, TASK);

  await deliverOversized(report("attempt-old", 1));

  assertShedRetry();
  assert.deepEqual(await runRow(h, TASK), live);
  assert.equal((await renew(current)).statusCode, 200, "the live attempt still owns its next renewal");
});

test("an oversized current callback still completes with its attempt identity", async () => {
  const current = report();
  assert.equal((await renew(current)).statusCode, 200);

  await deliverOversized(current);

  assertShedRetry();
  const row = await runRow(h, TASK);
  assert.equal(row.status, "completed");
  assert.equal(row.attempt_id, current.attemptId);
  assert.match(row.output as string, /exceeded the size/);
  const ledger = (row.metadata as { run_phase: { ledger: RunTimeLedgerEntry } }).run_phase.ledger;
  assert.ok(ledger.attempts.find((attempt) => attempt.attemptId === current.attemptId)?.endedAtDb);
  assert.equal(ledger.knownMsByState.executing ?? 0, 0, "shedding coverage must not invent a duration");
});

test("legacy callbacks without a report still complete after an actual 413", async () => {
  await deliverOversized();

  assertShedRetry();
  assert.ok(callbacks.every((callback) => !Object.hasOwn(callback.body, "run_time")));
  const row = await runRow(h, TASK);
  assert.equal(row.status, "completed");
  assert.equal(row.attempt_id, null);
});
