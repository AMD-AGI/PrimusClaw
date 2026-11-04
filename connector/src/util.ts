// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Small helpers with no dependencies of their own. */
import { createHash } from "node:crypto";

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", done); clearTimeout(t); resolve(); }
    signal?.addEventListener("abort", done, { once: true });
  });

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Truncate to `max` UTF-8 bytes and say how much was cut. */
export function truncateBytes(text: string, max: number): { text: string; truncated: boolean; bytes: number } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= max) return { text, truncated: false, bytes };
  let cut = Buffer.from(text, "utf8").subarray(0, max).toString("utf8");
  // A multi-byte character cut in half decodes to U+FFFD; drop it.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: `${cut}\n[truncated, ${bytes} bytes in all]`, truncated: true, bytes };
}

/** Exponential backoff with jitter: `base * 2^attempt`, capped, then 50%..100% of that. */
export function backoffMs(attempt: number, minMs: number, maxMs: number, random: () => number = Math.random): number {
  const raw = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 30));
  return Math.round(raw * (0.5 + random() / 2));
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

/** One line per record on stderr; the connector's own log, never an adapter's. */
export const stderrLogger = (quiet = false): Logger => {
  const w = (level: string) => (msg: string, extra?: Record<string, unknown>) => {
    if (quiet && level === "info") return;
    process.stderr.write(`${new Date().toISOString()} ${level} ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`);
  };
  return { info: w("info"), warn: w("warn"), error: w("error") };
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/**
 * A URL that credentials may be sent to: https, or http only to this machine (a
 * local development server). Anything else would put a bearer token or a refresh
 * token on the wire in the clear. Returns the URL without a trailing slash.
 */
export class UrlError extends Error {}

export function secureUrl(raw: string, what: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new UrlError(`${what} is not a valid URL: ${JSON.stringify(raw.slice(0, 80))}`); }
  const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new UrlError(`${what} must be an https:// URL (http:// is accepted only for localhost), got ${u.protocol}//${u.host}`);
  }
  return raw.replace(/\/+$/, "");
}
