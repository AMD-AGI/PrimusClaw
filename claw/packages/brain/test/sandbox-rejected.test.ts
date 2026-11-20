// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A create the platform refuses ends terminally, as `sandbox_rejected`, with the
// platform's own words and, when the refusal is about the timeout, the number the
// run asked for beside the one Claw sent.
//
// 2026-11-20: SaFE's admission webhook started refusing Sandbox workloads whose
// `timeout` is above a per-cluster QoS ceiling ("timeout 64800 exceeds the qos
// limit of 10800 seconds for scope Sandbox"). The provider threw that as an
// ordinary, retryable error; the run then ended with no failure reason at all.
// Claw adds an hour to the requested timeout, so the number SaFE names (64800)
// is not one the caller ever sent (61200).

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";

import { SafeWorkloadProvider, createRefused, SHUTDOWN_BUFFER_SECONDS } from "../src/sandbox/safe-workload-provider.js";
import {
  SandboxProvisionTerminalError, SANDBOX_REJECTED, platformErrorText, sandboxOpenFailureOf, sandboxUnavailableOf,
  timeoutRefusalNote, workloadTerminalText,
} from "../src/sandbox/errors.js";
import { classifySandboxFailure } from "../src/sandbox/reaper.js";

/** SaFE's answer to the 2026-11-20 create: the apiserver's error shape around the webhook's status. */
const WEBHOOK_DENIAL = JSON.stringify({
  errorCode: "Primus.00002",
  errorMessage: "admission webhook \"vworkload.kb.io\" denied the request: Bad request. "
    + "timeout 64800 exceeds the qos limit of 10800 seconds for scope Sandbox",
});
const KEY = "safe-key-0b1c2d3e4f5a6b7c";

let realFetch: typeof fetch | null = null;
let sent: Array<Record<string, unknown>> = [];
afterEach(() => {
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = null;
  sent = [];
});

function answer(status: number, body: string): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.body) sent.push(JSON.parse(String(init.body)));
    return new Response(body, { status });
  }) as unknown as typeof fetch;
}

const params = (timeoutSec?: number) => ({
  sessionId: "s", namespace: "default", image: "img:1", resources: { cpu: "1" }, env: {}, platformKey: KEY,
  ...(timeoutSec === undefined ? {} : { timeoutSec }),
});

test("the production webhook denial: terminal sandbox_rejected, SaFE's words, the timeout asked for and the one sent", async () => {
  answer(400, WEBHOOK_DENIAL);
  const events: Array<Record<string, unknown>> = [];
  const err = await new SafeWorkloadProvider()
    .create({ ...params(61_200), onEvent: async (e) => { events.push(e); } })
    .then(() => null, (e: unknown) => e);
  assert.ok(err instanceof SandboxProvisionTerminalError);
  assert.equal(err.reason, SANDBOX_REJECTED);
  assert.equal(sent[0]!.timeout, 61_200 + SHUTDOWN_BUFFER_SECONDS);
  assert.equal(
    err.message,
    "The platform refused to create the sandbox (HTTP 400): admission webhook \"vworkload.kb.io\" denied the request: "
      + "Bad request. timeout 64800 exceeds the qos limit of 10800 seconds for scope Sandbox "
      + "The run asked for timeout=61200s; Claw adds 3600s to stop the run cleanly and sent timeout=64800s, "
      + "above the platform's limit of 10800s.",
  );
  // A run is told not to open it again (the same request is refused again).
  assert.equal(sandboxUnavailableOf(err), err);
  // The session's events say it too, as the sandbox's failed status.
  assert.deepEqual(events.filter((e) => e.status === "failed").map((e) => e.reason), [SANDBOX_REJECTED]);
});

test("the note names the requested timeout that fits when only the padding is over the ceiling", () => {
  const text = "timeout 14400 exceeds the qos limit of 10800 seconds for scope Sandbox";
  assert.equal(
    timeoutRefusalNote(text, { requestedSec: 10_800, sentSec: 14_400, bufferSec: 3600 }),
    "The run asked for timeout=10800s; Claw adds 3600s to stop the run cleanly and sent timeout=14400s, "
      + "above the platform's limit of 10800s. A timeout of at most 7200s fits.",
  );
});

test("the note says what was sent when the deployment capped it, or when the run named none", () => {
  const text = "timeout 86400 exceeds the qos limit of 10800 seconds for scope Sandbox";
  assert.equal(
    timeoutRefusalNote(text, { requestedSec: 90_000, sentSec: 86_400, bufferSec: 3600 }),
    "The run asked for timeout=90000s; Claw sent timeout=86400s (90000s + 3600s, capped by the deployment), "
      + "above the platform's limit of 10800s.",
  );
  assert.equal(
    timeoutRefusalNote(text, { sentSec: 86_400, bufferSec: 3600 }),
    "The run named no timeout; Claw sent timeout=86400s (the deployment's default), above the platform's limit of 10800s.",
  );
});

test("a refusal that is not about the timeout carries no timeout note", async () => {
  answer(422, JSON.stringify({ errorCode: "Primus.00002", errorMessage: "Bad request. image is not allowed: img:1" }));
  const err = await new SafeWorkloadProvider().create(params(61_200)).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof SandboxProvisionTerminalError);
  assert.equal(err.message, "The platform refused to create the sandbox (HTTP 422): Bad request. image is not allowed: img:1");
});

test("the platform's text is bounded, on one line, and never carries the run's key", async () => {
  const long = `Bad request. bearer ${KEY}\n${"x".repeat(5000)}`;
  answer(400, JSON.stringify({ errorCode: "Primus.00002", errorMessage: long }));
  const err = await new SafeWorkloadProvider().create(params(600)).then(() => null, (e: unknown) => e) as Error;
  assert.ok(!err.message.includes(KEY), err.message);
  assert.ok(!err.message.includes("\n"));
  assert.ok(err.message.length < 800, String(err.message.length));
  // A 5xx keeps its retryable error, masked the same way.
  answer(503, `upstream said token=${KEY}`);
  const retryable = await new SafeWorkloadProvider().create(params(600)).then(() => null, (e: unknown) => e) as Error;
  assert.ok(!(retryable instanceof SandboxProvisionTerminalError));
  assert.ok(retryable.message.startsWith("Create Hands failed: HTTP 503"), retryable.message);
  assert.ok(!retryable.message.includes(KEY), retryable.message);
});

test("a body that is not SaFE's JSON is passed on as text; a JSON body without a message as itself", () => {
  assert.equal(platformErrorText("<html>Bad Gateway</html>"), "<html>Bad Gateway</html>");
  assert.equal(platformErrorText(JSON.stringify({ message: "denied" })), "denied");
  assert.equal(platformErrorText(""), "");
});

test("which answers are a refusal: every 4xx but 403 and the ones that mean later", () => {
  for (const s of [400, 401, 404, 409, 413, 422]) assert.equal(createRefused(s), true, String(s));
  for (const s of [200, 403, 408, 425, 429, 500, 502, 503]) assert.equal(createRefused(s), false, String(s));
});

test("a create that never reached the platform is a create that failed, and says so", async () => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  const err = await new SafeWorkloadProvider().create(params(600)).then(() => null, (e: unknown) => e) as Error;
  assert.equal(classifySandboxFailure(err.message), "sandbox_create_failed", err.message);
  assert.deepEqual(sandboxOpenFailureOf(err, classifySandboxFailure)?.reason, "sandbox_create_failed");
});

test("a terminal workload is described by its AdminFailed condition, never the scheduler's stale message", () => {
  assert.equal(
    workloadTerminalText({
      message: "In queue - insufficient resources",
      conditions: [
        { type: "Scheduled", status: "True" },
        { type: "AdminFailed", status: "True", reason: "FailedCreatePod", message: "exceeded quota: sandbox-quota" },
      ],
    }),
    "AdminFailed: FailedCreatePod: exceeded quota: sandbox-quota",
  );
  assert.equal(workloadTerminalText({ message: "stopped by owner" }), "stopped by owner");
  assert.equal(workloadTerminalText({}), "");
});

test("which open failures fail the run: provisioning endings and a failed create, not a refused account or a cancel", () => {
  const terminal = (reason: string) => new SandboxProvisionTerminalError(reason, "m");
  for (const reason of ["sandbox_rejected", "sandbox_workload_terminal", "sandbox_unschedulable", "sandbox_pending_timeout"]) {
    assert.equal(sandboxOpenFailureOf(terminal(reason), classifySandboxFailure)?.reason, reason);
  }
  for (const reason of ["sandbox_workspace_forbidden", "sandbox_workspace_not_allowed", "sandbox_wait_interrupted"]) {
    assert.equal(sandboxOpenFailureOf(terminal(reason), classifySandboxFailure), null, reason);
  }
  const wrapped = new Error("tool failed", { cause: new Error("Create Hands failed: HTTP 500 x") });
  assert.equal(sandboxOpenFailureOf(wrapped, classifySandboxFailure)?.reason, "sandbox_create_failed");
  assert.equal(sandboxOpenFailureOf(new Error("model provider timed out"), classifySandboxFailure), null);
});
