// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A misconfigured admission ceiling must not boot.
 *
 * Every degraded `ADMIT_*` value is `0`, and `0` is the value that means "this
 * dimension is not enforced" -- so the operator who tightened a ceiling and
 * mistyped it gets the dimension switched off, silently, and a `> 0` test never
 * sees it. That is why the assertion is fatal, and why it fires on any refusal
 * rather than on a relation of its own.
 *
 * The constants and both cross-setting loops are module-scope statements
 * evaluated once at import, so one configuration is one process; each case
 * below spawns test/admission-settings-probe.ts with its environment.
 *
 * Coverage:
 *   A1 each malformed class is refused and named
 *   A2 each malformed class is still refused with the doorbell off, its degraded
 *      0 having slipped past the coupling check
 *   A3 the bounds are on all eight parse lines, not one
 *   A4 a well-formed ceiling with the doorbell off is refused
 *   A5 soft above hard is refused on every dimension
 *   A6 the refusal is logged before it is thrown, under the startup event name
 *   A7 the configurations that must boot do boot
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PG_INT4_MAX } from "@claw/utils";

const TSX = fileURLToPath(import.meta.resolve("tsx/cli"));
const PROBE = fileURLToPath(new URL("./admission-settings-probe.ts", import.meta.url));
const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const SENTINEL = "@@ADMISSION@@";

interface Verdict {
  problems: string[];
  threw: string | null;
  logged: Array<{ obj: { problems: string[] }; msg: string }>;
}

const cache = new Map<string, Verdict>();

/** Evaluate config.js in a fresh process under exactly `overrides`. */
function boot(overrides: Record<string, string>): Verdict {
  const key = JSON.stringify(overrides);
  const hit = cache.get(key);
  if (hit) return hit;

  // Built by filtering rather than spreading: an ADMIT_* or a doorbell flag
  // exported by the runner's shell would otherwise decide a case the table did
  // not. `cwd` is pinned for the same reason -- config.ts loads dotenv.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("ADMIT_") || k === "RUN_DOORBELL_DISPATCH") continue;
    env[k] = v;
  }
  Object.assign(env, overrides);

  const out = execFileSync(process.execPath, [TSX, PROBE], {
    env, cwd: API_DIR, encoding: "utf8",
  });
  const verdict = JSON.parse(
    out.slice(out.lastIndexOf(SENTINEL) + SENTINEL.length),
  ) as Verdict;
  cache.set(key, verdict);
  return verdict;
}

const ON = { RUN_DOORBELL_DISPATCH: "true" };
const OFF = { RUN_DOORBELL_DISPATCH: "false" };

const refusal = (problems: readonly string[]) =>
  `refused admission settings: ${problems.join("; ")}`;

const coupling = (key: string, value: number) =>
  `${key}=${value} requires RUN_DOORBELL_DISPATCH=true; `
  + `with the doorbell off, chat dispatch is not admitted and the ceiling is not a fleet ceiling`;

const inversion = (softKey: string, soft: number, hardKey: string, hard: number) =>
  `${softKey}=${soft} is above ${hardKey}=${hard}, so it can never defer a run the hard ceiling admits`;

const outOfRange = (key: string, value: string) =>
  `${key}=${value} is outside the usable range 0..${PG_INT4_MAX}; using 0`;

/** Every malformed class, and the entry `envInt` pushes for it on `ADMIT_HARD_RUNS`. */
const MALFORMED: ReadonlyArray<readonly [label: string, value: string, problem: string]> = [
  ["a negative", "-1", outOfRange("ADMIT_HARD_RUNS", "-1")],
  ["a non-numeric", "abc", "ADMIT_HARD_RUNS=abc is not a number; using 0"],
  ["a blank", "", "ADMIT_HARD_RUNS= is blank; using 0"],
  ["a fractional", "2.7", "ADMIT_HARD_RUNS=2.7 is not a whole number; using 0"],
  ["an overflowing", String(PG_INT4_MAX + 1), outOfRange("ADMIT_HARD_RUNS", String(PG_INT4_MAX + 1))],
];

const DIMENSIONS = [
  ["ADMIT_SOFT_RUNS", "ADMIT_HARD_RUNS"],
  ["ADMIT_SOFT_SANDBOXES", "ADMIT_HARD_SANDBOXES"],
  ["ADMIT_SOFT_GPU_NODES", "ADMIT_HARD_GPU_NODES"],
] as const;

/** Every ceiling key, in the order config.ts evaluates and reports them. */
const CEILING_KEYS = [
  "ADMIT_SOFT_RUNS", "ADMIT_HARD_RUNS",
  "ADMIT_SOFT_SANDBOXES", "ADMIT_HARD_SANDBOXES",
  "ADMIT_SOFT_GPU_NODES", "ADMIT_HARD_GPU_NODES",
  "ADMIT_TREE_MAX_NODES", "ADMIT_TREE_MAX_DEPTH",
];

for (const [label, value, problem] of MALFORMED) {
  test(`A1 ${label} ceiling is refused and named`, () => {
    const v = boot({ ...ON, ADMIT_HARD_RUNS: value });
    assert.deepEqual(
      v.problems, [problem],
      `${label} value degrades to 0, which switches the dimension off; the boot `
      + `has to stop instead, naming the key and what was wrong with it`,
    );
    assert.equal(
      v.threw, refusal([problem]),
      `the assertion has to throw, not merely collect: a logged-and-continued `
      + `refusal is a fleet running with no ceiling the operator believes is set`,
    );
  });

  test(`A2 ${label} ceiling is still refused with the doorbell off`, () => {
    const v = boot({ ...OFF, ADMIT_HARD_RUNS: value });
    assert.deepEqual(
      v.problems, [problem],
      `the parse refusal is what stops this configuration whichever way the `
      + `doorbell is set`,
    );
    assert.ok(
      !v.problems.some((p) => p.includes("requires RUN_DOORBELL_DISPATCH=true")),
      `the degraded value is 0, so the coupling check never sees it -- the parse `
      + `refusal is the only thing standing between this configuration and a silent boot`,
    );
    assert.equal(v.threw, refusal([problem]));
  });
}

test("A3 every ADMIT_ line carries the strict bounds, not just one", () => {
  const v = boot({
    ...ON,
    ADMIT_SOFT_RUNS: "-1",
    ADMIT_HARD_RUNS: "abc",
    ADMIT_SOFT_SANDBOXES: "",
    ADMIT_HARD_SANDBOXES: "2.7",
    ADMIT_SOFT_GPU_NODES: String(PG_INT4_MAX + 1),
    ADMIT_HARD_GPU_NODES: "-2",
    ADMIT_TREE_MAX_NODES: "1e30",
    ADMIT_TREE_MAX_DEPTH: "3.5",
  });
  const expected = [
    outOfRange("ADMIT_SOFT_RUNS", "-1"),
    "ADMIT_HARD_RUNS=abc is not a number; using 0",
    "ADMIT_SOFT_SANDBOXES= is blank; using 0",
    "ADMIT_HARD_SANDBOXES=2.7 is not a whole number; using 0",
    outOfRange("ADMIT_SOFT_GPU_NODES", String(PG_INT4_MAX + 1)),
    outOfRange("ADMIT_HARD_GPU_NODES", "-2"),
    outOfRange("ADMIT_TREE_MAX_NODES", "1e30"),
    "ADMIT_TREE_MAX_DEPTH=3.5 is not a whole number; using 0",
  ];
  assert.deepEqual(
    v.problems, expected,
    `dropping the strict bounds from any single ADMIT_ line is a change the rest `
    + `of the suite stays green through, every other test leaving these keys unset`,
  );
  assert.equal(
    v.threw, refusal(expected),
    `the operator gets one exit, so every refused key has to be in the message, `
    + `not just the first`,
  );
});

test("A4 a well-formed ceiling with the doorbell off is refused as unenforceable", () => {
  const v = boot({ ...OFF, ADMIT_HARD_RUNS: "5" });
  assert.deepEqual(
    v.problems, [coupling("ADMIT_HARD_RUNS", 5)],
    `with the doorbell off, chat dispatch is unmetered, so the ceiling meters `
    + `batch work only and is not a fleet ceiling`,
  );
  assert.equal(v.threw, refusal([coupling("ADMIT_HARD_RUNS", 5)]));
});

test("A4b the coupling check covers every ceiling, and equal ceilings are not an inversion", () => {
  const v = boot({ ...OFF, ...Object.fromEntries(CEILING_KEYS.map((k) => [k, "5"])) });
  assert.deepEqual(
    v.problems, CEILING_KEYS.map((k) => coupling(k, 5)),
    `a ceiling left out of the coupling loop is one an operator can set with the `
    + `doorbell off and believe is metering the fleet`,
  );
});

for (const [softKey, hardKey] of DIMENSIONS) {
  test(`A5 ${softKey} above ${hardKey} is refused`, () => {
    const v = boot({ ...ON, [softKey]: "9", [hardKey]: "5" });
    assert.deepEqual(
      v.problems, [inversion(softKey, 9, hardKey, 5)],
      `the hard refusal is evaluated first, so a soft ceiling above it can never `
      + `defer anything -- the operator's queueing threshold is dead and nothing says so`,
    );
    assert.equal(v.threw, refusal([inversion(softKey, 9, hardKey, 5)]));
  });
}

test("A6 the refusal is logged under the startup event name before it is thrown", () => {
  const v = boot({ ...OFF, ADMIT_HARD_RUNS: "5" });
  assert.equal(v.logged.length, 1);
  assert.equal(
    v.logged[0].msg, "startup.admission_settings_refused",
    `a process that dies before it logs leaves the operator with an exit code and no key name`,
  );
  assert.deepEqual(
    v.logged[0].obj, { problems: [coupling("ADMIT_HARD_RUNS", 5)] },
    `the payload is what a log search finds, so every problem has to be in it under `
    + `the key the dashboards read`,
  );
});

const BOOTS: ReadonlyArray<readonly [name: string, overrides: Record<string, string>, why: string]> = [
  ["all-zero with the doorbell off", { ...OFF },
    "the default configuration is no ceiling at all; refusing it would refuse every deployment"],
  ["a soft-only configuration", { ...ON, ADMIT_SOFT_RUNS: "5" },
    "soft > 0 && hard > 0 gates the inversion check, so a soft ceiling with no hard "
    + "ceiling is a queueing threshold, not an inversion"],
  ["a hard-only configuration", { ...ON, ADMIT_HARD_RUNS: "5" },
    "a hard ceiling with no queueing window is the simplest working configuration there is"],
  ["soft == hard on every dimension",
    { ...ON, ...Object.fromEntries(DIMENSIONS.flat().map((k) => [k, "5"])) },
    "the boundary the predicate is written on: soft > hard, not soft >= hard, so equal "
    + "ceilings are a hard refusal with no queueing window and must boot"],
];

for (const [name, overrides, why] of BOOTS) {
  test(`A7 ${name} boots`, () => {
    const v = boot(overrides);
    assert.deepEqual(v.problems, [], why);
    assert.equal(v.threw, null, why);
    assert.equal(v.logged.length, 0, "a boot nobody refused has nothing to report");
  });
}
