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
import fs from "node:fs";

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

/**
 * What the provider's logger writes to stdout while `fn` runs. pino writes fd 1
 * through sonic-boom, with `fs.write` or `fs.writeSync`; both are watched.
 */
async function logsOf(fn: () => Promise<unknown>): Promise<string> {
  const mod = fs as unknown as Record<"write" | "writeSync", (...a: unknown[]) => unknown>;
  const real = { write: mod.write, writeSync: mod.writeSync };
  let out = "";
  const seen = (fd: unknown, data: unknown) => {
    if (fd === 1 && (typeof data === "string" || Buffer.isBuffer(data))) out += String(data);
  };
  mod.write = (...a: unknown[]) => { seen(a[0], a[1]); return real.write(...a); };
  mod.writeSync = (...a: unknown[]) => { seen(a[0], a[1]); return real.writeSync(...a); };
  try {
    await fn();
    // A line queued behind an earlier write goes out from that write's callback.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally { mod.write = real.write; mod.writeSync = real.writeSync; }
  return out;
}

test("a credential the sandbox's env carried, echoed back by the platform, is masked in the failure and the log", async () => {
  const CUSTOM = "custom-cred-9f8e7d6c5b4a3210";
  const withEnv = { ...params(61_200), env: { MY_SERVICE_CREDENTIAL: CUSTOM, SHORT: "1" } };
  const echo = `Bad request. env MY_SERVICE_CREDENTIAL=${CUSTOM} key ${KEY}`;
  for (const status of [400, 503]) {
    answer(status, JSON.stringify({ errorCode: "Primus.00002", errorMessage: echo }));
    let err: Error | null = null;
    const logs = await logsOf(async () => {
      err = await new SafeWorkloadProvider().create(withEnv).then(() => null, (e: unknown) => e as Error);
    });
    assert.ok(err, String(status));
    const message = (err as unknown as Error).message;
    assert.ok(message.includes("MY_SERVICE_CREDENTIAL=<redacted>"), message);
    assert.ok(!message.includes(CUSTOM) && !message.includes(KEY), message);
    // The refusal is logged here with the platform's body; a 5xx is logged by whoever catches it.
    if (status === 400) assert.ok(logs.includes("safe-workload.create_rejected"), `logged: ${logs}`);
    assert.ok(!logs.includes(CUSTOM) && !logs.includes(KEY), logs);
  }
});

/** Whether any piece of `secret` of 8 characters or more appears in `text`: a cut credential leaves its prefix. */
function leaksPartOf(text: string, secret: string): string | null {
  for (let at = 0; at + 8 <= secret.length; at++) {
    const piece = secret.slice(at, at + 8);
    if (text.includes(piece)) return piece;
  }
  return null;
}

const STRADDLING = "Zq9Xw2Lm7Pv4Rt8Ks1Hn6Bv3Cx5Dz0Qa";
/** 64 characters of a PEM body: a fixed, made-up sequence, different on each line. */
function fakeKeyLine(line: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  return Array.from({ length: 64 }, (_, i) => alphabet[(i * 7 + line * 13 + i * i * 3) % 64]).join("");
}
const PEM = [
  // Shaped like a PEM key, built here rather than written out so it is plainly not one.
  `-----BEGIN ${"PRIVATE"} KEY-----`,
  ...Array.from({ length: 3 }, (_, i) => fakeKeyLine(i)),
  `-----END ${"PRIVATE"} KEY-----`,
].join("\n");

test("a credential the platform echoed across the cut of its text leaves no part of it in the failure or the log", async () => {
  const withEnv = { ...params(61_200), env: { MY_CRED: STRADDLING } };
  // Placed so the value runs across the 600th character of the platform's text,
  // and the 300th of the logged body: cut before it is masked, its prefix would stay.
  for (const [status, lead] of [[400, 600 - 19], [503, 300 - 19 - "{\"errorMessage\":\"".length]] as const) {
    const said = `${"x".repeat(lead - " env MY_CRED=".length)} env MY_CRED=${STRADDLING} and more text after it`;
    answer(status, JSON.stringify({ errorMessage: said }));
    let err: Error | null = null;
    const logs = await logsOf(async () => {
      err = await new SafeWorkloadProvider().create(withEnv).then(() => null, (e: unknown) => e as Error);
    });
    const message = (err as unknown as Error).message;
    assert.equal(leaksPartOf(message, STRADDLING), null, `${status}: ${message}`);
    assert.equal(leaksPartOf(logs, STRADDLING), null, `${status}: ${logs}`);
  }
});

// Lines each too short to be masked alone: only the whole value, in the spelling the answer carries it in, is.
const SHORT_LINES = ["k7Qp2Wx9", "Rm4Tz8Lc", "Vb1Nh6Jd", "Fs3Gy5Ae"].join("\n");

for (const [name, cred] of [["a PEM key", PEM], ["a value of short lines", SHORT_LINES]] as const) test(`a multi-line credential (${name}) echoed back is masked as the platform wrote it: JSON-escaped, as text, or folded`, async () => {
  const PEM = cred;
  const withEnv = { ...params(61_200), env: { DEPLOY_PEM: PEM } };
  const echoes = [
    // SaFE's JSON error shape: the key's line breaks escaped in the body, real ones once parsed.
    JSON.stringify({ errorCode: "Primus.00002", errorMessage: `Bad request. env DEPLOY_PEM=${PEM} is invalid` }),
    // A plain-text answer quoting it as sent.
    `Bad request. env DEPLOY_PEM=${PEM} is invalid`,
    // An answer that already folded it onto one line.
    `Bad request. env DEPLOY_PEM=${PEM.replace(/\n/g, " ")} is invalid`,
    // An answer that quotes a single line of it.
    ...(cred === SHORT_LINES ? [] : [`Bad request. bad line ${PEM.split("\n")[2]}`]),
  ];
  const body = cred === SHORT_LINES ? [PEM.replace(/\n/g, "")] : PEM.split("\n").slice(1, -1);
  for (const status of [400, 503]) {
    for (const echo of echoes) {
      answer(status, echo);
      let err: Error | null = null;
      const logs = await logsOf(async () => {
        err = await new SafeWorkloadProvider().create(withEnv).then(() => null, (e: unknown) => e as Error);
      });
      const message = (err as unknown as Error).message;
      for (const line of body) {
        assert.equal(leaksPartOf(message, line), null, `${status} ${echo.slice(0, 40)}: ${message}`);
        assert.equal(leaksPartOf(logs, line), null, `${status} ${echo.slice(0, 40)}: ${logs}`);
      }
      assert.ok(message.includes("<redacted>"), message);
    }
  }
});

test("a 5xx body on several lines is folded onto one", async () => {
  answer(502, "<html>\r\n<h1>Bad Gateway</h1>\n\tupstream reset\n</html>");
  const err = await new SafeWorkloadProvider().create(params(600)).then(() => null, (e: unknown) => e) as Error;
  assert.equal(err.message, "Create Hands failed: HTTP 502 <html> <h1>Bad Gateway</h1> upstream reset </html>");
});

test("a body that is not SaFE's JSON is passed on as text; a JSON body without a message as itself", () => {
  assert.equal(platformErrorText("<html>Bad Gateway</html>", (t) => t), "<html>Bad Gateway</html>");
  assert.equal(platformErrorText(JSON.stringify({ message: "denied" }), (t) => t), "denied");
  assert.equal(platformErrorText("", (t) => t), "");
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
