// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant session's live stream as the tests feed it (the Python `assistant_fake` turn scripts and `_streams`): every
 * stream opened gets each event pushed from then on, until its signal aborts. It counts the streams still open and records the
 * `after` each was opened with.
 */
import type { JsonObject, SseEvent } from "@primusclaw/personal-agent";

export class LiveFeed {
  /** The `after` of each stream opened, in order. */
  readonly afters: string[] = [];
  /** Streams Claw has answered (opened), in all. */
  opened = 0;
  /** Streams opened and not yet closed. */
  open = 0;
  private readonly queues = new Set<{ events: SseEvent[]; wake: (() => void) | undefined }>();

  /** An event for every stream open now. */
  push(name: string, data: JsonObject): void {
    for (const queue of this.queues) {
      queue.events.push({ id: "", name, data });
      queue.wake?.();
    }
  }

  /** `ClawSessionsPort.stream`'s shape. */
  readonly stream = (
    _key: string,
    _sessionId: string,
    after?: string,
    signal?: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<SseEvent> => {
    this.afters.push(after ?? "");
    return this.events(signal ?? new AbortController().signal, onOpen);
  };

  /** Each event pushed from when the stream is open (Claw answered its request at once: `onOpen`) until its signal aborts. */
  private async *events(signal: AbortSignal, onOpen?: () => void): AsyncGenerator<SseEvent> {
    // (Claw answers the request a moment later, as over the wire: events pushed before then do not reach this stream)
    const ended = (): boolean => signal.aborted;
    for (let i = 0; i < 5 && !ended(); i += 1) await Promise.resolve();
    if (ended()) return;
    const queue: { events: SseEvent[]; wake: (() => void) | undefined } = { events: [], wake: undefined };
    this.queues.add(queue);
    this.open += 1;
    this.opened += 1;
    onOpen?.();
    try {
      while (!signal.aborted) {
        const next = queue.events.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          queue.wake = resolve;
          signal.addEventListener("abort", () => {
            resolve();
          });
        });
      }
    } finally {
      this.queues.delete(queue);
      this.open -= 1;
    }
  }
}
