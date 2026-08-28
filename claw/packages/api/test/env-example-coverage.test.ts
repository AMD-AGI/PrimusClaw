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
 * Coverage:
 *   R1 the requirement is real: production code throws when the key is absent
 *   R2 .env.example declares every such key
 *   R3 blank is not enough on its own, so the file must say how to make a value
 *   R4 the recipe .env.example documents produces a value the code accepts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env.example");
const TEXT = readFileSync(ENV_EXAMPLE, "utf8");

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
