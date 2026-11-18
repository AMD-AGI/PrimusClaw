// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Bot Framework token parsing and verification with PyJWT's rules (PyJWT 2.15, what the Python Function it replaces
 * resolved), so a token is refused for the same reason as there: the same segment checks, header checks, the RS256-only algorithm
 * list, the required claims and the claim checks in PyJWT's order, with no leeway. The signature itself is checked by
 * jose (RSASSA-PKCS1-v1_5 with SHA-256 over the token's own signing input).
 *
 * Errors carry the PyJWT exception they stand for, because the security event log reports a category per failure.
 */
import { flattenedVerify, errors as joseErrors } from "jose";

import { get, int, isObject, type JsonObject, truthy } from "./py.js";

/** The PyJWT exception a failure corresponds to. */
export type JwtErrorKind =
  | "DecodeError" // malformed: not a JWT, bad base64, bad JSON, a claim that is not an integer
  | "InvalidTokenError" // malformed: bad kid or crit header, a non-string sub or jti
  | "InvalidAlgorithmError" // malformed: an algorithm other than RS256
  | "MissingRequiredClaimError" // malformed
  | "InvalidIssuedAtError" // malformed
  | "ExpiredSignatureError"
  | "ImmatureSignatureError"
  | "InvalidAudienceError"
  | "InvalidSignatureError";

export class JwtError extends Error {
  constructor(
    readonly kind: JwtErrorKind,
    message: string,
  ) {
    super(message);
    this.name = kind;
  }
}

const decodeError = (message: string): JwtError => new JwtError("DecodeError", message);

const B64URL = /^[A-Za-z0-9_-]*$/;

/** PyJWS._decode_base64url_segment: unpadded or correctly padded base64url, canonical, nothing else. */
function segment(raw: string, name: string): Buffer {
  let stripped = raw;
  let padding = 0;
  while (stripped.endsWith("=")) {
    stripped = stripped.slice(0, -1);
    padding += 1;
    if (padding > 2) throw decodeError(`Invalid ${name} padding`);
  }
  if (padding && raw.length % 4 !== 0) throw decodeError(`Invalid ${name} padding`);
  if (stripped.length % 4 === 1 || !B64URL.test(stripped)) throw decodeError(`Invalid ${name} padding`);
  const decoded = Buffer.from(stripped, "base64url");
  if (decoded.toString("base64url") !== stripped) throw decodeError(`Invalid ${name} padding`);
  return decoded;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BOM = String.fromCharCode(0xfeff);

/**
 * `json.loads(data)` for bytes: UTF-8 (a leading BOM is dropped, as Python's encoding detection does for bytes), then
 * JSON. Python also reads NaN and Infinity; a token carrying those is refused here instead (no real token does).
 */
export function jsonFromBytes(data: Uint8Array): unknown {
  let text = UTF8.decode(data);
  if (text.startsWith(BOM)) text = text.slice(1);
  return JSON.parse(text);
}

export interface ParsedJwt {
  header: JsonObject;
  /** The three segments as they arrived, for the signature check. */
  segments: { protected: string; payload: string; signature: string };
  payload: Buffer;
}

/** PyJWS._validate_headers: `kid` a string, `crit` a non-empty list naming only `b64`, which must be present. */
function validateHeaders(header: JsonObject): void {
  if (Object.hasOwn(header, "kid") && typeof header["kid"] !== "string") {
    throw new JwtError("InvalidTokenError", "Key ID header parameter must be a string");
  }
  if (!Object.hasOwn(header, "crit")) return;
  const crit = header["crit"];
  if (!Array.isArray(crit) || crit.length === 0) {
    throw new JwtError("InvalidTokenError", "Invalid 'crit' header: must be a non-empty list");
  }
  for (const ext of crit) {
    if (typeof ext !== "string")
      throw new JwtError("InvalidTokenError", "Invalid 'crit' header: values must be strings");
    if (ext !== "b64") throw new JwtError("InvalidTokenError", `Unsupported critical extension: ${ext}`);
    if (!Object.hasOwn(header, ext)) {
      throw new JwtError("InvalidTokenError", `Critical extension '${ext}' is missing from headers`);
    }
  }
}

/** The header, as PyJWS._load reads it: a JSON object. */
function headerOf(segmentText: string): JsonObject {
  const headerData = segment(segmentText, "header");
  let header: unknown;
  try {
    header = jsonFromBytes(headerData);
  } catch (error) {
    throw decodeError(`Invalid header string: ${(error as Error).message}`);
  }
  if (!isObject(header)) throw decodeError("Invalid header string: must be a json object");
  return header;
}

/** PyJWS._load plus _validate_headers and the "b64" checks of decode_complete. */
export function parse(token: string): ParsedJwt {
  const lastDot = token.lastIndexOf(".");
  const firstDot = token.indexOf(".");
  if (lastDot < 0 || firstDot === lastDot) throw decodeError("Not enough segments");
  const headerSegment = token.slice(0, firstDot);
  const payloadSegment = token.slice(firstDot + 1, lastDot);
  const cryptoSegment = token.slice(lastDot + 1);
  const header = headerOf(headerSegment);
  const detached = get(header, "b64") === false;
  if (detached && payloadSegment) throw decodeError("Payload segment must be empty when 'b64' is false.");
  const payload = detached ? Buffer.alloc(0) : segment(payloadSegment, "payload");
  segment(cryptoSegment, "crypto");
  validateHeaders(header);
  if (detached) {
    const crit = truthy(get(header, "crit")) ? get(header, "crit") : [];
    if (!Array.isArray(crit) || !crit.includes("b64")) {
      throw new JwtError("InvalidTokenError", "The 'b64' header parameter requires 'b64' to be listed in 'crit'.");
    }
    throw decodeError("a token with b64=false needs a detached payload");
  }
  return { header, segments: { protected: headerSegment, payload: payloadSegment, signature: cryptoSegment }, payload };
}

/** PyJWT._decode_payload. */
export function decodePayload(parsed: ParsedJwt): JsonObject {
  let payload: unknown;
  try {
    payload = jsonFromBytes(parsed.payload);
  } catch (error) {
    throw decodeError(`Invalid payload string: ${(error as Error).message}`);
  }
  if (!isObject(payload)) throw decodeError("Invalid payload string: must be a json object");
  return payload;
}

/** What `get_signing_key_from_jwt` reads before it looks a key up: the whole token parsed, and the `kid`. */
export function unverifiedKid(token: string): string | undefined {
  const parsed = parse(token);
  decodePayload(parsed);
  const kid = get(parsed.header, "kid");
  return typeof kid === "string" ? kid : undefined;
}

/** A verification key: an RSA public key as a JWK (`kty`, `n`, `e`), or a key of another type, which RS256 refuses. */
export type VerificationKey = { kty: "RSA"; n: string; e: string } | { kty: "other" };

export const ALGORITHMS: readonly string[] = ["RS256"];
const REQUIRED = ["exp", "iss", "aud"];

/**
 * `jwt.decode(token, key, algorithms=["RS256"], audience=appId, options={"require": ["exp", "iss", "aud"],
 * "verify_iss": False})`. `now` is in seconds.
 */
export async function decode(token: string, key: VerificationKey, appId: string, now: number): Promise<JsonObject> {
  const parsed = parse(token);
  const alg = get(parsed.header, "alg");
  if (alg === undefined) throw new JwtError("InvalidAlgorithmError", "Algorithm not specified");
  if (!truthy(alg) || typeof alg !== "string" || !ALGORITHMS.includes(alg)) {
    throw new JwtError("InvalidAlgorithmError", "The specified alg value is not allowed");
  }
  if (key.kty !== "RSA") throw new Error("Expecting a PEM-formatted key.");
  try {
    await flattenedVerify(parsed.segments, { kty: "RSA", n: key.n, e: key.e }, { algorithms: [...ALGORITHMS] });
  } catch (error) {
    if (error instanceof joseErrors.JWSSignatureVerificationFailed) {
      throw new JwtError("InvalidSignatureError", "Signature verification failed");
    }
    if (error instanceof joseErrors.JWSInvalid || error instanceof joseErrors.JOSEAlgNotAllowed) {
      throw decodeError(error.message);
    }
    throw error;
  }
  const payload = decodePayload(parsed);
  validateClaims(payload, appId, now);
  return payload;
}

function claimInt(value: unknown, kind: JwtErrorKind, message: string): number {
  try {
    return int(value);
  } catch {
    throw new JwtError(kind, message);
  }
}

/** The `iat`, `nbf` and `exp` checks of PyJWT._validate_claims, in its order, with no leeway. */
function validateTimes(payload: JsonObject, now: number): void {
  if (Object.hasOwn(payload, "iat")) {
    const iat = claimInt(payload["iat"], "InvalidIssuedAtError", "Issued At claim (iat) must be an integer.");
    if (iat > now) throw new JwtError("ImmatureSignatureError", "The token is not yet valid (iat)");
  }
  if (Object.hasOwn(payload, "nbf")) {
    const nbf = claimInt(payload["nbf"], "DecodeError", "Not Before claim (nbf) must be an integer.");
    if (nbf > now) throw new JwtError("ImmatureSignatureError", "The token is not yet valid (nbf)");
  }
  if (Object.hasOwn(payload, "exp")) {
    const exp = claimInt(payload["exp"], "DecodeError", "Expiration Time claim (exp) must be an integer.");
    if (exp <= now) throw new JwtError("ExpiredSignatureError", "Signature has expired");
  }
}

/** PyJWT._validate_aud: a string or a list of strings, one of which is the app id. */
function validateAudience(payload: JsonObject, appId: string): void {
  if (!truthy(get(payload, "aud"))) throw new JwtError("MissingRequiredClaimError", 'Token is missing the "aud" claim');
  const aud = payload["aud"];
  const audiences = typeof aud === "string" ? [aud] : aud;
  if (!Array.isArray(audiences) || audiences.some((a) => typeof a !== "string")) {
    throw new JwtError("InvalidAudienceError", "Invalid claim format in token");
  }
  if (!audiences.includes(appId)) throw new JwtError("InvalidAudienceError", "Audience doesn't match");
}

/** PyJWT._validate_claims with this Function's options. */
export function validateClaims(payload: JsonObject, appId: string, now: number): void {
  for (const claim of REQUIRED) {
    const value = get(payload, claim);
    if (value === undefined || value === null) {
      throw new JwtError("MissingRequiredClaimError", `Token is missing the "${claim}" claim`);
    }
  }
  validateTimes(payload, now);
  // verify_iss is off: the caller checks the issuer against its own list.
  validateAudience(payload, appId);
  if (Object.hasOwn(payload, "sub") && typeof payload["sub"] !== "string") {
    throw new JwtError("InvalidTokenError", "Subject must be a string");
  }
  if (Object.hasOwn(payload, "jti") && typeof payload["jti"] !== "string") {
    throw new JwtError("InvalidTokenError", "JWT ID must be a string");
  }
}
