// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { webcrypto } from "node:crypto";
import {
  AUTH_INTERNAL_TOKEN,
  BYOK_VERIFY_API_STYLE,
  BYOK_VERIFY_MODELS_URL,
  MEMORY_LLM_BASE_URL,
  OPENAI_BASE_URL,
  type LlmApiStyle,
} from "../config.js";
import { AuthServiceMisconfiguredError } from "./safe-client.js";

const POSITIVE_TTL_MS = 10 * 60_000;
const NEGATIVE_TTL_MS = 30_000;
const VERIFY_TIMEOUT_MS = 5_000;
const MAX_CACHE = 1000;
const RATE_WINDOW_MS = 60_000;
const MAX_FRESH_VERIFICATIONS_PER_CLIENT = 120;

interface CacheEntry {
  userId: string | null;
  error: "invalid" | null;
  expiresAt: number;
}

const byokCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

export class ByokInvalidKeyError extends Error {
  constructor(message = "invalid BYOK API key") {
    super(message);
    this.name = "ByokInvalidKeyError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ByokUpstreamUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ByokUpstreamUnavailableError";
    Object.setPrototypeOf(this, new.target.prototype);
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class ByokRateLimitError extends Error {
  constructor(message = "too many BYOK verification attempts") {
    super(message);
    this.name = "ByokRateLimitError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function requireByokSecret(): string {
  if (!AUTH_INTERNAL_TOKEN) {
    throw new AuthServiceMisconfiguredError("AUTH_INTERNAL_TOKEN is not set; API cannot verify BYOK API keys");
  }
  return AUTH_INTERNAL_TOKEN;
}

function toHex(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("hex");
}

async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await webcrypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await webcrypto.subtle.sign("HMAC", key, enc.encode(value)));
}

async function fingerprintKey(apiKey: string): Promise<string> {
  const secret = requireByokSecret();
  // Not password storage/verification: this is a keyed cache fingerprint for BYOK auth.
  return await hmacSha256Hex(secret, apiKey);
}

/** Derive a stable, non-reversible BYOK user id without logging or storing the raw key. */
export async function deriveByokUserId(apiKey: string): Promise<string> {
  const secret = requireByokSecret();
  // Not password storage/verification: this is a keyed tenant fingerprint for BYOK isolation.
  return "byok-" + (await hmacSha256Hex(secret, apiKey)).slice(0, 16);
}

function remember(keyFingerprint: string, entry: Omit<CacheEntry, "expiresAt">, ttlMs: number): void {
  if (byokCache.size >= MAX_CACHE) {
    const oldest = byokCache.keys().next().value;
    if (oldest) byokCache.delete(oldest);
  }
  byokCache.set(keyFingerprint, { ...entry, expiresAt: Date.now() + ttlMs });
}

function checkRateLimit(clientId: string | undefined): void {
  const subject = clientId?.trim() || "unknown";
  const now = Date.now();
  const bucket = rateBuckets.get(subject);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(subject, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  bucket.count++;
  if (bucket.count > MAX_FRESH_VERIFICATIONS_PER_CLIENT) {
    throw new ByokRateLimitError();
  }
}

interface ByokVerifyTarget {
  url: string;
  apiStyle: LlmApiStyle;
}

/** Normalize an LLM base URL to its models endpoint. */
function toModelsUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (base.endsWith("/models")) return base;
  if (base.endsWith("/v1")) return `${base}/models`;
  return `${base}/v1/models`;
}

/** Parse the optional explicit verification protocol and reject typos. */
function configuredVerifyApiStyle(): LlmApiStyle | undefined {
  const value = BYOK_VERIFY_API_STYLE.trim();
  if (!value) return undefined;
  if (value === "anthropic" || value === "openai") return value;
  throw new AuthServiceMisconfiguredError(
    "BYOK_VERIFY_API_STYLE must be either \"anthropic\" or \"openai\"",
  );
}

/** Require an explicit protocol when the endpoint source is ambiguous. */
function requireVerifyApiStyle(apiStyle: LlmApiStyle | undefined): LlmApiStyle {
  if (apiStyle) return apiStyle;
  throw new AuthServiceMisconfiguredError(
    "BYOK_VERIFY_API_STYLE is required when BYOK verification does not use OPENAI_BASE_URL; " +
      "set it to \"openai\" for LiteLLM/OpenAI-compatible gateways or \"anthropic\" for native Anthropic",
  );
}

/** Resolve the verification URL and protocol together to keep auth headers aligned. */
function resolveByokVerifyTarget(): ByokVerifyTarget {
  const configuredStyle = configuredVerifyApiStyle();
  const explicitUrl = BYOK_VERIFY_MODELS_URL.trim();
  if (explicitUrl) {
    // Existing Secrets predate BYOK_VERIFY_API_STYLE. Preserve their gateway
    // behavior only when raw OPENAI_BASE_URL makes the protocol unambiguous.
    // Anthropic/Memory URLs may point to either native Anthropic or LiteLLM,
    // so fail closed instead of rejecting a valid key with the wrong header.
    const inferredStyle = OPENAI_BASE_URL.trim() ? "openai" : undefined;
    return {
      url: explicitUrl,
      apiStyle: requireVerifyApiStyle(configuredStyle ?? inferredStyle),
    };
  }

  if (OPENAI_BASE_URL.trim()) {
    return {
      url: toModelsUrl(OPENAI_BASE_URL),
      apiStyle: configuredStyle ?? "openai",
    };
  }

  if (MEMORY_LLM_BASE_URL.trim()) {
    return {
      url: toModelsUrl(MEMORY_LLM_BASE_URL),
      apiStyle: requireVerifyApiStyle(configuredStyle),
    };
  }

  throw new AuthServiceMisconfiguredError(
    "OPENAI_BASE_URL, MEMORY_LLM_BASE_URL, or BYOK_VERIFY_MODELS_URL is required for BYOK verification",
  );
}

function isNetworkLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return true;
  const msg = err.message.toLowerCase();
  return /fetch failed|econnrefused|econnreset|etimedout|enotfound|eai_again|socket hang up|network|getaddrinfo|cert|tls|aborted|timed?\s?out/.test(msg);
}

/** Build the upstream auth headers for the resolved verification protocol. */
function verifyHeaders(apiKey: string, apiStyle: LlmApiStyle): Record<string, string> {
  if (apiStyle === "anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

async function verifyByokKeyFresh(apiKey: string, keyFingerprint: string): Promise<string> {
  const target = resolveByokVerifyTarget();
  let resp: Response;
  try {
    resp = await fetch(target.url, {
      headers: verifyHeaders(apiKey, target.apiStyle),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (err) {
    if (isNetworkLikeError(err)) {
      throw new ByokUpstreamUnavailableError("LLM gateway unreachable while verifying BYOK API key", err);
    }
    throw err;
  }

  if (resp.status === 401 || resp.status === 403) {
    remember(keyFingerprint, { userId: null, error: "invalid" }, NEGATIVE_TTL_MS);
    throw new ByokInvalidKeyError();
  }
  if (!resp.ok) {
    throw new ByokUpstreamUnavailableError(`LLM gateway rejected BYOK verification with HTTP ${resp.status}`);
  }

  const userId = await deriveByokUserId(apiKey);
  remember(keyFingerprint, { userId, error: null }, POSITIVE_TTL_MS);
  return userId;
}

/** Verify the BYOK key against the LLM gateway and return its stable user id. */
export async function verifyByokKey(apiKey: string, clientId?: string): Promise<string> {
  const keyFingerprint = await fingerprintKey(apiKey);
  const cached = byokCache.get(keyFingerprint);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.error === "invalid") throw new ByokInvalidKeyError();
    if (cached.userId) return cached.userId;
  } else if (cached) {
    byokCache.delete(keyFingerprint);
  }

  const pending = inflight.get(keyFingerprint);
  if (pending) return pending;

  checkRateLimit(clientId);
  const p = verifyByokKeyFresh(apiKey, keyFingerprint).finally(() => inflight.delete(keyFingerprint));
  inflight.set(keyFingerprint, p);
  return p;
}
