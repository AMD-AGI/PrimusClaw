// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A built worker's run: its HTTP endpoints and /metrics listening, the features started, the timers running, then the
 * inbound consumer (or, with no queue, waiting) until it is stopped; everything closed on the way out.
 */
import type { Clock, Logger } from "@primusclaw/personal-agent";
import { errorName } from "@primusclaw/personal-agent";
import { listen, type buildServer } from "@primusclaw/personal-agent-runtime";

/** The HTTP server the runtime builds (the teams package does not depend on its framework). */
type Server = ReturnType<typeof buildServer>;

import type { InboundConsumer } from "../servicebus/consumer.js";
import type { Worker } from "../worker-api.js";
import { startTimers, type Timer } from "./timers.js";

export interface RunnerParts {
  readonly app: Server;
  readonly metricsApp: Server;
  readonly host: string;
  readonly port: number;
  readonly metricsPort: number;
  readonly consumer: InboundConsumer | undefined;
  readonly start: () => Promise<void>;
  readonly timers: readonly Timer[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly close: () => Promise<void>;
}

function waitFor(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else
      signal.addEventListener(
        "abort",
        () => {
          resolve();
        },
        { once: true },
      );
  });
}

async function listenMetrics(parts: RunnerParts): Promise<void> {
  try {
    await listen(parts.metricsApp, "0.0.0.0", parts.metricsPort);
  } catch (error) {
    // (/metrics is for the alerts only and never stops the worker)
    parts.logger.error("metrics: GET /metrics could not be served; the worker goes on without it", {
      port: parts.metricsPort,
      error: errorName(error),
    });
  }
}

/** Run every close in turn, each even when one before it failed; a failure is logged by its kind. */
export async function closeAll(logger: Logger, closes: readonly (() => unknown)[]): Promise<void> {
  for (const close of closes) {
    try {
      await close();
    } catch (error) {
      logger.error("a part of the worker could not be closed", { error: errorName(error) });
    }
  }
}

export function runner(parts: RunnerParts): Worker {
  const stopped = new AbortController();
  return {
    async run() {
      await listen(parts.app, parts.host, parts.port);
      await listenMetrics(parts);
      await parts.start();
      const timers = startTimers(parts.timers, parts.clock, parts.logger, stopped.signal);
      try {
        await (parts.consumer ? parts.consumer.run() : waitFor(stopped.signal));
      } finally {
        stopped.abort();
        await timers;
        // (each part is closed even when one before it fails to: a failure is logged by its kind)
        await closeAll(parts.logger, [() => parts.app.close(), () => parts.metricsApp.close(), () => parts.close()]);
      }
    },
    stop() {
      parts.consumer?.stop();
      stopped.abort();
      return Promise.resolve();
    },
  };
}
