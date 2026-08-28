// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";

import { constantTimeEquals } from "../src/security/constant-time.js";

test("constantTimeEquals: equal secrets match", () => {
  assert.equal(constantTimeEquals("s3cret-token", "s3cret-token"), true);
});

test("constantTimeEquals: different secrets do not match", () => {
  assert.equal(constantTimeEquals("s3cret-token", "s3cret-tokeN"), false);
  assert.equal(constantTimeEquals("abc", "abd"), false);
});

test("constantTimeEquals: different lengths do not match and do not throw", () => {
  // node's timingSafeEqual throws on unequal buffer lengths. Hashing first makes
  // both sides 32 bytes, so this must return false rather than surface a 500.
  assert.equal(constantTimeEquals("short", "much-longer-secret"), false);
  assert.equal(constantTimeEquals("much-longer-secret", "short"), false);
  assert.equal(constantTimeEquals("a", "a".repeat(4096)), false);
});

test("constantTimeEquals: a prefix of the secret does not match", () => {
  // The bug this guards against is a comparison that stops at the shorter
  // length, which would let any prefix authenticate.
  assert.equal(constantTimeEquals("s3cret", "s3cret-token"), false);
  assert.equal(constantTimeEquals("s3cret-token", "s3cret"), false);
});

test("constantTimeEquals: an unset expected secret fails closed", () => {
  // Guards the `AUTH_INTERNAL_TOKEN` unset case: "" must never authenticate.
  assert.equal(constantTimeEquals("", ""), false);
  assert.equal(constantTimeEquals("anything", ""), false);
  assert.equal(constantTimeEquals("", "anything"), false);
});

test("constantTimeEquals: multi-byte secrets compare by bytes, not code units", () => {
  assert.equal(constantTimeEquals("tökén", "tökén"), true);
  assert.equal(constantTimeEquals("tökén", "token"), false);
});
