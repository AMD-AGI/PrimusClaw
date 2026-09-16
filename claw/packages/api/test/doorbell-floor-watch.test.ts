// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The KV watch that is the only runtime writer of the doorbell latch.
 *
 * `latchFromOperation` is pinned in doorbell-capability.test.ts, but a pure
 * function nothing calls decides nothing: the deliveries have to reach it. The
 * loop that carries them lives inside `initNats`, and `ensureKvBucket` reaches a
 * live NATS server on every path through it, so the wiring is out of reach of
 * an in-process test. It is reachable in a child, where the `nats` package can
 * be resolved to a fake before `infra/nats.ts` is evaluated -- and the child is
 * what a subprocess boot test buys: the production sequence, not a restatement
 * of it.
 *
 * Two configurations, because the two operations mean opposite things:
 *   an asserted floor opens the gate at the version the operator wrote,
 *   and a delete revokes it rather than being read as an unparseable floor.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const NATS_SRC = pathToFileURL(join(PKG, "src", "infra", "nats.ts")).href;
const GATE_SRC = pathToFileURL(join(PKG, "src", "tasks", "doorbell-gate.ts")).href;
const TSX_LOADER = import.meta.resolve("tsx");

const CASE_TIMEOUT_MS = 120_000;
const CHILD_TIMEOUT_MS = 60_000;

const dir = mkdtempSync(join(tmpdir(), "claw-floor-watch-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A `nats` package that provisions nothing and delivers what the case asks for.
 *
 * The watcher never ends: an iterator that returns closes the latch as a dead
 * feed, which would answer every case with `unknown` and prove nothing about
 * the deliveries that came before it.
 */
const FAKE_NATS = `
export function StringCodec() {
  const enc = new TextEncoder(); const dec = new TextDecoder();
  return { encode: (s) => enc.encode(s), decode: (b) => dec.decode(b) };
}
export const StorageType = { File: "file" };
export const RetentionPolicy = { Limits: "limits" };
const stream = { config: { max_age: 3600e9, duplicate_window: 0, num_replicas: 1 } };
export async function connect() {
  const jsm = {
    streams: { info: async () => stream, add: async () => ({}), update: async () => ({}) },
    consumers: { info: async () => ({}), add: async () => ({}), update: async () => ({}) },
  };
  const bucket = {
    async watch() {
      const entries = JSON.parse(process.env.FLOOR_ENTRIES);
      const enc = new TextEncoder();
      return (async function* () {
        for (const e of entries) {
          yield { operation: e.op, value: enc.encode(e.value ?? "") };
        }
        await new Promise(() => {});
      })();
    },
  };
  const js = { views: { kv: async () => bucket } };
  return { jetstream: () => js, jetstreamManager: async () => jsm };
}
`;

const LOADER = `
export async function resolve(specifier, context, next) {
  if (specifier === "nats") {
    return { url: ${JSON.stringify(pathToFileURL(join(dir, "fake-nats.mjs")).href)}, shortCircuit: true };
  }
  return next(specifier, context);
}
`;

const REGISTER = `
import { register } from "node:module";
register(${JSON.stringify(pathToFileURL(join(dir, "loader.mjs")).href)});
`;

/** Boot the real `initNats`, let the deliveries land, and report the latch. */
const DRIVER = `
const nats = await import(${JSON.stringify(NATS_SRC)});
const gate = await import(${JSON.stringify(GATE_SRC)});
await nats.initNats();
await new Promise((resolve) => setTimeout(resolve, 250));
console.log("LATCH " + JSON.stringify(gate.doorbellLatch()));
`;

writeFileSync(join(dir, "fake-nats.mjs"), FAKE_NATS);
writeFileSync(join(dir, "loader.mjs"), LOADER);
writeFileSync(join(dir, "register.mjs"), REGISTER);
writeFileSync(join(dir, "driver.mts"), DRIVER);

async function latchAfter(entries: Array<{ op: string; value?: string }>): Promise<unknown> {
  const { stdout, stderr } = await run(
    process.execPath,
    [
      "--import", TSX_LOADER,
      "--import", pathToFileURL(join(dir, "register.mjs")).href,
      join(dir, "driver.mts"),
    ],
    {
      cwd: PKG,
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, FLOOR_ENTRIES: JSON.stringify(entries) },
    },
  );
  const line = (stdout + stderr).split("\n").find((l) => l.startsWith("LATCH "));
  assert.ok(line, `the child never reported a latch:\n${stdout}\n${stderr}`);
  return JSON.parse(line!.slice("LATCH ".length));
}

test("a floor written to the bucket is the latch this process runs on", { timeout: CASE_TIMEOUT_MS }, async () => {
  // Not the process default, and not a constant: the version the operator wrote
  // is the one the gate is decided against.
  assert.deepEqual(
    await latchAfter([{ op: "PUT", value: "7" }]),
    { state: "floor", version: 7 },
    "the delivered assertion never reached the latch, so every turn falls back to fat dispatch",
  );
});

test("a delete on the floor key revokes the assertion rather than corrupting it", { timeout: CASE_TIMEOUT_MS }, async () => {
  assert.deepEqual(
    await latchAfter([{ op: "PUT", value: "1" }, { op: "DEL" }]),
    { state: "revoked" },
    "a revocation that does not reach the latch leaves pods doorbelling after the operator withdrew the floor",
  );
});
