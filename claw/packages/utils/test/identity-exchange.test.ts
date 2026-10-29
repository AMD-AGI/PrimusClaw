// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * RFC 8693 token exchange and its token cache.
 *
 * A cached token is somebody's authority, so the properties here are about what
 * it must not be handed to: another subject, another audience, another scope. And
 * about what must keep working when the upstream does not: a token still inside
 * its lifetime, and nothing else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IdentityExchangeRefusedError, IdentityUnavailableError, TOKEN_EXCHANGE_GRANT, type ExchangeRequest } from "../src/index.js";
import { CLIENT_ID, CLIENT_SECRET, Clock, FakeIdentity, harness, smallExchange, type Harness } from "./identity-fake.js";

const SUBJECT_TYPE = "urn:example:params:token-type:user-ref";
const REQ: ExchangeRequest = { subjectToken: "user_id:u-1", subjectTokenType: SUBJECT_TYPE, audience: "svc-a", scope: "api" };

async function withHarness(over: Parameters<typeof harness>[0], run: (h: Harness) => Promise<void>): Promise<void> {
  const h = await harness(over);
  let n = 0;
  // Every answer carries a token that says which call produced it.
  h.fake.token = () => ({ body: { access_token: `tok-${++n}`, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 300, scope: "api" } });
  try { await run(h); } finally { await h.fake.close(); }
}

const unavailable = (reason: string) => (err: unknown): boolean => {
  assert.ok(err instanceof IdentityUnavailableError, String(err));
  assert.equal(err.reason, reason);
  return true;
};

test("the request is an RFC 8693 token-exchange form, authenticated as the client", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    const t = await client.exchange({ ...REQ, scope: ["api", "read"], resource: "https://svc.example.com", requestedTokenType: "urn:ietf:params:oauth:token-type:access_token" });
    const r = fake.last("/oauth/token");
    assert.equal(r.method, "POST");
    assert.equal(r.form.get("grant_type"), TOKEN_EXCHANGE_GRANT);
    assert.equal(r.form.get("subject_token"), "user_id:u-1");
    assert.equal(r.form.get("subject_token_type"), SUBJECT_TYPE);
    assert.equal(r.form.get("audience"), "svc-a");
    assert.equal(r.form.get("scope"), "api read");
    assert.equal(r.form.get("resource"), "https://svc.example.com");
    assert.equal(r.form.get("requested_token_type"), "urn:ietf:params:oauth:token-type:access_token");
    const basic = Buffer.from(String(r.headers.authorization).replace(/^Basic /, ""), "base64").toString("utf8");
    assert.equal(basic, `${CLIENT_ID}:s3cret%3Awith%2Breserved%2Fchars%3D`);
    assert.equal(decodeURIComponent(basic.split(":")[1] ?? ""), CLIENT_SECRET);
    assert.equal(t.accessToken, "tok-1");
    assert.equal(t.tokenType, "Bearer");
    assert.equal(t.scope, "api");
    assert.equal(t.expiresAt, clock.t + 300_000);
  });
});

test("members the caller did not give are not sent", async () => {
  await withHarness({}, async ({ fake, client }) => {
    await client.exchange({ subjectToken: "s", subjectTokenType: SUBJECT_TYPE });
    const r = fake.last("/oauth/token");
    for (const name of ["audience", "scope", "resource", "requested_token_type"]) {
      assert.equal(r.form.has(name), false, name);
    }
  });
});

test("the subject token type is required and has no default", async () => {
  await withHarness({}, async ({ fake, client }) => {
    await assert.rejects(client.exchange({ subjectToken: "s", subjectTokenType: "" }), TypeError);
    await assert.rejects(client.exchange({ subjectToken: "", subjectTokenType: SUBJECT_TYPE }), TypeError);
    assert.equal(fake.requests.length, 0);
  });
});

test("a token is reused while it has more than the refresh skew left", async () => {
  await withHarness({}, async ({ fake, clock, metrics, client }) => {
    const a = await client.exchange(REQ);
    clock.advance(269_999);                       // 30.001 s left
    const b = await client.exchange(REQ);
    assert.equal(b.accessToken, a.accessToken);
    assert.equal(fake.count("/oauth/token"), 1);
    clock.advance(1);                             // exactly the skew: replaced
    const c = await client.exchange(REQ);
    assert.notEqual(c.accessToken, a.accessToken);
    assert.equal(fake.count("/oauth/token"), 2);
    assert.equal(metrics.cacheCount("exchange", "hit"), 1);
    assert.equal(metrics.cacheCount("exchange", "miss"), 2);
  });
});

test("the caller can ask for more life than the default skew, or force a new token", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    const a = await client.exchange(REQ);
    clock.advance(100_000);                       // 200 s left
    assert.equal((await client.exchange(REQ)).accessToken, a.accessToken);
    const b = await client.exchange({ ...REQ, minRemainingMs: 250_000 });
    assert.notEqual(b.accessToken, a.accessToken, "less than 250 s left, so replaced");
    const c = await client.exchange({ ...REQ, forceRefresh: true });
    assert.notEqual(c.accessToken, b.accessToken);
    assert.equal(fake.count("/oauth/token"), 3);
    assert.equal((await client.exchange(REQ)).accessToken, c.accessToken, "the forced token is the one cached now");
  });
});

test("a token is never handed to another subject, audience, scope, resource or subject type", async () => {
  const variants: Array<[string, Partial<ExchangeRequest>]> = [
    ["subject", { subjectToken: "user_id:u-2" }],
    ["audience", { audience: "svc-b" }],
    ["scope", { scope: "read" }],
    ["resource", { resource: "https://other.example.com" }],
    ["subject token type", { subjectTokenType: "urn:example:params:token-type:other" }],
    ["requested token type", { requestedTokenType: "urn:ietf:params:oauth:token-type:jwt" }],
  ];
  await withHarness({}, async ({ fake, client }) => {
    const base = await client.exchange(REQ);
    for (const [name, change] of variants) {
      const other = await client.exchange({ ...REQ, ...change });
      assert.notEqual(other.accessToken, base.accessToken, `${name} must not share a token`);
    }
    assert.equal(fake.count("/oauth/token"), 1 + variants.length);
    // Scope as a list and as a string are the same question.
    const n = fake.count("/oauth/token");
    await client.exchange({ ...REQ, scope: ["api"] });
    assert.equal(fake.count("/oauth/token"), n);
  });
});

test("the key cannot be confused by values that run into each other", async () => {
  await withHarness({}, async ({ client }) => {
    const a = await client.exchange({ subjectToken: "ab", subjectTokenType: SUBJECT_TYPE, audience: "c" });
    const b = await client.exchange({ subjectToken: "a", subjectTokenType: SUBJECT_TYPE, audience: "bc" });
    assert.notEqual(a.accessToken, b.accessToken);
  });
});

test("concurrent exchanges of one request make one upstream call", async () => {
  await withHarness({}, async ({ fake, metrics, client }) => {
    const slow = fake.token;
    fake.token = (r) => ({ ...slow(r), delayMs: 60 });
    const all = await Promise.all(Array.from({ length: 10 }, () => client.exchange(REQ)));
    assert.equal(new Set(all.map((t) => t.accessToken)).size, 1);
    assert.equal(fake.count("/oauth/token"), 1);
    assert.equal(metrics.cacheCount("exchange", "coalesced"), 9);
  });
});

test("a token with no stated lifetime is used once and never cached", async () => {
  await withHarness({}, async ({ fake, client }) => {
    let n = 0;
    fake.token = () => ({ body: { access_token: `tok-${++n}`, token_type: "Bearer" } });
    const a = await client.exchange(REQ);
    assert.equal(a.expiresAt, null);
    const b = await client.exchange(REQ);
    assert.notEqual(a.accessToken, b.accessToken);
  });
});

test("a refusal is an answer: it is typed, counted as refused, and never cached", async () => {
  await withHarness({}, async ({ fake, metrics, client }) => {
    fake.token = () => ({ status: 400, body: { error: "invalid_grant", error_description: "no binding" } });
    for (let i = 0; i < 2; i++) {
      await assert.rejects(client.exchange(REQ), (err: unknown) => {
        assert.ok(err instanceof IdentityExchangeRefusedError);
        assert.equal(err.code, "invalid_grant");
        assert.equal(err.status, 400);
        assert.match(err.message, /no binding/);
        return true;
      });
    }
    assert.equal(fake.count("/oauth/token"), 2, "a binding granted a moment later must be seen");
    assert.equal(metrics.upstreamCount("exchange", "refused"), 2);
  });
});

test("an OAuth error description is cut short before it reaches a log line", async () => {
  await withHarness({}, async ({ fake, client }) => {
    fake.token = () => ({ status: 400, body: { error: "invalid_request", error_description: "x".repeat(5000) } });
    await assert.rejects(client.exchange(REQ), (err: unknown) => {
      assert.ok(err instanceof IdentityExchangeRefusedError);
      assert.ok(err.message.length < 300);
      return true;
    });
  });
});

test("an upstream that cannot answer is unavailable, with the reason", async () => {
  const cases: Array<[string, { status?: number; body?: unknown; destroy?: boolean }, string]> = [
    ["500", { status: 500, body: "" }, "http_5xx"],
    ["503", { status: 503, body: { error: "server_error" } }, "http_5xx"],
    ["429", { status: 429, body: "" }, "rate_limited"],
    ["401: the client itself is refused", { status: 401, body: { error: "invalid_client" } }, "client_rejected"],
    ["403", { status: 403, body: "" }, "client_rejected"],
    ["400 without an OAuth error body", { status: 400, body: "<html>" }, "http_4xx"],
    ["404", { status: 404, body: "" }, "http_4xx"],
    ["200 that is not JSON", { body: "<html>" }, "bad_response"],
    ["200 without access_token", { body: { token_type: "Bearer" } }, "bad_response"],
    ["200 with an empty access_token", { body: { access_token: "" } }, "bad_response"],
    ["dropped connection", { destroy: true }, "network"],
  ];
  for (const [name, reply, reason] of cases) {
    await withHarness({}, async ({ fake, client }) => {
      fake.token = () => reply;
      await assert.rejects(client.exchange(REQ), unavailable(reason), name);
    });
  }
});

test("when the upstream is down a token still inside its lifetime is handed out, and counted", async () => {
  await withHarness({}, async ({ fake, clock, metrics, client }) => {
    const a = await client.exchange(REQ);
    fake.token = () => ({ status: 503, body: "" });
    clock.advance(280_000);                       // 20 s left: below the skew, still valid
    const b = await client.exchange(REQ);
    assert.equal(b.accessToken, a.accessToken);
    assert.equal(metrics.staleCount("exchange"), 1);
    clock.advance(20_000);                        // expired
    await assert.rejects(client.exchange(REQ), unavailable("http_5xx"));
  });
});

test("a token that was just refused downstream is not handed out again because the upstream is down", async () => {
  await withHarness({}, async ({ fake, client }) => {
    await client.exchange(REQ);
    fake.token = () => ({ status: 503, body: "" });
    await assert.rejects(client.exchange({ ...REQ, forceRefresh: true }), unavailable("http_5xx"));
  });
});

test("a rejected client is not covered by a cached token, and neither is a refusal", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    await client.exchange(REQ);
    clock.advance(280_000);
    fake.token = () => ({ status: 401, body: { error: "invalid_client" } });
    await assert.rejects(client.exchange(REQ), unavailable("client_rejected"));
    fake.token = () => ({ status: 400, body: { error: "invalid_grant" } });
    await assert.rejects(client.exchange(REQ), IdentityExchangeRefusedError, "the binding was withdrawn: the old token does not outlive that");
  });
});

/**
 * What a refusal does to the NEXT call. The tests above check the call that
 * fails; a token the provider has refused to renew must also stop being served by
 * the call after it, from the cache and from the stale-if-error path alike.
 */
const OK_BODY = (token: string): { body: unknown } => ({ body: { access_token: token, token_type: "Bearer", expires_in: 300 } });

test("a forced refresh that is refused evicts the held token: the next plain call asks upstream", async () => {
  await withHarness({}, async ({ fake, client }) => {
    const first = await client.exchange(REQ);
    fake.token = () => ({ status: 400, body: { error: "invalid_grant" } });
    await assert.rejects(client.exchange({ ...REQ, forceRefresh: true }), IdentityExchangeRefusedError);
    fake.token = () => OK_BODY("tok-after");
    const next = await client.exchange(REQ);
    assert.notEqual(next.accessToken, first.accessToken, "the refused token came back from the cache");
    assert.equal(next.accessToken, "tok-after");
    assert.equal(fake.count("/oauth/token"), 3);
  });
});

test("a forced refresh that fails on a 5xx leaves nothing for a later plain call, hit or stale", async () => {
  await withHarness({}, async ({ fake, metrics, client }) => {
    await client.exchange(REQ);
    fake.token = () => ({ status: 503, body: "" });
    await assert.rejects(client.exchange({ ...REQ, forceRefresh: true }), unavailable("http_5xx"));
    // 270 s of the token's life remain, far above the skew: a cache hit if it were still held.
    await assert.rejects(client.exchange(REQ), unavailable("http_5xx"));
    assert.equal(fake.count("/oauth/token"), 3, "the plain call has to ask upstream, not hit");
    assert.equal(metrics.staleCount("exchange"), 0);
  });
});

test("a token inside the skew window is not served stale after the provider refused it", async () => {
  await withHarness({}, async ({ fake, clock, metrics, client }) => {
    await client.exchange(REQ);
    clock.advance(280_000);                       // 20 s left: below the skew, still valid
    fake.token = () => ({ status: 400, body: { error: "invalid_grant", error_description: "binding withdrawn" } });
    await assert.rejects(client.exchange(REQ), IdentityExchangeRefusedError);
    fake.token = () => ({ status: 503, body: "" });
    await assert.rejects(client.exchange(REQ), unavailable("http_5xx"), "the refused token was served from the stale path");
    assert.equal(metrics.staleCount("exchange"), 0);
  });
});

test("a rejected client (401) evicts the held token: neither a hit nor an outage serves it afterwards", async () => {
  await withHarness({}, async ({ fake, clock, metrics, client }) => {
    // In the skew window, so the plain call asks upstream and is turned away.
    await client.exchange(REQ);
    clock.advance(280_000);
    fake.token = () => ({ status: 401, body: { error: "invalid_client" } });
    await assert.rejects(client.exchange(REQ), unavailable("client_rejected"));
    fake.token = () => ({ status: 503, body: "" });
    await assert.rejects(client.exchange(REQ), unavailable("http_5xx"));
    assert.equal(metrics.staleCount("exchange"), 0);
  });
  await withHarness({}, async ({ fake, client }) => {
    // A forced refresh turned away with 403: a fresh token with life left must not remain either.
    await client.exchange(REQ);
    fake.token = () => ({ status: 403, body: "" });
    await assert.rejects(client.exchange({ ...REQ, forceRefresh: true }), unavailable("client_rejected"));
    fake.token = () => OK_BODY("tok-after");
    assert.equal((await client.exchange(REQ)).accessToken, "tok-after");
  });
});

test("an outage that is not a refusal still falls back to the held token on the next call", async () => {
  // The other side of the eviction: only a refusal or a forced refresh drops the token.
  await withHarness({}, async ({ fake, clock, metrics, client }) => {
    const a = await client.exchange(REQ);
    clock.advance(280_000);
    fake.token = () => ({ status: 503, body: "" });
    assert.equal((await client.exchange(REQ)).accessToken, a.accessToken);
    assert.equal((await client.exchange(REQ)).accessToken, a.accessToken);
    assert.equal(metrics.staleCount("exchange"), 2);
  });
});

test("a call that was waiting on a 5xx does not serve a token a refusal or forced refresh evicted meanwhile", async () => {
  await withHarness({}, async ({ fake, clock, metrics, client }) => {
    await client.exchange(REQ);
    clock.advance(280_000);                       // the plain call below goes upstream with a token to fall back to
    let asked = 0;
    fake.token = () => (++asked === 1
      ? { status: 503, body: "", delayMs: 80 }
      : { status: 400, body: { error: "invalid_grant" } });
    const waiting = client.exchange(REQ);
    const forced = client.exchange({ ...REQ, forceRefresh: true });
    await assert.rejects(forced, IdentityExchangeRefusedError);
    await assert.rejects(waiting, unavailable("http_5xx"));
    assert.equal(metrics.staleCount("exchange"), 0);
  });
});

test("an exchange that finishes late does not overwrite the token a forced refresh stored since", async () => {
  await withHarness({}, async ({ fake, client }) => {
    let asked = 0;
    fake.token = () => (++asked === 1 ? { ...OK_BODY("tok-old"), delayMs: 80 } : OK_BODY("tok-new"));
    const slow = client.exchange(REQ);
    const forced = client.exchange({ ...REQ, forceRefresh: true });
    assert.equal((await forced).accessToken, "tok-new");
    assert.equal((await slow).accessToken, "tok-old", "the slow caller still gets the answer it waited for");
    const next = await client.exchange(REQ);
    assert.equal(next.accessToken, "tok-new", "the older answer replaced the newer one in the cache");
    assert.equal(fake.count("/oauth/token"), 2);
  });
});

test("a failed exchange for a subject never seen has nothing to fall back to", async () => {
  await withHarness({}, async ({ fake, client }) => {
    fake.token = () => ({ status: 503, body: "" });
    await assert.rejects(client.exchange({ ...REQ, subjectToken: "user_id:never" }), unavailable("http_5xx"));
  });
});

test("the token cache is bounded: the oldest token makes room", async () => {
  const fake = await FakeIdentity.start();
  try {
    let n = 0;
    fake.token = () => ({ body: { access_token: `tok-${++n}`, token_type: "Bearer", expires_in: 300 } });
    const small = smallExchange(fake, new Clock(), 2);
    const ask = (who: string) => small.exchange({ ...REQ, subjectToken: `user_id:${who}` });
    await ask("a");
    await ask("b");
    await ask("c");                       // evicts a
    assert.equal(fake.count("/oauth/token"), 3);
    await ask("b");
    await ask("c");
    assert.equal(fake.count("/oauth/token"), 3, "b and c are still held");
    await ask("a");
    assert.equal(fake.count("/oauth/token"), 4, "a was evicted and is asked again");
  } finally {
    await fake.close();
  }
});
