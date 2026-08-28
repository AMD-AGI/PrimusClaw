// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The `timeout` string an exec carries is the *command's* deadline inside the
 * container. It says nothing about the HTTP call that delivers it, and the SaFE
 * provider used to pass no client-side bound at all -- so a Router that
 * accepted the connection and then went quiet held the caller for undici's
 * five-minute header timeout.
 *
 * That is on the critical path of the container probe, which runs between tool
 * batches precisely when the control plane is least likely to answer: the whole
 * agent loop stopped behind a call nobody was going to finish.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXEC_TRANSPORT_SLACK_MS,
  parseExecTimeoutMs,
} from "../src/sandbox/provider.js";

test("timeout strings are read in the units they are written in", () => {
  assert.equal(parseExecTimeoutMs("5s"), 5_000);
  assert.equal(parseExecTimeoutMs("30"), 30_000, "a bare number is seconds");
  assert.equal(parseExecTimeoutMs("10m"), 600_000);
  assert.equal(parseExecTimeoutMs("1h"), 3_600_000);
  assert.equal(parseExecTimeoutMs(" 5s "), 5_000);
});

test("an unparseable timeout falls back to a bounded default", () => {
  // Never unbounded: a malformed string is a caller bug, and answering it with
  // "wait forever" turns that bug into a stuck run.
  assert.equal(parseExecTimeoutMs("soon"), 60_000);
  assert.equal(parseExecTimeoutMs(""), 60_000);
  assert.equal(parseExecTimeoutMs("-5s"), 60_000);
});

test("the transport is given more time than the command it carries", () => {
  // The other order is worse than having no bound: the HTTP call would give up
  // while the command it was waiting for still had time on the clock, and every
  // long exec would fail just short of finishing.
  for (const timeout of ["5s", "10m", "1h"]) {
    const command = parseExecTimeoutMs(timeout);
    assert.ok(
      command + EXEC_TRANSPORT_SLACK_MS > command,
      `${timeout}: transport budget must exceed the command's own`,
    );
  }
  assert.ok(EXEC_TRANSPORT_SLACK_MS > 0);
});

test("the SaFE exec call gives up on its own, rather than waiting on undici", async () => {
  const { getSafeWorkloadProvider } = await import("../src/sandbox/factory.js");
  const realFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  let body: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    body = JSON.parse(String(init?.body ?? "{}"));
    return {
      ok: true,
      status: 200,
      json: async () => ({ exit_code: 0, stdout: "", stderr: "" }),
    } as unknown as Response;
  }) as typeof fetch;

  try {
    await getSafeWorkloadProvider().exec(
      {
        provider: "safe-workload",
        id: "wl-1",
        sandboxName: "wl-1",
        namespace: "ns",
        handsBaseUrl: "",
        platformKey: "pk",
      },
      "true",
      "5s",
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(signal instanceof AbortSignal, "the request must carry an abort signal");
  assert.equal(signal?.aborted, false, "and must not already be spent");
  // The command's own deadline still travels in the body: the two bounds are
  // different questions and the sandbox side needs its one.
  assert.equal(body.timeout, "5s");
});
