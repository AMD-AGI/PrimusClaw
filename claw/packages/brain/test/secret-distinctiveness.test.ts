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
import { readFileSync } from "node:fs";
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
    "sk-ant-api03-xxxxxxxxxxxx", "aB3-dE6-fG9-hJ2",
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

test("length is not the axis, and neither is the shape of the letters", () => {
  // This test has been wrong twice, in the same direction both times. It once
  // asserted that sixteen letters is "past what vocabulary reaches"
  // (`internationalization` is twenty). It was then rewritten to assert that
  // a letter run is judged on shape, and that was wrong too
  // (`straightforwardly` stacks consonants and is still a word).
  //
  // Letters are now never hunted, at any length, in any casing. These four
  // are the assertions the two failed rules disagreed about, and they all
  // resolve the same way now.
  for (const letters of ["a".repeat(15), "A".repeat(15), "a".repeat(16), "A".repeat(16)]) {
    assert.equal(isDistinctiveSecret(letters), false, "letters are never hunted");
  }
  // What is still distinctive is anything that is not only letters. This is
  // the line that carries the whole predicate now, so it is the one to pin.
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
    // Round 8: consonant clusters (ghtf, rdl, ndst) and a vowel ratio under
    // a third. Every one of these is an ordinary English word.
    "straightforwardly", "straightforwardness", "misunderstandings",
    "strengthlessness", "twelfthstreets", "chrysanthemums",
  ]) {
    assert.ok(!isDistinctiveSecret(word), `${JSON.stringify(word)} is a word`);
  }
});

test("a letter run that is obviously a token is still not hunted, on purpose", () => {
  // These do read as generated, and under a credential name they are not
  // substituted out of free text anyway. That is the accepted cost of giving
  // up on letter-shape rules, and it is documented at redactPersistedEvent
  // rather than left for a reader to discover here.
  //
  // The exposure is bounded: each is still masked by key name wherever it
  // sits in a field, so what is missed is a free-text echo, and a missed
  // secret is fixed by rotating it. A deleted word is fixed by nothing.
  for (const token of [
    "XkjQmzPlVbNrTqWd", "zxjqvbnmwrtplkgf", "deadbeefcafebabe",
  ]) {
    assert.ok(!isDistinctiveSecret(token), `${JSON.stringify(token)} is letters only`);
  }
  // The moment anything other than a letter appears, it is hunted again --
  // which is what most generated credentials actually look like.
  for (const token of ["Xk9$mzPl2vQ", "deadbeef-cafe-babe", "a1b2c3d4e5f6a7b8"]) {
    assert.ok(isDistinctiveSecret(token), `${JSON.stringify(token)} is not letters only`);
  }
});

test("no word in the checked-in corpus is ever hunted", () => {
  // The corpus is the audit trail. Three shape heuristics were tried here and
  // each was defeated by an ordinary word within a round of review; the words
  // that broke them are checked in beside this test so the next person to
  // propose a shape rule can run it against them first.
  //
  // Under the current rule -- letters are never hunted -- this passes
  // trivially. That is the point: it stops being trivial the moment someone
  // reintroduces a heuristic, and then it fails loudly instead of quietly
  // deleting words from transcripts.
  const corpus = readFileSync(
    new URL("./fixtures/english-words.txt", import.meta.url), "utf8",
  )
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.ok(corpus.length >= 30, "corpus should not have been emptied");
  for (const word of corpus) {
    assert.ok(!isDistinctiveSecret(word), `${JSON.stringify(word)} is an ordinary word`);
  }
});
