// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Session SSH keypair for the Infera idle-pod control plane.
 *
 * Infera GPU pods deploy idle with sshd; the optimizer inside the sandbox SSHes
 * in to (re)launch the engine per round. A pod's `authorized_keys` is baked at
 * create time from `MN_SSH_AUTHORIZED_KEY` and is never refreshed, so the key
 * that reaches the sandbox must be the exact key the running pods trust.
 *
 * The keypair is therefore DERIVED, not randomly generated: HKDF over a
 * Brain-held secret plus the session and message ids. A redelivered message
 * adopting its still-running workload (see sandbox/multi-node/safe-provider.ts) reproduces the
 * same key without persisting private material anywhere, and two sessions can
 * never observe each other's key.
 *
 * ed25519 is used because its private key IS its 32-byte seed, which is what
 * makes derivation possible; the cost is having to emit the bespoke
 * "openssh-key-v1" container, since OpenSSH will not read ed25519 from PKCS#8.
 */

import { createPrivateKey, hkdfSync } from "node:crypto";

const KEY_TYPE = "ssh-ed25519";
/** PKCS#8 prefix for a raw ed25519 seed (RFC 8410 PrivateKeyInfo). */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** openssh-key-v1 pads the private section to this block size when unencrypted. */
const OPENSSH_PAD_BLOCK = 8;

export interface SshKeypair {
  /** "openssh-key-v1" PEM, written into the sandbox for `ssh -i`. */
  privateKeyPem: string;
  /** `ssh-ed25519 AAAA... comment` one-liner for MN_SSH_AUTHORIZED_KEY. */
  authorizedKey: string;
}

/** Length-prefixed SSH wire string. */
function sshString(payload: Buffer | string): Buffer {
  const buf = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/** Wire-format public key blob, shared by authorized_keys and the private file. */
function publicKeyBlob(rawPublicKey: Buffer): Buffer {
  return Buffer.concat([sshString(KEY_TYPE), sshString(rawPublicKey)]);
}

/** PEM-wrap a DER body with 70-character base64 lines, as OpenSSH writes it. */
function pemWrap(label: string, der: Buffer): string {
  const b64 = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 70) lines.push(b64.slice(i, i + 70));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * Encode an unencrypted ed25519 key in the openssh-key-v1 container.
 *
 * The check integers are a format requirement (OpenSSH compares them to detect
 * a wrong passphrase); with `ciphername = none` any matching pair is valid, so
 * they are derived from the key itself to keep the output deterministic.
 */
function encodeOpenSshPrivateKey(seed: Buffer, rawPublicKey: Buffer, comment: string): Buffer {
  const pub = publicKeyBlob(rawPublicKey);
  const checkInt = rawPublicKey.readUInt32BE(0);
  const check = Buffer.alloc(4);
  check.writeUInt32BE(checkInt, 0);

  let privateSection = Buffer.concat([
    check,
    check,
    sshString(KEY_TYPE),
    sshString(rawPublicKey),
    // ed25519 "private" field is seed || public key.
    sshString(Buffer.concat([seed, rawPublicKey])),
    sshString(comment),
  ]);
  const padLen = (OPENSSH_PAD_BLOCK - (privateSection.length % OPENSSH_PAD_BLOCK)) % OPENSSH_PAD_BLOCK;
  if (padLen > 0) {
    privateSection = Buffer.concat([
      privateSection,
      Buffer.from(Array.from({ length: padLen }, (_, i) => i + 1)),
    ]);
  }

  const keyCount = Buffer.alloc(4);
  keyCount.writeUInt32BE(1, 0);
  return Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"), // ciphername
    sshString("none"), // kdfname
    sshString(Buffer.alloc(0)), // kdfoptions
    keyCount,
    sshString(pub),
    sshString(privateSection),
  ]);
}

/** Raw 32-byte ed25519 public key for a seed. */
function rawPublicKeyForSeed(seed: Buffer): Buffer {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  // An ed25519 JWK carries the public `x` alongside the private `d`, so the
  // public half comes straight off the private key.
  const jwk = privateKey.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("ed25519 public key is missing its x coordinate");
  return Buffer.from(jwk.x, "base64url");
}

/**
 * Derive the keypair for one multi-node cluster.
 *
 * `secret` must be stable across Brain restarts (AUTH_INTERNAL_TOKEN in
 * practice) or an adopted workload's pods would reject the regenerated key.
 * `comment` lands in the pod's authorized_keys, so it carries the session id.
 */
export function deriveSessionKeypair(secret: string, scope: string, comment: string): SshKeypair {
  if (!secret) throw new Error("a stable secret is required to derive the multi-node SSH key");
  const seed = Buffer.from(hkdfSync("sha256", secret, "primus-claw-mn-ssh", scope, 32));
  const rawPublicKey = rawPublicKeyForSeed(seed);
  const label = comment || "primus-claw";
  return {
    privateKeyPem: pemWrap("OPENSSH PRIVATE KEY", encodeOpenSshPrivateKey(seed, rawPublicKey, label)),
    authorizedKey: `${KEY_TYPE} ${publicKeyBlob(rawPublicKey).toString("base64")} ${label}`,
  };
}
