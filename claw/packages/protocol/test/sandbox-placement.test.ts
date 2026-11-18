// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `parseSandboxPlacement`: what a session's `placement` may hold.
 *
 *   P1 absent, null and empty mean no placement
 *   P2 well-formed label keys and values are accepted and returned as sent
 *   P3 malformed keys, malformed values (whitespace above all: SaFE splits a value
 *      on it into an `In` list), non-strings and unknown fields are refused
 *   P4 the platform's own keys are refused
 *   P5 at most eight entries
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSandboxPlacement,
  SANDBOX_PLACEMENT_MAX_NODE_LABELS,
} from "../src/sandbox-placement.js";

test("P1 absent, null and empty mean no placement", () => {
  for (const raw of [undefined, null, {}, { nodeLabels: null }, { nodeLabels: {} }]) {
    assert.deepEqual(parseSandboxPlacement(raw), { ok: true, placement: null }, JSON.stringify(raw));
  }
});

const ACCEPTED: Array<Record<string, string>> = [
  { "autopilot.amd.com/preemptible": "false" },
  { "example.com/pool": "reserved", "example.com/tier": "a-1" },
  { "node.example.io/gpu.product": "MI300X" },
  { pool: "x" },
  { "a/b": "c" },
  { [`example.com/${"n".repeat(63)}`]: "v".repeat(63) },
  { "Under_score.and-dash": "V_1.2-3" },
  Object.fromEntries(Array.from({ length: SANDBOX_PLACEMENT_MAX_NODE_LABELS }, (_, i) => [`example.com/k${i}`, `v${i}`])),
];

for (const nodeLabels of ACCEPTED) {
  test(`P2 accepts ${JSON.stringify(nodeLabels).slice(0, 80)}`, () => {
    assert.deepEqual(parseSandboxPlacement({ nodeLabels }), { ok: true, placement: { nodeLabels } });
  });
}

const REFUSED: Array<[string, unknown, RegExp]> = [
  ["a string", "autopilot.amd.com/preemptible=false", /^placement must be an object/],
  ["an array", [{ nodeLabels: {} }], /^placement must be an object/],
  ["an unknown field", { nodeLabels: { a: "b" }, nodeSelector: {} }, /^placement\.nodeSelector is not a known field/],
  ["nodeLabels as an array", { nodeLabels: [["a", "b"]] }, /^placement\.nodeLabels must be an object/],
  ["nodeLabels as a string", { nodeLabels: "a=b" }, /^placement\.nodeLabels must be an object/],
  ["a value with a space", { nodeLabels: { "example.com/pool": "a b" } }, /is not a label value.*no whitespace/],
  ["a value with a tab", { nodeLabels: { "example.com/pool": "a\tb" } }, /is not a label value/],
  ["a value with a newline", { nodeLabels: { "example.com/pool": "a\n" } }, /is not a label value/],
  ["an empty value", { nodeLabels: { "example.com/pool": "" } }, /is not a label value/],
  ["a value of 64 characters", { nodeLabels: { "example.com/pool": "v".repeat(64) } }, /is not a label value/],
  ["a value with a leading dash", { nodeLabels: { "example.com/pool": "-a" } }, /is not a label value/],
  ["a value with a slash", { nodeLabels: { "example.com/pool": "a/b" } }, /is not a label value/],
  ["a boolean value", { nodeLabels: { "autopilot.amd.com/preemptible": false } }, /must be a string \(quote it/],
  ["a number value", { nodeLabels: { "example.com/count": 2 } }, /must be a string/],
  ["a null value", { nodeLabels: { "example.com/pool": null } }, /must be a string/],
  ["an empty key", { nodeLabels: { "": "v" } }, /is not a label key/],
  ["a key with a space", { nodeLabels: { "example.com/my pool": "v" } }, /is not a label key/],
  ["a name of 64 characters", { nodeLabels: { [`example.com/${"n".repeat(64)}`]: "v" } }, /is not a label key/],
  ["an empty name", { nodeLabels: { "example.com/": "v" } }, /is not a label key/],
  ["an empty prefix", { nodeLabels: { "/pool": "v" } }, /prefix must be a DNS subdomain/],
  ["an uppercase prefix", { nodeLabels: { "Example.com/pool": "v" } }, /prefix must be a DNS subdomain/],
  ["two slashes", { nodeLabels: { "a/b/c": "v" } }, /is not a label key/],
  ["a prefix of 254 characters", { nodeLabels: { [`${"a".repeat(254)}/pool`]: "v" } }, /prefix must be a DNS subdomain/],
  ["a key with a trailing dot", { nodeLabels: { "pool.": "v" } }, /is not a label key/],
  [
    `${SANDBOX_PLACEMENT_MAX_NODE_LABELS + 1} entries`,
    { nodeLabels: Object.fromEntries(Array.from({ length: SANDBOX_PLACEMENT_MAX_NODE_LABELS + 1 }, (_, i) => [`k${i}`, "v"])) },
    /has 9 entries; at most 8 are allowed/,
  ],
];

for (const [label, raw, message] of REFUSED) {
  test(`P3/P5 refuses ${label}`, () => {
    const r = parseSandboxPlacement(raw);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, message);
  });
}

const RESERVED = [
  "kubernetes.io/hostname",
  "specified-nodes",
  "excluded-nodes",
  "primus-safe.workspace.id",
  "primus-safe.nodeflavor.id",
  "primus-safe.owner",
  "autopilot.amd.com/w",
  "safe-exec.amd.com/w",
];

for (const key of RESERVED) {
  test(`P4 refuses the reserved key ${key}`, () => {
    const r = parseSandboxPlacement({ nodeLabels: { "example.com/pool": "ok", [key]: "node-1" } });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /is reserved by the platform and cannot be used for placement$/);
  });
}
