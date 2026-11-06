// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the process does with an error nothing else handled.
 *
 * Node's default is to exit on either kind, and for a brain that is the wrong
 * trade: one pod holds several users' runs, and on 2026-11-06 one rejection
 * nobody awaited -- a run that had already failed, reported a second time by a
 * promise derived from it -- exited a pod and stalled every run on it for
 * eleven minutes. The two kinds are treated differently because they are
 * different:
 *
 *   - An unhandled rejection is a promise somebody forgot to await or catch. The
 *     work it belonged to has already finished, one way or the other; the
 *     process state is no less consistent than before. It is logged with its
 *     stack at error level and counted, so it is still a bug that shows up on a
 *     dashboard and an alert -- it is not swallowed -- but it no longer takes the
 *     pod's other runs with it.
 *   - An uncaught exception unwound a synchronous stack to the top, and whatever
 *     that stack was in the middle of is now half done. Carrying on is not safe,
 *     so the process still exits, non-zero. But it exits through `onFatal`, the
 *     same hand-off a SIGTERM gets, so the runs on the pod are checkpointed and
 *     handed back for another replica to resume, instead of being left to time
 *     out their leases.
 */
export interface ProcessGuardDeps {
  log: {
    error: (obj: Record<string, unknown>, msg: string) => void;
    fatal: (obj: Record<string, unknown>, msg: string) => void;
  };
  count: (kind: "unhandled_rejection" | "uncaught_exception") => void;
  /** Begin an orderly shutdown that ends in `process.exit(code)`. */
  onFatal: (err: unknown) => void;
}

export function installProcessGuards(deps: ProcessGuardDeps, proc: NodeJS.Process = process): void {
  proc.on("unhandledRejection", (reason) => {
    deps.count("unhandled_rejection");
    deps.log.error({ err: reason }, "process.unhandled_rejection");
  });
  proc.on("uncaughtException", (err, origin) => {
    deps.count("uncaught_exception");
    deps.log.fatal({ err, origin }, "process.uncaught_exception");
    deps.onFatal(err);
  });
}
