// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker process, as an assembly can build it: the public `main` builds it with the neutral plugins, a deployment's
 * own `main` (with its identity platform, model gateway rules, extra routes) builds it with its plugins. Everything else
 * (store, Claw client, Teams outbound, inbound queue, HTTP endpoints) is assembled from the environment the same way for
 * both.
 */
import type { Clock, Logger, Plugins } from "@primusclaw/personal-agent";

/** The environment the worker reads its settings from (`process.env`, or a copy a test or a gate made). */
export type WorkerEnv = Readonly<Record<string, string | undefined>>;

export interface WorkerOptions {
  /** Defaults: the system clock, a line logger on stderr, the global `fetch`. */
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly fetch?: typeof fetch;
}

/** A built worker: nothing runs until `run`. */
export interface Worker {
  /**
   * Start every part (HTTP endpoints, the inbound consumer or the gate's test entry, the timers) and resolve when the
   * worker has stopped: after `stop`, or when a part fails (the promise rejects then).
   */
  run(): Promise<void>;
  /** Stop taking new work, finish what is in hand, close connections. */
  stop(): Promise<void>;
}

/**
 * Build the worker from `env` with `plugins`. Rejects at start, before anything is served, when the settings are not
 * usable (a missing required setting, an unreadable key file): a worker that starts must be able to answer.
 */
export type BuildWorker = (env: WorkerEnv, plugins: Plugins, options?: WorkerOptions) => Promise<Worker>;
