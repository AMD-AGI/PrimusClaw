// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_PLATFORM_ENV, isReservedAppEnv } from "@claw/protocol";

const APPS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/apps");

/** Variable names the app-run code sets: `env.NAME = ...` and `const X_ENV = "NAME"`. */
function injectedNames(): Map<string, string> {
  const found = new Map<string, string>();
  for (const f of readdirSync(APPS_DIR).filter((n) => n.endsWith(".ts"))) {
    const text = readFileSync(join(APPS_DIR, f), "utf-8");
    for (const m of text.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\s*=/g)) found.set(m[1]!, f);
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*_ENV\s*=\s*"([A-Z][A-Z0-9_]*)"/g)) found.set(m[1]!, f);
  }
  return found;
}

test("every variable the app-run code injects is reserved against manifests", () => {
  const found = injectedNames();
  // The scan must see the code it guards, or it passes by finding nothing.
  for (const n of ["CLAW_SESSION_ID", "CLAW_APP_RUN_ID", "NODE_NAME"]) {
    assert.ok(found.has(n), `scan no longer finds ${n}; update the patterns`);
  }
  for (const [name, file] of found) assert.ok(isReservedAppEnv(name), `${name} (set in ${file}) is not reserved in the manifest validator`);
});

test("the platform table covers what the sandbox and the handoff provide", () => {
  assert.ok(isReservedAppEnv(APP_PLATFORM_ENV.user_data_path));
  assert.ok(isReservedAppEnv(APP_PLATFORM_ENV.topology_handoff_file));
});
