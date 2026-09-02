// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every helper on `metrics` has to be called by something.
 *
 * A metric that is declared and never recorded is worse than a missing one. It
 * registers, so `/metrics` prints its `# HELP` and `# TYPE` lines and it shows
 * up in every "which metrics exist" listing; it just never gets a sample. A
 * dashboard built from that listing renders an empty panel, and an empty panel
 * for a counter reads as "this never happened" -- which for
 * `claw_brain_task_total` means "no tasks ran" and for `claw_sandbox_start_total`
 * means "no sandboxes were created". Both are indistinguishable from an outage,
 * and both were true of this package: `onTask`, `onSandboxStart` and
 * `onSandboxStop` sat unreferenced, so task throughput, task duration and
 * sandbox cold-start had no data at all while looking fully instrumented.
 *
 * Nothing catches that at build time -- an unused object property is not an
 * unused import -- and nothing catches it at runtime either, because the
 * absence of a sample is not an error. So it is asserted here, statically,
 * against the source.
 *
 * The reverse direction is checked too: a `metrics.foo(...)` call naming a
 * helper that does not exist would be a type error today, but the same scan
 * answers it for free and keeps the two lists honest with each other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const METRICS_FILE = join(SRC, "infra", "metrics.ts");

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Method names declared on the exported `metrics` object literal. */
function declaredHelpers(source: string): string[] {
  const start = source.indexOf("export const metrics");
  assert.notEqual(start, -1, "could not find `export const metrics` in metrics.ts");
  // Two-space indent is the object's own member level; a deeper indent is a
  // nested literal and a shallower one has left the object.
  const names = [...source.slice(start).matchAll(/^ {2}([a-z][A-Za-z0-9_]*)\(/gm)]
    .map((m) => m[1]);
  return [...new Set(names)];
}

test("every metrics helper has at least one call site", () => {
  const metricsSource = readFileSync(METRICS_FILE, "utf8");
  const helpers = declaredHelpers(metricsSource);
  assert.ok(helpers.length > 20, `expected the metrics facade to be large; found ${helpers.length}`);

  const callers = tsFilesUnder(SRC)
    .filter((f) => f !== METRICS_FILE)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const unwired = helpers.filter((name) => !callers.includes(`metrics.${name}(`));
  assert.deepEqual(
    unwired,
    [],
    `these metrics helpers are declared but never called, so their series never receive `
      + `a sample and every panel built on them reads as a flatline: ${unwired.join(", ")}`,
  );
});

test("every metrics.* call names a helper that exists", () => {
  const metricsSource = readFileSync(METRICS_FILE, "utf8");
  const helpers = new Set(declaredHelpers(metricsSource));

  const called = new Set<string>();
  for (const file of tsFilesUnder(SRC)) {
    if (file === METRICS_FILE) continue;
    for (const m of readFileSync(file, "utf8").matchAll(/\bmetrics\.([a-z][A-Za-z0-9_]*)\(/g)) {
      called.add(m[1]);
    }
  }

  const unknown = [...called].filter((name) => !helpers.has(name));
  assert.deepEqual(unknown, [], `called but not declared on the metrics facade: ${unknown.join(", ")}`);
});
