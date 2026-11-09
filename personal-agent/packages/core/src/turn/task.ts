// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Cancellable background work, the way the turn needs it: a piece of work starts on its own (not inside its caller's
 * synchronous step), can be waited for without its error being thrown at the waiter, and can be cancelled. Cancelling
 * aborts the work's signal: a sleep on it ends at once, and the work stops at its next check (`signal.throwIfAborted()`),
 * the way a cancelled coroutine stops at its next await.
 */

export class Cancelled extends Error {
  constructor() {
    super("cancelled");
    this.name = "Cancelled";
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof Cancelled;
}

export type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export class Task<T> {
  private readonly controller = new AbortController();
  private finished = false;
  /** Settles with what the work returned or threw; never rejects. */
  readonly outcome: Promise<Outcome<T>>;

  constructor(work: (signal: AbortSignal) => Promise<T>) {
    const signal = this.controller.signal;
    this.outcome = Promise.resolve()
      .then(() => work(signal))
      .then(
        (value): Outcome<T> => ({ ok: true, value }),
        (error: unknown): Outcome<T> => ({ ok: false, error }),
      )
      .finally(() => {
        this.finished = true;
      });
  }

  get done(): boolean {
    return this.finished;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    if (!this.finished) this.controller.abort(new Cancelled());
  }

  /** Wait until it is over, whatever came of it. */
  async settled(): Promise<void> {
    await this.outcome;
  }

  /** What it returned, or what it threw, thrown here. */
  async result(): Promise<T> {
    const outcome = await this.outcome;
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }
}

/** `promise`, unless `signal` is aborted first: then its reason is thrown (the promise goes on unwatched). */
export async function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Cancelled());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Detached work that must outlive its caller (a repeated edit, a stream closed after a cancel): kept until it ends. */
const BACKGROUND = new Set<Task<unknown>>();

export function detach(work: (signal: AbortSignal) => Promise<unknown>): Task<unknown> {
  const task = new Task(work);
  BACKGROUND.add(task);
  void task.outcome.then(() => BACKGROUND.delete(task));
  return task;
}

/** How much detached work is still running (tests). */
export function detachedCount(): number {
  return BACKGROUND.size;
}
