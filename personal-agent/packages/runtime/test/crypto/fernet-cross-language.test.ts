// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Fernet across languages: tokens Python's `cryptography` made decrypt here, and tokens made here decrypt in Python.
// Both workers read the same database, so a token one of them cannot read is a person whose link is lost.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Fernet, InvalidToken, MultiFernet } from "../../src/crypto/fernet.js";
import { hashLinkCode, linkHashKey } from "../../src/crypto/link-code.js";
import { urlsafeB64Decode, urlsafeB64Encode } from "../../src/crypto/py-base64.js";

interface Sample {
  readonly keys: readonly string[];
  readonly plaintext_b64: string;
  readonly token: string;
  readonly tampered: readonly string[];
}

interface Golden {
  readonly fernet: readonly Sample[];
  readonly link_codes: readonly { readonly fernet_key: string; readonly code: string; readonly hash: string }[];
}

const DATA = new URL("../../../../test-support/data/fernet-golden.json", import.meta.url);
const SCRIPT = new URL("../../../../test-support/python/fernet_golden.py", import.meta.url);
const golden = JSON.parse(readFileSync(DATA, "utf8")) as Golden;

const multi = (keys: readonly string[]): MultiFernet => new MultiFernet(keys.map((k) => new Fernet(k)));

function refused(reader: MultiFernet, token: string): boolean {
  try {
    reader.decrypt(token);
    return false;
  } catch (error) {
    if (error instanceof InvalidToken) return true;
    throw error;
  }
}

test("tokens Python made decrypt to the same bytes here (100/100), and every tampered copy is refused", () => {
  assert.equal(golden.fernet.length, 100);
  let equal = 0;
  let tampered = 0;
  for (const sample of golden.fernet) {
    const reader = multi(sample.keys);
    if (Buffer.from(reader.decrypt(sample.token)).equals(Buffer.from(sample.plaintext_b64, "base64"))) equal += 1;
    tampered += sample.tampered.filter((bad) => refused(reader, bad)).length;
  }
  assert.equal(equal, 100);
  assert.equal(tampered, 500);
});

test("a link code hashes to the same hex as Python's HMAC derivation (20/20)", () => {
  assert.equal(golden.link_codes.length, 20);
  for (const { fernet_key: key, code, hash } of golden.link_codes) {
    assert.equal(hashLinkCode(code, linkHashKey(key)), hash);
  }
});

function tamper(token: string): string[] {
  const raw = urlsafeB64Decode(token);
  return [0, 4, 12, 30, raw.length - 1].map((at) => {
    const changed = Uint8Array.from(raw);
    changed[at] = (changed[at] ?? 0) ^ 0x01;
    return urlsafeB64Encode(changed);
  });
}

function tsSamples(): Sample[] {
  const texts = ["", "ak-", "密钥 🔑 key", "é".repeat(17), "x".repeat(16)];
  return Array.from({ length: 100 }, (_, i) => {
    const keys = Array.from({ length: 1 + (i % 3) }, () => Fernet.generateKey());
    const plain = i < texts.length ? Buffer.from(texts[i] ?? "", "utf8") : randomBytes(i * 3);
    const token = multi(keys).encrypt(plain);
    return { keys, plaintext_b64: plain.toString("base64"), token, tampered: tamper(token) };
  });
}

/** Python with `cryptography`, or why there is none. In CI its absence is a failure, never a skip. */
function python(): string | undefined {
  const probe = spawnSync("python3", ["-c", "import cryptography"], { encoding: "utf8" });
  return probe.status === 0 ? undefined : `python3 with cryptography is not available (${probe.stderr.trim() || String(probe.error)})`;
}

const missing = python();

test("tokens made here decrypt in Python (100/100), and Python refuses every tampered copy", { skip: missing !== undefined && process.env["CI"] === undefined ? missing : false }, () => {
  assert.equal(missing, undefined, missing);
  const run = spawnSync("python3", [SCRIPT.pathname, "verify"], {
    input: JSON.stringify({ fernet: tsSamples() }),
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { samples: 100, equal: 100, tampered: 500, refused: 500 });
});
