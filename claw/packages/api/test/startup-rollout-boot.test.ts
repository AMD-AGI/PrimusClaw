// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The rollout gate as production runs it: `main()` in a real subprocess.
 *
 * Every in-process test of the rule calls `assertRolloutConfigAtStartup()`
 * itself, so all of them would still pass if `main()` stopped calling it.
 * `index.ts` exports nothing and invokes `main()` at module scope, so booting
 * the entrypoint is the only way to observe the production sequence.
 *
 * The file is hermetic because the gate sits above `initUserEnvCrypto()`,
 * `initDb()` and `initNats()`: a refused configuration dies before any I/O, and
 * an accepted one dies on a closed loopback port. Which message came out is the
 * assertion -- a reverse-order configuration exits non-zero either way, because
 * `assertAdmissionSettings()` on the next line refuses it too.
 *
 * Coverage:
 *   B1 a reverse-order configuration is refused by the rollout gate, not by its
 *      neighbour, and the process never reaches app.listen
 *   B2 an accepted configuration passes the gate and dies inside initDb
 *   B3 a single non-zero ceiling is named alone
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(PKG, "src", "index.ts");
const TSX_LOADER = import.meta.resolve("tsx");

const CASE_TIMEOUT_MS = 120_000;
const BOOT_TIMEOUT_MS = 60_000;

const ROLLOUT_REFUSAL = "run doorbell dispatch is off while admission is still metering:";
const ADMISSION_REFUSAL = "refused admission settings:";

/** The 32-byte base64 key `.env.example` documents, so `initUserEnvCrypto()` accepts it. */
const ENCRYPTION_KEY = execFileSync("openssl", ["rand", "-base64", "32"], {
  encoding: "utf8",
}).trim();

/** A port bound then released, so a later connect proves nobody claimed it since. */
async function reserveFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function connectRefused(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

interface Boot {
  code: number | null;
  out: string;
}

/**
 * Boot `index.ts` with exactly this environment and nothing inherited.
 *
 * The child env is built from scratch rather than spread over `process.env`:
 * the suite's own `DATABASE_URL`, `NATS_URL` or `ADMIT_*` would otherwise decide
 * the outcome before the gate runs. `DOTENV_CONFIG_PATH` names a file that does
 * not exist because `config.ts` does `import "dotenv/config"`, which would fill
 * unset keys from a developer's local `.env`.
 *
 * `out` concatenates both streams: pino is constructed with no destination, so
 * the startup failure lands on stdout.
 */
async function boot(env: Record<string, string>): Promise<Boot> {
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", TSX_LOADER, ENTRY], {
      cwd: PKG,
      timeout: BOOT_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        DOTENV_CONFIG_PATH: join(PKG, "no-such.env"),
        DOTENV_CONFIG_QUIET: "true",
        USER_ENV_ENCRYPTION_KEY: ENCRYPTION_KEY,
        ...env,
      },
    });
    return { code: 0, out: stdout + stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? null, out: (failed.stdout ?? "") + (failed.stderr ?? "") };
  }
}

test("a reverse-order configuration is refused at boot by the rollout gate itself", { timeout: CASE_TIMEOUT_MS }, async () => {
  const port = await reserveFreePort();

  const result = await boot({
    RUN_DOORBELL_DISPATCH: "false",
    ADMIT_SOFT_RUNS: "5",
    ADMIT_HARD_SANDBOXES: "7",
    API_PORT: String(port),
  });

  assert.equal(result.code, 1);
  assert.match(result.out, /"msg":"api\.startup_failed"/);
  assert.ok(
    result.out.includes(
      `${ROLLOUT_REFUSAL} ADMIT_SOFT_RUNS, ADMIT_HARD_SANDBOXES are non-zero.`
        + " Clear the admission ceilings first, disable RUN_DOORBELL_DISPATCH second.",
    ),
    "the reverse-order configuration was refused, but not by the rollout gate --"
      + " main() may no longer call assertRolloutConfigAtStartup()",
  );
  assert.ok(
    !result.out.includes(ADMISSION_REFUSAL),
    "assertAdmissionSettings() refused this boot instead, which it would also do if"
      + " main() had dropped the rollout gate entirely",
  );
});

test("the boot the rollout gate refuses binds no port", { timeout: CASE_TIMEOUT_MS }, async () => {
  const port = await reserveFreePort();

  const result = await boot({
    RUN_DOORBELL_DISPATCH: "false",
    ADMIT_SOFT_RUNS: "5",
    API_PORT: String(port),
  });

  assert.equal(result.code, 1);
  assert.ok(
    !result.out.includes("api-v2.ready"),
    "a refused boot logged the ready line, so it reached app.listen",
  );
  assert.equal(
    await connectRefused(port),
    true,
    "a boot the rollout gate refuses must never have reached app.listen",
  );
});

test("an accepted configuration passes the gate and fails on the database instead", { timeout: CASE_TIMEOUT_MS }, async () => {
  const apiPort = await reserveFreePort();
  const deadDbPort = await reserveFreePort();

  const result = await boot({
    RUN_DOORBELL_DISPATCH: "true",
    ADMIT_SOFT_RUNS: "5",
    ADMIT_HARD_SANDBOXES: "7",
    API_PORT: String(apiPort),
    DATABASE_URL: `postgres://claw:claw@127.0.0.1:${deadDbPort}/none`,
  });

  assert.equal(result.code, 1);
  assert.match(result.out, /"msg":"api\.startup_failed"/);
  assert.ok(
    result.out.includes(`ECONNREFUSED 127.0.0.1:${deadDbPort}`),
    "startup did not reach initDb's pool.connect(), so the gate is not what it passed",
  );
  assert.ok(
    !result.out.includes(ROLLOUT_REFUSAL),
    "an accepted configuration must not be refused by the rollout gate",
  );
  assert.ok(!result.out.includes(ADMISSION_REFUSAL));
  assert.equal(await connectRefused(apiPort), true);
});

test("the gate names only the ceiling that is non-zero", { timeout: CASE_TIMEOUT_MS }, async () => {
  const port = await reserveFreePort();

  const result = await boot({
    RUN_DOORBELL_DISPATCH: "false",
    ADMIT_TREE_MAX_DEPTH: "3",
    API_PORT: String(port),
  });

  assert.equal(result.code, 1);
  assert.ok(result.out.includes(`${ROLLOUT_REFUSAL} ADMIT_TREE_MAX_DEPTH are non-zero.`));
  assert.ok(!result.out.includes("ADMIT_SOFT_RUNS"), "a zero ceiling is not an offender");
});
