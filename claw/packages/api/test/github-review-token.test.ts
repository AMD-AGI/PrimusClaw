// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The signed token a turn's tool calls carry. */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { mintSessionToolToken, verifySessionToolToken } from "../src/github-review/token.js";

const SECRET = "k".repeat(40);
const CLAIMS = { sessionId: "s-1", requesterUserId: "u-1", actorUserId: "u-2" };
const NOW = 1_800_000_000_000;

test("a token proves the three ids it was minted for", () => {
  const v = verifySessionToolToken(mintSessionToolToken(CLAIMS, SECRET, 60, NOW), SECRET, NOW + 1000);
  assert.deepEqual(v, { ok: true, claims: CLAIMS });
});

test("another secret, a changed body, a changed signature and junk are refused", () => {
  const t = mintSessionToolToken(CLAIMS, SECRET, 60, NOW);
  assert.deepEqual(verifySessionToolToken(t, "j".repeat(40), NOW), { ok: false, reason: "bad_signature" });
  const [body, sig] = t.split(".") as [string, string];
  const forged = Buffer.from(JSON.stringify({ v: 1, sid: "s-1", req: "u-1", act: "u-3", exp: NOW / 1000 + 60 })).toString("base64url");
  assert.deepEqual(verifySessionToolToken(`${forged}.${sig}`, SECRET, NOW), { ok: false, reason: "bad_signature" });
  assert.deepEqual(verifySessionToolToken(`${body}.${sig.slice(0, -2)}xx`, SECRET, NOW), { ok: false, reason: "bad_signature" });
  for (const junk of ["", "x", ".", "a.b", "..."]) assert.equal(verifySessionToolToken(junk, SECRET, NOW).ok, false, junk);
});

test("a token has a life, and an empty secret signs nothing", () => {
  const t = mintSessionToolToken(CLAIMS, SECRET, 60, NOW);
  assert.equal(verifySessionToolToken(t, SECRET, NOW + 59_000).ok, true);
  assert.deepEqual(verifySessionToolToken(t, SECRET, NOW + 61_000), { ok: false, reason: "expired" });
  assert.throws(() => mintSessionToolToken(CLAIMS, "", 60, NOW));
  assert.equal(verifySessionToolToken(t, "", NOW).ok, false);
});

test("a token minted for one purpose is not another's: the signature covers a fixed prefix", () => {
  const t = mintSessionToolToken(CLAIMS, SECRET, 60, NOW);
  const [body] = t.split(".") as [string];
  const bare = createHmac("sha256", SECRET).update(body).digest("base64url");
  assert.equal(verifySessionToolToken(`${body}.${bare}`, SECRET, NOW).ok, false);
});
