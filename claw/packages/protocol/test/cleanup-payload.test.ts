// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the cleanup message payload.
 *
 * The encoder runs in the API and the decoder in Brain, so they live together
 * here rather than as two private helpers that could drift apart. What the
 * payload carries is the SaFE key the teardown authenticates with: Brain used
 * to read it from the session's `hands.<sid>` KV entry, which is deleted from
 * two directions while the teardown runs, and a teardown without a key leaves
 * the session's GPU clusters running.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { encodeCleanupPayload, decodeCleanupPayload } from "../src/subjects.js";

test("a published key survives the round trip", () => {
  const wire = encodeCleanupPayload({ platformKey: "safe-key-123" });
  assert.equal(decodeCleanupPayload(wire).platformKey, "safe-key-123");
});

test("an empty payload is not an error, just no key", () => {
  // A publisher predating the payload sends no body at all; the consumer is
  // expected to fall back to its own lookup rather than fail the teardown.
  for (const raw of ["", undefined, null]) {
    assert.deepEqual(decodeCleanupPayload(raw), {});
  }
});

test("unusable payloads decode to no key rather than throwing", () => {
  // Every one of these means "fall back to the lookup". A teardown must never
  // be lost to a malformed message.
  for (const raw of ["not json", "[]", "null", '"a string"', "42", '{"platformKey":7}', "{}"]) {
    assert.deepEqual(decodeCleanupPayload(raw), {}, `raw=${raw}`);
  }
});

test("only the key is carried across, not whatever else was sent", () => {
  const decoded = decodeCleanupPayload('{"platformKey":"k","somethingElse":"ignored"}');
  assert.deepEqual(decoded, { platformKey: "k" });
});
