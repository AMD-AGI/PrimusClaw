// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { deflateRawSync } from "node:zlib";
import type { Clock, LogFields, Logger } from "@primusclaw/personal-agent";
import { createClawClient, type ClawClientOptions, type Fetch } from "../../src/index.js";

/** A request the fake Claw received. */
export interface Sent {
  readonly method: string;
  readonly url: URL;
  /** The path as it goes on the wire (WHATWG-parsed, as `fetch` sends it), still percent-encoded. */
  readonly rawPath: string;
  readonly headers: Headers;
  readonly body: unknown;
  readonly form: FormData | null;
}

export type Answer = (request: Sent) => Response | Promise<Response>;

/** A JSON answer. */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A Claw on the wire: records every request and answers it with `answer`. */
export class Wire {
  readonly sent: Sent[] = [];
  answer: Answer;

  constructor(answer: Answer = () => json(200, { ok: true, data: {} })) {
    this.answer = answer;
  }

  readonly fetch: Fetch = async (url, init) => {
    const parsed = new URL(url);
    const body = init.body;
    const sent: Sent = {
      method: init.method ?? "GET",
      url: parsed,
      rawPath: parsed.pathname,
      headers: new Headers(init.headers),
      body: typeof body === "string" ? JSON.parse(body) : undefined,
      form: body instanceof FormData ? body : null,
    };
    this.sent.push(sent);
    return this.answer(sent);
  };

  client(options: Partial<ClawClientOptions> = {}): ReturnType<typeof createClawClient> {
    return createClawClient({ baseUrl: "https://claw.test", clock: new FakeClock(), fetch: this.fetch, ...options });
  }
}

/** A monotonic clock the test moves. */
export class FakeClock implements Clock {
  now = 1_000_000;
  epochMs(): number {
    return this.now;
  }
  monotonicMs(): number {
    return this.now;
  }
  sleep(): Promise<void> {
    return Promise.resolve();
  }
}

/** A logger that keeps every line. */
export class RecordingLogger implements Logger {
  readonly lines: Array<{ level: string; message: string; fields: LogFields }> = [];
  debug(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: "debug", message, fields });
  }
  info(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: "info", message, fields });
  }
  warn(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: "warn", message, fields });
  }
  error(message: string, fields: LogFields = {}): void {
    this.lines.push({ level: "error", message, fields });
  }
  child(): Logger {
    return this;
  }
}

/** A zip archive of `files` (deflated, as Python's `zipfile` writes with ZIP_DEFLATED; `stored` keeps them as they are). */
export function zip(files: Record<string, string | Uint8Array>, stored = false): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = typeof text === "string" ? Buffer.from(text, "utf8") : Buffer.from(text);
    const data = stored ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}
