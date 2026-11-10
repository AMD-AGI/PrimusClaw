// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker as a program (from personal-agent/: `node --import tsx packages/teams/src/main.ts`): built from the
 * environment with the neutral plugins, run until a signal. A worker that cannot start says why in one CRITICAL line,
 * before it takes a message: status 2 for a secret that cannot be read, 1 for anything else (a setting that cannot work).
 */
import { neutralPlugins, SecretsUnavailable, type Plugins } from "@primusclaw/personal-agent";

import { buildWorker } from "./assembly/worker.js";
import type { PluginFactory, Worker, WorkerEnv } from "./worker-api.js";

/**
 * Build and run a worker with `plugins` (a deployment's own entry passes its plugins or its factory; the public program the
 * neutral ones); the exit status the process should end with. Every entry ends the same way: one CRITICAL line, 2 for a
 * secret that cannot be read, 1 for anything else.
 */
export async function main(
  env: WorkerEnv,
  plugins: Plugins | PluginFactory = neutralPlugins(),
  write: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Promise<number> {
  let worker: Worker;
  try {
    worker = await buildWorker(env, plugins);
  } catch (error) {
    const why = error instanceof Error ? error.message : "the worker could not be built";
    if (error instanceof SecretsUnavailable) {
      write(`${new Date().toISOString()} CRITICAL secrets: ${why}; the worker does not start without them`);
      return 2;
    }
    write(`${new Date().toISOString()} CRITICAL the worker does not start: ${why}`);
    return 1;
  }
  const stop = (): void => {
    void worker.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  await worker.run();
  return 0;
}

if (import.meta.main) {
  process.exitCode = await main(process.env);
}
