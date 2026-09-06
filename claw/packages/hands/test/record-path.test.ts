// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The triple-to-path encoding, which is what keeps one shell's record out of
 * another's location.
 *
 * The properties asserted here are consequences of the encoding's shape rather
 * than of checks laid over it, so each test states the shape it depends on: `.`
 * never survives encoding, so no segment can be `.` or `..`; `/` and NUL never
 * survive it, so no part can reach another part's level; the marker byte is
 * escaped, so decoding is unambiguous and the transform is injective.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  ABSENT_RUN, MAX_SCOPE_PART_BYTES, NO_RUN_SEGMENT, assertScopePart, assertShellId,
  componentsMatch, decodePart, encodePart, recordComponents,
} from "../src/runtime/record-path.js";

const NUL = String.fromCharCode(0);

test("the separator, the climb and the terminator all stop being themselves", () => {
  assert.equal(encodePart("a/b"), "a~2Fb");
  assert.equal(encodePart(".."), "~2E~2E");
  assert.equal(encodePart(`a${NUL}b`), "a~00b");
  assert.equal(encodePart("~"), "~7E", "the marker is escaped, or decoding is ambiguous");
});

test("encoding is injective, so two triples cannot produce one path", () => {
  // Round-tripping every input is the property, tested over the cases that
  // would collide under a lossy or sanitising transform.
  for (const part of ["a/b", "a", "..", "~2F", "~", "", "unicode-ü", "a.b-c_d"]) {
    assert.equal(decodePart(encodePart(part)), part, part);
  }
  assert.notEqual(encodePart("a/b"), encodePart("a~2Fb"));
});

test("no output of the encoding contains a dot, at any position", () => {
  // Which is what puts the reserved no-run segment outside its image for every
  // input that could exist, in both directions.
  for (const part of ["...", "a.b", ".norun", " .", "~2E"]) {
    assert.ok(!encodePart(part).includes("."), part);
  }
  assert.ok(NO_RUN_SEGMENT.startsWith("."));
});

test("a start with no run identity is filed, not left invisible", () => {
  const [, run] = recordComponents("sess", ABSENT_RUN, "bg-1");
  assert.equal(run, NO_RUN_SEGMENT);

  // A header carrying the literal text is an ordinary record of its own owner
  // scope, so no caller can address the reserved location.
  const [, spelled] = recordComponents("sess", ".norun", "bg-1");
  assert.equal(spelled, "~2Enorun");
  assert.notEqual(spelled, NO_RUN_SEGMENT);
});

test("an over-long part is carried whole down levels, never digested", () => {
  // A hash is not injective, so a digest fallback could reproduce one path for
  // two triples and the reader's re-encode check would have nothing to catch.
  const long = "ࠀ".repeat(MAX_SCOPE_PART_BYTES / 3);
  const parts = recordComponents(long, ABSENT_RUN, "bg-1");
  const owner = parts.slice(0, parts.indexOf(NO_RUN_SEGMENT));

  assert.ok(owner.length > 1, "600 encoded bytes do not fit one component");
  assert.ok(owner.every((c) => c.length <= 202));
  assert.ok(owner.at(-1)!.startsWith(".e"), "the terminal component fixes where the part ends");
  assert.equal(
    decodePart(owner.map((c) => c.replace(/^\.[ce]/, "")).join("")), long,
    "concatenating the bodies in path order reproduces the encoding exactly",
  );
});

test("a scope part the path cannot be built from is refused by name", () => {
  assert.throws(() => assertScopePart("owner scope", ""), /owner scope must not be empty/);
  assert.throws(
    () => assertScopePart("run identity", "ࠀ".repeat(MAX_SCOPE_PART_BYTES)),
    /run identity is \d+ UTF-8 bytes/,
    "the arrival check counts UTF-16 units, which admits three times the bytes "
      + "the path is actually built from",
  );
});

test("a caller-supplied shell id is refused rather than repaired", () => {
  // Sanitising two distinct ids into one merges two shells' records, so the
  // boundary names the field and the accepted set and changes nothing.
  for (const bad of ["", ".", "..", "a/b", "-lead", "a b", "x".repeat(65), `a${NUL}b`]) {
    assert.throws(() => assertShellId(bad), /shell_id must match/, JSON.stringify(bad));
  }
  for (const good of ["bg-1", "server", "a.b_c-9", "X".repeat(64)]) {
    assert.doesNotThrow(() => assertShellId(good), good);
  }
});

test("a record claiming a location its own fields do not reproduce is rejected", () => {
  const real = recordComponents("sess", "run-1", "bg-1");
  assert.ok(componentsMatch(real, "sess", "run-1", "bg-1"));
  assert.ok(!componentsMatch(real, "sess", "run-2", "bg-1"),
    "a record moved into another run's location fails the reader's re-encode check");
  assert.ok(!componentsMatch(recordComponents("sess", ABSENT_RUN, "bg-1"), "sess", ".norun", "bg-1"),
    "and one naming the reserved segment as a string cannot claim it either");
});
