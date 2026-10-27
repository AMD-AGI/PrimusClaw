// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The HMAC check receivers use on outbound notifications, and the address guard
 * the sender applies to a subscription URL. No database: both are pure.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { SIGNATURE_TOLERANCE_SECONDS, signPayload, verifySignature } from "../src/notifications/signing.js";
import { guardWebhookUrl, isPrivateAddress } from "../src/notifications/url-guard.js";

const SECRET = "s3cret-for-tests";
const BODY = JSON.stringify({ event_id: "e1", type: "run.completed" });
const NOW = 1_800_000_000;
const signed = (ts = NOW, body = BODY, secret = SECRET) => ({
  secret, timestamp: String(ts), signature: signPayload(secret, ts, body), body, nowSeconds: NOW,
});

test("a correctly signed, fresh request verifies", () => {
  assert.equal(verifySignature(signed()), "ok");
});

test("a signature made with another secret is refused", () => {
  assert.equal(verifySignature({ ...signed(), signature: signPayload("other-secret", NOW, BODY) }), "bad_signature");
});

test("a body changed after signing is refused", () => {
  assert.equal(verifySignature({ ...signed(), body: BODY.replace("completed", "failed") }), "bad_signature");
});

test("a timestamp swapped after signing is refused, because it is part of the signed string", () => {
  const s = signed();
  assert.equal(verifySignature({ ...s, timestamp: String(NOW + 1) }), "bad_signature");
});

test("a garbage, truncated or empty signature is refused and does not throw", () => {
  for (const signature of ["", "sha256=", "sha256=zz", "md5=abc", signPayload(SECRET, NOW, BODY).slice(0, -2)]) {
    assert.notEqual(verifySignature({ ...signed(), signature }), "ok", signature);
  }
  assert.equal(verifySignature({ ...signed(), signature: undefined }), "malformed");
  assert.equal(verifySignature({ ...signed(), timestamp: "12abc" }), "malformed");
  assert.equal(verifySignature({ ...signed(), secret: "" }), "malformed");
});

test("replay window: valid inside it, refused outside it, in both directions", () => {
  const edge = SIGNATURE_TOLERANCE_SECONDS;
  assert.equal(verifySignature({ ...signed(NOW - edge), nowSeconds: NOW }), "ok");
  assert.equal(verifySignature({ ...signed(NOW - edge - 1), nowSeconds: NOW }), "stale_timestamp");
  assert.equal(verifySignature({ ...signed(NOW + edge), nowSeconds: NOW }), "ok");
  assert.equal(verifySignature({ ...signed(NOW + edge + 1), nowSeconds: NOW }), "stale_timestamp");
  // A captured request replayed an hour later carries a valid MAC and is still refused.
  assert.equal(verifySignature({ ...signed(), nowSeconds: NOW + 3600 }), "stale_timestamp");
});

test("the signed string is `<timestamp>.<body>` under HMAC-SHA256, as receivers will compute it", () => {
  const expected = `sha256=${createHmac("sha256", "k").update("1.b").digest("hex")}`;
  assert.equal(signPayload("k", 1, "b"), expected);
});

test("private, loopback and link-local addresses are recognised, mapped ones included", () => {
  for (const a of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1", "0.0.0.0"]) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"]) assert.equal(isPrivateAddress(a), false, a);
});

test("only https to a public address passes; the operator's allow-list is the one exception", async () => {
  const pub = async () => [{ address: "93.184.216.34", family: 4 }];
  const priv = async () => [{ address: "10.0.0.7", family: 4 }];
  const none = new Set<string>();
  assert.equal((await guardWebhookUrl("https://hooks.example.com/x", none, pub)).ok, true);
  assert.deepEqual(await guardWebhookUrl("http://hooks.example.com/x", none, pub), { ok: false, reason: "https_required" });
  assert.deepEqual(await guardWebhookUrl("https://internal.example.com/x", none, priv), { ok: false, reason: "private_address" });
  assert.deepEqual(await guardWebhookUrl("https://127.0.0.1/x", none), { ok: false, reason: "private_address" });
  assert.deepEqual(await guardWebhookUrl("https://[::1]/x", none), { ok: false, reason: "private_address" });
  assert.deepEqual(await guardWebhookUrl("https://u:p@hooks.example.com/x", none, pub), { ok: false, reason: "credentials_in_url" });
  assert.deepEqual(await guardWebhookUrl("not a url", none), { ok: false, reason: "invalid_url" });
  // A name that resolves to both a public and a private address is refused: the connection could land on either.
  const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }];
  assert.deepEqual(await guardWebhookUrl("https://mixed.example.com/x", none, mixed), { ok: false, reason: "private_address" });
  // The allow-list admits a private host, and http for it.
  const allowed = new Set(["worker.svc.cluster.local"]);
  const r = await guardWebhookUrl("http://worker.svc.cluster.local:8080/hook", allowed, priv);
  assert.equal(r.ok, true);
});
