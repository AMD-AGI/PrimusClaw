// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// platform-facts-egress.test.ts
//
// `withPlatformFacts` is what puts the platform's account of a dead run onto
// the ExecuteResult the callback carries. It wraps the value at three exits,
// and every one of them sits inside a redactEgressPayload(...) call whose inner
// argument a merge can silently unwrap: main renamed the redactor while this
// branch added the wrapper, so the conflict is exactly `redactor(wrapper(x))`
// against `redactor(x)`, and resolving it either way compiles.
//
// That is not hypothetical -- it happened once during integration and nothing
// went red. These pin the join: the facts must reach the payload, and they must
// reach it at every exit, not just the one someone happened to look at.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/tasks/runner.ts", import.meta.url), "utf8");

test("every egress of an ExecuteResult carries the platform facts", () => {
  // Counted rather than spot-checked. A wrapper dropped at one exit is the
  // shape this defends against, and "some call sites have it" is the state a
  // half-resolved conflict leaves behind.
  const egress = [...SRC.matchAll(/redactEgressPayload<ExecuteResult>\(\s*\n\s*([^\n]*)/g)]
    .map((m) => m[1].trim());
  assert.ok(egress.length >= 3, `expected the three result exits, found ${egress.length}`);
  for (const [i, arg] of egress.entries()) {
    assert.match(arg, /^this\.withPlatformFacts\(/,
      `ExecuteResult egress #${i + 1} sends the raw value: ${arg}`);
  }
});

test("the wrapper adds the facts only when there are facts to add", () => {
  // A run that ended normally has none, and stamping an empty object would make
  // "the platform said nothing" indistinguishable from "the platform was never
  // asked" -- the conflation the whole platform-facts path exists to remove.
  const fn = SRC.slice(SRC.indexOf("private withPlatformFacts"));
  assert.match(fn.slice(0, 240), /if \(!this\.platformFacts\) return result;/,
    "absent facts must leave the result untouched");
  assert.match(fn.slice(0, 240), /\{ \.\.\.result, platformFacts: this\.platformFacts \}/,
    "and present facts must be added without mutating the caller's object");
});

test("nothing still calls the redactor by its pre-rename name", () => {
  // The rename is what made the conflict, and a straggler would compile only
  // because the old export still exists somewhere.
  assert.ok(!/redactCheckpointState/.test(SRC),
    "runner.ts must use redactEgressPayload throughout");
});
