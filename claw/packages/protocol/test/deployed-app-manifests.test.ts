// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAppManifest } from "../src/app-manifest.js";

const APPS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../deploy/apps");

const manifests = readdirSync(APPS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => join(APPS_DIR, d.name, "manifest.json"));

test("the deployment config carries at least one app manifest", () => {
  assert.ok(manifests.length > 0);
});

for (const file of manifests) {
  test(`${file.slice(APPS_DIR.length + 1)} is a valid AppManifest v1`, () => {
    const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(validateAppManifest(manifest), []);
  });
}
