// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `.env.example` has to name every key the API refuses to boot without.
 *
 * The file is the documented quick start: the README says copy it to `.env`,
 * and `start-all.sh` sources it. A key the code demands and this file never
 * mentions is therefore invisible -- the reader does everything the docs say
 * and the process still exits before it opens the database, with a message
 * about a variable no document they were given has ever named. That is how
 * `USER_ENV_ENCRYPTION_KEY` shipped: `initUserEnvCrypto()` is the first thing
 * `main()` calls (api/src/index.ts), the Helm chart marks it required, and all
 * 108 keys in `.env.example` omitted it, so only the local path broke.
 *
 * The requirement below is not asserted from a list, it is executed: each entry
 * deletes the variable and checks the *production* function still throws. So if
 * someone makes a key optional, this test fails and asks to be updated rather
 * than quietly guarding a rule that no longer exists; and if someone deletes
 * the `.env.example` line, it fails for the reason the operator would.
 *
 * The set is deliberately finite -- the keys the API validates at boot, before
 * any I/O -- rather than "every env var anything reads", which has no zero.
 *
 * The same file has to be *runnable*, not merely complete, which is the second
 * half below. Two ways it stopped being so, both shipped: a key whose blank is
 * refused rather than defaulted, which turns `cp .env.example .env` into a
 * process that exits before Fastify listens; and a rollout switch an operator
 * must flip by hand that only the chart path ever named, so the local stack had
 * no copy of the instruction at all.
 *
 * Coverage:
 *   R1 the requirement is real: production code throws when the key is absent
 *   R2 .env.example declares every such key
 *   R3 blank is not enough on its own, so the file must say how to make a value
 *   R4 the recipe .env.example documents produces a value the code accepts
 *   R5 the documented quick start boots: sourcing the file the way start-all.sh
 *      does leaves the admission assertion with nothing to refuse
 *   R6 every rollout switch the deploy path documents is declared here too
 *   R7 and its comment names the value a rollout has to set it to
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(TEST_DIR, "..");
const REPO = join(TEST_DIR, "..", "..", "..");
const ENV_EXAMPLE = join(REPO, ".env.example");
const TEXT = readFileSync(ENV_EXAMPLE, "utf8");

/** The config probe admission-settings.test.ts spawns, and its stdout marker. */
const TSX = fileURLToPath(import.meta.resolve("tsx/cli"));
const PROBE = join(TEST_DIR, "admission-settings-probe.ts");
const SENTINEL = "@@ADMISSION@@";

/** Keys the file declares, blank or not — `KEY=` at the start of a line. */
const DECLARED = new Set(
  TEXT.split("\n")
    .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1])
    .filter((k): k is string => k !== undefined),
);

/** The comment block sitting directly above a key, which is its documentation. */
function commentAbove(key: string): string {
  const lines = TEXT.split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${key}=`));
  assert.notEqual(at, -1, `${key} is not declared in .env.example`);
  const block: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i].startsWith("#"); i--) block.unshift(lines[i]);
  return block.join("\n");
}

/**
 * Every key the API validates before it touches the database or NATS.
 *
 * `requiredBy` calls the real boot-time validator with the variable removed, so
 * the premise of R2 is proved by production code rather than restated here.
 * `recipe` is the shell command `.env.example` tells the reader to run, and it
 * is run for real in R4 -- a documented command that does not produce an
 * accepted value is the same blocker one step further along.
 */
const BOOT_REQUIRED = [
  {
    key: "USER_ENV_ENCRYPTION_KEY",
    // api/src/index.ts main(): initUserEnvCrypto() before initDb()/initNats().
    requiredBy: async () => (await import("../src/crypto/user-env.js")).initUserEnvCrypto(),
    recipe: ["openssl", ["rand", "-base64", "32"]] as const,
    recipeText: "openssl rand -base64 32",
  },
];

/** Run `fn` with `key` removed from the environment, then put it back. */
async function without(key: string, fn: () => Promise<void>): Promise<void> {
  const before = process.env[key];
  delete process.env[key];
  try {
    await fn();
  } finally {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  }
}

for (const { key, requiredBy, recipe, recipeText } of BOOT_REQUIRED) {
  test(`R1 ${key} really is required: the boot check throws without it`, async () => {
    await without(key, async () => {
      await assert.rejects(
        async () => await requiredBy(),
        (err: Error) => err.message.includes(key),
        `${key} is listed as boot-required but the code no longer refuses to `
        + `start without it — drop it from BOOT_REQUIRED, or restore the check`,
      );
    });
  });

  test(`R2 .env.example declares ${key}`, () => {
    assert.ok(
      DECLARED.has(key),
      `${key} is validated before the API opens the database, and .env.example `
      + `is the file the README tells operators to copy. Omitting it means the `
      + `documented quick start exits at startup naming a variable no document `
      + `they were handed mentions. Add it (${ENV_EXAMPLE}).`,
    );
  });

  test(`R3 .env.example says how to produce a valid ${key}`, () => {
    // The entry is shipped blank, like every other credential in the file, so
    // the line alone does not get anyone booted. What does is the recipe.
    assert.match(
      commentAbove(key),
      new RegExp(recipeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `a blank required credential is only actionable with the command that `
      + `makes one; ${key}'s comment must carry "${recipeText}"`,
    );
  });

  test(`R4 the documented recipe for ${key} produces a value the code accepts`, async () => {
    const [cmd, args] = recipe;
    const generated = execFileSync(cmd, [...args], { encoding: "utf8" }).trim();
    const before = process.env[key];
    process.env[key] = generated;
    try {
      await assert.doesNotReject(
        async () => await requiredBy(),
        `\`${recipeText}\` is what .env.example tells the reader to run, so its `
        + `output has to satisfy the boot check it is meant to satisfy`,
      );
    } finally {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
  });
}

// ---------------------------------------------------------------------------
// R5-R7: the file has to run, not just be complete.
// ---------------------------------------------------------------------------

/**
 * Evaluate `src/config.ts` under `set -a; source .env.example`, as the reader
 * would have it after `cp .env.example .env && scripts/start-all.sh`.
 *
 * Real `bash`, not a dotenv parser written here: the whole claim is about what
 * `source` does to a line left empty -- it EXPORTS it as `""`, where an omitted
 * line would have arrived as absent -- so parsing the file in JS would test the
 * parser and not the shell that actually runs. The subprocess is the probe
 * admission-settings.test.ts uses, because the eight `ADMIT_*` constants and
 * both cross-setting loops are module-scope statements: one configuration is
 * one process.
 */
function bootFromEnvExample(): { problems: string[]; threw: string | null } {
  // Filtered rather than spread: an ADMIT_* or a doorbell flag exported by the
  // runner's own shell would otherwise answer the question the file is on trial
  // for. `cwd` is pinned for the neighbouring reason -- config.ts loads dotenv,
  // and a stray .env beside some other package would join in.
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("ADMIT_") || k === "RUN_DOORBELL_DISPATCH") continue;
    env[k] = v;
  }
  const out = execFileSync(
    "bash",
    [
      "-c", 'set -a; . "$1"; set +a; exec "$2" "$3" "$4"', "env-example-coverage",
      ENV_EXAMPLE, process.execPath, TSX, PROBE,
    ],
    { env, cwd: API_DIR, encoding: "utf8" },
  );
  return JSON.parse(out.slice(out.lastIndexOf(SENTINEL) + SENTINEL.length)) as {
    problems: string[];
    threw: string | null;
  };
}

test("R5 the documented quick start boots: sourcing .env.example refuses nothing", () => {
  const verdict = bootFromEnvExample();
  assert.deepEqual(
    verdict.problems, [],
    `every ADMIT_* line is parsed with blankIsRefused, so a key left empty in `
    + `this file is not an unset key -- \`set -a; source .env\` hands the process `
    + `"" and the parse refuses it. The eight of them therefore have to carry `
    + `the 0 that spells "not enforced", or the documented quick start is a `
    + `process that exits before Fastify listens, naming keys the reader never `
    + `set. Fix ${ENV_EXAMPLE}, not the guard: reading blank as 0 would make a `
    + `ceiling that failed to render indistinguishable from one deliberately off.`,
  );
  assert.equal(
    verdict.threw, null,
    `assertAdmissionSettings() is fatal by design and runs in main() above `
    + `initDb(), so any entry above is the whole boot, not a warning`,
  );
});

/**
 * Switches an operator has to set by hand during a rollout, and the deploy
 * files that say so.
 *
 * `documentedBy` is the premise, and it is checked rather than asserted: if the
 * chart path stops carrying a switch, R6 fails against this table and asks to
 * be updated, instead of silently guarding a rule that no longer exists. What
 * it buys is the other direction -- a switch that only the chart path names is
 * one the local stack's operator is never told about, and the rollout step is
 * missed on exactly the deployments with no chart to read.
 */
const ROLLOUT_SWITCHES = [
  {
    key: "RUN_FAT_PREPARING_RECONCILE",
    documentedBy: ["deploy/values.example.env", "deploy/common.sh"],
    // The value a rollup from a release predating the durable holder must set.
    rolloutValue: "false",
  },
];

for (const { key, documentedBy, rolloutValue } of ROLLOUT_SWITCHES) {
  test(`R6 .env.example declares the rollout switch ${key}`, () => {
    for (const file of documentedBy) {
      assert.match(
        readFileSync(join(REPO, file), "utf8"),
        new RegExp(`^${key}=`, "m"),
        `${file} no longer carries ${key}; if the switch is gone, drop it from `
        + `ROLLOUT_SWITCHES rather than leaving a rule with nothing behind it`,
      );
    }
    assert.ok(
      DECLARED.has(key),
      `${key} is a switch an operator must set during a rollup -- `
      + `${documentedBy.join(" and ")} both say so -- and .env.example is the `
      + `only one of the three a deployment with no chart ever reads. Omitted `
      + `here, the step is invisible to exactly the operators who have to take `
      + `it by hand. Add it (${ENV_EXAMPLE}).`,
    );
  });

  test(`R7 .env.example says what a rollout sets ${key} to`, () => {
    // Shipped blank, like the rest of the optional section, because blank is
    // this one's default; what makes the line worth anything is the comment
    // naming the value and the window.
    assert.match(
      commentAbove(key),
      new RegExp(`\\b${rolloutValue}\\b`),
      `a declared switch with no instruction is a line the reader skips; `
      + `${key}'s comment must name "${rolloutValue}" as the rollout setting`,
    );
  });
}
