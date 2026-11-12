// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { AskerLanguages } from "../../src/routing/turn-start.js";

test("an asker's language is the message's own, else their last one in that group, else none", () => {
  const askers = new AskerLanguages();
  assert.equal(askers.answer("g-1", "alice", "ok"), undefined);
  assert.equal(askers.answer("g-1", "alice", "帮我看看这个 PR"), "zh");
  assert.equal(askers.answer("g-1", "alice", "ok #3"), "zh");
  assert.equal(askers.answer("g-1", "bob", "ok"), undefined, "another member");
  assert.equal(askers.answer("g-2", "alice", "ok"), undefined, "another group");
  assert.equal(askers.answer("g-1", "alice", "please check the build again"), "en");
  assert.equal(askers.answer("g-1", "alice", "https://example.com/pr/3"), "en");
});

test("the oldest asker is forgotten first once 10000 are kept", () => {
  const askers = new AskerLanguages();
  askers.answer("g", "first", "帮我看看");
  askers.answer("g", "second", "帮我看看");
  for (let i = 0; i < 9_998; i++) askers.answer("g", `u${String(i)}`, "please check the build");
  askers.answer("g", "first", "please check the build"); // (asked again: the newest now)
  askers.answer("g", "one-more", "帮我看看");
  assert.equal(askers.answer("g", "first", "ok"), "en");
  assert.equal(askers.answer("g", "second", "ok"), undefined);
  assert.equal(askers.answer("g", "one-more", "ok"), "zh");
});
