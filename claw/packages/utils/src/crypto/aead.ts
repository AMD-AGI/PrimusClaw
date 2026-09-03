// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * AES-256-GCM sealing with mandatory additional authenticated data.
 *
 * Wire format, base64 of:
 *   byte[0]       version (0x01)
 *   byte[1..13)   12-byte nonce, fresh per seal
 *   byte[13..-16) ciphertext
 *   byte[-16..)   16-byte GCM tag
 *
 * The same layout api/src/crypto/user-env.ts already writes, so the two can be
 * reasoned about together; this one is not a refactor of that module, which
 * has callers matching on its exact error strings.
 *
 * AAD is a required parameter rather than an optional one. GCM authenticates
 * it without storing it, which is what lets a caller bind a sealed blob to the
 * identity of the thing it belongs to -- a run, a session, a schema version --
 * so that a blob lifted from one context and pasted into another fails to open
 * instead of decrypting into content the reader will trust. That property is
 * the reason this exists, and an AAD that defaults to empty is one someone
 * forgets to pass. Callers with genuinely nothing to bind pass an explicit
 * empty buffer and have to look at what they are doing to write it.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const AEAD_VERSION_V1 = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;
export const AEAD_KEY_LEN = 32;

/** Thrown for every failure to open: wrong key, wrong AAD, or tampering. */
export class AeadOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AeadOpenError";
  }
}

/**
 * Decode a base64 key and check its length.
 *
 * Separate from seal/open so a process can fail at boot rather than at the
 * first write. A key that is the wrong length is a deployment mistake, and the
 * useful moment to say so is before anything depends on it.
 */
export function decodeAeadKey(b64: string, envVarName: string): Buffer {
  const decoded = Buffer.from(b64, "base64");
  if (decoded.length !== AEAD_KEY_LEN) {
    throw new Error(
      `${envVarName} decoded to ${decoded.length} bytes, expected ${AEAD_KEY_LEN}. `
      + `Generate with 'openssl rand -base64 32'.`,
    );
  }
  return decoded;
}

export function sealAead(key: Buffer, plaintext: Buffer, aad: Buffer): string {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    Buffer.from([AEAD_VERSION_V1]), nonce, ct, cipher.getAuthTag(),
  ]).toString("base64");
}

export function openAead(key: Buffer, sealed: string, aad: Buffer): Buffer {
  const raw = Buffer.from(sealed, "base64");
  // A truncated blob must not reach createDecipheriv with a sliced-to-nothing
  // nonce, where the error would name the algorithm rather than the input.
  if (raw.length < 1 + NONCE_LEN + TAG_LEN) {
    throw new AeadOpenError(`sealed value is ${raw.length} bytes, too short to be well formed`);
  }
  if (raw[0] !== AEAD_VERSION_V1) {
    throw new AeadOpenError(`unknown seal version 0x${raw[0]!.toString(16)}`);
  }
  const nonce = raw.subarray(1, 1 + NONCE_LEN);
  const ct = raw.subarray(1 + NONCE_LEN, raw.length - TAG_LEN);
  const tag = raw.subarray(raw.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    // GCM cannot say which of the three it was, and saying so is the honest
    // report: the caller's only correct response to any of them is to treat
    // the value as absent.
    throw new AeadOpenError("authentication failed: wrong key, wrong AAD, or modified ciphertext");
  }
}
