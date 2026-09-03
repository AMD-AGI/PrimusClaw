// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The key is read once, at boot, from an environment variable that a human
 * pasted into. Everything downstream of it -- every sealed checkpoint the
 * process writes for as long as it lives -- is unreadable by any pod that
 * decoded a different key. So the only safe behaviour on a mangled key is to
 * refuse it, loudly, before the first write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { decodeAeadKey, AEAD_KEY_LEN } from "../src/crypto/aead.js";

const GOOD = randomBytes(AEAD_KEY_LEN).toString("base64");

test("decodeAeadKey accepts the canonical encoding of a key", () => {
  const key = decodeAeadKey(GOOD, "BRAIN_CHECKPOINT_KEY");
  assert.equal(key.length, AEAD_KEY_LEN);
  assert.equal(key.toString("base64"), GOOD);
});

test("decodeAeadKey refuses input Buffer.from would quietly repair", () => {
  // Each of these decodes to *something* under `Buffer.from(s, "base64")`,
  // because it skips characters it cannot interpret rather than failing. A
  // trailing newline read from a file, a space that survived a copy-paste, and
  // a key that picked up quotes on its way through a shell all land here -- and
  // two pods given two different manglings of the same key would each come up,
  // seal happily, and be unable to read each other's checkpoints.
  for (const [what, bad] of [
    ["a trailing newline", `${GOOD}\n`],
    ["a leading space", ` ${GOOD}`],
    ["an inner space", `${GOOD.slice(0, 10)} ${GOOD.slice(10)}`],
    ["shell quotes", `"${GOOD}"`],
    ["a url-safe alphabet", GOOD.replace(/\+/g, "-").replace(/\//g, "_")],
  ] as const) {
    assert.throws(
      () => decodeAeadKey(bad, "BRAIN_CHECKPOINT_KEY"),
      /canonical base64/,
      `${what} was accepted`,
    );
  }
});

test("decodeAeadKey refuses an encoding that does not round-trip", () => {
  // Not reachable through the character class: the padding and the trailing
  // bits are both syntactically fine and still not the canonical encoding of
  // the bytes they decode to. Left unchecked, the same 32 bytes would have more
  // than one accepted spelling.
  const nonCanonicalTrailingBits = `${GOOD.slice(0, -1)}${GOOD.endsWith("=") ? "=" : "B"}`;
  if (nonCanonicalTrailingBits !== GOOD) {
    const decoded = Buffer.from(nonCanonicalTrailingBits, "base64");
    if (decoded.toString("base64") !== nonCanonicalTrailingBits) {
      assert.throws(
        () => decodeAeadKey(nonCanonicalTrailingBits, "K"),
        /canonical base64 encoding of its own bytes/,
      );
    }
  }
  // Padding where no padding belongs: 32 bytes need none at all.
  assert.throws(() => decodeAeadKey(`${GOOD}==`, "K"), /canonical base64/);
});

test("decodeAeadKey names the length when the key is the wrong size", () => {
  // A syntactically perfect base64 string of the wrong length is the ordinary
  // deployment mistake -- 16 bytes from a different generator, or 32 hex
  // characters base64'd. The error has to say which of the two problems it is,
  // because the fix is different.
  const short = randomBytes(16).toString("base64");
  assert.throws(
    () => decodeAeadKey(short, "BRAIN_CHECKPOINT_KEY"),
    (e: Error) => /decoded to 16 bytes, expected 32/.test(e.message)
      && /BRAIN_CHECKPOINT_KEY/.test(e.message),
  );
});
