// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sandbox-internal credential carrying the owner and run scope it proves.
 * The proof is keyed by the sandbox token, which model-issued processes cannot
 * use to mint credentials for another scope.
 */

import { createHmac } from "node:crypto";
import { constantTimeEquals } from "./constant-time.js";

/** The run segment of a scope that presented no run identity. */
export const ABSENT_RUN_SCOPE = ".norun";

const SEPARATOR = "/";
const ESCAPE = "~";
const UNRESERVED = /[A-Za-z0-9_-]/;

export interface CredentialScope {
  owner: string;
  /** Null is the typed absence, distinct from every run identity string. */
  run: string | null;
}

/**
 * Encode one scope part over its UTF-8 bytes. Injective by construction, and
 * emitting neither the separator nor a `.`.
 */
export function encodeScopePart(part: string): string {
  let out = "";
  for (const byte of Buffer.from(part, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += UNRESERVED.test(ch) ? ch : ESCAPE + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

export function decodeScopePart(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] !== ESCAPE) {
      bytes.push(encoded.charCodeAt(i));
      continue;
    }
    const hex = encoded.slice(i + 1, i + 3);
    if (!/^[0-9A-F]{2}$/.test(hex)) throw new Error(`scope: malformed escape at ${i}`);
    bytes.push(parseInt(hex, 16));
    i += 2;
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * The exact bytes the proof is taken over.
 *
 * The encoding emits neither the separator nor a `.`, so the two parts cannot
 * span it: `("a/b", "c")` and `("a", "b/c")` encode differently and cannot
 * present one proof. The absent run's segment lies outside the encoding's image
 * for the same reason, so no run identity can spell it.
 */
export function scopeBytes(scope: CredentialScope): string {
  const run = scope.run === null ? ABSENT_RUN_SCOPE : encodeScopePart(scope.run);
  return `${encodeScopePart(scope.owner)}${SEPARATOR}${run}`;
}

export function mintScopeCredential(scope: CredentialScope, secret: string): string {
  const bytes = scopeBytes(scope);
  return `${bytes}.${createHmac("sha256", secret).update(bytes).digest("hex")}`;
}

export type ScopeCredentialError = "scope_credential_malformed" | "scope_proof_invalid";

export type ScopeVerification =
  | { ok: true; scope: CredentialScope }
  | { ok: false; error: ScopeCredentialError };

/**
 * Recover the scope a presented credential proves, or refuse.
 *
 * Refuses rather than falling back to the request body: a sandbox that answered
 * an unproven caller would reopen the cross-scope reap this exists to close, and
 * a control plane that downgraded would let whatever answers the endpoint choose
 * the weaker protocol.
 */
export function verifyScopeCredential(presented: string, secret: string): ScopeVerification {
  const split = presented.lastIndexOf(".");
  if (split <= 0 || !secret) return { ok: false, error: "scope_credential_malformed" };
  const bytes = presented.slice(0, split);

  if (!constantTimeEquals(presented.slice(split + 1), createHmac("sha256", secret).update(bytes).digest("hex"))) {
    return { ok: false, error: "scope_proof_invalid" };
  }

  const parts = bytes.split(SEPARATOR);
  if (parts.length !== 2 || !parts[0]) return { ok: false, error: "scope_credential_malformed" };
  try {
    return {
      ok: true,
      scope: {
        owner: decodeScopePart(parts[0]),
        run: parts[1] === ABSENT_RUN_SCOPE ? null : decodeScopePart(parts[1]),
      },
    };
  } catch {
    return { ok: false, error: "scope_credential_malformed" };
  }
}
