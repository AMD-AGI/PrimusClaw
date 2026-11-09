// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  credentialRefused,
  describeRefusal,
  needsWiderScope,
  usable,
  type GithubState,
} from "../../src/ports/github.js";
import {
  keyOf,
  keyParts,
  pullKey,
  pullRef,
  pullTarget,
  pullUrl,
  pullsIn,
  samePull,
  shortName,
  slug,
} from "../../src/review/pull-ref.js";
import {
  bareName,
  casefold,
  codePoints,
  flat,
  isAlnum,
  isUpper,
  isWordChar,
  stripChars,
  unique,
} from "../../src/review/text/unicode.js";

test("a pull request's names and keys", () => {
  const pull = pullRef("AMD-AGI", "Hyperloom", 12);
  assert.equal(slug(pull), "AMD-AGI/Hyperloom");
  assert.equal(shortName(pull), "AMD-AGI/Hyperloom#12");
  assert.equal(pullUrl(pull), "https://github.com/AMD-AGI/Hyperloom/pull/12");
  assert.deepEqual(pullTarget(pull), ["AMD-AGI", "Hyperloom", 12]);
  assert.equal(pullKey(pull), keyOf("amd-agi", "hyperloom", 12));
  assert.deepEqual(keyParts(pullKey(pull)), ["amd-agi", "hyperloom", 12]);
  assert.ok(samePull(pull, pullRef("amd-agi", "HYPERLOOM", 12)));
});

test("pull requests are found in the order the text names them, each once", () => {
  const text = "AMD-AGI/b#2 then https://github.com/AMD-AGI/a.git/pull/1, amd-agi/B#2 and x/y#3a and z/w#12345678";
  assert.deepEqual(pullsIn(text).map(shortName), ["AMD-AGI/b#2", "AMD-AGI/a#1", "x/y#3"]); // (a letter may follow the number; eight digits may not)
  assert.deepEqual(pullsIn("合入AMD-AGI/x#1，AMD-AGI/x#2").map(shortName), ["AMD-AGI/x#1", "AMD-AGI/x#2"]);
});

test("a binding reads private repositories only with repo", () => {
  const state: GithubState = {
    userId: "u",
    bound: true,
    login: "x",
    scopes: ["public_repo"],
    expiresAt: "",
    expired: false,
    delegation: false,
    lastUsedAt: "",
  };
  assert.equal(usable(state), true);
  assert.equal(usable({ ...state, expired: true }), false);
  assert.equal(needsWiderScope(state.scopes), true);
  assert.equal(needsWiderScope(["repo"]), false);
  assert.equal(describeRefusal(credentialRefused(503)), "identity service answered 503");
  assert.equal(describeRefusal(credentialRefused(400, "invalid_scope")), "identity service answered 400 invalid_scope");
});

test("text helpers keep Python's string semantics", () => {
  assert.deepEqual(codePoints("a😀"), ["a", "😀"]);
  assert.equal(casefold("ÀB"), "àb");
  assert.equal(isAlnum("瑞"), true);
  assert.equal(isAlnum("_"), false);
  assert.equal(isWordChar("_"), true);
  assert.equal(flat("Lin, Mei (Lab)"), "linmeilab");
  assert.deepEqual(unique([2, 1, 2]), [2, 1]);
  assert.equal(isUpper("CI"), true);
  assert.equal(isUpper("Ci"), false);
  assert.equal(isUpper("12"), false);
  assert.equal(stripChars("@@x@", "@"), "x");
  assert.equal(bareName(" ，@Bob: "), "Bob");
});
