// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawError, ClawUnreachable, SseFrames, type ClawCredential, type SseEvent } from "@primusclaw/personal-agent";
import { type ClawHttp, DEFAULT_TIMEOUT_MS, head, readText, unreachable } from "./http.js";

/** Claw sends a keepalive every 15 s; silence this long means a dead stream. */
export const STREAM_IDLE_MS = 90_000;

/** Options of an SSE read (tests shorten the waits). */
export interface StreamTiming {
  readonly connectMs?: number;
  readonly idleMs?: number;
}

/**
 * The events of a Claw SSE stream at `path` (history after `after`, then live). The connection is given `connectMs` to
 * answer and is dropped (ClawUnreachable "timeout") after `idleMs` with nothing read; `signal` ends it early.
 */
export async function* sseEvents(
  http: ClawHttp,
  path: string,
  key: ClawCredential,
  after: string | undefined,
  signal?: AbortSignal,
  timing: StreamTiming = {},
): AsyncGenerator<SseEvent> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(signal?.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const full = after === undefined || after === "" ? path : `${path}?${new URLSearchParams({ after }).toString()}`;
  const watchdog = new Watchdog(controller, timing.connectMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await http.send(
      { method: "GET", path: full, key, headers: { Accept: "text/event-stream" } },
      { signal: controller.signal },
    );
    if (response.status >= 400) throw new ClawError(response.status, head(await readText(response, path)));
    yield* readFrames(response, watchdog, timing.idleMs ?? STREAM_IDLE_MS, path);
  } finally {
    watchdog.stop();
    signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

async function* readFrames(
  response: Response,
  watchdog: Watchdog,
  idleMs: number,
  path: string,
): AsyncGenerator<SseEvent> {
  const frames = new SseFrames();
  const decoder = new TextDecoder();
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  for (;;) {
    watchdog.arm(idleMs);
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (err) {
      throw watchdog.fired ? new ClawUnreachable("timeout", path) : unreachable(err, path);
    }
    watchdog.stop();
    if (chunk.done) return;
    yield* frames.push(decoder.decode(chunk.value, { stream: true }));
  }
}

/** Aborts the connection when a wait runs out; re-armed for every read. */
class Watchdog {
  fired = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly controller: AbortController,
    firstMs: number,
  ) {
    this.arm(firstMs);
  }

  arm(ms: number): void {
    this.stop();
    this.timer = setTimeout(() => {
      this.fired = true;
      this.controller.abort();
    }, ms);
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}
