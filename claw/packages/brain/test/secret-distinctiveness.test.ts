// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which credential values may be hunted by blind substring replacement.
 *
 * Everything reaching this predicate is already vouched for by name, so the
 * question is not whether a value is secret but whether replacing it wherever
 * it appears will also destroy ordinary text -- in payloads that are logged,
 * streamed to users, and replayed to the model, where what is cut is gone.
 *
 * A flat length floor failed in both directions, and the two halves below pin
 * both failures at once. Raise the bar and `hunter2` leaks; lower it and
 * `true` is excised from every command in the transcript.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isDistinctiveSecret } from "../src/events/redaction.js";

test("a short but distinctive credential is still hunted", () => {
  // The regression that motivated this: DB_PASSWORD=hunter2 is named
  // unambiguously and is seven characters, and a 16-character floor sent it
  // to NATS, the event DB, SSE and the checkpoint verbatim.
  for (const secret of ["hunter2", "P@ssw0rd", "Hunter", "abc-123", "s3cr3t"]) {
    assert.ok(isDistinctiveSecret(secret), `${JSON.stringify(secret)} must be redacted`);
  }
});

test("long or structured values are hunted whatever they contain", () => {
  for (const secret of [
    `ghp_${"a".repeat(36)}`, "postgres://user:pw@host:5432/db",
    "sk-ant-api03-xxxxxxxxxxxx", "abcdefghijklmnop",
  ]) {
    assert.ok(isDistinctiveSecret(secret));
  }
});

test("a value that collides with prose is left alone whatever its name claims", () => {
  // A var called FEATURE_TOKEN holding "true" passes the name check. Hunting
  // it would cut that word out of every command and log line in the payload.
  for (const ordinary of ["true", "false", "yes", "no", "none", "default", "info", "debug"]) {
    assert.ok(!isDistinctiveSecret(ordinary), `${JSON.stringify(ordinary)} must not be substituted`);
  }
  for (const ordinary of ["main", "remote", "staging", "master", "prod"]) {
    assert.ok(!isDistinctiveSecret(ordinary), `${JSON.stringify(ordinary)} is vocabulary, not a token`);
  }
  for (const ordinary of ["8080", "3", "1.5", "2024"]) {
    assert.ok(!isDistinctiveSecret(ordinary), `${JSON.stringify(ordinary)} is a number`);
  }
});

test("a value too short to carry entropy is never substituted", () => {
  for (const tiny of ["", "a", "ab", "abc", "x1"]) assert.ok(!isDistinctiveSecret(tiny));
});
