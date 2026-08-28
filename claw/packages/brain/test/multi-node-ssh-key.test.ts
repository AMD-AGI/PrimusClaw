// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey } from "node:crypto";
import { deriveSessionKeypair } from "../src/sandbox/multi-node/ssh-key.js";

const SECRET = "brain-internal-token";
const SCOPE = "sess-1:msg-1";
const COMMENT = "primus-claw-sess-1";

/** Read one length-prefixed SSH wire string, returning it and the next offset. */
function readSshString(buf: Buffer, offset: number): [Buffer, number] {
  const len = buf.readUInt32BE(offset);
  const start = offset + 4;
  return [buf.subarray(start, start + len), start + len];
}

/** Base64 body of a PEM block, concatenated. */
function pemBody(pem: string): Buffer {
  const lines = pem.trim().split("\n");
  assert.equal(lines[0], "-----BEGIN OPENSSH PRIVATE KEY-----");
  assert.equal(lines[lines.length - 1], "-----END OPENSSH PRIVATE KEY-----");
  return Buffer.from(lines.slice(1, -1).join(""), "base64");
}

/** The 32-byte ed25519 public key node derives from a raw seed. */
function publicKeyForSeed(seed: Buffer): Buffer {
  const key = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  return Buffer.from(String(jwk.x), "base64url");
}

test("the keypair is reproducible, which is what lets a redelivery adopt its cluster", () => {
  // A pod's authorized_keys is baked at create time and never refreshed, so a
  // redelivered message must re-derive the exact key the pods already trust.
  const first = deriveSessionKeypair(SECRET, SCOPE, COMMENT);
  const again = deriveSessionKeypair(SECRET, SCOPE, COMMENT);
  assert.equal(again.privateKeyPem, first.privateKeyPem);
  assert.equal(again.authorizedKey, first.authorizedKey);
});

test("scope and secret both isolate the key", () => {
  const base = deriveSessionKeypair(SECRET, SCOPE, COMMENT);
  // Another message in the same session must not reach this cluster's pods.
  assert.notEqual(deriveSessionKeypair(SECRET, "sess-1:msg-2", COMMENT).authorizedKey, base.authorizedKey);
  // Nor may another session, even at an identical scope.
  assert.notEqual(deriveSessionKeypair(SECRET, "sess-2:msg-1", COMMENT).authorizedKey, base.authorizedKey);
  // A rotated Brain secret invalidates every prior key.
  assert.notEqual(deriveSessionKeypair("other-secret", SCOPE, COMMENT).authorizedKey, base.authorizedKey);
});

test("deriving without a stable secret is refused", () => {
  // Falling back to a random key would silently lock the optimizer out of pods
  // that already trust a different one.
  assert.throws(() => deriveSessionKeypair("", SCOPE, COMMENT), /stable secret/);
});

test("authorized_keys line carries a well-formed ed25519 blob and the comment", () => {
  const { authorizedKey } = deriveSessionKeypair(SECRET, SCOPE, COMMENT);
  const [type, blob, comment] = authorizedKey.split(" ");
  assert.equal(type, "ssh-ed25519");
  assert.equal(comment, COMMENT);

  const decoded = Buffer.from(blob, "base64");
  const [algo, afterAlgo] = readSshString(decoded, 0);
  const [rawPub, end] = readSshString(decoded, afterAlgo);
  assert.equal(algo.toString(), "ssh-ed25519");
  assert.equal(rawPub.length, 32);
  assert.equal(end, decoded.length, "trailing bytes in the public blob");
});

test("the private file is an openssh-key-v1 container matching its public half", () => {
  // Hand-rolled binary: a wrong length prefix or pad byte only surfaces as an
  // opaque "invalid format" from ssh at launch time.
  const { privateKeyPem, authorizedKey } = deriveSessionKeypair(SECRET, SCOPE, COMMENT);
  const der = pemBody(privateKeyPem);

  const magic = "openssh-key-v1\0";
  assert.equal(der.subarray(0, magic.length).toString("binary"), magic);

  let off = magic.length;
  let field: Buffer;
  [field, off] = readSshString(der, off);
  assert.equal(field.toString(), "none", "unencrypted keys must declare ciphername none");
  [field, off] = readSshString(der, off);
  assert.equal(field.toString(), "none", "kdfname");
  [field, off] = readSshString(der, off);
  assert.equal(field.length, 0, "kdfoptions must be empty when unencrypted");
  assert.equal(der.readUInt32BE(off), 1, "exactly one key per file");
  off += 4;

  let pubBlob: Buffer;
  [pubBlob, off] = readSshString(der, off);
  assert.equal(
    pubBlob.toString("base64"),
    authorizedKey.split(" ")[1],
    "the embedded public blob must equal the authorized_keys blob",
  );

  let priv: Buffer;
  [priv, off] = readSshString(der, off);
  assert.equal(off, der.length, "trailing bytes after the private section");
  assert.equal(priv.length % 8, 0, "the private section must be padded to the 8-byte block");

  // check1 == check2 is how OpenSSH detects a wrong passphrase; they must match
  // even though nothing here is encrypted.
  assert.equal(priv.readUInt32BE(0), priv.readUInt32BE(4));

  let p = 8;
  [field, p] = readSshString(priv, p);
  assert.equal(field.toString(), "ssh-ed25519");
  let embeddedPub: Buffer;
  [embeddedPub, p] = readSshString(priv, p);
  let seedAndPub: Buffer;
  [seedAndPub, p] = readSshString(priv, p);
  let privComment: Buffer;
  [privComment, p] = readSshString(priv, p);

  assert.equal(seedAndPub.length, 64, "ed25519 private field is seed || public");
  const seed = seedAndPub.subarray(0, 32);
  assert.deepEqual(seedAndPub.subarray(32), embeddedPub, "trailing public half must match");
  assert.deepEqual(
    publicKeyForSeed(seed),
    embeddedPub,
    "the stored public key must be the one this seed actually produces",
  );
  assert.equal(privComment.toString(), COMMENT);

  // Whatever follows the comment is padding: 1, 2, 3, ... up to the block size.
  const pad = priv.subarray(p);
  assert.ok(pad.length < 8);
  assert.deepEqual(pad, Buffer.from(Array.from({ length: pad.length }, (_, i) => i + 1)));
});
