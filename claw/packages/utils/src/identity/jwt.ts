// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { verify as cryptoVerify } from "node:crypto";
import { JwtVerificationError } from "./errors.js";
import type { JwksCache } from "./jwks.js";

export type JwtAlgorithm = "RS256" | "ES256";

export interface JwtVerifyOptions {
  /** The `iss` the token must carry. */
  issuer: string;
  /** An `aud` the token must name. */
  audience: string;
  /**
   * The JOSE `typ` the token must declare, for a profile that fixes it (an RFC
   * 9068 access token is `at+jwt`). Compared case-insensitively, with or without
   * the `application/` prefix RFC 7515 section 4.1.9 allows.
   */
  typ?: string;
  /** Defaults to both supported algorithms. Never HMAC, never `none`. */
  algorithms?: readonly JwtAlgorithm[];
  /** Allowed clock difference with the issuer, in seconds. Defaults to 30. */
  clockToleranceSeconds?: number;
}

export interface VerifiedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

const DEFAULT_ALGORITHMS: readonly JwtAlgorithm[] = ["RS256", "ES256"];
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;
const B64URL = /^[A-Za-z0-9_-]*$/;

function decodeSegment(segment: string): Buffer {
  if (!B64URL.test(segment)) throw new JwtVerificationError("malformed");
  return Buffer.from(segment, "base64url");
}

function decodeJsonObject(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeSegment(segment).toString("utf8"));
  } catch (err) {
    if (err instanceof JwtVerificationError) throw err;
    throw new JwtVerificationError("malformed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new JwtVerificationError("malformed");
  }
  return parsed as Record<string, unknown>;
}

function normalizeTyp(typ: string): string {
  const t = typ.toLowerCase();
  return t.startsWith("application/") ? t.slice("application/".length) : t;
}

/**
 * Check a compact JWT against the issuer's keys and the claims a resource server
 * must check. This is local verification: it cannot see a revocation, so a
 * token is good until it expires. Use it for short-lived tokens, and ask the
 * introspection endpoint about anything that must be revocable at once.
 *
 * Throws {@link JwtVerificationError} for a token that is wrong, and lets an
 * {@link IdentityUnavailableError} from the key fetch through: "the keys could
 * not be loaded" is not "the token is forged".
 */
export async function verifyJwt(
  token: string,
  opts: JwtVerifyOptions,
  keys: JwksCache,
  now: () => number,
): Promise<VerifiedJwt> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtVerificationError("malformed");
  const [h, p, sig] = parts as [string, string, string];
  const header = decodeJsonObject(h);
  const signature = decodeSegment(sig);

  const allowed = opts.algorithms ?? DEFAULT_ALGORITHMS;
  const alg = header.alg;
  if (typeof alg !== "string" || !(allowed as readonly string[]).includes(alg)) {
    throw new JwtVerificationError("alg_not_allowed");
  }
  // RFC 7515 section 4.1.11: an extension this code does not implement must
  // make the token invalid, and none is implemented.
  if (header.crit !== undefined) throw new JwtVerificationError("malformed");
  if (opts.typ !== undefined) {
    if (typeof header.typ !== "string" || normalizeTyp(header.typ) !== normalizeTyp(opts.typ)) {
      throw new JwtVerificationError("typ_mismatch");
    }
  }
  if (header.kid !== undefined && typeof header.kid !== "string") throw new JwtVerificationError("malformed");

  const key = await keys.getKey(header.kid as string | undefined);
  // The algorithm comes from the token, so the key's own type has to agree with it:
  // otherwise a token could pick how its signature is read.
  if (key.kind !== (alg === "RS256" ? "rsa" : "ec")) throw new JwtVerificationError("key_mismatch");

  const signed = Buffer.from(`${h}.${p}`, "ascii");
  let ok = false;
  try {
    ok = alg === "RS256"
      ? cryptoVerify("sha256", signed, key.key, signature)
      : cryptoVerify("sha256", signed, { key: key.key, dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    ok = false;
  }
  if (!ok) throw new JwtVerificationError("bad_signature");

  const claims = decodeJsonObject(p);
  if (claims.iss !== opts.issuer) throw new JwtVerificationError("issuer_mismatch");
  const aud = claims.aud;
  const audiences = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud : [];
  if (!audiences.includes(opts.audience)) throw new JwtVerificationError("audience_mismatch");

  const tolerance = opts.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const nowSec = Math.floor(now() / 1000);
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw new JwtVerificationError("missing_claim");
  if (nowSec >= claims.exp + tolerance) throw new JwtVerificationError("expired");
  if (claims.nbf !== undefined) {
    if (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf)) throw new JwtVerificationError("malformed");
    if (nowSec + tolerance < claims.nbf) throw new JwtVerificationError("not_yet_valid");
  }
  return { header, claims };
}
