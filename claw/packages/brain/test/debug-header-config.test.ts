// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A misconfigured diagnostic must fail at boot, not on the wire.
 *
 * Both rejections here protect against a mistake that is worse than the
 * feature is useful. An invalid HTTP token makes `Headers.get()` throw, and
 * that call sits inside the fetch wrapper after the response has arrived --
 * so a typo does not degrade a diagnostic, it fails every LLM request the
 * deployment makes. A credential name turns the diagnostic into the leak the
 * allowlist exists to prevent: the value is logged, and a gateway echoing
 * `authorization` back is ordinary.
 *
 * Rejecting rather than skipping, because a silently dropped name is
 * indistinguishable from a gateway that does not send that header -- the
 * operator then debugs the gateway.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { assertDiagnosableHeaderName } from "../src/config.js";

test("a name that is not an HTTP token is refused", () => {
  for (const bad of ["x upstream", "x:upstream", "x/upstream", "x\nupstream", "(comment)"]) {
    assert.throws(
      () => assertDiagnosableHeaderName(bad),
      /not a valid HTTP header name/,
      `${JSON.stringify(bad)} would throw inside Headers.get() on every response`,
    );
  }
});

test("a credential-bearing name is refused", () => {
  for (const bad of ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]) {
    assert.throws(() => assertDiagnosableHeaderName(bad), /carries a credential/);
  }
});

test("the headers this exists to capture are accepted", () => {
  for (const ok of [
    "x-litellm-model-id", "llm_provider-request-id", "x-ratelimit-remaining-tokens",
    "x-ratelimit-key", "x-request-id", "cf-ray",
  ]) {
    assert.doesNotThrow(() => assertDiagnosableHeaderName(ok));
  }
});
