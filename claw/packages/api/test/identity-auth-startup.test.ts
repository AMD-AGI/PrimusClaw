// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The startup checks CLAW_AUTH_PROVIDER=identity runs before serving. */
import test from "node:test";
import assert from "node:assert/strict";

import { identityAuthMissingSettings, identityKeySourceProblem } from "../src/startup/identity-auth.js";

const READY = {
  IDENTITY_CLIENT_ENABLED: "true", IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
  IDENTITY_INTROSPECTION_URL: "https://identity.test/oauth/introspect",
};

test("identity auth needs LLM_KEY_SOURCE=platformKey; other providers take any source", () => {
  assert.equal(identityKeySourceProblem(true, "platformKey"), null);
  assert.match(identityKeySourceProblem(true, "virtualKey") ?? "", /LLM_KEY_SOURCE=platformKey/);
  assert.equal(identityKeySourceProblem(false, "virtualKey"), null);
});

test("a complete identity configuration is missing nothing", () => {
  assert.deepEqual(identityAuthMissingSettings(true, "production", READY), []);
  assert.deepEqual(identityAuthMissingSettings(true, "production", { ...READY, IDENTITY_INTROSPECTION_URL: "", IDENTITY_API_URL: "https://identity.test" }), []);
});

test("each missing client setting is named", () => {
  assert.deepEqual(identityAuthMissingSettings(true, "production", {}), [
    "IDENTITY_CLIENT_ENABLED", "IDENTITY_CLIENT_ID", "IDENTITY_CLIENT_SECRET", "IDENTITY_INTROSPECTION_URL or IDENTITY_API_URL",
  ]);
  assert.deepEqual(identityAuthMissingSettings(true, "production", { ...READY, IDENTITY_CLIENT_ENABLED: "false" }), ["IDENTITY_CLIENT_ENABLED"]);
});

test("an introspection URL without /oauth/introspect and no IDENTITY_API_URL has no usable base", () => {
  assert.deepEqual(
    identityAuthMissingSettings(true, "production", { ...READY, IDENTITY_INTROSPECTION_URL: "https://identity.test/introspect" }),
    ["IDENTITY_INTROSPECTION_URL or IDENTITY_API_URL"],
  );
});

test("dev mode and other providers are not checked", () => {
  assert.deepEqual(identityAuthMissingSettings(true, "dev", {}), []);
  assert.deepEqual(identityAuthMissingSettings(false, "production", {}), []);
});
