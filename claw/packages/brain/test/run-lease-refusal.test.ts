// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a refused lease renewal is read.
 *
 * The endpoint answers 409 to three different situations, and two of them ask
 * the refused worker for opposite things. A row that went terminal leaves this
 * worker holding a sandbox and a delivery nobody else can release; a row
 * another worker took over leaves it holding neither, whatever handles it still
 * has. Getting this backwards is not a smaller version of the same mistake --
 * it terminates the message the live worker is running from.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";

import { postRunLease } from "../src/tasks/callback.js";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const request = {
  session_id: "s-1",
  run_lease: { url: "http://api.test/v1/internal/tasks/t-1/lease", token: "tok" },
} as unknown as ExecuteRequest;

const renewal = {
  brainId: "brain-7", leaseSeconds: 45, phase: "executing" as const,
  waitReason: null, waitedMs: 0, waits: 0,
};

/** Answer every renewal with one status and one body. */
function apiAnswers(status: number, body: unknown): void {
  globalThis.fetch = (async () => ({
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  })) as unknown as typeof fetch;
}

test("a row that went terminal is one this worker has to give back", async () => {
  apiAnswers(409, { ok: false, reason: "terminal" });
  assert.equal(await postRunLease(request, renewal), "gone");
});

test("a row nobody can find is the same answer, for the same reason", async () => {
  // Nobody holds it either way, and the worker is the only one that can
  // release what it is holding.
  apiAnswers(409, { ok: false, reason: "missing" });
  assert.equal(await postRunLease(request, renewal), "gone");
});

test("a row another worker holds is one to leave completely alone", async () => {
  apiAnswers(409, { ok: false, reason: "superseded" });
  assert.equal(await postRunLease(request, renewal), "superseded");
});

test("an API too old to say is read as the answer that breaks nothing", async () => {
  // The window of a rolling upgrade, where the two mistakes are not the same
  // size: standing down on a terminal row costs what it cost before this
  // distinction existed, and giving a live worker's sandbox and message away
  // costs that worker's turn.
  apiAnswers(409, { ok: false, error: "run is not active" });
  assert.equal(await postRunLease(request, renewal), "superseded");
});

test("a body that is not JSON at all is read the same conservative way", async () => {
  globalThis.fetch = (async () => ({
    ok: false,
    status: 409,
    async json() { throw new Error("not json"); },
  })) as unknown as typeof fetch;
  assert.equal(await postRunLease(request, renewal), "superseded");
});

test("a failure that is not a refusal is not a verdict at all", async () => {
  // An API that is down, a timeout, a 500: treating any of them as "this run
  // is over" would stop every run on the fleet the moment the API had a bad
  // minute.
  apiAnswers(500, { error: "boom" });
  assert.equal(await postRunLease(request, renewal), null);
});

test("an accepted renewal reports the row's status", async () => {
  apiAnswers(200, { ok: true, status: "running" });
  assert.equal(await postRunLease(request, renewal), "running");
});

test("a run with no lease endpoint says nothing and calls nobody", async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; throw new Error("unreachable"); }) as never;
  assert.equal(await postRunLease({ session_id: "s-1" } as ExecuteRequest, renewal), null);
  assert.equal(called, false);
});
