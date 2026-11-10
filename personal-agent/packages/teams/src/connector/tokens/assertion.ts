// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The client assertion of workload identity federation: the RSA key that signs it, its key id (the RFC 7638 thumbprint
 * the published JWKS carries), and the signed RS256 JWT itself (`iss`/`sub` as registered in the identity's federated
 * credential, audience api://AzureADTokenExchange).
 */
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, type KeyObject } from "node:crypto";

/** The audience a federated identity credential accepts. */
export const ASSERTION_AUDIENCE = "api://AzureADTokenExchange";
export const ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
/** 10 minutes in all, back-dated by ASSERTION_SKEW_SECONDS for clock skew. */
export const ASSERTION_LIFETIME_SECONDS = 600;
export const ASSERTION_SKEW_SECONDS = 60;

/** The key is not an unencrypted RSA private key in PEM (Python's ValueError). */
export class AssertionKeyError extends Error {
  override name = "AssertionKeyError";
}

export interface AssertionKey {
  readonly key: KeyObject;
  /** The RFC 7638 thumbprint of the public key: the `kid`. */
  readonly kid: string;
}

function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

/** The signing key and its key id; throws AssertionKeyError for anything but an unencrypted RSA private key in PEM. */
export function loadAssertionKey(pem: string | Uint8Array): AssertionKey {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(pem), format: "pem" });
  } catch (error) {
    throw new AssertionKeyError("the assertion key is not an unencrypted PEM private key", { cause: error });
  }
  if (key.asymmetricKeyType !== "rsa") throw new AssertionKeyError("the assertion key is not an RSA key");
  const jwk = createPublicKey(key).export({ format: "jwk" });
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    throw new AssertionKeyError("the assertion key is not an RSA key");
  }
  return { key, kid: jwkThumbprint({ n: jwk.n, e: jwk.e }) };
}

/** The RFC 7638 SHA-256 thumbprint of an RSA public key given as its JWK members (base64url, no leading zero bytes). */
export function jwkThumbprint(jwk: { readonly n: string; readonly e: string }): string {
  const canonical = JSON.stringify({ e: jwk.e, kty: "RSA", n: jwk.n });
  return b64url(createHash("sha256").update(canonical).digest());
}

export interface AssertionClaims {
  readonly issuer: string;
  readonly subject: string;
  /** Wall-clock seconds since the epoch. */
  readonly now: number;
  /** The token id; a fresh UUID by default: an assertion is never reused. */
  readonly jti?: string;
}

/** A fresh signed assertion, valid ASSERTION_LIFETIME_SECONDS in all (back-dated for clock skew). */
export function signAssertion(signer: AssertionKey, claims: AssertionClaims): string {
  const now = Math.floor(claims.now);
  const head = { alg: "RS256", typ: "JWT", kid: signer.kid };
  const body = {
    iss: claims.issuer,
    sub: claims.subject,
    aud: ASSERTION_AUDIENCE,
    iat: now - ASSERTION_SKEW_SECONDS,
    nbf: now - ASSERTION_SKEW_SECONDS,
    exp: now - ASSERTION_SKEW_SECONDS + ASSERTION_LIFETIME_SECONDS,
    jti: claims.jti ?? randomUUID(),
  };
  const signingInput = `${b64url(JSON.stringify(head))}.${b64url(JSON.stringify(body))}`;
  const signature = sign("sha256", Buffer.from(signingInput), signer.key);
  return `${signingInput}.${b64url(signature)}`;
}
