// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { sleep } from "@claw/utils";
import pino from "pino";
import {
  FETCH_HEADERS_TIMEOUT_MS,
  FETCH_BODY_IDLE_TIMEOUT_MS,
  FETCH_TOTAL_TIMEOUT_MS,
} from "../config.js";

const logger = pino({ name: "retry" });

/**
 * Run fetch with three-layer timeout guarding:
 *   - headers:  connect + send + first byte of headers must land within
 *               FETCH_HEADERS_TIMEOUT_MS (default 600s, aligned with LiteLLM
 *               gateway's read=600s budget).
 *   - body idle: once headers arrive, each streamed body chunk resets an idle
 *               timer. If no new chunk for FETCH_BODY_IDLE_TIMEOUT_MS (default
 *               600s) we abort. This tolerates slow but progressing upstreams
 *               (LiteLLM proxying Vertex for Opus w/ thinking can stream for
 *               10+ minutes but always sends SSE keep-alives or partial deltas).
 *   - total:    hard ceiling FETCH_TOTAL_TIMEOUT_MS (default 600s) guards
 *               against pathological slow-loris / infinite streams.
 *
 * Historical: the old impl used a single 180s hard timeout for headers+body
 * which tripped repeatedly on large-tool-count Opus requests (40 tools, long
 * message history). Per-chunk idle progress is the right abstraction.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const onCallerAbort = () => ctrl.abort((init.signal as any)?.reason);
  if (init.signal) {
    if (init.signal.aborted) ctrl.abort((init.signal as any).reason);
    else init.signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const headersTimer = setTimeout(
    () => ctrl.abort(new Error(`fetch headers timeout ${FETCH_HEADERS_TIMEOUT_MS}ms`)),
    FETCH_HEADERS_TIMEOUT_MS,
  );
  const totalTimer = setTimeout(
    () => ctrl.abort(new Error(`fetch total timeout ${FETCH_TOTAL_TIMEOUT_MS}ms`)),
    FETCH_TOTAL_TIMEOUT_MS,
  );

  let resp: Response;
  try {
    resp = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(headersTimer);
    clearTimeout(totalTimer);
    if (init.signal) init.signal.removeEventListener?.("abort", onCallerAbort);
    throw e;
  }
  clearTimeout(headersTimer);

  // Stream body with per-chunk idle timeout. Fall back to resp.text() if the
  // body stream is unavailable (e.g. no-content responses).
  let bodyText = "";
  const reader = resp.body?.getReader();
  if (!reader) {
    clearTimeout(totalTimer);
    if (init.signal) init.signal.removeEventListener?.("abort", onCallerAbort);
    bodyText = await resp.text();
    return new Response(bodyText, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }

  const decoder = new TextDecoder();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => ctrl.abort(new Error(`fetch body idle timeout ${FETCH_BODY_IDLE_TIMEOUT_MS}ms (no chunk)`)),
      FETCH_BODY_IDLE_TIMEOUT_MS,
    );
  };
  try {
    resetIdle();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) bodyText += decoder.decode(value, { stream: true });
      resetIdle();
    }
    bodyText += decoder.decode();
    return new Response(bodyText, {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (init.signal) init.signal.removeEventListener?.("abort", onCallerAbort);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/**
 * Fetch with exponential backoff retry for 5xx and 429 errors.
 * 4xx (except 429) are not retried. Network hangs and body stalls trip the
 * timeout guard in fetchWithTimeout and retry like a 5xx.
 *
 * Every retry path emits a structured warn log so operators can see whether
 * a long-running request is silently retrying or actually making progress.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 0; i <= maxRetries; i++) {
    const attempt = i + 1;
    try {
      const resp = await fetchWithTimeout(url, init);

      if (resp.ok) return resp;

      // 4xx (except 429): don't retry
      if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) return resp;

      // 429: respect retry-after header
      if (resp.status === 429) {
        const retryAfter = parseRetryAfter(resp.headers.get("retry-after"));
        logger.warn({ url, attempt, maxRetries: maxRetries + 1, status: 429, retryAfter }, "retry.rate_limited");
        await sleep(retryAfter * 1000);
        continue;
      }

      // 5xx: exponential backoff
      if (i < maxRetries) {
        const delay = baseDelay * Math.pow(2, i);
        logger.warn({ url, attempt, maxRetries: maxRetries + 1, status: resp.status, delayMs: delay }, "retry.server_error");
        await sleep(delay);
      } else {
        logger.error({ url, attempt, maxRetries: maxRetries + 1, status: resp.status }, "retry.exhausted_server_error");
      }
    } catch (err) {
      lastErr = err;
      // If the caller aborted, surface immediately — not our problem to retry.
      if (init.signal?.aborted) throw err;
      const errMsg = String((err as Error)?.message || err);
      if (i < maxRetries) {
        const delay = baseDelay * Math.pow(2, i);
        logger.warn({ url, attempt, maxRetries: maxRetries + 1, err: errMsg, delayMs: delay }, "retry.fetch_failed");
        await sleep(delay);
      } else {
        logger.error({ url, attempt, maxRetries: maxRetries + 1, err: errMsg }, "retry.exhausted_fetch_failed");
      }
    }
  }
  throw new Error(`LLM API failed after ${maxRetries} retries${lastErr ? `: ${(lastErr as Error).message}` : ""}`);
}

/**
 * Parse `Retry-After` header. RFC 7231 allows two formats: integer seconds
 * (e.g. "120") or HTTP-date (e.g. "Wed, 21 Oct 2026 07:28:00 GMT"). Old code
 * did parseInt() blindly, which returned NaN for HTTP-date → sleep(NaN) →
 * tight retry loop / 429 storm. Cap at 5 min to bound a misbehaving upstream.
 */
function parseRetryAfter(raw: string | null): number {
  if (!raw) return 5;
  const trimmed = raw.trim();
  // Integer seconds form
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, 300) : 5;
  }
  // HTTP-date form
  const ts = Date.parse(trimmed);
  if (!Number.isFinite(ts)) return 5;
  const deltaSec = Math.ceil((ts - Date.now()) / 1000);
  return deltaSec > 0 ? Math.min(deltaSec, 300) : 5;
}

/** Determine if an error is retryable (Brain should nak and re-queue). */
export function isRetryable(err: unknown): boolean {
  const e = err as { name?: string; status?: number; message?: string; cause?: { message?: string; code?: string } };
  const msg = String(e?.message || err).toLowerCase();
  const causeMsg = String(e?.cause?.message || "").toLowerCase();
  const causeCode = String(e?.cause?.code || "").toLowerCase();
  // Anthropic SDK error classes (top-level message often "Connection error."
  // — the actual fetch/DNS detail lives in `.cause`). Without these checks
  // transient gateway hiccups burn the task instead of getting redelivered.
  if (e?.name === "APIConnectionError" || e?.name === "APIConnectionTimeoutError") return true;
  if (typeof e?.status === "number" && [408, 409, 429, 500, 502, 503, 504].includes(e.status)) return true;
  // Legacy / undici / NATS string matches.
  if (msg.includes("503") || msg.includes("502") || msg.includes("429")) return true;
  if (msg.includes("econnrefused") || msg.includes("econnreset") || msg.includes("etimedout")) return true;
  if (msg.includes("fetch failed") || msg.includes("connection error")) return true;
  if (msg.includes("getaddrinfo") || msg.includes("enotfound")) return true;
  if (causeMsg.includes("fetch failed") || causeMsg.includes("getaddrinfo") || causeMsg.includes("enotfound")) return true;
  if (causeCode === "enotfound" || causeCode === "econnreset" || causeCode === "econnrefused") return true;
  if (msg.includes("nats")) return true;
  return false;
}
