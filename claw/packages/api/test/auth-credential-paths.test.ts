// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Each credential path is a standalone function taking (request, verifier,
 * pathname), so the decisions that used to be buried in the middleware body can
 * be driven directly with a stub SaFE client.
 *
 * What matters here is the outcome kind, not the response body: `absent` is the
 * only outcome that lets the next path run, so every "presented but not
 * verifiable" case that returns `absent` is a credential that a *different*
 * header could then authenticate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyRequest } from "fastify";

import {
  CREDENTIAL_PATHS,
  verifyBearerApiKey,
  verifyDownloadQueryToken,
  verifySessionCookie,
  verifyXApiKeyHeader,
  type CredentialOutcome,
  type CredentialVerifier,
} from "../src/auth/middleware.js";
import {
  AuthServiceMisconfiguredError,
  AuthUpstreamUnreachableError,
} from "../src/auth/safe-client.js";
import type { UserInfo } from "../src/auth/models.js";

const DOWNLOAD_PATH = "/v1/sessions/abc/files/main.py";
const API_PATH = "/v1/sessions";
const KEY = "ak-test-key";

const USER: UserInfo = {
  userId: "u-1",
  userName: "User One",
  roles: ["default"],
  platformKey: "",
  virtualKey: "vk-1",
};

function request(init: {
  cookies?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string | string[]>;
}): FastifyRequest {
  return {
    cookies: init.cookies,
    query: init.query ?? {},
    headers: init.headers ?? {},
  } as unknown as FastifyRequest;
}

/** Records what the path asked SaFE, so "never called" is assertable. */
type Stub = CredentialVerifier & { cookieCalls: string[][]; apiKeyCalls: string[] };

function stub(result: UserInfo | Error): Stub {
  const s: Stub = {
    cookieCalls: [],
    apiKeyCalls: [],
    async verifyCookie(token: string, userType = "") {
      s.cookieCalls.push([token, userType]);
      if (result instanceof Error) throw result;
      return result;
    },
    async verifyApiKey(key: string) {
      s.apiKeyCalls.push(key);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return s;
}

function rejection(outcome: CredentialOutcome): { status: number; legacyError: string } {
  assert.equal(outcome.status, "rejected");
  const { status, legacyError } = (outcome as { error: { status: number; legacyError: string } }).error;
  return { status, legacyError };
}

test("path order is cookie, query token, bearer, x-api-key", () => {
  // Cookie must stay first: if a header path ran first, a request carrying a
  // stale cookie *and* a valid key would authenticate instead of being
  // rejected on the cookie.
  assert.deepEqual(CREDENTIAL_PATHS.map((p) => p.name), [
    "verifySessionCookie",
    "verifyDownloadQueryToken",
    "verifyBearerApiKey",
    "verifyXApiKeyHeader",
  ]);
});

test("cookie: no Token cookie is absent and does not call SaFE", async () => {
  const client = stub(USER);
  assert.deepEqual(await verifySessionCookie(request({}), client, API_PATH), { status: "absent" });
  assert.deepEqual(await verifySessionCookie(request({ cookies: {} }), client, API_PATH), { status: "absent" });
  assert.equal(client.cookieCalls.length, 0);
});

test("cookie: a verified Token cookie authenticates and forwards userType", async () => {
  const client = stub(USER);
  const outcome = await verifySessionCookie(
    request({ cookies: { Token: "cookie-value", userType: "internal" } }),
    client,
    API_PATH,
  );
  assert.deepEqual(outcome, { status: "verified", user: USER, method: "cookie" });
  assert.deepEqual(client.cookieCalls, [["cookie-value", "internal"]]);
});

test("cookie: a missing userType cookie is sent as empty, not undefined", async () => {
  const client = stub(USER);
  await verifySessionCookie(request({ cookies: { Token: "cookie-value" } }), client, API_PATH);
  assert.deepEqual(client.cookieCalls, [["cookie-value", ""]]);
});

test("cookie: a rejected cookie rejects the request rather than falling through", async () => {
  const outcome = await verifySessionCookie(
    request({ cookies: { Token: "stale" }, headers: { authorization: `Bearer ${KEY}` } }),
    stub(new Error("invalid token")),
    API_PATH,
  );
  assert.deepEqual(rejection(outcome), { status: 401, legacyError: "invalid_cookie" });
});

test("cookie: an unreachable SaFE is a 503, not a 401", async () => {
  // A 401 would send the user off to re-authenticate against a service that is
  // down; the credential itself was never judged.
  const outcome = await verifySessionCookie(
    request({ cookies: { Token: "value" } }),
    stub(new AuthUpstreamUnreachableError("connect ECONNREFUSED")),
    API_PATH,
  );
  assert.deepEqual(rejection(outcome), { status: 503, legacyError: "authentication_service_unavailable" });
});

test("cookie: a misconfigured auth service is a 500", async () => {
  const outcome = await verifySessionCookie(
    request({ cookies: { Token: "value" } }),
    stub(new AuthServiceMisconfiguredError("AUTH_INTERNAL_TOKEN is not set")),
    API_PATH,
  );
  assert.deepEqual(rejection(outcome), { status: 500, legacyError: "authentication_misconfigured" });
});

test("query token: ignored outside the browser-download routes", async () => {
  const client = stub(USER);
  const outcome = await verifyDownloadQueryToken(request({ query: { token: KEY } }), client, API_PATH);
  assert.deepEqual(outcome, { status: "absent" });
  assert.equal(client.apiKeyCalls.length, 0);
});

test("query token: authenticates an ak- key on a download route", async () => {
  const client = stub(USER);
  const outcome = await verifyDownloadQueryToken(request({ query: { token: KEY } }), client, DOWNLOAD_PATH);
  assert.deepEqual(outcome, { status: "verified", user: USER, method: "query_token" });
  assert.deepEqual(client.apiKeyCalls, [KEY]);
});

test("query token: a non-ak value is not sent to SaFE", async () => {
  const client = stub(USER);
  const outcome = await verifyDownloadQueryToken(
    request({ query: { token: "session-cookie-value" } }),
    client,
    DOWNLOAD_PATH,
  );
  assert.deepEqual(outcome, { status: "absent" });
  assert.equal(client.apiKeyCalls.length, 0);
});

test("query token: a rejected key falls through to the header paths", async () => {
  // On download routes the query parameter is the fallback, not the primary
  // scheme, so a bad one must not mask a valid Authorization header.
  const outcome = await verifyDownloadQueryToken(
    request({ query: { token: KEY } }),
    stub(new Error("invalid api key")),
    DOWNLOAD_PATH,
  );
  assert.deepEqual(outcome, { status: "absent" });
});

test("bearer: authenticates an ak- key", async () => {
  const client = stub(USER);
  const outcome = await verifyBearerApiKey(
    request({ headers: { authorization: `Bearer ${KEY}` } }),
    client,
    API_PATH,
  );
  assert.deepEqual(outcome, { status: "verified", user: USER, method: "api_key" });
  assert.deepEqual(client.apiKeyCalls, [KEY]);
});

test("bearer: another scheme or a non-ak value is left to the next path", async () => {
  const client = stub(USER);
  for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer eyJhbGciOiJIUzI1NiJ9.x.y", "bearer ak-lowercase"]) {
    assert.deepEqual(
      await verifyBearerApiKey(request({ headers: { authorization } }), client, API_PATH),
      { status: "absent" },
      authorization,
    );
  }
  assert.equal(client.apiKeyCalls.length, 0);
});

test("bearer: a rejected key rejects the request", async () => {
  const outcome = await verifyBearerApiKey(
    request({ headers: { authorization: `Bearer ${KEY}` } }),
    stub(new Error("invalid api key")),
    API_PATH,
  );
  assert.deepEqual(rejection(outcome), { status: 401, legacyError: "invalid_api_key" });
});

test("bearer: an unreachable SaFE is a 503", async () => {
  const outcome = await verifyBearerApiKey(
    request({ headers: { authorization: `Bearer ${KEY}` } }),
    stub(new AuthUpstreamUnreachableError("connect ECONNREFUSED")),
    API_PATH,
  );
  assert.deepEqual(rejection(outcome), { status: 503, legacyError: "authentication_service_unavailable" });
});

test("x-api-key: authenticates an ak- key", async () => {
  const client = stub(USER);
  const outcome = await verifyXApiKeyHeader(request({ headers: { "x-api-key": KEY } }), client, API_PATH);
  assert.deepEqual(outcome, { status: "verified", user: USER, method: "x_api_key" });
  assert.deepEqual(client.apiKeyCalls, [KEY]);
});

test("x-api-key: a repeated header verifies the first value only", async () => {
  const client = stub(USER);
  await verifyXApiKeyHeader(request({ headers: { "x-api-key": [KEY, "ak-second"] } }), client, API_PATH);
  assert.deepEqual(client.apiKeyCalls, [KEY]);
});

test("x-api-key: a missing or non-ak header is absent", async () => {
  const client = stub(USER);
  assert.deepEqual(await verifyXApiKeyHeader(request({}), client, API_PATH), { status: "absent" });
  assert.deepEqual(
    await verifyXApiKeyHeader(request({ headers: { "x-api-key": "not-a-key" } }), client, API_PATH),
    { status: "absent" },
  );
  assert.equal(client.apiKeyCalls.length, 0);
});

test("x-api-key: a rejected key rejects the request", async () => {
  const outcome = await verifyXApiKeyHeader(
    request({ headers: { "x-api-key": KEY } }),
    stub(new Error("invalid api key")),
    API_PATH,
  );
  assert.deepEqual(rejection(outcome), { status: 401, legacyError: "invalid_api_key" });
});
