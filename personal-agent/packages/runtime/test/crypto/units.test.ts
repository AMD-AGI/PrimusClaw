// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Python-compatible base64, Fernet edge cases, and the Crypto port on node:crypto.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Base64Error,
  Fernet,
  InvalidToken,
  MultiFernet,
  nodeCrypto,
  urlsafeB64Decode,
  urlsafeB64Encode,
} from "@primusclaw/personal-agent-runtime";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

test("base64 decodes as Python's urlsafe_b64decode: both alphabets, junk skipped, padding required", () => {
  assert.equal(text(urlsafeB64Decode("aGVsbG8=")), "hello");
  assert.equal(text(urlsafeB64Decode("aGV sbG8=\n")), "hello");
  assert.deepEqual(urlsafeB64Decode("-_8="), Uint8Array.from([0xfb, 0xff]));
  assert.deepEqual(urlsafeB64Decode("+/8="), Uint8Array.from([0xfb, 0xff]));
  assert.equal(text(urlsafeB64Decode("aGk=trailing")), "hi"); // stops at a completed pad sequence
  assert.equal(text(urlsafeB64Decode(new TextEncoder().encode("aGk="))), "hi");
  assert.equal(text(urlsafeB64Decode("a=Gk=")), "hi"); // a pad too early is skipped
  assert.throws(() => urlsafeB64Decode("aGVsbG8"), Base64Error);
  assert.throws(() => urlsafeB64Decode("a"), Base64Error);
  assert.equal(urlsafeB64Encode(Uint8Array.from([0xfb, 0xff])), "-_8=");
});

test("a Fernet key must be 32 bytes of base64", () => {
  assert.throws(() => new Fernet("short"), RangeError);
  assert.throws(() => new Fernet("abc"), RangeError);
  assert.throws(() => new MultiFernet([]), RangeError);
  assert.equal(urlsafeB64Decode(Fernet.generateKey()).length, 32);
});

test("a token round-trips, is refused by another key, and respects a ttl", () => {
  let now = 1_000;
  const fernet = new Fernet(Fernet.generateKey(), { nowSeconds: () => now });
  const token = fernet.encrypt("secret");
  assert.equal(text(fernet.decrypt(token)), "secret");
  assert.equal(text(fernet.decrypt(token, 10)), "secret");
  now += 11;
  assert.throws(() => fernet.decrypt(token, 10), InvalidToken);
  assert.equal(text(fernet.decrypt(token)), "secret"); // no ttl: age is not checked
  assert.throws(() => fernet.decryptAtTime(token, 10, 1_000 - 61), InvalidToken); // from the future
  assert.throws(() => new Fernet(Fernet.generateKey()).decrypt(token), InvalidToken);
  assert.throws(() => fernet.decrypt("%%%"), InvalidToken);
  assert.throws(() => fernet.decrypt(urlsafeB64Encode(Uint8Array.from([0x80, 1, 2]))), InvalidToken);
});

test("a token with a valid MAC but a broken body is refused, not thrown as another error", () => {
  const key = Fernet.generateKey();
  const fernet = new Fernet(key);
  const signing = Buffer.from(urlsafeB64Decode(key)).subarray(0, 16);
  const sign = (body: Buffer): string =>
    urlsafeB64Encode(Buffer.concat([body, Buffer.from(nodeCrypto.hmacSha256Hex(signing, body), "hex")]));
  const header = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(8), Buffer.alloc(16)]);
  assert.throws(() => fernet.decrypt(sign(Buffer.concat([header, Buffer.alloc(5)]))), InvalidToken); // not a block
  assert.throws(() => fernet.decrypt(sign(Buffer.concat([header, Buffer.alloc(16)]))), InvalidToken); // bad padding
  assert.throws(() => fernet.decrypt(sign(Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0]))), InvalidToken); // too short
});

test("MultiFernet encrypts with the first key, reads with any, and rotates keeping the timestamp", () => {
  const first = new Fernet(Fernet.generateKey(), { nowSeconds: () => 5_000 });
  const second = new Fernet(Fernet.generateKey(), { nowSeconds: () => 4_000 });
  const multi = new MultiFernet([first, second]);
  assert.equal(text(first.decrypt(multi.encrypt("a"))), "a");
  const old = second.encrypt("b");
  assert.equal(text(multi.decrypt(old)), "b");
  const rotated = multi.rotate(old);
  assert.equal(text(first.decrypt(rotated)), "b");
  assert.equal(Buffer.from(urlsafeB64Decode(rotated)).readBigUInt64BE(1), 4_000n);
  assert.equal(text(first.decrypt(new MultiFernet([first]).rotate(first.encrypt("c")))), "c");
  const stranger = new Fernet(Fernet.generateKey()).encrypt("x");
  assert.throws(() => multi.decrypt(stranger), InvalidToken);
  assert.throws(() => multi.rotate(stranger), InvalidToken);
});

test("the Crypto port hashes and compares as node:crypto does", () => {
  assert.equal(nodeCrypto.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(nodeCrypto.sha1Hex(new TextEncoder().encode("abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(
    nodeCrypto.hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
  assert.equal(nodeCrypto.timingSafeEqual("abc", "abc"), true);
  assert.equal(nodeCrypto.timingSafeEqual("abc", "abd"), false);
  assert.equal(nodeCrypto.timingSafeEqual("abc", "abcd"), false);
});
