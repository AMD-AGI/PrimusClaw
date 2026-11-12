// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A worker as a program: built, run until a signal. A worker that cannot start says why in one CRITICAL line, before it
 * takes a message: status 2 for a secret that cannot be read, 1 for anything else (a setting that cannot work). A surface
 * package's `main` is this with its own `buildWorker`.
 */
import { SecretsUnavailable } from "@primusclaw/personal-agent";

import type { Worker } from "./worker-api.js";

/** Build a worker with `build` and run it until SIGTERM or SIGINT; the exit status the process should end with. */
export async function runMain(
  build: () => Promise<Worker>,
  write: (line: string) => void = (line) => process.stderr.write(line + "\n"),
): Promise<number> {
  let worker: Worker;
  try {
    worker = await build();
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
