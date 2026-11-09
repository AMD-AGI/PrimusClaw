// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The Fernet specification's own vectors (generate / verify / invalid), as pyca/cryptography ships them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Fernet, InvalidToken } from "../../src/crypto/fernet.js";

interface Vector {
  readonly token: string;
  readonly now: string;
  readonly secret: string;
  readonly src?: string;
  readonly iv?: readonly number[];
  readonly ttl_sec?: number;
  readonly desc?: string;
}

function vectors(name: string): Vector[] {
  const url = new URL(`../../../../test-support/data/fernet-spec/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as Vector[];
}

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

test("generate: the spec's tokens are made byte for byte from key, time, IV and plaintext", () => {
  const all = vectors("generate");
  assert.ok(all.length > 0);
  for (const v of all) {
    const token = new Fernet(v.secret).encryptFromParts(
      new TextEncoder().encode(v.src ?? ""),
      seconds(v.now),
      Uint8Array.from(v.iv ?? []),
    );
    assert.equal(token, v.token);
  }
});

test("verify: the spec's tokens decrypt to their plaintext within their ttl", () => {
  const all = vectors("verify");
  assert.ok(all.length > 0);
  for (const v of all) {
    const plain = new Fernet(v.secret).decryptAtTime(v.token, v.ttl_sec ?? 0, seconds(v.now));
    assert.equal(new TextDecoder().decode(plain), v.src);
  }
});

test("invalid: every one of the spec's bad tokens is refused as InvalidToken", () => {
  const all = vectors("invalid");
  assert.equal(all.length, 8);
  for (const v of all) {
    assert.throws(
      () => new Fernet(v.secret).decryptAtTime(v.token, v.ttl_sec ?? 0, seconds(v.now)),
      InvalidToken,
      v.desc,
    );
  }
});
