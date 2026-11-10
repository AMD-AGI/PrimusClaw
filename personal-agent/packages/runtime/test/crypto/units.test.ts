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

test("base64 decodes as Python 3.12's urlsafe_b64decode: both alphabets, junk skipped, padding required", () => {
  assert.equal(text(urlsafeB64Decode("aGVsbG8=")), "hello");
  assert.equal(text(urlsafeB64Decode("aGV sbG8=\n")), "hello");
  assert.deepEqual(urlsafeB64Decode("-_8="), Uint8Array.from([0xfb, 0xff]));
  assert.deepEqual(urlsafeB64Decode("+/8="), Uint8Array.from([0xfb, 0xff]));
  assert.equal(text(urlsafeB64Decode("aGk=trailing")), "hi"); // Python 3.12 (the worker image) stops at a completed pad sequence
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

// Fixed keys: whether a zero ciphertext block decrypts to legal PKCS7 padding depends on the key (about 1 key in 256
// gives a last byte of 0x01), so a random key made the "bad padding" case fail now and then. Both outcomes were checked
// against Python's `cryptography` (Fernet.decrypt on the same tokens): BAD_PADDING_KEY raises InvalidToken,
// LEGAL_PADDING_KEY returns the 15 bytes below.
const BAD_PADDING_KEY = "wd7WBluziLYHHCBYFrVOppZ8xlavX5nlBBJvMM8KMME=";
const LEGAL_PADDING_KEY = "ppTaaNSsXkV_J_IwymeR1avudmSGh7OUPY9hpwfVYFE=";
const HEADER = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(8), Buffer.alloc(16)]);

/** A token for `body` under `key`, signed as Fernet signs (so its MAC is valid whatever the body). */
function signed(key: string, body: Buffer): string {
  const signing = Buffer.from(urlsafeB64Decode(key)).subarray(0, 16);
  return urlsafeB64Encode(Buffer.concat([body, Buffer.from(nodeCrypto.hmacSha256Hex(signing, body), "hex")]));
}

test("a token with a valid MAC but a broken body is refused, not thrown as another error", () => {
  const fernet = new Fernet(BAD_PADDING_KEY);
  assert.throws(() => fernet.decrypt(signed(BAD_PADDING_KEY, Buffer.concat([HEADER, Buffer.alloc(5)]))), InvalidToken); // not a block
  assert.throws(() => fernet.decrypt(signed(BAD_PADDING_KEY, Buffer.concat([HEADER, Buffer.alloc(16)]))), InvalidToken); // bad padding
  assert.throws(
    () => fernet.decrypt(signed(BAD_PADDING_KEY, Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0, 0]))),
    InvalidToken,
  ); // too short
});

test("a signed body whose padding happens to be legal decrypts, as in Python; tampering with it is refused by the MAC", () => {
  // The case that made the test above flaky: with this key the zero block decrypts to a last byte of 0x01.
  const fernet = new Fernet(LEGAL_PADDING_KEY);
  const token = signed(LEGAL_PADDING_KEY, Buffer.concat([HEADER, Buffer.alloc(16)]));
  assert.equal(Buffer.from(fernet.decrypt(token)).toString("hex"), "fca4f61138c98ef82efa0cc51a106a");
  const tampered = Buffer.from(urlsafeB64Decode(token));
  tampered[30] = (tampered[30] ?? 0) ^ 0x01; // a ciphertext byte, the MAC left as it was
  assert.throws(() => fernet.decrypt(urlsafeB64Encode(tampered)), InvalidToken);
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
