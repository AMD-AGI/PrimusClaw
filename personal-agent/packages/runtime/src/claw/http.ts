// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import {
  ClawAnswerInvalid,
  ClawError,
  ClawUnreachable,
  CredentialMisuse,
  ReplayRefused,
  isApiKey,
  notAClawId,
  type ClawCredential,
} from "@primusclaw/personal-agent";

/** What every call waits for at most, unless it says otherwise (the Python worker's client timeout). */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** How much of an error answer is kept (`ClawError.detail`). */
const DETAIL_MAX = 200;

/** The `fetch` this client uses; a test passes a fake. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One request to Claw. */
export interface ClawRequest {
  readonly method: string;
  /** Path and query, starting with `/`; every id in it already passed `segment` or `pyQuote`. */
  readonly path: string;
  readonly key: ClawCredential;
  readonly body?: unknown;
  /** A multipart body instead of JSON (`fetch` writes its content type). */
  readonly form?: FormData;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

/** An id Claw handed out, as it goes into a request path: URI-unreserved characters only, one segment exactly as written. */
const SEGMENT = /^[A-Za-z0-9._~-]{1,200}$/;

/**
 * `value` for one segment of a Claw request path. Ids reach this client from stored rows and from card actions a person
 * can edit, so anything that could change which endpoint or host a request reaches is refused before a request is made,
 * as ClawError(404): the answer Claw gives for an id that is not the caller's.
 */
export function segment(value: string | number): string {
  const text = String(value);
  if (!SEGMENT.test(text) || text === "." || text === "..") throw notAClawId();
  return text;
}

/** Python's `urllib.parse.quote(value, safe="")`: everything but letters, digits and `_.-~` percent-encoded (UTF-8). */
export function pyQuote(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The bearer header of a credential. */
export function auth(key: ClawCredential): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

/** Refuses a call that must carry an exchanged identity token when `key` is an API key, before anything goes out. */
export function requireToken(key: ClawCredential, what: string): void {
  if (isApiKey(key)) throw new CredentialMisuse(`${what} is made with the exchanged token, never with an API key`);
}

/**
 * The header that carries a person's own linked key next to an identity token, or none. It never rides next to an `ak-`
 * credential, which would make it a second key of the same person on a request Claw refuses for a key.
 */
export function modelKeyHeader(key: ClawCredential, modelKey: string | undefined): Record<string, string> {
  if (modelKey === undefined || modelKey === "") return {};
  if (isApiKey(key))
    throw new CredentialMisuse("a model key goes next to the exchanged token, never next to an API key");
  return { "x-api-key": modelKey };
}

/** The low-level HTTP of the Claw client: one place that sends, times out, and turns failures into core's errors. */
export class ClawHttp {
  readonly baseUrl: string;
  private readonly fetch: Fetch;

  constructor(baseUrl: string, fetchImpl: Fetch) {
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
  }

  /** Sends the request; the response whatever its status. Network failures and timeouts are ClawUnreachable. */
  async send(request: ClawRequest, extra: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = { ...auth(request.key), ...request.headers };
    let body: BodyInit | undefined = request.form;
    if (request.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(request.body);
    }
    const signal = extra.signal ?? AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      return await this.fetch(this.baseUrl + request.path, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...extra,
        signal,
      });
    } catch (err) {
      throw unreachable(err, request.path);
    }
  }

  /** A call whose answer is JSON; an error status is ClawError, a body that is not JSON ClawAnswerInvalid. */
  async json(request: ClawRequest): Promise<unknown> {
    const response = await this.send(request);
    const text = await readText(response, request.path);
    if (response.status >= 400) throw new ClawError(response.status, head(text));
    return parseJson(text);
  }

  /**
   * A GET whose reply is refused (ReplayRefused) once it is larger than `maxBytes`, before it is decoded: it is read in
   * pieces and never held whole beyond that. Asked for and read as it is on the wire (`Accept-Encoding: identity`); a
   * reply that comes content-encoded all the same is refused unread. An error reply is only quoted (512 bytes).
   */
  async boundedJson(request: ClawRequest, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
    const response = await this.send(
      { ...request, headers: { ...request.headers, "Accept-Encoding": "identity" } },
      signal === undefined ? {} : { signal },
    );
    const encoding = (response.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
    if (encoding !== "" && encoding !== "identity") {
      await response.body?.cancel();
      throw new ReplayRefused("the reply is content-encoded");
    }
    const failed = response.status >= 400;
    const bytes = await readBounded(response, failed ? 512 : maxBytes, !failed, request.path);
    const text = new TextDecoder().decode(bytes);
    if (failed) throw new ClawError(response.status, head(text));
    return parseJson(text);
  }
}

/** The first 200 characters of an error answer. */
export function head(text: string): string {
  return Array.from(text).slice(0, DETAIL_MAX).join("");
}

/** The body as text; a connection that breaks while it is read is ClawUnreachable. */
export async function readText(response: Response, what: string): Promise<string> {
  try {
    return await response.text();
  } catch (err) {
    throw unreachable(err, what);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ClawAnswerInvalid("an answer that is not JSON");
  }
}

/**
 * The body, read in pieces up to `limit` bytes: past it, `refuse` (a success) throws ReplayRefused; otherwise (an error
 * reply, only quoted) what was read is cut there.
 */
async function readBounded(response: Response, limit: number, refuse: boolean, what: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  try {
    for (;;) {
      if (reader === undefined) break;
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        if (refuse) throw new ReplayRefused(`the reply is larger than ${String(limit)} bytes`);
        break;
      }
    }
  } catch (err) {
    if (err instanceof ReplayRefused) throw err;
    throw unreachable(err, what);
  }
  return concat(chunks).subarray(0, limit);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** A failure to reach Claw, as core's error: a timeout or an abort is "timeout", anything else "network". */
export function unreachable(err: unknown, what: string): ClawUnreachable {
  const name = err instanceof Error ? err.name : "";
  const kind = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
  return new ClawUnreachable(kind, what.split("?")[0] ?? what);
}
