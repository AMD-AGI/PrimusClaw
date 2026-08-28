// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { claimNextRun, claimRun, failClaimedRun, unclaimRun } from "../src/clients/run-claim.js";

const originalFetch = globalThis.fetch;
const originalApiUrl = process.env.INTERNAL_BACKEND_URL;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiUrl === undefined) delete process.env.INTERNAL_BACKEND_URL;
  else process.env.INTERNAL_BACKEND_URL = originalApiUrl;
});

function jsonResp(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withApiUrl(): void {
  process.env.INTERNAL_BACKEND_URL = "http://api.example";
}

test("claim posts to the configured API, not a caller-supplied host", async () => {
  withApiUrl();
  const request = { session_id: "s-1", task_id: "ktsk_1", llm_api_key: "sk-live" };
  const seen: string[] = [];
  globalThis.fetch = (async (url) => {
    seen.push(String(url));
    return jsonResp(200, { ok: true, request, claim_count: 4 });
  }) as typeof fetch;
  assert.deepEqual(await claimRun("ktsk_1"), { request, claimCount: 4 });
  assert.deepEqual(seen, ["http://api.example/v1/internal/tasks/ktsk_1/claim"]);
});

test("an empty API URL is a retry, not a miss", async () => {
  delete process.env.INTERNAL_BACKEND_URL;
  const seen: string[] = [];
  globalThis.fetch = (async (url) => {
    seen.push(String(url));
    return jsonResp(200, { ok: true, request: {} });
  }) as typeof fetch;
  await assert.rejects(() => claimRun("ktsk_1"), /no_api_url/);
  await assert.rejects(() => claimNextRun(), /no_api_url/);
  assert.deepEqual(seen, []);
});

test("a settled 422 is a miss, not a throw", async () => {
  withApiUrl();
  globalThis.fetch = (async () => jsonResp(422, { ok: false, error: "unclaimable" })) as typeof fetch;
  assert.equal(await claimRun("ktsk_1"), null);
});

test("a lost claim race is a miss, not a throw", async () => {
  withApiUrl();
  globalThis.fetch = (async () => jsonResp(409, { ok: false })) as typeof fetch;
  assert.equal(await claimRun("ktsk_1"), null);
});

test("a vanished row is a miss, not a throw", async () => {
  withApiUrl();
  globalThis.fetch = (async () => jsonResp(404, { ok: false })) as typeof fetch;
  assert.equal(await claimRun("ktsk_1"), null);
});

test("an empty claim body is a miss", async () => {
  withApiUrl();
  globalThis.fetch = (async () => jsonResp(200, { ok: true, request: null })) as typeof fetch;
  assert.equal(await claimRun("ktsk_1"), null);
});

test("unclaim swallows a transport failure", async () => {
  withApiUrl();
  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  await unclaimRun("ktsk_1");
});

test("fail-claim posts session_deleted unless a doorbell term asks otherwise", async () => {
  withApiUrl();
  const seen: Array<{ url: string; body: { reason?: string } }> = [];
  globalThis.fetch = (async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return jsonResp(200, { ok: true });
  }) as typeof fetch;
  await failClaimedRun("ktsk_1");
  await failClaimedRun("ktsk_1", "claim_abandoned");
  await failClaimedRun("ktsk_1", "workspace_unbound");
  assert.equal(seen[0].url, "http://api.example/v1/internal/tasks/ktsk_1/fail-claim");
  assert.equal(seen[0].body.reason, "session_deleted");
  assert.equal(seen[1].body.reason, "claim_abandoned");
  assert.equal(seen[2].body.reason, "workspace_unbound");
});

test("fail-claim retries a 500 and stops on 409", async () => {
  withApiUrl();
  const statuses: number[] = [];
  globalThis.fetch = (async () => {
    const status = statuses.length < 1 ? 500 : 409;
    statuses.push(status);
    return jsonResp(status, { ok: false });
  }) as typeof fetch;
  await failClaimedRun("ktsk_1");
  assert.deepEqual(statuses, [500, 409]);
});

test("a claim response without a count still yields a first-attempt delay", async () => {
  // An API too old to report `claim_count`, or a row that read back null: the
  // backoff has to start somewhere, and zero would mean no delay at all.
  withApiUrl();
  const request = { session_id: "s-1", task_id: "ktsk_1" };
  globalThis.fetch = (async () => jsonResp(200, { ok: true, request })) as typeof fetch;
  assert.deepEqual(await claimRun("ktsk_1"), { request, claimCount: 1 });
});

test("the claim count travels with a claim-next handoff", async () => {
  withApiUrl();
  const request = { session_id: "s-2", task_id: "ktsk_2" };
  globalThis.fetch = (async () => jsonResp(200, { ok: true, request, claim_count: 7 })) as typeof fetch;
  assert.deepEqual(await claimNextRun(), { request, claimCount: 7 });
});
