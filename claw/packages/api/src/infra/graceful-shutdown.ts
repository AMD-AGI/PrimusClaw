// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How an API pod leaves a rolling update without taking requests with it.
 *
 * There was no SIGTERM handling at all: Node's default exited the process the
 * moment the signal arrived, so every request in flight, every SSE stream and
 * every internal MCP call on the pod was reset, and the pod's grace period was
 * never used. The order here is the one Kubernetes needs:
 *
 *   1. The pod is already out of the Service's endpoints by the time SIGTERM
 *      arrives, because the chart's preStop sleeps first. From here on the pod
 *      also reports itself not ready (`/ready`), and every response carries
 *      `Connection: close`, so a client holding a keep-alive socket to it
 *      reconnects -- to another replica -- for its next request instead of
 *      sending it into a socket about to close.
 *   2. Event streams are told to reconnect: an SSE `retry:` field and the end of
 *      the response, which every EventSource-style client answers by opening
 *      the stream again, resuming from its last event id. Streams never end on
 *      their own, so without this the drain below would wait for the deadline.
 *   3. The server stops accepting and waits for the requests it has to finish.
 *   4. Background consumers and pools are closed: a NATS drain hands the
 *      unacknowledged messages back for another replica instead of leaving them
 *      to time out, and the PG pools end so no transaction is cut mid-flight.
 *
 * Everything is bounded by `deadlineMs`, a few seconds inside the pod's grace
 * period, so a request that never finishes costs an exit code rather than a
 * SIGKILL.
 */
import type { ServerResponse, OutgoingHttpHeaders } from "node:http";

export interface ShutdownLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface ShutdownStep {
  name: string;
  run: () => Promise<unknown>;
}

export interface GracefulShutdownOptions {
  logger: ShutdownLogger;
  /** Overall budget from the signal to exit. */
  deadlineMs: number;
  /** Extra time to keep serving after the signal, before closing (0 behind a preStop sleep). */
  delayMs: number;
  /** Stop accepting and wait for in-flight requests (Fastify's `close`). */
  closeServer: () => Promise<void>;
  /** After the server: consumers, NATS, pools. Each is bounded by what is left of the deadline. */
  steps: ShutdownStep[];
  exit: (code: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** The SSE frame a closing pod sends before ending a stream: reconnect in one second. */
export const SSE_RECONNECT_FRAME = "retry: 1000\n\n";

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if (Array.isArray(headers)) {
    for (let i = 0; i + 1 < headers.length; i += 2) {
      if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1]);
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(headers as OutgoingHttpHeaders)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(",") : String(v);
  }
  return undefined;
}

export class GracefulShutdown {
  private state: "serving" | "draining" | "closing_streams" = "serving";
  private readonly streams = new Set<ServerResponse>();
  private started = false;

  constructor(private readonly opts: GracefulShutdownOptions) {}

  /** True from the signal on: readiness fails and responses ask for a new connection. */
  get draining(): boolean {
    return this.state !== "serving";
  }

  get openStreams(): number {
    return this.streams.size;
  }

  /**
   * Called for every response before anything is written. Watches for an event
   * stream being opened -- by a hijacked route writing its own head or by a
   * normal reply with the header set -- and remembers it until it closes.
   */
  watchResponse(res: ServerResponse): void {
    const originalWriteHead = res.writeHead;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    res.writeHead = function patchedWriteHead(this: ServerResponse, ...args: unknown[]) {
      const headers = typeof args[1] === "object" ? args[1] : args[2];
      const type = headerValue(headers, "content-type") ?? String(res.getHeader("content-type") ?? "");
      if (self.draining) {
        // Replace whatever the route asked for: a keep-alive promise made by a
        // pod that is about to close is the one the client must not believe.
        if (headers && typeof headers === "object" && !Array.isArray(headers)) {
          for (const k of Object.keys(headers)) if (k.toLowerCase() === "connection") delete (headers as Record<string, unknown>)[k];
          (headers as Record<string, unknown>).Connection = "close";
        } else if (!res.headersSent) {
          res.setHeader("Connection", "close");
        }
      }
      const out = (originalWriteHead as (...a: unknown[]) => ServerResponse).apply(this, args);
      if (/text\/event-stream/i.test(type)) self.trackStream(res);
      return out;
    } as typeof res.writeHead;
  }

  private trackStream(res: ServerResponse): void {
    if (this.state === "closing_streams") {
      // Opened after the streams were told to go: tell this one too.
      setImmediate(() => this.endStream(res));
      return;
    }
    this.streams.add(res);
    res.once("close", () => this.streams.delete(res));
  }

  private endStream(res: ServerResponse): void {
    try {
      if (!res.writableEnded) {
        res.write(SSE_RECONNECT_FRAME);
        res.end();
      }
    } catch { /* the client is already gone */ }
    this.streams.delete(res);
  }

  /** Install once; a second signal while shutting down is ignored. */
  install(proc: NodeJS.Process = process): void {
    const handler = (sig: string) => { void this.begin(sig); };
    proc.once("SIGTERM", () => handler("SIGTERM"));
    proc.once("SIGINT", () => handler("SIGINT"));
  }

  async begin(signal: string): Promise<void> {
    if (this.started) return;
    this.started = true;
    const { logger, deadlineMs, delayMs } = this.opts;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const startedAt = Date.now();
    const left = () => Math.max(0, deadlineMs - (Date.now() - startedAt));
    let exited = false;
    const exit = (code: number) => {
      if (exited) return;
      exited = true;
      this.opts.exit(code);
    };
    const deadline = setTimeout(() => {
      logger.warn({ signal, openStreams: this.streams.size, deadlineMs }, "api.shutdown.deadline_exceeded");
      exit(1);
    }, deadlineMs);
    deadline.unref?.();

    this.state = "draining";
    logger.info({ signal, delayMs, deadlineMs, openStreams: this.streams.size }, "api.shutdown.draining");
    if (delayMs > 0) await sleep(delayMs);

    this.state = "closing_streams";
    const streams = [...this.streams];
    for (const res of streams) this.endStream(res);
    logger.info({ signal, streams: streams.length }, "api.shutdown.streams_closed");

    // Clean means every request the server had was answered. A server that
    // had to be abandoned at the deadline cut some off, and says so in its exit
    // code whichever of the two timers noticed first. The steps after it are
    // housekeeping: their failures are logged, not reported as lost work.
    const served = await bounded("server", this.opts.closeServer(), left(), logger);
    for (const step of this.opts.steps) {
      await bounded(step.name, step.run(), left(), logger);
    }
    clearTimeout(deadline);
    logger.info({ signal, served, elapsedMs: Date.now() - startedAt }, "api.shutdown.complete");
    exit(served ? 0 : 1);
  }
}

async function bounded(name: string, work: Promise<unknown>, ms: number, logger: ShutdownLogger): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not finish in ${ms}ms`)), ms);
        timer.unref?.();
      }),
    ]);
    return true;
  } catch (err) {
    logger.warn({ step: name, err: err instanceof Error ? err.message : String(err) }, "api.shutdown.step_failed");
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
