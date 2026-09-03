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

// ── Boundaries ──────────────────────────────────────────────────────────────

test("the lowercase-word exemption ends exactly where the docstring says", () => {
  // A plain lowercase run is vocabulary below 16 characters and a token at or
  // above it. Both sides are load-bearing and neither is obvious from the
  // code, so the step is pinned rather than left to be rediscovered: moving it
  // down leaks a generated lowercase token, moving it up excises a word.
  assert.equal(isDistinctiveSecret("a".repeat(15)), false, "15 lowercase letters may be prose");
  assert.equal(isDistinctiveSecret("a".repeat(16)), true, "16 is past what vocabulary reaches");
  // Only a *plain* lowercase run gets the exemption. Anything the shift key or
  // the number row touched is distinctive at any length above the floor.
  for (const short of ["Main", "ma1n", "ma-n", "m.in", "Prod", "s3cr3t"]) {
    assert.ok(isDistinctiveSecret(short), `${JSON.stringify(short)} does not occur in prose`);
  }
});

test("the length floor sits between three and four characters", () => {
  // Below the floor nothing is hunted whatever it looks like, because the
  // collision risk swamps any entropy a value that short can carry.
  for (const tiny of ["P@w", "a1!", "xY9"]) {
    assert.ok(!isDistinctiveSecret(tiny), `${JSON.stringify(tiny)} is under the floor`);
  }
  assert.ok(isDistinctiveSecret("P@w1"), "four characters with punctuation is hunted");
});

test("numbers are left alone in the spellings a config file actually uses", () => {
  // A var named *_SECRET holding a port or a size is ordinary, and cutting it
  // would rewrite every number that happened to match in the transcript.
  for (const n of ["8080", "1.5", "1,000", "0", "20250903", "1.50"]) {
    assert.ok(!isDistinctiveSecret(n), `${JSON.stringify(n)} is a number`);
  }
  // A version-like string is not one of those spellings, and is distinctive
  // enough to be safe to hunt; noted so the boundary is deliberate.
  assert.ok(isDistinctiveSecret("1.2.3"));
});

test("case alone does not make a boolean spelling distinctive", () => {
  // The list is compared lowercased. A var holding "TRUE" or "Disabled" is the
  // same collision hazard as one holding "true".
  for (const ordinary of ["TRUE", "False", "YES", "Off", "None", "NULL", "Default", "Debug"]) {
    assert.ok(!isDistinctiveSecret(ordinary), `${JSON.stringify(ordinary)} is a boolean spelling`);
  }
});
