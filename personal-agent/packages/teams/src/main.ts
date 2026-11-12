// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker as a program (from personal-agent/: `node --import tsx packages/teams/src/main.ts`): built from the
 * environment with the neutral plugins, run until a signal. A worker that cannot start says why in one CRITICAL line,
 * before it takes a message: status 2 for a secret that cannot be read, 1 for anything else (a setting that cannot work).
 */
import { neutralPlugins, type Plugins } from "@primusclaw/personal-agent";
import { runMain, type PluginFactory, type WorkerEnv } from "@primusclaw/personal-agent-runtime/worker";

import { buildWorker } from "./assembly/worker.js";

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
  return await runMain(() => buildWorker(env, plugins), write);
}

if (import.meta.main) {
  process.exitCode = await main(process.env);
}
