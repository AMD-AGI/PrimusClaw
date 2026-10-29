// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One bounded GET of a JSON document from a service this API fronts for the
 * caller (SaFE, the LLM gateway), with the ways it can go wrong sorted into the
 * four a route has to answer differently.
 *
 * The sorting is the point. A route that lets `fetch`'s exception escape answers
 * 500 for "the service is down", which tells a dashboard the API is broken when
 * it is the dependency; and one that treats every non-2xx alike sends a user
 * whose session merely lapsed to an error page instead of the login.
 *
 *   unreachable  no answer: DNS, TLS, reset, or the timeout below. 503.
 *   rejected     the service refused the credential (401/403). The route decides
 *                what that means: for the caller's own SaFE session it is a 401,
 *                for a key the API chose for the caller it is the API's problem.
 *   http         any other non-2xx. 502.
 *   bad_body     a 2xx whose body is not the JSON object/array the route expects.
 *                502: the service answered, with something this API cannot use.
 *
 * Nothing here logs or returns the request headers, and the failure carries a
 * status number and an error class, never an upstream body: a body from a
 * service that was just sent a credential is exactly where one gets echoed back.
 */

export type UpstreamFailure =
  | { kind: "unreachable"; detail: string }
  | { kind: "rejected"; status: number }
  | { kind: "http"; status: number }
  | { kind: "bad_body" };

export class UpstreamError extends Error {
  constructor(readonly failure: UpstreamFailure) {
    super(`upstream ${failure.kind}`);
    this.name = "UpstreamError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Long enough for a loaded gateway, short enough that a hung one does not hold a request open. */
export const UPSTREAM_TIMEOUT_MS = 10_000;
/**
 * A list endpoint answering with more than this is not the document this API asked
 * for. Enforced while the body is read, not after: a limit checked on a string
 * that has already been buffered bounds nothing.
 */
export const UPSTREAM_MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The class of a fetch failure, without its message: a message can carry the URL. */
export function describeFetchFailure(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
    const code = (err as Error & { cause?: { code?: unknown } }).cause?.code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  }
  return "network_error";
}

/**
 * The body as text, or null when it is larger than `maxBytes`. A declared length
 * over the limit is refused without reading anything; otherwise chunks are
 * counted as they arrive and the stream is cancelled the moment the total passes
 * the limit, so what is held in memory never exceeds the limit plus one chunk
 * however much the upstream tries to send. Read failures (timeout, reset) throw.
 */
async function readBounded(resp: Response, maxBytes: number): Promise<string | null> {
  const declared = Number(resp.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await resp.body?.cancel().catch(() => {});
    return null;
  }
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function getUpstreamJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number = UPSTREAM_TIMEOUT_MS,
): Promise<unknown> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new UpstreamError({ kind: "unreachable", detail: describeFetchFailure(err) });
  }
  if (resp.status === 401 || resp.status === 403) {
    await resp.body?.cancel().catch(() => {});
    throw new UpstreamError({ kind: "rejected", status: resp.status });
  }
  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    throw new UpstreamError({ kind: "http", status: resp.status });
  }
  let text: string | null;
  try {
    text = await readBounded(resp, UPSTREAM_MAX_BODY_BYTES);
  } catch (err) {
    // The body stalled or the connection dropped mid-stream: still "no usable answer".
    throw new UpstreamError({ kind: "unreachable", detail: describeFetchFailure(err) });
  }
  if (text === null) throw new UpstreamError({ kind: "bad_body" });
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return parsed;
  } catch {
    throw new UpstreamError({ kind: "bad_body" });
  }
}
