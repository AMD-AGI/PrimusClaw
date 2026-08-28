// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// redactSecrets + scanForSecretLeak smoke tests against the canonical secret
// patterns the codebase enforces against.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, safePreview, scanForSecretLeak } from "../src/security/redact-secrets.js";

test("redact CLAW_INTERNAL_TOKEN literal", () => {
  const text = "before CLAW_INTERNAL_TOKEN=abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789 after";
  const r = redactSecrets(text);
  assert.ok(r.hits >= 1, "must redact at least one hit");
  assert.equal(r.text.includes("abcdef0123456789"), false, "raw hex must not survive");
});

test("redact Authorization Bearer", () => {
  const text = `Authorization: Bearer sk-wwgPBEXkGzHHqFi649yfew\nrest of body`;
  const r = redactSecrets(text);
  assert.equal(r.text.includes("sk-wwgPBEXkGzHHqFi649yfew"), false);
  assert.match(r.text, /Bearer\s+<redacted>/);
});

test("redact x-api-key header literal", () => {
  const text = `x-api-key: ak-EXAMPLE-not-a-real-key_00000000000000000000`;
  const r = redactSecrets(text);
  assert.equal(r.text.includes("ak-EXAMPLE-not-a-real-key_00000000000000000000"), false);
  assert.ok(r.hits >= 1);
});

test("redact 64-char hex token bare", () => {
  const tok = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
  const text = `something ${tok} else`;
  const r = redactSecrets(text);
  assert.equal(r.text.includes(tok), false);
});

test("redact extra explicit secret", () => {
  const tok = "abracadabra_my_internal_token_value_64_chars_long_AAAAAAAAAAAAAA";
  const text = `value=${tok}`;
  const r = redactSecrets(text, [tok]);
  assert.equal(r.text.includes(tok), false);
  assert.match(r.text, /<redacted>/);
});

test("scanForSecretLeak detects Bearer without mutating", () => {
  const text = "x-api-key: sk-1234567890abcdefghij something";
  const hit = scanForSecretLeak(text);
  assert.ok(hit, "expected hit");
  assert.equal(hit!.category, "x_api_key");
});

test("scanForSecretLeak detects explicit secret", () => {
  const text = "logger.info: token leaked here: my-secret-12345-very-long-value";
  const hit = scanForSecretLeak(text, ["my-secret-12345-very-long-value"]);
  assert.ok(hit, "explicit-secret hit");
  assert.equal(hit!.category, "explicit_secret");
});

test("clean text returns no hit", () => {
  const text = "everything is fine here, no secrets at all";
  const r = redactSecrets(text);
  assert.equal(r.hits, 0);
  assert.equal(r.text, text);
  assert.equal(scanForSecretLeak(text), null);
});

// safePreview: redaction must happen before truncation.

test("safePreview truncates to the requested length", () => {
  const out = safePreview("x".repeat(100), 10);
  assert.equal(out, `${"x".repeat(10)}…`);
});

test("safePreview leaves short clean text untouched", () => {
  assert.equal(safePreview("hello world", 500), "hello world");
});

test("safePreview redacts a secret that straddles the cut", () => {
  // The Bearer token starts before the 40-char cut and continues past it.
  // Truncating first would slice it mid-token, leaving a fragment that no
  // longer matches the catalogue and so survives into the log.
  const text = `${"a".repeat(20)} Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345 trailing`;
  const out = safePreview(text, 40);
  assert.equal(out.includes("sk-abcdefghij"), false, "no fragment of the token may survive");
  assert.ok(out.includes("<redacted>"), "the token must be replaced, not merely cut off");
});

test("safePreview redacts beyond the truncation point without leaking it", () => {
  const text = `head ${"b".repeat(600)} Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345`;
  const out = safePreview(text, 50);
  assert.equal(out.includes("sk-abcdef"), false);
  assert.ok(out.length <= 51, "output stays bounded");
});

test("safePreview handles empty input", () => {
  assert.equal(safePreview("", 100), "");
});
