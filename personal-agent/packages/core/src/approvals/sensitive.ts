// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which values of a tool call must never be shown (teams_agent/approval_view.py): an argument whose NAME reads as a credential is
 * replaced whole, every string is masked by shape, and a value typed under a credential name is scrubbed wherever else it repeats.
 *
 * Mirrors the key-name rule Claw redacts events with (claw/packages/utils security/sensitive-keys.ts): by word, never by
 * substring, so `accessToken` and `api_key` are credentials while `tokenizer` and a bare `key` are not.
 */

import { MASK, redactText } from "../security/redact.js";

const WORDS = new Set([
  "token", "secret", "secrets", "password", "passwords", "passwd", "passphrase", "passphrases", "authorization", "auth", "auths",
  "authentication", "authenticate", "authorisation", "credential", "credentials", "cookie", "cookies", "apikey", "apikeys",
  "accesskey", "secretkey", "privatekey", "platformkey", "virtualkey", "pgpassword", "pgpass", "pat", "pats", "dsn",
  "connectionstring",
  // A bare `pwd` too: as the name of a tool argument it is a password far more often than a path.
  "pwd",
]);
const PAIRS = new Set([
  "api key", "access key", "secret key", "private key", "platform key", "virtual key", "signing key", "encryption key", "ssh key",
  "database url", "db url", "database uri", "db uri", "connection string",
]);
const TOKEN_PAIRS = new Set([
  "api token", "access token", "auth token", "authorization token", "bearer token", "refresh token", "session token",
  "service token", "secret token", "private token", "id token", "identity token",
]);
const COUNTERS = new Set(["token usage", "token count", "token limit", "token len"]);
const MIN_SECRET = 4;
const MAX_DEPTH = 6;
const MAX_CHILDREN = 100;

function words(name: string): string[] {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function singular(word: string): string {
  if (word === "keys") return "key";
  if (word === "tokens") return "token";
  return word;
}

/** Whether a value stored under this argument name must not be shown. */
export function isSensitiveName(name: unknown): boolean {
  const parts = words(String(name));
  if (parts.length === 0 || COUNTERS.has(parts.join(" "))) return false;
  return parts.some((word, i) => {
    if (WORDS.has(word)) return true;
    const next = parts[i + 1];
    if (next === undefined) return false;
    const pair = `${word} ${next}`;
    const one = `${word} ${singular(next)}`;
    return PAIRS.has(pair) || PAIRS.has(one) || TOKEN_PAIRS.has(one);
  });
}

/** Every string (or number) under a credential-named argument, at any depth: the values no text about the call may repeat. */
export function credentialValues(value: unknown, underSecret = false, depth = 0): string[] {
  if (depth > MAX_DEPTH || value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value);
    return underSecret && Array.from(text).length >= MIN_SECRET ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_CHILDREN).flatMap((child) => credentialValues(child, underSecret, depth + 1));
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_CHILDREN)
      .flatMap(([key, child]) => credentialValues(child, underSecret || isSensitiveName(key), depth + 1));
  }
  return [];
}

/** `text` with every occurrence of each secret replaced; longest first, so one inside another goes whole. */
export function scrub(text: string, secrets: readonly string[]): string {
  const ordered = [...new Set(secrets)].sort((a, b) => Array.from(b).length - Array.from(a).length);
  return ordered.reduce((out, secret) => out.split(secret).join(MASK), text);
}

/**
 * A copy of a JSON value with credential-named fields replaced whole and strings masked by shape; `secrets` (the values typed
 * under credential-named arguments) are replaced wherever else they repeat.
 */
export function maskValue(value: unknown, secrets: readonly string[] = [], depth = 0): unknown {
  if (typeof value === "string") return scrub(redactText(value).text, secrets);
  if (Array.isArray(value)) return depth >= MAX_DEPTH ? "…" : value.map((v) => maskValue(v, secrets, depth + 1));
  if (value !== null && typeof value === "object") {
    if (depth >= MAX_DEPTH) return "…";
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        isSensitiveName(k) ? MASK : maskValue(v, secrets, depth + 1),
      ]),
    );
  }
  return value;
}
