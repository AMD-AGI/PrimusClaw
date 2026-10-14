// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every name this service reads from its environment is one it owns.
 *
 * Owning a name decides two things: the env file a request builds cannot apply
 * it, and a spawned command does not inherit it. Hands reads its settings in
 * several modules, at import time, so a name added to any of them and not to
 * the owned set would be settable by a request and visible to every command,
 * with nothing failing. The names are taken from the source, not from a list
 * kept beside it, so a new read is checked by the edit that adds it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { serviceOwned } from "../src/runtime/env-file.js";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith(".ts") ? [path] : [];
  });
}

/** Names read as `process.env.X`, `process.env["X"]`, or through config.ts's `env("X")`. */
function namesRead(): Map<string, string> {
  const read = new Map<string, string>();
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
    /\benv\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]/g,
  ];
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const re of patterns) {
      for (const m of text.matchAll(re)) read.set(m[1], file.slice(SRC.length + 1));
    }
  }
  return read;
}

test("every environment name the source reads is owned by this service", () => {
  const read = namesRead();
  // Not vacuous: the reads this set has to cover, in the modules they live in.
  for (const known of [
    "AUTH_CLAW_TOKEN", "AUTH_INTERNAL_TOKEN", "MCP_PORT", "WORKSPACE_PATH",
    "BASH_OUTPUT_BYTES", "BASH_MAX_TIMEOUT_SEC", "WAIT_MAX_SEC",
    "HANDS_STATE_DIR", "HANDS_CHILD_ISOLATION", "BG_SHELL_ENABLED",
  ]) {
    assert.ok(read.has(known), `the scan no longer finds ${known}; it is reading the wrong tree`);
  }
  const unowned = [...read].filter(([name]) => !serviceOwned(name)).map(([n, f]) => `${n} (${f})`);
  assert.deepEqual(unowned, [], "read by Hands but settable by a request and inherited by commands");
});

test("no module reads the environment under a computed name the scan cannot see", () => {
  // config.ts's helper takes the name as a parameter, and the env file writes
  // the names it was given; each is covered above or is the write itself.
  const allowed = new Set(["config.ts", join("runtime", "env-file.ts")]);
  const dynamic: string[] = [];
  for (const file of sources(SRC)) {
    const rel = file.slice(SRC.length + 1);
    if (allowed.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    if (/process\.env\[\s*[^"'`\s]/.test(text)) dynamic.push(rel);
  }
  assert.deepEqual(dynamic, []);
});
