// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The shape of a push notification config, checked before it is stored. Pure:
 * where the URL points is the guard's question, answered in a2a-push.test.ts.
 */
import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { validatePushConfig } from "../src/routes/a2a-push.js";

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

