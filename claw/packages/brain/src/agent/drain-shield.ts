// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { SIGTERM_ABORT_REASON } from "../tasks/abort-registry.js";

/** A tool call's own signal, and what to do once the call has returned. */
export interface ShieldedSignal {
  /** Pass this to the call instead of the run's signal. */
  signal: AbortSignal | undefined;
  /** Whether the call itself was cut: the shield gave way, or the run stopped for another reason. */
  cut(): boolean;
  /** Stop following the run's signal (call it when the call has returned). */
  dispose(): void;
}

/**
 * The signal a tool call already in flight is dispatched with: the run's own
 * signal, except that a drain (SIGTERM) reaches the call only `graceMs` later.
 *
 * A drain used to cut every call at once. Hands kills a command whose request
 * is cancelled, so a foreground `bash` a rollout caught was killed half way, and
 * the run resumed on another replica told only that the call was interrupted
 * (`INTERRUPTED_TOOL_RESULT`). The model then said so in the chat and ran the
 * command again. Let through, the call ends on its own, its real result is
 * written to the turn journal, and the resumed run answers it from there.
 *
 * Any other reason (a person's Stop, a lost lease, the deadline, a terminal
 * row) reaches the call at once: the run must stop touching the sandbox then.
 * `graceMs` 0 is the old behaviour.
 */
export function shieldFromDrain(run: AbortSignal | undefined, graceMs: number): ShieldedSignal {
  if (!run || graceMs <= 0) {
    return { signal: run, cut: () => run?.aborted === true, dispose: () => {} };
  }
  const own = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const follow = (): void => {
    if (run.reason !== SIGTERM_ABORT_REASON) {
      own.abort(run.reason);
      return;
    }
    timer = setTimeout(() => own.abort(run.reason), graceMs);
    // (never what keeps a process alive: the drain exits on its own once its runs are handed back)
    timer.unref?.();
  };
  if (run.aborted) follow();
  else run.addEventListener("abort", follow, { once: true });
  return {
    signal: own.signal,
    cut: () => own.signal.aborted,
    dispose: () => {
      run.removeEventListener("abort", follow);
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
