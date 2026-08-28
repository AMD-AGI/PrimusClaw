// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The signal that moves a Backend row out of `preparing`.
 *
 * Its whole design point is that it is a report and not a handoff: `agent_done`
 * throws when it cannot be delivered, because the row's terminal state depends
 * on it and the execution message must stay unacked. This one must do the
 * opposite. If it fails, the run is still running and will still report how it
 * ended; only the description of the row in the meantime is less precise, and
 * failing a live run over that would trade a reporting problem for an
 * execution one.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { postTaskRunning } from "../src/tasks/callback.js";

interface Sent { url: string; init: RequestInit }

const realFetch = globalThis.fetch;

/** Records calls and answers however the test says. */
function stubFetch(responder: () => Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return responder();
  }) as typeof globalThis.fetch;
  return sent;
}

function request(over: Record<string, unknown> = {}): never {
  return {
    session_id: "s-1",
    message_id: "m-1",
    prompt: "hi",
    task_id: "ktsk_1",
    callback_url: "http://api/v1/internal/tasks/ktsk_1",
    backend_internal_token: "tok",
    ...over,
  } as never;
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test("posts the run-started status to the task's callback endpoint", async () => {
  const sent = stubFetch(async () => new Response("{}", { status: 200 }));
  await postTaskRunning(request());

  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://api/v1/internal/tasks/ktsk_1/event");
  const body = JSON.parse(String(sent[0].init.body));
  assert.deepEqual(body, {
    task_id: "ktsk_1",
    type: "statusUpdate",
    agent_status: "running",
  });
  const headers = sent[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok", "the endpoint is authenticated");
});

test("carries which brain and which sandbox are running the task", async () => {
  // `claw_tasks.brain_id` and `.sandbox_workload_id` have existed unwritten
  // since the table was created, and neither fact is knowable where the row
  // is: the dispatcher does not choose the pod and does not build the
  // sandbox. This call is the first moment both exist.
  const sent = stubFetch(async () => new Response("{}", { status: 200 }));
  await postTaskRunning(request(), { brainId: "brain-7", sandboxWorkloadId: "hands-abc" });

  const body = JSON.parse(String(sent[0].init.body));
  assert.equal(body.brain_id, "brain-7");
  assert.equal(body.sandbox_workload_id, "hands-abc");
});

test("omits a workload id it never learned rather than sending an empty one", async () => {
  // A sandbox lookup can come back empty. Sending "" would overwrite a
  // previous attempt's real id with nothing; leaving the field out lets the
  // receiver's COALESCE keep what it has.
  const sent = stubFetch(async () => new Response("{}", { status: 200 }));
  await postTaskRunning(request(), { brainId: "brain-7", sandboxWorkloadId: "" });

  const body = JSON.parse(String(sent[0].init.body));
  assert.equal(body.brain_id, "brain-7");
  assert.ok(!("sandbox_workload_id" in body), "an unknown id is absent, not blank");
});

test("stays silent for a chat run, which has no task row to move", async () => {
  const sent = stubFetch(async () => new Response("{}", { status: 200 }));
  await postTaskRunning(request({ task_id: undefined }));
  await postTaskRunning(request({ callback_url: undefined }));
  assert.equal(sent.length, 0);
});

test("a rejected signal does not fail the run", async () => {
  stubFetch(async () => new Response("nope", { status: 500 }));
  // Resolves. The alternative -- throwing -- would abort a run that is
  // executing perfectly well because Backend could not be told about it.
  await postTaskRunning(request());
});

test("an unreachable Backend does not fail the run", async () => {
  stubFetch(async () => { throw new Error("ECONNREFUSED"); });
  await postTaskRunning(request());
});

test("does not retry, unlike agent_done", async () => {
  // agent_done retries because delivery is the point. Here a stale `running`
  // is worth less than the latency, and the sweeper and the terminal callback
  // both correct the row anyway.
  const sent = stubFetch(async () => new Response("nope", { status: 503 }));
  await postTaskRunning(request());
  assert.equal(sent.length, 1);
});
