// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Test doubles for the inbound file tests: a recording fetch, a bot token source, a recording logger, the fixtures. */
import type { Clock, InboundFile, LogFields, Logger } from "@primusclaw/personal-agent";
import { FakeClock } from "../../../../test-support/clock.js";
import { FILE_DOWNLOAD_INFO } from "../../src/inbound/attachments.js";
import { TeamsFileFetcher, type BotTokens, type TeamsFileFetcherOptions } from "../../src/inbound/fetcher.js";

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array<number>(24).fill(0)]);
export const BOT_URL = "https://smba.trafficmanager.net/amer/v3/attachments/0-cus-d1-abc/views/original";
export const SHAREPOINT =
  "https://contoso-my.sharepoint.com/personal/a/_layouts/15/download.aspx?UniqueId=1&tempauth=x";

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** A pasted image as `inboundFiles` makes it. */
export function pasted(url = BOT_URL, index = 1): InboundFile {
  return { name: "", type: "", handle: { kind: "pasted", url, index } };
}

/** A sent file as `inboundFiles` makes it. */
export function sent(name: string, url: string, type = "", index = 1): InboundFile {
  return { name, type, handle: { kind: "download", url, index } };
}

export function image(url = BOT_URL, kind = "image/*"): Record<string, unknown> {
  return { contentType: kind, contentUrl: url };
}

export function fileInfo(name = "report.pdf", url = SHAREPOINT, fileType = "pdf"): Record<string, unknown> {
  return { contentType: FILE_DOWNLOAD_INFO, name, content: { downloadUrl: url, uniqueId: "u1", fileType } };
}

export function dm(text: string, attachments: unknown[]): Record<string, unknown> {
  return {
    type: "message",
    id: "act-9",
    text,
    from: { id: "29:a", aadObjectId: "aad-a", name: "Lin Mei" },
    attachments,
    recipient: { id: "28:bot" },
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    channelId: "msteams",
    conversation: { id: "conv-aad-a", conversationType: "personal" },
  };
}

export class Tokens implements BotTokens {
  constructor(private readonly fail = false) {}

  get(): Promise<string> {
    return this.fail ? Promise.reject(new RangeError("IMDS answered 400")) : Promise.resolve("bot-token");
  }
}

export interface Seen {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface Answer {
  readonly status?: number;
  readonly body?: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A fetch that records each request (its headers lower case) and answers with `handler`. */
export function recordingFetch(handler: (url: URL) => Answer): {
  fetch: TeamsFileFetcherOptions["fetch"];
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    seen.push({ url, headers });
    const answer = handler(new URL(url));
    const body = answer.body ?? new Uint8Array();
    return Promise.resolve(new Response(body.byteLength ? new Uint8Array(body) : null, answer));
  };
  return { fetch, seen };
}

/** A fetcher on a recording fetch; `tokens` null means no token source. */
export function fetcher(
  handler: (url: URL) => Answer,
  tokens: BotTokens | null = new Tokens(),
  extra: Partial<TeamsFileFetcherOptions> = {},
): { files: TeamsFileFetcher; seen: Seen[]; clock: Clock } {
  const { fetch, seen } = recordingFetch(handler);
  const clock = new FakeClock();
  return { files: new TeamsFileFetcher({ fetch, clock, tokens: tokens ?? undefined, ...extra }), seen, clock };
}

export interface LogLine {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that keeps every line. */
export class RecordingLogger implements Logger {
  constructor(readonly lines: LogLine[] = []) {}

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

  text(): string {
    return JSON.stringify(this.lines);
  }
}
