// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Characterization tests for guardPath.
 *
 * Despite the name, guardPath performs NO access restriction — it only resolves
 * to an absolute path. The sandbox container is the security boundary, and
 * tools legitimately need to reach mounted volumes outside the workspace.
 * These tests pin that documented behavior down so a future reader does not
 * mistake the name for containment, and so any deliberate change to make it
 * actually restrict paths has to update them explicitly.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { guardPath } from "../src/runtime/path-guard.js";
import { WORKSPACE } from "../src/config.js";

test("guardPath: resolves a relative path against WORKSPACE", () => {
  assert.equal(guardPath("a/b.txt"), path.join(WORKSPACE, "a/b.txt"));
});

test("guardPath: returns an absolute path unchanged", () => {
  assert.equal(guardPath("/etc/hostname"), "/etc/hostname");
});

test("guardPath: normalizes . and .. segments", () => {
  assert.equal(guardPath("/tmp/x/../y/./z"), "/tmp/y/z");
});

test("guardPath: does NOT confine paths to WORKSPACE", () => {
  // Documents the deliberate design: escaping the workspace is allowed because
  // containment is enforced by the container, not by this function.
  const escaped = guardPath("../../etc/passwd");
  assert.equal(escaped, path.resolve(WORKSPACE, "../../etc/passwd"));
  assert.ok(!escaped.startsWith(path.join(WORKSPACE, "/")));
});

test("guardPath: never throws for syntactically odd input", () => {
  // Callers wrap guardPath in try/catch; nothing in the current implementation
  // rejects input, so those branches are unreachable by design.
  for (const input of ["", ".", "..", "//x", "a\\b", " leading-space"]) {
    assert.equal(typeof guardPath(input), "string");
  }
});

test("guardPath: empty input resolves to WORKSPACE itself", () => {
  assert.equal(guardPath(""), WORKSPACE);
});
