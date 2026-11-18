// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One HTTP GET of a file: redirects followed by hand so the bot's token never follows one to another origin, the body
 * counted as it arrives and abandoned past the size limit, and every wait (the answer, each chunk) limited by an idle
 * timeout on the injected clock. What goes wrong is said in words for the user (`NotFetched`); the log gets the status
 * or the error's kind, never the URL.
 */
import { pyStrip, type Clock, type Logger } from "@primusclaw/personal-agent";
import { DeadlineError } from "../connector/errors.js";
import { raceAbort, reasonOf } from "../connector/timer.js";

/** How long one wait (the answer, the next chunk) may take, like httpx's per-operation timeout. */
export const FETCH_TIMEOUT_MS = 60_000;
/** httpx's default limit. */
export const MAX_REDIRECTS = 20;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const OCTET_STREAM = "application/octet-stream";

/** The `fetch` the fetcher uses (the global one in production; a fake in tests). */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Why one file was not fetched, in words for the user. */
export class NotFetched extends Error {
  override name = "NotFetched";
}

class TooManyRedirects extends Error {
  override name = "TooManyRedirects";
}

export interface Downloaded {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface DownloadOptions {
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly maxBytes: number;
}

/** An idle timeout: aborts its signal when `arm` has not been called for FETCH_TIMEOUT_MS. */
class Watchdog {
  private readonly controller = new AbortController();
  private stop: AbortController | undefined;

  constructor(private readonly clock: Clock) {
    this.arm();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  arm(): void {
    this.stop?.abort();
    const stop = new AbortController();
    this.stop = stop;
    this.clock.sleep(FETCH_TIMEOUT_MS, stop.signal).then(
      () => {
        this.controller.abort(new DeadlineError("the download stalled"));
      },
      () => undefined, // re-armed or disposed: this wait is no longer the limit
    );
  }

  dispose(): void {
    this.stop?.abort();
  }
}

function port(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

/**
 * httpx's rule for the Authorization header on a redirect: kept to the same origin (scheme, host, port), and on the
 * upgrade of the same host from http to https on the default ports; dropped everywhere else.
 */
export function keepsAuthorization(from: URL, to: URL): boolean {
  const sameHost = from.hostname === to.hostname;
  if (sameHost && from.protocol === to.protocol && port(from) === port(to)) return true;
  return sameHost && from.protocol === "http:" && to.protocol === "https:" && port(from) === "80" && port(to) === "443";
}

function discard(response: Response): void {
  // the body of an answer that is not read (a redirect, an error status): closing it has nothing left to report
  response.body?.cancel().catch(() => undefined);
}

/** GET `url`, following redirects by hand; the Authorization header is dropped on a hop `keepsAuthorization` refuses. */
async function follow(
  fetch: FetchLike,
  url: string,
  headers: Record<string, string>,
  dog: Watchdog,
): Promise<Response> {
  let target = url;
  let sent = headers;
  for (let hops = 0; ; hops++) {
    const response = await raceAbort(
      dog.signal,
      fetch(target, { method: "GET", headers: sent, redirect: "manual", signal: dog.signal }),
    );
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
    discard(response);
    if (hops >= MAX_REDIRECTS) throw new TooManyRedirects("too many redirects");
    const next = new URL(location, target);
    if (!keepsAuthorization(new URL(target), next)) {
      sent = Object.fromEntries(Object.entries(sent).filter(([name]) => name.toLowerCase() !== "authorization"));
    }
    target = next.href;
    dog.arm();
  }
}

/** The body, counted as it arrives; past `maxBytes` the download is abandoned. */
async function readBounded(response: Response, maxBytes: number, dog: Watchdog): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await raceAbort(dog.signal, reader.read());
      if (done) break;
      dog.arm();
      size += value.byteLength;
      if (size > maxBytes) {
        throw new NotFetched(`it is larger than ${String(Math.floor(maxBytes / (1024 * 1024)))} MB`);
      }
      chunks.push(value);
    }
  } catch (error) {
    reader.cancel().catch(() => undefined); // the download is abandoned; what its cancel says changes nothing
    throw error;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function mediaTypeOf(response: Response): string {
  const header = response.headers.get("content-type") ?? OCTET_STREAM;
  return pyStrip(header.split(";")[0] ?? "") || OCTET_STREAM;
}

/** The file at `url`; throws NotFetched with the reason in the user's words. */
export async function download(
  url: string,
  headers: Record<string, string>,
  options: DownloadOptions,
): Promise<Downloaded> {
  const dog = new Watchdog(options.clock);
  try {
    const response = await follow(options.fetch, url, headers, dog);
    dog.arm();
    if (response.status !== 200) {
      discard(response);
      options.logger.warn("an attachment could not be fetched", { status: response.status });
      throw new NotFetched(`Teams answered ${String(response.status)}`);
    }
    const bytes = await readBounded(response, options.maxBytes, dog);
    return { bytes, mediaType: mediaTypeOf(response) };
  } catch (error) {
    if (error instanceof NotFetched) throw error;
    // a stalled download is a timeout, whatever the aborted request rejected with
    const cause = dog.signal.aborted ? reasonOf(dog.signal) : error;
    options.logger.warn("an attachment could not be fetched", {
      errorName: cause instanceof Error ? cause.name : typeof cause,
    });
    throw new NotFetched("the download failed");
  } finally {
    dog.dispose();
  }
}
