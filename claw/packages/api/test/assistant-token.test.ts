// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The bearer of an assistant turn: what it proves, and what makes it worthless.
 *
 *   T1  a minted token reads back as the claims it was minted with, for both roles
 *   T2  a token past its expiry is refused, and one that expires this second is too
 *   T3  a token minted under another key, or altered in any part, is refused
 *   T4  a worker token without its item or generation is not a token, however it was signed
 *   T5  malformed input of every shape is refused as malformed, never thrown
 *   T6  the key the assistant needs to start is checked at boot
 */
import assert from "node:assert/strict";
import test from "node:test";

import { assertAssistantTokenKey, mintAssistantToken, verifyAssistantToken, type AssistantTokenClaims } from "../src/assistant/token.js";

const KEY = "k".repeat(40);
const NOW = 1_800_000_000;
const router: AssistantTokenClaims = { sid: "s-router", role: "router", mid: "claw-1", task_id: "ktsk_1", exp: NOW + 600 };
const worker: AssistantTokenClaims = { sid: "s-work", role: "worker", item_id: "kwi_1", gen: 3, mid: "claw-2", task_id: "ktsk_2", exp: NOW + 600 };

test("T1 a minted token reads back as its claims", () => {
  for (const claims of [router, worker]) {
    const verdict = verifyAssistantToken(mintAssistantToken(claims, KEY), KEY, NOW);
    assert.deepEqual(verdict, { ok: true, claims });
  }
});

test("T2 expiry is enforced, and the second it expires is already too late", () => {
  const token = mintAssistantToken(router, KEY);
  assert.deepEqual(verifyAssistantToken(token, KEY, router.exp - 1).ok, true);
  assert.deepEqual(verifyAssistantToken(token, KEY, router.exp), { ok: false, reason: "expired" });
  assert.deepEqual(verifyAssistantToken(token, KEY, router.exp + 1), { ok: false, reason: "expired" });
});

test("T3 another key, or any altered part, is refused", () => {
  const token = mintAssistantToken(worker, KEY);
  assert.deepEqual(verifyAssistantToken(token, "x".repeat(40), NOW), { ok: false, reason: "bad_signature" });
  const [version, body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...worker, item_id: "kwi_other" })).toString("base64url");
  assert.deepEqual(verifyAssistantToken(`${version}.${forged}.${sig}`, KEY, NOW), { ok: false, reason: "bad_signature" });
  const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
  assert.deepEqual(verifyAssistantToken(`${version}.${body}.${flipped}`, KEY, NOW), { ok: false, reason: "bad_signature" });
});

test("T3b a token is bound to the assistant: the same key's signature over another domain proves nothing", async () => {
  const { createHmac } = await import("node:crypto");
  const body = Buffer.from(JSON.stringify(router)).toString("base64url");
  for (const signed of ["", "a1."]) {
    const sig = createHmac("sha256", KEY).update(signed).update(body).digest("base64url");
    assert.deepEqual(verifyAssistantToken(`a1.${body}.${sig}`, KEY, NOW), { ok: false, reason: "bad_signature" }, JSON.stringify(signed));
  }
});

test("T4 a signed body that is not a well-formed claim set is refused", () => {
  // Signed with the real key: what is refused here is the shape, not the signature.
  const sign = (obj: unknown) => mintAssistantToken(obj as AssistantTokenClaims, KEY);
  const bad: unknown[] = [
    { ...worker, gen: undefined },
    { ...worker, item_id: undefined },
    { ...worker, gen: 1.5 },
    { ...router, role: "admin" },
    { ...router, sid: "" },
    { ...router, task_id: undefined },
    { ...router, exp: "soon" },
    [],
    null,
  ];
  for (const claims of bad) {
    assert.deepEqual(verifyAssistantToken(sign(claims), KEY, NOW), { ok: false, reason: "malformed" }, JSON.stringify(claims));
  }
});

test("T5 malformed input is refused as malformed", () => {
  for (const presented of ["", "a1", "a1.x", "a1.x.y.z", "b2.x.y", "a1..y", "Bearer abc", "not a token"]) {
    assert.deepEqual(verifyAssistantToken(presented, KEY, NOW), { ok: false, reason: "malformed" }, presented);
  }
  assert.deepEqual(verifyAssistantToken(mintAssistantToken(router, KEY), "", NOW), { ok: false, reason: "malformed" });
  assert.throws(() => mintAssistantToken(router, ""), /not configured/);
});

test("T6 an assistant without a usable key refuses to start; with the switch off nothing is asked", () => {
  assert.throws(() => assertAssistantTokenKey(true, ""), /CLAW_ASSISTANT_TOKEN_KEY/);
  assert.throws(() => assertAssistantTokenKey(true, "short"), /at least 32/);
  assertAssistantTokenKey(true, "k".repeat(32));
  assertAssistantTokenKey(false, "");
});
