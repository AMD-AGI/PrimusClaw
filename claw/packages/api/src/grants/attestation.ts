// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * ES256 grant attestations and the JWKS that publishes their public keys.
 *
 * The current key signs. A previous key stays in the JWKS until the operator
 * removes it, so attestations it already signed keep verifying.
 */
import {
  createPrivateKey,
  createPublicKey,
  createSign,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { readFileSync } from "node:fs";

export const ATTESTATION_ISSUER = "primus-claw";
export const ATTESTATION_AUDIENCE = "agent-sandbox-workload";

export interface AttestationClaims {
  grantId: string;
  userId: string;
  workspaces: string[];
  kinds: string[];
  maxGpusPerSandbox: number;
  expiresAt: Date;
  issuedAt?: Date;
}

interface SigningKey {
  kid: string;
  privatePem: string;
  publicJwk: PublicJwk;
}

interface PublicJwk {
  kty: "EC";
  crv: "P-256";
  alg: "ES256";
  use: "sig";
  kid: string;
  x: string;
  y: string;
}

export interface JwksDocument {
  keys: PublicJwk[];
}

/** Load the current signing key and any previous key still published. */
export function loadSigningKeys(env: NodeJS.ProcessEnv = process.env): {
  current: SigningKey;
  previous: SigningKey | null;
} {
  const currentPem = readPem(env, "GRANT_SIGNING_KEY", "GRANT_SIGNING_KEY_FILE");
  if (!currentPem) {
    throw new Error("grant signing key is not configured");
  }
  const current = signingKey(env.GRANT_SIGNING_KID?.trim() || "claw-1", currentPem);
  const previousPem = readPem(env, "GRANT_SIGNING_PREVIOUS_KEY", "GRANT_SIGNING_PREVIOUS_KEY_FILE");
  const previous = previousPem
    ? signingKey(env.GRANT_SIGNING_PREVIOUS_KID?.trim() || "claw-0", previousPem)
    : null;
  return { current, previous };
}

/** Public keys for the current signer and the previous signer, when one is set. */
export function jwksDocument(env: NodeJS.ProcessEnv = process.env): JwksDocument {
  const { current, previous } = loadSigningKeys(env);
  const keys = [current.publicJwk];
  if (previous && previous.publicJwk.kid !== current.publicJwk.kid) {
    keys.push(previous.publicJwk);
  }
  return { keys };
}

/** Sign a grant attestation with the current key. exp matches expiresAt at second resolution. */
export function signAttestation(claims: AttestationClaims, env: NodeJS.ProcessEnv = process.env): string {
  const { current } = loadSigningKeys(env);
  const exp = Math.floor(claims.expiresAt.getTime() / 1000);
  const iat = Math.floor((claims.issuedAt ?? new Date()).getTime() / 1000);
  const payload = {
    iss: ATTESTATION_ISSUER,
    aud: ATTESTATION_AUDIENCE,
    jti: claims.grantId,
    sub: claims.userId,
    workspaces: claims.workspaces,
    kinds: claims.kinds,
    maxGpusPerSandbox: claims.maxGpusPerSandbox,
    iat,
    exp,
  };
  return signEs256(current.privatePem, current.publicJwk.kid, payload);
}

/** A DNS-1123 grant id. The same id is reused when an issue call is retried. */
export function newGrantId(): string {
  return "gr-" + randomBytes(12).toString("hex");
}

/** Truncate a time to a UTC second so the JWT exp and the grant body agree. */
export function atSecond(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

function readPem(env: NodeJS.ProcessEnv, inline: string, file: string): string {
  const fromEnv = env[inline]?.trim();
  if (fromEnv) return fromEnv.replace(/\\n/g, "\n");
  const path = env[file]?.trim();
  if (!path) return "";
  return readFileSync(path, "utf8").trim();
}

function signingKey(kid: string, pem: string): SigningKey {
  const priv = createPrivateKey(pem);
  return { kid, privatePem: pem, publicJwk: publicJwk(kid, priv) };
}

function publicJwk(kid: string, key: KeyObject): PublicJwk {
  const pub = createPublicKey(key);
  const jwk = pub.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string; y?: string };
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("grant signing key must be a P-256 private key");
  }
  return { kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid, x: jwk.x, y: jwk.y };
}

function signEs256(pem: string, kid: string, payload: object): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT", kid })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const input = `${header}.${body}`;
  const signer = createSign("SHA256");
  signer.update(input);
  signer.end();
  const der = signer.sign(createPrivateKey(pem));
  return `${input}.${b64url(derToP1363(der, 32))}`;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Convert a DER ECDSA signature to the fixed-width R||S form JWT ES256 uses. */
export function derToP1363(der: Buffer, size: number): Buffer {
  if (der[0] !== 0x30) throw new Error("ecdsa signature is not DER");
  let offset = 2;
  if (der[1] & 0x80) offset = 2 + (der[1] & 0x7f);
  const read = (): Buffer => {
    if (der[offset] !== 0x02) throw new Error("ecdsa signature is not DER");
    const len = der[offset + 1];
    const start = offset + 2;
    offset = start + len;
    let part = der.subarray(start, start + len);
    if (part.length > size) {
      if (part[0] !== 0x00) throw new Error("ecdsa component is too long");
      part = part.subarray(part.length - size);
    }
    const out = Buffer.alloc(size);
    part.copy(out, size - part.length);
    return out;
  };
  return Buffer.concat([read(), read()]);
}
