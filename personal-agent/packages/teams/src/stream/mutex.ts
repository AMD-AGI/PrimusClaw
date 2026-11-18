// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A first-come-first-served lock: what is run under it runs one at a time, in the order it asked. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `work` when every earlier `run` has finished (whether it succeeded or not). */
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
