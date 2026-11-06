// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether `deliver_file` is on when the deployment does not say. Its download
 * answers only an interactive sign-in, which kubernetes/BYOK mode has only with
 * identity tokens, so there it is off unless the operator turns it on. Config
 * reads the environment once at import, so each row is its own process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CONFIG = fileURLToPath(new URL("../src/config.ts", import.meta.url));

async function enabledUnder(env: Record<string, string>): Promise<string> {
  const base = { ...process.env };
  delete base.CLAW_DEPLOY_MODE;
  delete base.DELIVER_FILE_ENABLED;
  const { stdout } = await run(process.execPath, [
    TSX, "--eval", `import(${JSON.stringify(CONFIG)}).then((c) => console.log("DELIVER_FILE_ENABLED=" + c.DELIVER_FILE_ENABLED))`,
  ], { env: { ...base, ...env }, timeout: 60_000 });
  return stdout.match(/DELIVER_FILE_ENABLED=(\w+)/)?.[1] ?? `no answer in: ${stdout}`;
}

test("deliver_file defaults to on in SaFE mode and off in kubernetes mode; an explicit setting wins in either", async () => {
  const rows: Array<[string, Record<string, string>, string]> = [
    ["safe, unset", {}, "true"],
    ["safe, explicit off", { DELIVER_FILE_ENABLED: "false" }, "false"],
    ["kubernetes, unset", { CLAW_DEPLOY_MODE: "kubernetes" }, "false"],
    ["kubernetes, explicit on", { CLAW_DEPLOY_MODE: "kubernetes", DELIVER_FILE_ENABLED: "true" }, "true"],
  ];
  for (const [name, env, want] of rows) assert.equal(await enabledUnder(env), want, name);
});
