// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { handsNetworkErrorReason, isHandsNetworkError } from "../src/clients/hands.js";

function netErr(code: string, message = "fetch failed"): Error {
  const err = new Error(message) as Error & { cause?: unknown };
  err.cause = { code };
  return err;
}

// These used to also assert which reasons were "ambiguous enough to probe
// first". That classification is gone: the recovery path asks the container and
// asks Hands' health route instead of inferring either from the error string,
// so what the reason has to do now is name the failure for a log line and be
// recognised as a network failure at all.

test("the reason comes from the error's cause chain, not its message", () => {
  assert.equal(handsNetworkErrorReason(netErr("UND_ERR_SOCKET")), "UND_ERR_SOCKET");
  assert.equal(handsNetworkErrorReason(netErr("ECONNREFUSED")), "ECONNREFUSED");
});

test("a bare fetch failure still yields a usable reason", () => {
  assert.equal(handsNetworkErrorReason(new Error("fetch failed")), "fetch failed");
});

test("an error with nothing to go on is named rather than left blank", () => {
  assert.equal(handsNetworkErrorReason(new Error("something else entirely")), "unknown");
  assert.equal(handsNetworkErrorReason(null), "unknown");
});

test("both the transient and the endpoint-gone classes count as network errors", () => {
  // Both reach the recovery path now, which is the point: the loop counts them
  // the same way and the recovery decides what they mean.
  for (const code of ["UND_ERR_SOCKET", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT"]) {
    assert.equal(isHandsNetworkError(netErr(code)), true, code);
  }
});

test("the whole undici family is recognised by code alone", () => {
  // undici reports these with an empty or generic message, so a classifier that
  // reads the message and not the code sends them to the LLM as tool output and
  // the run never reaches recovery at all.
  for (const code of [
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_CLOSED",
    "UND_ERR_DESTROYED",
  ]) {
    assert.equal(isHandsNetworkError(netErr(code, "")), true, code);
    assert.equal(handsNetworkErrorReason(netErr(code, "")), code, code);
  }
});

test("a deliberate abort is not a sandbox network failure", () => {
  // Cancellation is ours: a task that was stopped must not look like a sandbox
  // that broke, or shutting a run down would trigger a recovery of its sandbox.
  assert.equal(
    isHandsNetworkError(netErr("UND_ERR_ABORTED", "The operation was aborted")),
    false,
  );
});

test("a tool's own failure is not a network error", () => {
  assert.equal(isHandsNetworkError(new Error("command exited with code 1")), false);
});
