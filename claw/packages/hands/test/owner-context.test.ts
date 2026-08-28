// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The owner travels on a header and ends up as part of a registry key, so what
 * is accepted as one decides whether an owner can name another owner's shell.
 * The run travels the same way and decides whose shells end with a run.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  NO_RUN, OWNER_HEADER, RUN_HEADER, UNOWNED,
  currentOwner, currentRun, normalizeOwner, normalizeRun, withCaller,
} from "../src/runtime/owner-context.js";

test("a normal owner survives untouched", () => {
  assert.equal(normalizeOwner("  9f1c-4d2e  "), "9f1c-4d2e");
});

test("a NUL cannot be smuggled in", () => {
  // The registry key is `owner \0 id`, so an owner allowed to contain the
  // separator could address an entry filed under a different owner.
  assert.equal(normalizeOwner("victim\u0000server"), UNOWNED);
  assert.equal(normalizeOwner("a\nb"), UNOWNED, "the same applies to any control character");
});

test("an absent, empty, or non-string header is not an owner", () => {
  assert.equal(normalizeOwner(undefined), UNOWNED);
  assert.equal(normalizeOwner(""), UNOWNED);
  assert.equal(normalizeOwner("   "), UNOWNED);
  assert.equal(normalizeOwner(["a", "b"]), UNOWNED, "a repeated header arrives as an array");
  assert.equal(normalizeOwner(42), UNOWNED);
});

test("an owner longer than any real id is rejected", () => {
  assert.equal(normalizeOwner("x".repeat(201)), UNOWNED);
  assert.equal(normalizeOwner("x".repeat(200)), "x".repeat(200));
});

test("a missing run is no run rather than a shared bucket", () => {
  // The difference matters: an unowned shell is still addressable and still
  // killed at shutdown, while a shell with no run is simply never reaped by run
  // -- which is what an older Brain that sends no run header should get.
  assert.equal(normalizeRun(undefined), NO_RUN);
  assert.equal(normalizeRun(""), NO_RUN);
  assert.equal(normalizeRun("ktsk_1"), "ktsk_1");
  assert.equal(normalizeRun("a\u0000b"), NO_RUN, "the same validation as the owner");
});

test("outside a request there is an owner, not a crash", () => {
  // Probes and self-checks call tools with no request around them.
  assert.equal(currentOwner(), UNOWNED);
  assert.equal(currentRun(), NO_RUN);
});

test("the owner is visible to whatever the request runs, including async work", async () => {
  const seen = await withCaller({ owner: "run-1", run: "ktsk_1" }, async () => {
    await new Promise((r) => setTimeout(r, 1));
    return [currentOwner(), currentRun()];
  });
  assert.deepEqual(seen, ["run-1", "ktsk_1"], "tools await, so a context that did not survive an await would be useless");
  assert.equal(currentOwner(), UNOWNED, "and it does not leak past the request");
  assert.equal(currentRun(), NO_RUN);
});

test("concurrent requests do not see each other's owner", async () => {
  const [a, b] = await Promise.all([
    withCaller({ owner: "run-a", run: "r-a" }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return [currentOwner(), currentRun()];
    }),
    withCaller({ owner: "run-b", run: "r-b" }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return [currentOwner(), currentRun()];
    }),
  ]);
  assert.deepEqual([a, b], [["run-a", "r-a"], ["run-b", "r-b"]]);
});

test("the header names are the ones Brain sends", () => {
  assert.equal(OWNER_HEADER, "x-claw-owner");
  assert.equal(RUN_HEADER, "x-claw-run");
  for (const name of [OWNER_HEADER, RUN_HEADER]) {
    assert.equal(name, name.toLowerCase(), "node lowercases incoming header names");
  }
});
