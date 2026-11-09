// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { neutralPlugins, ok, type KeyRevoker } from "../src/index.js";

test("the neutral plugins know nobody, revoke nothing, deliver nothing and exchange nothing", async () => {
  const p = neutralPlugins();
  assert.equal(await p.identityLookup.ownerOfKey("k"), undefined);
  assert.equal(await p.keyRevoker.revoke("k"), false);
  const notConfigured = { ok: false, error: { kind: "sink_not_configured" } };
  assert.deepEqual(await p.feedbackSink.createIssue("t", "b", ["l"]), notConfigured);
  assert.deepEqual(await p.feedbackSink.findIssue("m", 0), notConfigured);
  assert.deepEqual(await p.feedbackSink.hasComment(1, "m", 0), notConfigured);
  assert.deepEqual(await p.feedbackSink.comment(1, "b"), notConfigured);
  assert.equal(p.modelRefusalPolicy.classify("403 No APIM Key binding found", true), undefined);
  assert.equal(p.modelRefusalPolicy.guidance({ kind: "missing" }, "en"), "");
  assert.equal(p.modelRefusalPolicy.fallbackLead({ kind: "missing" }, "zh"), "");
  assert.equal(p.tokenExchange.enabled, false);
  assert.deepEqual(await p.tokenExchange.tokenFor("u"), { ok: false, error: { kind: "exchange_unavailable" } });
  assert.deepEqual(await p.tokenExchange.bindingRequest("u", ""), {
    ok: false,
    error: { kind: "exchange_unavailable" },
  });
  p.tokenExchange.invalidate("u");
  assert.deepEqual(p.routeExtensions, []);
});

test("neutralPlugins puts an override in place of its default and keeps the rest", async () => {
  const revoker: KeyRevoker = { revoke: () => Promise.resolve(true) };
  const p = neutralPlugins({
    keyRevoker: revoker,
    routeExtensions: [
      { method: "POST", path: "/x", handle: () => Promise.resolve({ status: 202, body: { ok: true } }) },
    ],
  });
  assert.equal(p.keyRevoker, revoker);
  assert.equal(await p.keyRevoker.revoke("k"), true);
  assert.equal(await p.identityLookup.ownerOfKey("k"), undefined);
  const [route] = p.routeExtensions;
  assert.deepEqual(await route?.handle({ headers: {}, bearer: "", body: null }), { status: 202, body: { ok: true } });
  assert.deepEqual(ok(1), { ok: true, value: 1 });
});
