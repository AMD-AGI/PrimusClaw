// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `callerAuthOf`: the credential a route may present to SaFE on the caller's
 * behalf is the one the auth middleware accepted, in the middleware's order. The
 * same table is asserted through the app-run route's re-export in
 * app-run-create.test.ts, which needs a database; this one does not.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { callerAuthOf } from "../src/auth/caller-auth.js";
import { callerAuthOf as reExported } from "../src/routes/app-run-create.js";

const req = (headers: Record<string, unknown>, cookies: Record<string, string> = {}) => ({ headers, cookies }) as any;

test("the credential is the one the middleware accepts, in its order", () => {
  assert.deepEqual(callerAuthOf(req({ authorization: "Bearer gateway-token", "x-api-key": "ak-user" })), { authorization: "Bearer ak-user" });
  assert.deepEqual(callerAuthOf(req({ authorization: "Bearer ak-b", "x-api-key": "ak-x" })), { authorization: "Bearer ak-b" });
  assert.deepEqual(callerAuthOf(req({ "x-api-key": ["ak-first", "ak-second"] })), { authorization: "Bearer ak-first" });
  assert.deepEqual(callerAuthOf(req({ cookie: "Token=t; userType=default", authorization: "Bearer ak-b" }, { Token: "t" })), { cookie: "Token=t; userType=default" });
  assert.deepEqual(callerAuthOf(req({ authorization: "Bearer gateway-token" })), {});
  assert.deepEqual(callerAuthOf(req({})), {});
});

test("an x-api-key that is not an ak- key is not forwarded, alone or beside a Bearer one", () => {
  assert.deepEqual(callerAuthOf(req({ "x-api-key": "sk-not-ours" })), {});
  assert.deepEqual(callerAuthOf(req({ "x-api-key": ["sk-not-ours", "ak-second"] })), {});
  assert.deepEqual(callerAuthOf(req({ authorization: "Bearer ak-b", "x-api-key": "sk-not-ours" })), { authorization: "Bearer ak-b" });
});

test("a cookie jar without a Token cookie is not a credential", () => {
  assert.deepEqual(callerAuthOf(req({ cookie: "theme=dark" }, { theme: "dark" })), {});
});

test("the app-run route still exports the same function", () => {
  assert.equal(reExported, callerAuthOf);
});
