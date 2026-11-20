// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A result the API cannot store is not resent.
//
// The API answers 422 when the database refused the values in an `agent_done`
// body (SQLSTATE 22021, 22P05, 22P02, 22003). Before, Brain read every non-2xx
// the same way: three attempts, then a nak, then the whole delivery again --
// the same refused body each time until the poison guard ran out of
// deliveries. Now a 422 is answered once, with a failure that carries none of
// the original body, and a second 422 ends the delivery with
// `AgentDoneRejectedError`, which the runner quarantines instead of naking.
//
//   R1 422 then 200: the run is reported failed with `result_unstorable`, and
//      nothing from the refused result is sent again
//   R2 422 twice: exactly two requests, then AgentDoneRejectedError (not a
//      delivery error, which every caller answers with a nak)
//   R3 a 500 is still retried three times and ends as a delivery error
//   R4 the health metrics: failures by status, consecutive failures reset by a
//      success, and the oldest pending result's age

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  AgentDoneDeliveryError, AgentDoneRejectedError, RESULT_UNSTORABLE_REASON, postAgentDone,
} from "../src/tasks/callback.js";
import {
  AGENT_DONE_PENDING_FORGET_MS, agentDoneConsecutiveFailures, metrics, oldestAgentDonePendingSeconds, registry,
} from "../src/infra/metrics.js";

const SECRET_OUTPUT = "stdout of the step\u0000with a NUL";

function result(over: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    finalText: SECRET_OUTPUT,
    captures: { stdout: SECRET_OUTPUT },
    tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0 },
    turns: 3_000_000_000,
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 1, error_calls: 0, by_tool: { bash: 1 } },
    elapsedMs: 12,
    abortReason: "completed",
    ...over,
  } as ExecuteResult;
}

/** A callback endpoint answering each request with the next status in `statuses`. */
async function api(statuses: number[]) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const status = statuses[Math.min(bodies.length - 1, statuses.length - 1)]!;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(status === 422
        ? JSON.stringify({ ok: false, error: "unstorable_result", sqlstate: "22003" })
        : JSON.stringify({ ok: status < 300 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    request: (taskId: string) => ({
      task_id: taskId, session_id: "sess-refused", message_id: taskId, mode: "script",
      callback_url: `http://127.0.0.1:${port}/v1/internal/tasks/${taskId}`,
      backend_internal_token: "per-task-token",
    }) as unknown as ExecuteRequest,
    bodies,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

async function counter(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  const value = metric?.values.find((v) => Object.entries(labels).every(([k, l]) => v.labels[k] === l));
  return Number(value?.value ?? 0);
}

test("R1 a refused result is replaced by a failure carrying none of it", async () => {
  const endpoint = await api([422, 200]);
  try {
    await postAgentDone(endpoint.request("t-r1"), result());
    assert.equal(endpoint.bodies.length, 2);
    const [first, second] = endpoint.bodies;
    assert.equal(first!.final_text, SECRET_OUTPUT, "the first attempt is the result as it was");
    assert.equal(second!.abort_reason, "error");
    assert.equal(second!.failure_reason, RESULT_UNSTORABLE_REASON);
    assert.match(String(second!.failure_message), /SQLSTATE 22003/);
    assert.equal(second!.turns, undefined, "a count out of range is one of the refusals, so it is not resent");
    assert.ok(!JSON.stringify(second).includes("with a NUL"), "nothing from the refused body is sent again");
  } finally {
    await endpoint.close();
  }
});

test("R2 a refused failure ends the delivery after two requests, as a rejection", async () => {
  const endpoint = await api([422]);
  try {
    const err = await postAgentDone(endpoint.request("t-r2"), result()).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof AgentDoneRejectedError, `expected a rejection, got ${String(err)}`);
    assert.ok(!(err instanceof AgentDoneDeliveryError), "a delivery error is naked and resent");
    assert.equal(err.status, 422);
    assert.equal(err.sqlstate, "22003");
    assert.equal(endpoint.bodies.length, 2);
  } finally {
    await endpoint.close();
  }
});

test("R3 a 500 is still retried and ends as a delivery error", async () => {
  const endpoint = await api([500]);
  try {
    const err = await postAgentDone(endpoint.request("t-r3"), result({ turns: 1 })).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof AgentDoneDeliveryError, `expected a delivery error, got ${String(err)}`);
    assert.equal(endpoint.bodies.length, 3);
  } finally {
    await endpoint.close();
  }
});

test("R4 failures by status, consecutive failures, and the oldest pending result", async () => {
  const before500 = await counter("claw_brain_agent_done_failures_total", { status: "500" });
  const endpoint = await api([500, 500, 200]);
  try {
    const t0 = Date.now();
    metrics.onAgentDoneDelivered(undefined);
    assert.equal(agentDoneConsecutiveFailures(), 0);
    await postAgentDone(endpoint.request("t-r4"), result({ turns: 1 }), undefined, t0 - 90_000);
    assert.equal(await counter("claw_brain_agent_done_failures_total", { status: "500" }), before500 + 2);
    assert.equal(agentDoneConsecutiveFailures(), 0, "a success ends the run of failures");
    // R3's result is still pending (a seconds-old one); this one, 90 s old, is not.
    assert.ok(oldestAgentDonePendingSeconds() < 60, "a delivered result is no longer pending");
  } finally {
    await endpoint.close();
  }

  const failing = await api([500]);
  try {
    const since = Date.now() - 90_000;
    await assert.rejects(postAgentDone(failing.request("t-r4b"), result({ turns: 1 }), undefined, since));
    assert.equal(agentDoneConsecutiveFailures(), 3);
    assert.ok(oldestAgentDonePendingSeconds() >= 90, "the age counts from when the result was first stored");
    assert.equal(await counter("claw_brain_agent_done_consecutive_failures"), 3);
    assert.ok(await counter("claw_brain_agent_done_oldest_pending_seconds") >= 90);
    // Nobody has tried it for longer than the forget window: another replica took the redelivery.
    assert.equal(oldestAgentDonePendingSeconds(Date.now() + AGENT_DONE_PENDING_FORGET_MS + 1), 0);
  } finally {
    await failing.close();
  }
});
