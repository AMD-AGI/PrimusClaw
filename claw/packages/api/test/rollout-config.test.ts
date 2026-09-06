// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// rollout-config.test.ts
//
// The rollback ordering rule and the nine startup gauges. This process runs the
// fully-enabled configuration -- rollout-config-env.ts sets it before config.js
// is evaluated -- so the env-reading half is exercised against real constants;
// every other configuration is put through the pure validator, which takes its
// config as an argument and needs no second process.

import "./rollout-config-env.js";

import { test } from "node:test";
import assert from "node:assert/strict";
import { envSettingProblems } from "../src/config.js";
import { ADMISSION_DIMENSIONS, registry, type AdmissionDimension } from "../src/infra/metrics.js";
import {
  applyRolloutConfigGauges, assertRolloutConfigAtStartup, readRolloutConfig,
  validateRolloutConfig, type RolloutConfig,
} from "../src/startup/rollout-config.js";

function ceilings(set: Partial<Record<AdmissionDimension, number>> = {}) {
  const all = {} as Record<AdmissionDimension, number>;
  for (const dimension of ADMISSION_DIMENSIONS) all[dimension] = set[dimension] ?? 0;
  return all;
}

const R1_CEILINGS_CLEARED: RolloutConfig = { doorbellDispatch: true, ceilings: ceilings() };
const R4_DOORBELL_OFF: RolloutConfig = { doorbellDispatch: false, ceilings: ceilings() };
const REVERSE_ORDER: RolloutConfig = {
  doorbellDispatch: false,
  ceilings: ceilings({ soft_runs: 5, hard_sandboxes: 7 }),
};

async function gauge(name: string, labels: Record<string, string> = {}): Promise<number | null> {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of (await registry.metrics()).split("\n")) {
    if (!line.startsWith(`${name}{`)) continue;
    const head = line.slice(0, line.lastIndexOf(" "));
    if (!wanted.every((pair) => head.includes(pair))) continue;
    return Number(line.slice(line.lastIndexOf(" ") + 1));
  }
  return null;
}

test("the process reads its ceilings and its doorbell flag from the environment", () => {
  const cfg = readRolloutConfig();
  assert.equal(cfg.doorbellDispatch, true);
  assert.equal(cfg.ceilings.soft_runs, 5);
  assert.equal(cfg.ceilings.hard_sandboxes, 7);
  assert.equal(cfg.ceilings.hard_runs, 0);
});

test("a fully-enabled configuration is accepted and exports all nine series", async () => {
  assert.doesNotThrow(() => assertRolloutConfigAtStartup());

  assert.equal(await gauge("claw_api_doorbell_dispatch_enabled"), 1);
  for (const dimension of ADMISSION_DIMENSIONS) {
    const expected = dimension === "soft_runs" || dimension === "hard_sandboxes" ? 1 : 0;
    assert.equal(
      await gauge("claw_api_admission_enforced", { dimension }), expected,
      `${dimension} should report ${expected}`,
    );
  }
});

test("the gauges are published even for a configuration the assertion refuses", async () => {
  // Nothing scrapes a pod that refuses to start, but the ordering is what makes
  // a started pod's exposition complete: a verdict enforced first would leave
  // the eight enforced series missing on every accepted boot too.
  assert.throws(() => assertRolloutConfigAtStartup(REVERSE_ORDER));
  assert.equal(await gauge("claw_api_doorbell_dispatch_enabled"), 0);
  assert.equal(await gauge("claw_api_admission_enforced", { dimension: "soft_runs" }), 1);
  assert.equal(await gauge("claw_api_admission_enforced", { dimension: "hard_runs" }), 0);

  applyRolloutConfigGauges(readRolloutConfig());
});

test("the refusal names the env keys the operator has to clear", () => {
  assert.throws(
    () => assertRolloutConfigAtStartup(REVERSE_ORDER),
    (err: unknown) => {
      const message = (err as Error).message;
      assert.match(message, /ADMIT_SOFT_RUNS/);
      assert.match(message, /ADMIT_HARD_SANDBOXES/);
      assert.ok(!message.includes("ADMIT_HARD_RUNS"), "a zero ceiling is not an offender");
      return true;
    },
  );
});

test("doorbell off with any ceiling still set is the one illegal state", () => {
  for (const dimension of ADMISSION_DIMENSIONS) {
    const verdict = validateRolloutConfig({
      doorbellDispatch: false,
      ceilings: ceilings({ [dimension]: 1 }),
    });
    assert.deepEqual(verdict, { ok: false, reason: "reverse_order", offending: [dimension] });
  }
});

test("the sequential rollback is accepted in order and refused in reverse", () => {
  for (const state of [R1_CEILINGS_CLEARED, R4_DOORBELL_OFF]) {
    assert.deepEqual(validateRolloutConfig(state), { ok: true });
  }
  assert.equal(validateRolloutConfig(REVERSE_ORDER).ok, false);
});

test("the atomic rollback and the shipped defaults are the same accepted state", () => {
  assert.deepEqual(validateRolloutConfig(R4_DOORBELL_OFF), { ok: true });
  assert.deepEqual(
    validateRolloutConfig({ doorbellDispatch: false, ceilings: ceilings() }),
    validateRolloutConfig(R4_DOORBELL_OFF),
  );
});

test("a metered fleet with the doorbell on is accepted at every dimension", () => {
  for (const dimension of ADMISSION_DIMENSIONS) {
    assert.deepEqual(
      validateRolloutConfig({ doorbellDispatch: true, ceilings: ceilings({ [dimension]: 1 }) }),
      { ok: true },
    );
  }
});

test("no legal ADMIT_* value is refused by config parsing", () => {
  // A tightened {min} in config.ts would silently replace a value the rollback
  // procedure tells operators to set, and the pod would meter a dimension the
  // operator believes is cleared.
  const complaints = envSettingProblems().filter((p) => p.startsWith("ADMIT_"));
  assert.deepEqual(complaints, []);
});
