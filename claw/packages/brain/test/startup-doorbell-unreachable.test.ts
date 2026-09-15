// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one combination in which a pod has no route into doorbell execution.
 *
 * `RUN_DOORBELL_DISPATCH=false` makes this pod decline every doorbell on the
 * wire, and an unset `INTERNAL_BACKEND_URL` means it runs no claim-next loop to
 * find the row later. Neither is wrong on its own -- a fat-only deployment sets
 * the first legitimately -- so the warning is the only thing that separates a
 * fleet executing nothing from a fleet configured on purpose.
 *
 * The check reads two constants captured at import, so the two configurations
 * need two processes; and `index.ts` exports nothing and calls `main()` at
 * module scope, so booting the entrypoint is the only way to observe it. The
 * file is hermetic because `validateStartupConfig()` is the first statement in
 * `main()`: every boot here dies on a closed NATS port a moment later, and that
 * death is what proves the check was reached rather than skipped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PKG, "src", "index.ts");
const TSX_LOADER = import.meta.resolve("tsx");

const CASE_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = 60_000;

const UNREACHABLE = "startup.doorbell_execution_unreachable";
/** Where every boot here ends, and therefore the proof it got past the check. */
const NATS_REFUSED = "CONNECTION_REFUSED";

/** A port bound then released, so a later connect proves nobody claimed it since. */
async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Boot `index.ts` with exactly this environment and nothing inherited.
 *
 * Built from scratch rather than spread over `process.env`, so that a
 * developer's `RUN_DOORBELL_DISPATCH` or `INTERNAL_BACKEND_URL` cannot decide
 * the outcome; `DOTENV_CONFIG_PATH` names a file that does not exist because
 * `config.ts` does `import "dotenv/config"`.
 */
async function boot(env: Record<string, string>): Promise<string> {
  const natsPort = await reserveFreePort();
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", TSX_LOADER, ENTRY], {
      cwd: PKG,
      timeout: BOOT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        DOTENV_CONFIG_PATH: join(PKG, "no-such.env"),
        DOTENV_CONFIG_QUIET: "true",
        NATS_URL: `nats://127.0.0.1:${natsPort}`,
        ...env,
      },
    });
    return stdout + stderr;
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string };
    return (failed.stdout ?? "") + (failed.stderr ?? "");
  }
}

test("a pod that declines every doorbell and claims nothing says so at boot", { timeout: CASE_TIMEOUT_MS }, async () => {
  const out = await boot({ RUN_DOORBELL_DISPATCH: "false" });

  assert.ok(
    out.includes(NATS_REFUSED),
    `the boot did not reach its NATS connect, so nothing here is evidence:\n${out}`,
  );
  assert.ok(
    out.includes(UNREACHABLE),
    "a pod with no route into doorbell execution booted without saying so",
  );
});

test("a fat-only pod that can still claim is not warned about", { timeout: CASE_TIMEOUT_MS }, async () => {
  // The switch is off here too. What makes this configuration whole is the
  // claim-next loop, so warning about it would train an operator to ignore the
  // line that matters.
  const out = await boot({
    RUN_DOORBELL_DISPATCH: "false",
    INTERNAL_BACKEND_URL: "http://api:8080",
  });

  assert.ok(
    out.includes(NATS_REFUSED),
    `the boot did not reach its NATS connect, so nothing here is evidence:\n${out}`,
  );
  assert.ok(
    !out.includes(UNREACHABLE),
    "a pod that runs a claim-next loop was reported as having no route into execution",
  );
});
