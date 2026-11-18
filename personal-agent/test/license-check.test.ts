// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { allowedExpression, check } from "../scripts/license-check.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("permissive licences and expressions that can be met with them pass", () => {
  for (const ok of ["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "BlueOak-1.0.0", "Unlicense"]) {
    assert.equal(allowedExpression(ok), true, ok);
  }
  assert.equal(allowedExpression("(MIT OR GPL-3.0-only)"), true);
  assert.equal(allowedExpression("MIT AND (Apache-2.0 OR GPL-2.0-only)"), true);
  assert.equal(allowedExpression("Apache-2.0 WITH LLVM-exception"), true);
});

test("copyleft, unknown and missing licences fail", () => {
  for (const bad of [
    "GPL-3.0-only",
    "AGPL-3.0",
    "LGPL-2.1-or-later",
    "MPL-2.0",
    "SEE LICENSE IN LICENSE",
    "UNLICENSED",
    "",
    "  ",
  ]) {
    assert.equal(allowedExpression(bad), false, bad);
  }
  assert.equal(allowedExpression("MIT AND GPL-3.0-only"), false);
  assert.equal(allowedExpression("(GPL-2.0-only OR LGPL-3.0-only)"), false);
});

test("only production packages of the lockfile are judged, and a bad one is reported", () => {
  const lock = {
    packages: {
      "": { name: "root" },
      "packages/core": { name: "@x/core", license: "GPL-3.0-only" },
      "node_modules/ok": { version: "1.0.0", license: "MIT" },
      "node_modules/legacy": { version: "2.0.0", license: { type: "BSD-3-Clause" } },
      "node_modules/a/node_modules/nested": { version: "3.0.0", license: "AGPL-3.0" },
      "node_modules/none": { version: "4.0.0" },
      "node_modules/devonly": { version: "5.0.0", license: "GPL-3.0-only", dev: true },
      "node_modules/@x/core": { link: true, resolved: "packages/core" },
    },
  };
  const findings = check(lock);
  assert.deepEqual(
    findings.map((f) => `${f.name} ${f.license} ${String(f.ok)}`),
    ["legacy BSD-3-Clause true", "nested AGPL-3.0 false", "none  false", "ok MIT true"],
  );
  assert.throws(() => check({}), /not a package-lock/);
});

test("this workspace's own production dependencies pass", () => {
  const findings = check(JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8")) as unknown);
  assert.ok(findings.length > 50);
  assert.deepEqual(
    findings.filter((f) => !f.ok),
    [],
  );
});
