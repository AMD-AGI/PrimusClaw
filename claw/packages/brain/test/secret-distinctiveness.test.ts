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
 * A flat length floor failed in both directions, and the halves below pin the
 * failures at once. Raise the bar and short real secrets leak; lower it and
 * `true` is excised from every command in the transcript.
 *
 * Two shapes have no separating predicate at all -- `hunter2` and
 * `getUserById2` are one shape -- and those are settled in favour of leaving
 * prose intact, for the reasons written down at `isDistinctiveSecret`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { isDistinctiveSecret } from "../src/events/redaction.js";

test("a short but distinctive credential is still hunted", () => {
  // The regression that motivated this: a short password is named
  // unambiguously and is seven characters, and a 16-character floor sent it
  // to NATS, the event DB, SSE and the checkpoint verbatim. Each of these
  // carries something no word does -- a symbol, a separator, digits inside
  // the letters -- which is exactly what `hunter2` lacks.
  for (const secret of ["P@ssw0rd", "abc-123", "s3cr3t", "x9k2m4p7"]) {
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
  // Case is not entropy. An env file writes MAIN, Staging and main for the
  // same word, and hunting the shouted spelling cuts it out of the transcript
  // exactly as thoroughly as hunting the quiet one would.
  for (const ordinary of ["MAIN", "Staging", "Prod", "REMOTE", "Master", "Hunter", "TRUE", "Debug"]) {
    assert.ok(!isDistinctiveSecret(ordinary), `${JSON.stringify(ordinary)} is the same word shouted`);
  }
  // Nor does internal casing make a word into a token. Product and API names
  // are written this way constantly, and a transcript is full of camelCase
  // identifiers; under a name like PROJECT_TOKEN the old mixed-case exemption
  // would have cut "GitHub" out of every sentence that used it.
  for (const ordinary of [
    "GitHub", "OpenAI", "iPhone", "macOS", "PyTorch", "JavaScript",
    "getUserById", "myVariable", "XkjQmzPl",
  ]) {
    assert.ok(
      !isDistinctiveSecret(ordinary),
      `${JSON.stringify(ordinary)} is spelled the way identifiers and product names are`,
    );
  }
  for (const ordinary of ["8080", "3", "1.5", "2024"]) {
    assert.ok(!isDistinctiveSecret(ordinary), `${JSON.stringify(ordinary)} is a number`);
  }
});

test("a value too short to carry entropy is never substituted", () => {
  for (const tiny of ["", "a", "ab", "abc", "x1"]) assert.ok(!isDistinctiveSecret(tiny));
});

// ── Boundaries ──────────────────────────────────────────────────────────────

test("past sixteen characters the run has to actually read as a word", () => {
  // This test used to assert that sixteen letters is "past what vocabulary
  // reaches", and that claim was simply false: `internationalization` is
  // twenty and `characterization` is exactly sixteen. Length still admits
  // anything shorter on faith, because everything that short collides with
  // something, but above the line the run is now judged on shape.
  assert.equal(isDistinctiveSecret("a".repeat(15)), false, "15 letters may be prose");
  assert.equal(isDistinctiveSecret("A".repeat(15)), false, "shouting does not add entropy");
  // A sixteen-character run of one letter is not a word by any reading, and
  // stays distinctive -- so the old assertions still hold, for a better
  // reason than the one they were written with.
  assert.equal(isDistinctiveSecret("a".repeat(16)), true, "one letter repeated is not a word");
  assert.equal(isDistinctiveSecret("A".repeat(16)), true, "the shape is the same in either case");
  // Casing is not consulted at all. It was, once, on the premise that a
  // mid-word capital meant a generated token -- but `GitHub`, `macOS` and
  // `iPhone` all change case mid-word, and the premise cost more than it
  // bought. What earns the exemption now is being letters and nothing else;
  // anything the number row or the punctuation keys touched is distinctive
  // above the floor, whatever case it is written in.
  for (const short of ["ma1n", "ma-n", "m.in", "s3cr3t", "P@ssw0rd", "abc-123"]) {
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

test("an identifier with a digit on the end is not distinctive enough to hunt", () => {
  // A var named PROJECT_TOKEN can hold `getUserById2`, and hunting it turns
  // "call getUserById2" in the transcript into "call <redacted>". There is no
  // predicate separating this from `hunter2`; see isDistinctiveSecret for why
  // the tie is broken towards leaving the transcript alone.
  for (const ordinary of [
    "getUserById2", "word2", "word123", "retry3", "Batch7", "step10", "hunter2",
  ]) {
    assert.ok(
      !isDistinctiveSecret(ordinary), `${JSON.stringify(ordinary)} reads as an identifier`,
    );
  }
});

test("a slash-joined pair of words is a path or a zone, not a token", () => {
  for (const ordinary of [
    "America/New_York", "Europe/London", "Asia/Tokyo", "feature/Login", "src/Main_Handler",
  ]) {
    assert.ok(!isDistinctiveSecret(ordinary), `${JSON.stringify(ordinary)} is path-shaped`);
  }
  // A path carrying anything a path does not carry stays huntable.
  for (const secret of ["prod/a9f3c2b1d4e5", "vault/kv2/db-password"]) {
    assert.ok(isDistinctiveSecret(secret), `${JSON.stringify(secret)} is not just words`);
  }
});

test("a toolchain string is not distinctive however punctuated it is", () => {
  // These are long, mixed-case and full of symbols, so every length-and-
  // entropy measure calls them distinctive. They are still build strings, and
  // a var named RUNTIME_TOKEN holding one is ordinary.
  for (const build of [
    "Node20.0.0-rc.1+OpenSSL3", "Python3.12RC1+NumPy2", "Rust1.80.0-beta.1+LLVM18",
    "x86_64+AVX2", "Python3.13t+NumPy2",
  ]) {
    assert.ok(!isDistinctiveSecret(build), `${JSON.stringify(build)} is a toolchain`);
  }
  // The exemption is for versions, not for anything with a word and a number
  // in it. These stay huntable, and `abc-123` is the one that says why the
  // version rule had to be narrower than the prose rule.
  for (const secret of ["abc-123", "vault/kv2/db-password", "prod/a9f3c2b1d4e5"]) {
    assert.ok(isDistinctiveSecret(secret), `${JSON.stringify(secret)} is still a secret`);
  }
});

test("a long ordinary word is not a secret however it is named", () => {
  // PROJECT_TOKEN=internationalization is collected by name, by design, and
  // the shape gate is the only thing left. Getting this wrong turned "enable
  // internationalization support" into "enable <redacted> support" -- the
  // exact corruption this whole pass exists to avoid.
  for (const word of [
    "internationalization", "characterization", "responsibilities",
    "institutionalization", "telecommunications", "indistinguishable",
    "juxtapositioning", "Internationalization", "CHARACTERIZATION",
  ]) {
    assert.ok(!isDistinctiveSecret(word), `${JSON.stringify(word)} is a word`);
  }
});

test("a long run of letters that is not a word is still a secret", () => {
  // The other direction, and the reason the fix could not simply be "letters
  // are always prose". None of these reads as English: no vowels to speak of,
  // consonants stacked, or hex -- which is vowel-rich only by accident of its
  // alphabet and is excluded before the vowel count is taken.
  for (const secret of [
    "XkjQmzPlVbNrTqWd", "zxjqvbnmwrtplkgf", "deadbeefcafebabe",
    "abcdefabcdefabcd", "qwrtpsdfghjklzxc",
  ]) {
    assert.ok(isDistinctiveSecret(secret), `${JSON.stringify(secret)} is not a word`);
  }
});
