// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";

import { GithubApi, GithubApiError, segment, type FetchLike } from "../../src/github/api.js";
import { AppTokenSource, FallbackTokenSource, GithubAuthError, appJwt } from "../../src/github/app-token.js";

interface Seen {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function recorder(answers: (() => Response)[]): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: (url, init) => {
      seen.push({ url, init });
      const next = answers.shift();
      if (next === undefined) return Promise.reject(new TypeError("no answer"));
      return Promise.resolve(next());
    },
  };
}

const header = (seen: Seen | undefined, name: string): string => new Headers(seen?.init?.headers).get(name) ?? "";

test("an anonymous call carries GitHub's headers and no credential", async () => {
  const { fetch, seen } = recorder([() => new Response("{}", { status: 200 })]);
  const api = new GithubApi({ fetch, apiUrl: "https://api.test/" });
  const response = await api.request({ method: "GET", path: "/repos/o/r" });
  assert.equal(response.status, 200);
  assert.equal(seen[0]?.url, "https://api.test/repos/o/r");
  assert.equal(header(seen[0], "accept"), "application/vnd.github+json");
  assert.equal(header(seen[0], "authorization"), "");
});

test("a 401 mints a new token once, and a transport failure is a status-0 error", async () => {
  let minted = 0;
  const tokens = {
    token: () => Promise.resolve(`t${String(minted)}`),
    invalidate: () => {
      minted += 1;
    },
  };
  const { fetch, seen } = recorder([() => new Response("", { status: 401 }), () => new Response("", { status: 201 })]);
  const api = new GithubApi({ fetch, tokens });
  const response = await api.request({ method: "POST", path: "/x", body: { a: 1 } });
  assert.equal(response.status, 201);
  assert.deepEqual(
    seen.map((s) => header(s, "authorization")),
    ["Bearer t0", "Bearer t1"],
  );
  assert.equal(seen[1]?.init?.body, '{"a":1}');
  await assert.rejects(api.request({ method: "GET", path: "/y" }), (err: unknown) => {
    assert.ok(err instanceof GithubApiError);
    assert.deepEqual([err.status, err.code], [0, "transport_TypeError"]);
    return true;
  });
  assert.equal(new GithubApiError(404).code, "github_404");
  assert.equal(segment("a b/c!"), "a%20b%2Fc%21");
});

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" });

test("an App proves itself with an RS256 JWT, back-dated a minute and valid nine more", () => {
  const jwt = appJwt("42", PEM, 1_000_000.7);
  const [head = "", claims = "", signature = ""] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url").toString()), {
    iat: 999_940,
    exp: 1_000_540,
    iss: "42",
  });
  assert.ok(verify("RSA-SHA256", Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(signature, "base64url")));
  assert.throws(
    () => appJwt("42", "not a key", 0),
    (err: unknown) => err instanceof GithubAuthError && err.code === "key_invalid",
  );
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => appJwt("42", ec, 0), GithubAuthError);
});

test("an installation token is minted for one repository and cached until shortly before it expires", async () => {
  let now = 1_000_000;
  const expires = new Date((now + 3600) * 1000).toISOString();
  const { fetch, seen } = recorder([
    () => new Response(JSON.stringify({ token: "ghs_1", expires_at: expires }), { status: 201 }),
    () => new Response(JSON.stringify({ token: "ghs_2", expires_at: expires }), { status: 201 }),
  ]);
  const source = new AppTokenSource({
    appId: "42",
    installationId: "7",
    key: () => Promise.resolve(PEM),
    repositories: ["feedback"],
    permissions: { issues: "write" },
    fetch,
    clock: () => now,
  });
  assert.deepEqual(await Promise.all([source.token(), source.token()]), ["ghs_1", "ghs_1"]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://api.github.com/app/installations/7/access_tokens");
  const body = seen.map((s) => s.init?.body).find((b) => typeof b === "string") ?? "";
  assert.deepEqual(JSON.parse(body), {
    repositories: ["feedback"],
    permissions: { issues: "write" },
  });
  now += 3600 - 100; // (within REFRESH_BEFORE_SECONDS of the expiry)
  assert.equal(await source.token(), "ghs_2");
  source.invalidate();
});

test("each way minting fails says which, never what was answered", async () => {
  const fail = async (answer: (() => Response) | undefined, key = () => Promise.resolve(PEM)) => {
    const { fetch } = recorder(answer ? [answer] : []);
    const source = new AppTokenSource({
      appId: "1",
      installationId: "2",
      key,
      repositories: [],
      permissions: {},
      fetch,
    });
    try {
      await source.token();
    } catch (err) {
      return err instanceof GithubAuthError ? err.code : "other";
    }
    return "none";
  };
  assert.equal(await fail(() => new Response("{}", { status: 403 })), "mint_403");
  assert.equal(await fail(() => new Response("nope", { status: 201 })), "mint_bad_response");
  assert.equal(await fail(() => new Response('{"token":""}', { status: 201 })), "mint_bad_response");
  assert.equal(await fail(undefined), "mint_transport_TypeError");
  assert.equal(await fail(undefined, () => Promise.reject(new Error("ENOENT"))), "key_file_unreadable");
});

test("a plain token stands in when the App fails, and the App is not retried for a minute", async () => {
  let now = 0;
  let appCalls = 0;
  const failures: string[] = [];
  const app = {
    token: () => {
      appCalls += 1;
      return Promise.reject(new GithubAuthError("mint_500"));
    },
    invalidate: () => undefined,
  };
  const source = new FallbackTokenSource(
    app,
    () => Promise.resolve(" plain \n"),
    () => now,
    60,
    (code) => failures.push(code),
  );
  assert.equal(await source.token(), "plain");
  assert.equal(await source.token(), "plain");
  assert.equal(appCalls, 1);
  now = 61;
  await source.token();
  assert.equal(appCalls, 2);
  assert.deepEqual(failures, ["mint_500", "mint_500"]);
  source.invalidate();
  const code = async (s: FallbackTokenSource) =>
    s.token().then(
      () => "none",
      (err: unknown) => (err instanceof GithubAuthError ? err.code : "other"),
    );
  assert.equal(await code(new FallbackTokenSource(undefined, undefined)), "no_credential");
  assert.equal(await code(new FallbackTokenSource(undefined, () => Promise.resolve("  "))), "token_file_empty");
  assert.equal(
    await code(new FallbackTokenSource(undefined, () => Promise.reject(new Error("x")))),
    "token_file_unreadable",
  );
  assert.equal(await code(new FallbackTokenSource(app, undefined)), "mint_500");
  const other = { token: () => Promise.reject(new RangeError("bug")), invalidate: () => undefined };
  assert.equal(await code(new FallbackTokenSource(other, () => Promise.resolve("p"))), "other");
});

test("every slash at the end of the base URL is dropped, in linear time", async () => {
  const { fetch, seen } = recorder([() => new Response("{}", { status: 200 })]);
  const api = new GithubApi({ fetch, apiUrl: "https://api.test///" });
  await api.request({ method: "GET", path: "/repos/o/r" });
  assert.equal(seen[0]?.url, "https://api.test/repos/o/r");
  const started = performance.now();
  const long = new GithubApi({ fetch, apiUrl: `https://api.test${"/".repeat(50_000)}x` });
  assert.ok(long instanceof GithubApi);
  assert.ok(performance.now() - started < 100);
});
