// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { StringDecoder } from "node:string_decoder";

/** The least time between two progress notifications of one foreground command. */
export const OUTPUT_PROGRESS_INTERVAL_MS = 250;
/** Output sent as progress per command; past it the rest is in the result only. */
export const OUTPUT_PROGRESS_MAX_BYTES = 1024 * 1024;
/** A line still unterminated at this length is sent anyway, so a command that never prints a newline still shows. */
const PARTIAL_LINE_MAX_CHARS = 4096;

/**
 * A foreground command's output as it is written, for the MCP progress notifications of its `tools/call` (the caller asked by
 * sending a `progressToken`). Each notification's `message` is the output since the previous one: stdout and stderr in the order
 * they arrived, whole lines only (`\n` or `\r` ends one), at most one per `intervalMs`. Whole lines because the caller redacts each
 * notification on its own, and a value split across two of them is in neither whole. `end` sends whatever is left, the last
 * partial line included, before the result goes out. Sending is best-effort: a notification that fails is dropped, and the result
 * still carries all of the output.
 */
export class OutputProgress {
  private readonly decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  private pending = "";
  private sentBytes = 0;
  private n = 0;
  private lastAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private ended = false;

  constructor(
    private readonly send: (message: string, progress: number) => Promise<void>,
    private readonly intervalMs = OUTPUT_PROGRESS_INTERVAL_MS,
    private readonly maxBytes = OUTPUT_PROGRESS_MAX_BYTES,
  ) {}

  write(stream: "stdout" | "stderr", chunk: Buffer): void {
    if (this.ended || this.sentBytes >= this.maxBytes) return;
    this.pending += this.decoders[stream].write(chunk);
    if (this.timer) return;
    const wait = this.lastAt + this.intervalMs - Date.now();
    if (wait <= 0) {
      this.flush(false);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.ended) this.flush(false);
    }, wait);
    this.timer.unref?.();
  }

  private flush(final: boolean): void {
    let upTo = this.pending.length;
    if (!final) {
      const lineEnd = Math.max(this.pending.lastIndexOf("\n"), this.pending.lastIndexOf("\r")) + 1;
      upTo = this.pending.length - lineEnd >= PARTIAL_LINE_MAX_CHARS ? this.pending.length : lineEnd;
    }
    if (upTo === 0) return;
    let message = this.pending.slice(0, upTo);
    this.pending = this.pending.slice(upTo);
    const room = this.maxBytes - this.sentBytes;
    if (Buffer.byteLength(message) > room) message = Buffer.from(message).subarray(0, room).toString("utf8").replace(/�$/, "");
    if (!message) return;
    this.sentBytes += Buffer.byteLength(message);
    this.lastAt = Date.now();
    const progress = ++this.n;
    this.chain = this.chain.then(() => this.send(message, progress)).catch(() => {});
  }

  /** The command ended: send what is left and wait until every notification is out, before the result is written. */
  async end(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.ended) {
      this.ended = true;
      if (this.sentBytes < this.maxBytes) {
        this.pending += this.decoders.stdout.end() + this.decoders.stderr.end();
        this.flush(true);
      }
    }
    await this.chain;
  }
}
