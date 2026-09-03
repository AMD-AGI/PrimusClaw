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

// ── Boundaries ──────────────────────────────────────────────────────────────

test("the token check is applied to what the operator actually typed", () => {
  // The env parse trims and lowercases, so these reach the predicate only when
  // a caller forgets to. It is exported, so that caller exists: the guard has
  // to hold on the raw string rather than assume it was normalized first.
  for (const bad of [
    "",                       // an entry that was nothing but a comma
    " x-request-id",          // an untrimmed list entry
    "x-request-id ",
    "x-reqüest",         // a non-ASCII character that looks like a letter
    "x-request-id, cf-ray",   // the whole list handed over unsplit
    "x-request-id\t",
  ]) {
    assert.throws(
      () => assertDiagnosableHeaderName(bad),
      /not a valid HTTP header name/,
      `${JSON.stringify(bad)} would throw inside Headers.get() on every response`,
    );
  }
});

test("a credential name is refused whatever case it is written in", () => {
  // Header names are case-insensitive on the wire, so a list of lowercase
  // spellings has to be compared case-insensitively. `WWW-Authenticate` was
  // accepted: the set holds only `www-authenticate`, and the word-level
  // predicate does not cover that name at all.
  for (const bad of [
    "Authorization", "AUTHORIZATION", "Proxy-Authorization",
    "WWW-Authenticate", "WWW-AUTHENTICATE", "Proxy-Authenticate",
    "Set-Cookie", "X-Amz-Security-Token", "X-CSRF-Token", "X-XSRF-Token",
  ]) {
    assert.throws(
      () => assertDiagnosableHeaderName(bad),
      /carries a credential/,
      `${JSON.stringify(bad)} is the same header as its lowercase spelling`,
    );
  }
});

test("credential-shaped names nobody put on a list are caught by the word rule", () => {
  // The point of sharing isSensitiveKey with the redactor rather than keeping
  // a second fixed list: these are the names that get thought of second, and a
  // credential word added for the redactor is added for this at the same time.
  for (const bad of [
    "x-client-secret", "x-access-token", "x-refresh-token", "x-goog-api-key",
    "x-private-key", "x-session-cookie", "x-user-password", "x-github-pat",
    "x-db-dsn", "x-signing-key", "x-platform-key",
  ]) {
    assert.throws(() => assertDiagnosableHeaderName(bad), /carries a credential/);
  }
});

test("a name that merely contains credential letters is still accepted", () => {
  // The word rule must not become a substring rule: rejecting these would take
  // away the rate-limit and request-id headers that are the normal thing to
  // capture, and a rejection is a boot failure, not a dropped field.
  for (const ok of [
    "x-ratelimit-key",        // `key` alone is not a credential word
    "x-tokenizer-version",    // contains "token" only as letters
    "x-compat-mode",          // contains "pat" only as letters
    "x-request-path",
    "x-envoy-upstream-service-time",
  ]) {
    assert.doesNotThrow(
      () => assertDiagnosableHeaderName(ok),
      `${JSON.stringify(ok)} identifies an upstream and must stay capturable`,
    );
  }
});

test("the auth family is rejected as a word, not as a list of names", () => {
  // A fixed list only rejects what someone thought of, and these are what
  // gets thought of second. All four passed validation before, and any of
  // them would have carried a credential into the cache-loss log.
  for (const name of [
    "x-auth", "x-auth-key", "authentication-info", "proxy-authentication-info",
    // Header names are case-insensitive on the wire, so the check has to be.
    "X-Auth", "X-AUTH-KEY", "Authentication-Info", "Proxy-Authentication-Info",
    // Shapes the word rule picks up without anyone listing them.
    "auth-token", "x-auth-token", "x-authentication",
  ]) {
    assert.throws(
      () => assertDiagnosableHeaderName(name),
      /carries a credential/,
      `${JSON.stringify(name)} must be rejected`,
    );
  }
});

test("headers that merely contain the letters auth are still diagnosable", () => {
  // The word split is what makes the rule above safe to state so broadly:
  // none of these contains `auth` as a word, so none of them is caught.
  for (const name of ["x-author", "oauth-provider", "x-authored-by", "x-request-id"]) {
    assert.doesNotThrow(() => assertDiagnosableHeaderName(name), `${name} is safe`);
  }
});
