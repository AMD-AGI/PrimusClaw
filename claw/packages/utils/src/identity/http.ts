// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { IdentityUnavailableError, type UnavailableReason } from "./errors.js";
import type { IdentityOp } from "./types.js";

export interface HttpSettings {
  /** Covers connecting, the response headers and reading the body. */
  timeoutMs: number;
  /** An upstream that streams without end must not be able to grow this process. */
  maxBodyBytes: number;
}

export interface HttpAnswer {
  status: number;
  body: string;
}

/**
 * What a non-2xx status means for a caller that cannot get an answer.
 *
 * 401 and 403 are `client_rejected` only for an endpoint that authenticates the
 * caller; on an unauthenticated document fetch they are just a refusal.
 */
export function classifyStatus(status: number, credentialed: boolean): UnavailableReason {
  if (credentialed && (status === 401 || status === 403)) return "client_rejected";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "http_5xx";
  return "http_4xx";
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: string; cause?: { code?: string; name?: string } } | null;
  if (!e || typeof e !== "object") return false;
  if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  const code = e.cause?.code ?? "";
  return e.cause?.name === "TimeoutError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT";
}

async function readCapped(resp: Response, maxBytes: number): Promise<string | null> {
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One HTTP round trip, with every way it can fail turned into an
 * {@link IdentityUnavailableError}.
 *
 * Redirects are refused rather than followed: this carries client credentials,
 * and a 3xx from an authenticated endpoint is a misconfiguration to report, not a
 * second host to hand them to.
 */
export async function send(
  op: IdentityOp,
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  http: HttpSettings,
): Promise<HttpAnswer> {
  try {
    const resp = await fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(http.timeoutMs),
    });
    const body = await readCapped(resp, http.maxBodyBytes);
    if (body === null) throw new IdentityUnavailableError(op, "bad_response", resp.status);
    return { status: resp.status, body };
  } catch (err) {
    if (err instanceof IdentityUnavailableError) throw err;
    throw new IdentityUnavailableError(op, isTimeout(err) ? "timeout" : "network", undefined, err);
  }
}

/** Parse a JSON object body, or say the upstream sent something it should not have. */
export function parseJsonObject(op: IdentityOp, status: number, body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new IdentityUnavailableError(op, "bad_response", status);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IdentityUnavailableError(op, "bad_response", status);
  }
  return parsed as Record<string, unknown>;
}

/**
 * HTTP Basic credentials as RFC 6749 section 2.3.1 spells them: both halves are
 * form-urlencoded before the colon joins them, so a secret containing `:` or `+`
 * survives.
 */
export function basicAuthHeader(clientId: string, clientSecret: string): string {
  const enc = (v: string): string => new URLSearchParams({ v }).toString().slice(2);
  return `Basic ${Buffer.from(`${enc(clientId)}:${enc(clientSecret)}`, "utf8").toString("base64")}`;
}

/**
 * A fixed-size stand-in for a credential, for use as a cache key and nowhere
 * else. A credential is never a map key, so it cannot turn up in a heap dump
 * summary or a debug print of the map.
 */
export function digest(...parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    // Length-prefixed so ("ab","c") and ("a","bc") are different keys.
    h.update(String(Buffer.byteLength(p)));
    h.update(":");
    h.update(p);
  }
  return h.digest("hex");
}
