// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// redactSecrets + scanForSecretLeak smoke tests against the canonical secret
// patterns the codebase enforces against.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  redactSecrets, safePreview, scanForSecretLeak, looksLikeCredentialValue,
} from "../src/security/redact-secrets.js";

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

// ── Token boundaries ────────────────────────────────────────────────────────
//
// These patterns run over payloads that are replayed to the model, so an
// over-broad match does not mask a secret, it destroys conversation content.
// A prefix that appears mid-identifier must not start a match.

test("a vendor prefix inside a larger word is not a token", () => {
  for (const prose of [
    "task-management-system", "risk-assessment-framework", "disk-usage-monitoring-tool",
    `myhf_${"a".repeat(24)}`, `aghp_${"a".repeat(36)}`, "whisk-abcdefghijklmnopqrst",
  ]) {
    const r = redactSecrets(prose);
    assert.equal(r.text, prose, `${JSON.stringify(prose)} must survive byte-identical`);
    assert.equal(r.hits, 0);
  }
});

test("a real token at a boundary is still redacted", () => {
  for (const secret of [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz", `ghp_${"a".repeat(36)}`,
    `hf_${"b".repeat(24)}`, "AKIAIOSFODNN7EXAMPLE", `glpat-${"c".repeat(20)}`,
  ]) {
    for (const text of [secret, `key=${secret}`, `(${secret})`, `run ${secret} now`]) {
      const r = redactSecrets(text);
      assert.equal(r.text.includes(secret), false, `${JSON.stringify(text)} must be redacted`);
    }
  }
});

test("a password-only URI is redacted", () => {
  // redis:// and amqp:// URIs routinely carry no username at all. Requiring
  // one left the password in the clear in exactly the deployments that use it.
  for (const uri of [
    "redis://:s3cr3tpassword@cache.internal:6379/0",
    "amqp://:hunter2@broker:5672",
    "mongodb://user:pw123456@db.internal:27017/app",
  ]) {
    const r = redactSecrets(uri);
    assert.equal(r.text.includes("s3cr3tpassword"), false);
    assert.equal(r.text.includes("hunter2"), false);
    assert.equal(r.text.includes("pw123456"), false);
    assert.ok(r.text.includes("@"), "the host half must survive for the URI to stay diagnosable");
  }
  const plain = "redis://cache.internal:6379/0";
  assert.equal(redactSecrets(plain).text, plain, "a URI with no credentials is untouched");
});

// ── Leak scanning tracks the redactor ───────────────────────────────────────

test("scanForSecretLeak covers the shapes the redactor redacts", () => {
  for (const [text, category] of [
    [`token=ghp_${"a".repeat(36)}`, "vendor_token"],
    ["dsn=redis://:s3cr3tpassword@cache:6379", "url_credentials"],
  ] as const) {
    const hit = scanForSecretLeak(text);
    assert.ok(hit, `expected a hit for ${JSON.stringify(text)}`);
    assert.equal(hit!.category, category);
  }
  assert.equal(scanForSecretLeak("task-management-system is fine"), null);
});

// ── Credential-shaped values under unremarkable names ───────────────────────

test("looksLikeCredentialValue catches a symbol-bearing credential", () => {
  for (const secret of ["P@ssw0rd", "Xk9$mzPl2", "aB3!aB3!aB3!"]) {
    assert.ok(looksLikeCredentialValue(secret), `${JSON.stringify(secret)} reads as a credential`);
  }
});

test("looksLikeCredentialValue leaves paths, versions and prose alone", () => {
  // The incident this whole predicate is bounded by: MODEL_PATH=/models/Qwen3-8B
  // was collected as a secret and blind-substituted out of a thousand
  // transcripts. Anything with a slash or a space is a path or a sentence, and
  // a value with no symbol at all is not distinctive enough to hunt blind.
  for (const ordinary of [
    "/models/Qwen3-8B", "Qwen3-8B", "v1.2.3", "https://api.internal/v1",
    "sed -n '140,340p'", "backends/vllm_runner.py", "Staging", "abcdef123456",
    "P@w", "a".repeat(200),
  ]) {
    assert.equal(
      looksLikeCredentialValue(ordinary), false,
      `${JSON.stringify(ordinary)} must not be hunted by shape`,
    );
  }
});
