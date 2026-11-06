// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The shape of a push notification config, checked before it is stored. Pure:
 * where the URL points is the guard's question, answered in a2a-push.test.ts.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { guardPushUrl, validatePushConfig } from "../src/routes/a2a-push.js";

describe("P1 the shape of a config", () => {
  const ok = (raw: unknown) => { const v = validatePushConfig(raw); assert.equal(v.ok, true, JSON.stringify(v)); return (v as { ok: true; value: Record<string, unknown> }).value; };
  const bad = (raw: unknown, pattern: RegExp) => {
    const v = validatePushConfig(raw);
    assert.equal(v.ok, false, JSON.stringify(raw));
    assert.match((v as { error: string }).error, pattern);
  };

  test("the smallest config is a url", () => assert.deepEqual(ok({ url: "https://h.example.com/x" }), {
    id: undefined, url: "https://h.example.com/x", token: undefined, scheme: undefined, credentials: undefined,
  }));
  test("everything the spec names is kept", () => {
    const v = ok({ id: "cfg-1", url: "https://h.example.com/x", token: "t", authentication: { scheme: "Bearer", credentials: "c" } });
    assert.deepEqual([v.id, v.token, v.scheme, v.credentials], ["cfg-1", "t", "Bearer", "c"]);
  });
  test("a scheme with no credentials is accepted, and sends no header (the SDK's own sender does the same)", () => {
    assert.equal(ok({ url: "https://h.example.com/x", authentication: { scheme: "Bearer" } }).credentials, undefined);
  });
  const refusals: Array<[string, unknown, RegExp]> = [
    ["not an object", "https://h.example.com", /object/],
    ["null", null, /object/],
    ["an array", [], /object/],
    ["no url", {}, /url/],
    ["a url that is not a string", { url: 7 }, /url/],
    ["an id with a space", { url: "https://h.example.com", id: "a b" }, /id/],
    ["an id that is too long", { url: "https://h.example.com", id: "a".repeat(129) }, /id/],
    ["a token that is too long", { url: "https://h.example.com", token: "t".repeat(513) }, /token/],
    ["a token with a line break (it goes into a header)", { url: "https://h.example.com", token: "a\r\nX-Evil: 1" }, /single-line/],
    ["an authentication with no scheme", { url: "https://h.example.com", authentication: {} }, /scheme/],
    ["a scheme that is not a token", { url: "https://h.example.com", authentication: { scheme: "Bearer x" } }, /scheme/],
    ["credentials with a line break", { url: "https://h.example.com", authentication: { scheme: "Bearer", credentials: "a\nb" } }, /single-line/],
    ["credentials that are not a string", { url: "https://h.example.com", authentication: { scheme: "Bearer", credentials: 7 } }, /single-line/],
    ["an authentication that is not an object", { url: "https://h.example.com", authentication: "Bearer x" }, /scheme/],
  ];
  for (const [name, raw, pattern] of refusals) test(`refuses ${name}`, () => bad(raw, pattern));
});


describe("P1 the operator's list as the whole of it", () => {
  const listed = new Set(["hooks.internal", "receiver.example.com", "::1"]);
  const publicAddress = async () => [{ address: "203.0.113.9", family: 4 }];
  const privateAddress = async () => [{ address: "10.2.3.4", family: 4 }];

  test("off, a public host not named passes, as it always did", async () => {
    assert.equal((await guardPushUrl("https://elsewhere.example.org/x", listed, false, publicAddress)).ok, true);
  });
  test("on, a public host not named is refused before it is resolved", async () => {
    let asked = 0;
    const r = await guardPushUrl("https://elsewhere.example.org/x", listed, true, async () => { asked += 1; return publicAddress(); });
    assert.deepEqual(r, { ok: false, reason: "host_not_allowed" });
    assert.equal(asked, 0);
  });
  test("on, a named host passes, private over http and public over https", async () => {
    assert.equal((await guardPushUrl("http://hooks.internal:8080/hook", listed, true, privateAddress)).ok, true);
    assert.equal((await guardPushUrl("https://Receiver.Example.com/hook", listed, true, publicAddress)).ok, true);
    assert.equal((await guardPushUrl("http://[::1]:9/hook", listed, true)).ok, true, "a bracketed IPv6 literal is matched without its brackets");
  });
  test("on, a named host is still held to the rest of the guard", async () => {
    assert.deepEqual(await guardPushUrl("https://u:p@hooks.internal/x", listed, true, privateAddress), { ok: false, reason: "credentials_in_url" });
    assert.deepEqual(await guardPushUrl("ftp://hooks.internal/x", listed, true, privateAddress), { ok: false, reason: "https_required" });
  });
  test("on, a name that only differs from a listed one is refused", async () => {
    for (const url of ["https://hooks.internal.evil.example/x", "https://evil.example/hooks.internal", "https://xhooks.internal/x"]) {
      assert.deepEqual(await guardPushUrl(url, listed, true, publicAddress), { ok: false, reason: "host_not_allowed" }, url);
    }
  });
  test("on, an unparseable url is refused", async () => {
    assert.deepEqual(await guardPushUrl("not a url", listed, true), { ok: false, reason: "invalid_url" });
  });
});
