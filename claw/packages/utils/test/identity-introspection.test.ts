// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * RFC 7662 introspection through the identity client: what is cached and for
 * how long, what is shared between concurrent callers, and above all what
 * happens when the upstream cannot answer.
 *
 * The properties that matter are negative. An outage must never read as
 * "inactive" (a caller may cache that, and a valid user is then refused), an
 * inactive answer must never be served stale (a revoked credential would
 * revive), and a refusal of the client's own credentials must never be papered
 * over by a stale entry.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IdentityUnavailableError, type IdentityClient } from "../src/index.js";
import {
  CLIENT_ID, CLIENT_SECRET, Clock, FakeIdentity, activeAnswer, harness, smallIntrospector, type Harness,
} from "./identity-fake.js";

const TOKEN = "session-token-value";

function unavailable(reason: string, status?: number) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof IdentityUnavailableError, `expected IdentityUnavailableError, got ${String(err)}`);
    assert.equal(err.reason, reason);
    if (status !== undefined) assert.equal(err.status, status);
    return true;
  };
}

async function withHarness(
  over: Parameters<typeof harness>[0],
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const h = await harness(over);
  try { await run(h); } finally { await h.fake.close(); }
}

const introspect = (c: IdentityClient, token = TOKEN, opts?: Parameters<IdentityClient["introspect"]>[1]) =>
  c.introspect(token, opts);

test("a positive answer is served from the cache for 30 s and then asked again", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    fake.introspect = () => ({ body: activeAnswer() });
    const first = await introspect(client);
    assert.equal(first.active, true);
    assert.equal(fake.count("/oauth/introspect"), 1);

    clock.advance(29_999);
    await introspect(client);
    assert.equal(fake.count("/oauth/introspect"), 1, "29.999 s is still inside the window");

    clock.advance(1);
    await introspect(client);
    assert.equal(fake.count("/oauth/introspect"), 2, "30 s is outside it");
  });
});

test("an inactive answer is kept for 5 s, not 30", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    fake.introspect = () => ({ body: { active: false } });
    assert.deepEqual(await introspect(client), { active: false });
    clock.advance(4_999);
    await introspect(client);
    assert.equal(fake.count("/oauth/introspect"), 1);
    clock.advance(1);
    await introspect(client);
    assert.equal(fake.count("/oauth/introspect"), 2, "a credential refused 5 s ago may have been issued since");
  });
});

test("a revocation is visible once the positive window ends", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    fake.introspect = () => ({ body: activeAnswer() });
    assert.equal((await introspect(client)).active, true);
    fake.introspect = () => ({ body: { active: false } });
    clock.advance(30_000);
    assert.equal((await introspect(client)).active, false);
  });
});

test("the cache windows come from the settings", async () => {
  for (const [name, over, advance, calls] of [
    ["positive 10 s, just inside", { positiveTtlMs: 10_000 }, 9_999, 1],
    ["positive 10 s, at the edge", { positiveTtlMs: 10_000 }, 10_000, 2],
    ["positive caching off", { positiveTtlMs: 0 }, 0, 2],
  ] as const) {
    await withHarness(over, async ({ fake, clock, client }) => {
      fake.introspect = () => ({ body: activeAnswer() });
      await introspect(client);
      clock.advance(advance);
      await introspect(client);
      assert.equal(fake.count("/oauth/introspect"), calls, name);
    });
  }
  await withHarness({ negativeTtlMs: 0 }, async ({ fake, client }) => {
    fake.introspect = () => ({ body: { active: false } });
    await introspect(client);
    await introspect(client);
    assert.equal(fake.count("/oauth/introspect"), 2, "negative caching off");
  });
});

test("a positive answer is never kept past the token's own expiry", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    fake.introspect = () => ({ body: activeAnswer({ exp: clock.seconds + 10 }) });
    await introspect(client);
    clock.advance(9_999);
    await introspect(client);
    assert.equal(fake.count("/oauth/introspect"), 1);
    clock.advance(1);
    await introspect(client);
    assert.equal(fake.count("/oauth/introspect"), 2, "exp, not the 30 s window, ended it");
  });
});

test("the answer is mapped: roles, groups, audience, scope, expiry, preferred name", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    fake.introspect = () => ({
      body: activeAnswer({
        preferred_username: "u1", name: "User One", roles: ["default", "system-admin"],
        groups: ["system-admin"], aud: "svc-a", scope: "api read", client_id: "svc-x", jti: "j1",
        exp: clock.seconds + 300, act: { sub: "svc-x" },
      }),
    });
    const r = await introspect(client);
    assert.ok(r.active);
    assert.equal(r.sub, "user-1");
    assert.equal(r.preferredUsername, "u1");
    assert.equal(r.name, "User One");
    assert.deepEqual(r.roles, ["default", "system-admin"]);
    assert.deepEqual(r.groups, ["system-admin"]);
    assert.deepEqual(r.audience, ["svc-a"]);
    assert.deepEqual(r.scope, ["api", "read"]);
    assert.equal(r.clientId, "svc-x");
    assert.equal(r.expiresAt, (clock.seconds + 300) * 1000);
    assert.deepEqual(r.claims.act, { sub: "svc-x" });
  });
});

test("the question is a form POST authenticated with the client credentials", async () => {
  await withHarness({}, async ({ fake, client }) => {
    fake.introspect = () => ({ body: activeAnswer() });
    await introspect(client, TOKEN, { tokenTypeHint: "access_token", params: { audience: "svc-a" } });
    const r = fake.last("/oauth/introspect");
    assert.equal(r.method, "POST");
    assert.match(String(r.headers["content-type"]), /^application\/x-www-form-urlencoded/);
    assert.equal(r.form.get("token"), TOKEN);
    assert.equal(r.form.get("token_type_hint"), "access_token");
    assert.equal(r.form.get("audience"), "svc-a");
    // RFC 6749 section 2.3.1: each half is form-urlencoded before it is joined, so
    // the `:` and `+` in this secret must come back as percent-escapes.
    const [scheme, encoded] = String(r.headers.authorization).split(" ");
    assert.equal(scheme, "Basic");
    const [id, secret] = Buffer.from(encoded ?? "", "base64").toString("utf8").split(":");
    assert.equal(decodeURIComponent((id ?? "").replace(/\+/g, " ")), CLIENT_ID);
    assert.equal(secret, "s3cret%3Awith%2Breserved%2Fchars%3D");
    assert.equal(decodeURIComponent(secret ?? ""), CLIENT_SECRET);
  });
});

test("parameters that would replace the credential or the token are refused", async () => {
  await withHarness({}, async ({ fake, client }) => {
    for (const name of ["token", "token_type_hint", "client_id", "client_secret"]) {
      await assert.rejects(introspect(client, TOKEN, { params: { [name]: "x" } }), TypeError, name);
    }
    assert.equal(fake.count("/oauth/introspect"), 0);
  });
});

test("an empty credential is inactive without asking anyone", async () => {
  await withHarness({}, async ({ fake, client }) => {
    assert.deepEqual(await introspect(client, ""), { active: false });
    assert.equal(fake.requests.length, 0);
  });
});

test("answers are keyed by the whole question: another audience is another entry", async () => {
  await withHarness({}, async ({ fake, client }) => {
    fake.introspect = (r) => ({ body: r.form.get("audience") === "svc-a" ? activeAnswer() : { active: false } });
    const a = await introspect(client, TOKEN, { params: { audience: "svc-a" } });
    const b = await introspect(client, TOKEN, { params: { audience: "svc-b" } });
    assert.equal(a.active, true);
    assert.equal(b.active, false, "the answer for svc-a must not be served for svc-b");
    assert.equal(fake.count("/oauth/introspect"), 2);
    // The same params in another order are the same question.
    await introspect(client, TOKEN, { params: { audience: "svc-a", client_ip: "10.0.0.1" } });
    await introspect(client, TOKEN, { params: { client_ip: "10.0.0.1", audience: "svc-a" } });
    assert.equal(fake.count("/oauth/introspect"), 3);
  });
});

test("different credentials never share an entry", async () => {
  await withHarness({}, async ({ fake, client }) => {
    fake.introspect = (r) => ({ body: r.form.get("token") === "good" ? activeAnswer() : { active: false } });
    assert.equal((await introspect(client, "good")).active, true);
    assert.equal((await introspect(client, "bad")).active, false);
    assert.equal(fake.count("/oauth/introspect"), 2);
  });
});

test("concurrent lookups of one credential make one upstream call", async () => {
  await withHarness({}, async ({ fake, metrics, client }) => {
    fake.introspect = () => ({ body: activeAnswer(), delayMs: 60 });
    const results = await Promise.all(Array.from({ length: 20 }, () => introspect(client)));
    assert.ok(results.every((r) => r.active));
    assert.equal(fake.count("/oauth/introspect"), 1);
    assert.equal(metrics.cacheCount("introspection", "miss"), 1);
    assert.equal(metrics.cacheCount("introspection", "coalesced"), 19);
    // A different credential is not held up by, or merged with, the first.
    await Promise.all([introspect(client, "other-1"), introspect(client, "other-2")]);
    assert.equal(fake.count("/oauth/introspect"), 3);
  });
});

test("the cache ratio is recorded: one lookup, one cache result", async () => {
  await withHarness({}, async ({ fake, clock, metrics, client }) => {
    fake.introspect = (r) => ({ body: r.form.get("token") === "neg" ? { active: false } : activeAnswer() });
    await introspect(client);              // miss
    await introspect(client);              // hit
    await introspect(client, "neg");       // miss
    await introspect(client, "neg");       // hit_negative
    clock.advance(31_000);
    await introspect(client);              // miss again
    assert.equal(metrics.cacheCount("introspection", "miss"), 3);
    assert.equal(metrics.cacheCount("introspection", "hit"), 1);
    assert.equal(metrics.cacheCount("introspection", "hit_negative"), 1);
    assert.equal(metrics.cache.filter(([op]) => op === "introspection").length, 5, "one result per lookup");
    assert.equal(metrics.upstreamCount("introspection", "ok"), 2);
    assert.equal(metrics.upstreamCount("introspection", "inactive"), 1);
  });
});

// --- the upstream cannot answer ---------------------------------------------------

test("an upstream that cannot answer is an error, never {active:false}, and is not cached", async () => {
  const cases: Array<[string, { status?: number; body?: unknown; destroy?: boolean }, string, number | undefined]> = [
    ["500", { status: 500, body: "boom" }, "http_5xx", 500],
    ["502", { status: 502, body: "bad gateway" }, "http_5xx", 502],
    ["503 with an OAuth error body", { status: 503, body: { error: "server_error" } }, "http_5xx", 503],
    ["504", { status: 504, body: "" }, "http_5xx", 504],
    ["429", { status: 429, body: "slow down" }, "rate_limited", 429],
    ["408", { status: 408, body: "" }, "timeout", 408],
    ["404 from a mis-routed ingress", { status: 404, body: "not found" }, "http_4xx", 404],
    ["400", { status: 400, body: { error: "invalid_request" } }, "http_4xx", 400],
    ["200 that is not JSON", { body: "<html>maintenance</html>" }, "bad_response", 200],
    ["200 JSON array", { body: [] }, "bad_response", 200],
    ["200 JSON null", { body: "null" }, "bad_response", 200],
    ["200 without active", { body: {} }, "bad_response", 200],
    ["200 with active as a string", { body: { active: "true" } }, "bad_response", 200],
    ["connection dropped", { destroy: true }, "network", undefined],
  ];
  for (const [name, reply, reason, status] of cases) {
    await withHarness({}, async ({ fake, metrics, client }) => {
      fake.introspect = () => reply;
      await assert.rejects(introspect(client), unavailable(reason, status), name);
      await assert.rejects(introspect(client), unavailable(reason, status), `${name} (second call)`);
      assert.equal(fake.count("/oauth/introspect"), 2, `${name}: a failure must not be cached`);
      assert.equal(metrics.upstreamCount("introspection", reason as never), 2, name);
    });
  }
});

test("a slow upstream times out as unavailable", async () => {
  await withHarness({ requestTimeoutMs: 100 }, async ({ fake, client }) => {
    fake.introspect = () => ({ body: activeAnswer(), delayMs: 600 });
    await assert.rejects(introspect(client), unavailable("timeout"));
  });
});

test("a redirect is not followed with the client's credentials", async () => {
  await withHarness({}, async ({ fake, client }) => {
    const canary = await FakeIdentity.start();
    try {
      canary.introspect = () => ({ body: activeAnswer() });
      fake.introspect = () => ({ status: 302, headers: { Location: `${canary.issuer}/oauth/introspect` }, body: "" });
      await assert.rejects(introspect(client), unavailable("network"));
      assert.equal(canary.requests.length, 0, "the redirect target must never be contacted");
    } finally {
      await canary.close();
    }
  });
});

test("a body past the size cap is refused", async () => {
  await withHarness({}, async ({ fake, client }) => {
    fake.introspect = () => ({ body: `{"active":true,"pad":"${"x".repeat(1024 * 1024 + 10)}"}` });
    await assert.rejects(introspect(client), unavailable("bad_response"));
  });
});

// --- stale_if_error -----------------------------------------------------------------

async function seeded(over: Parameters<typeof harness>[0], run: (h: Harness) => Promise<void>): Promise<void> {
  await withHarness(over, async (h) => {
    h.fake.introspect = () => ({ body: activeAnswer() });
    assert.equal((await introspect(h.client)).active, true);
    await run(h);
  });
}

test("a cached credential keeps working through an outage, and each such answer is counted", async () => {
  await seeded({}, async ({ fake, clock, metrics, client }) => {
    fake.introspect = () => ({ status: 503, body: { error: "server_error" } });
    clock.advance(31_000);
    const r = await introspect(client);
    assert.equal(r.active, true);
    assert.equal(fake.count("/oauth/introspect"), 2, "it did try the upstream first");
    assert.equal(metrics.staleCount("introspection"), 1);
  });
});

test("a failed refresh is not retried for 5 s: the stale answer is served without a call", async () => {
  await seeded({}, async ({ fake, clock, metrics, client }) => {
    fake.introspect = () => ({ status: 503, body: "" });
    clock.advance(31_000);
    await introspect(client);                    // attempt, fails, stale
    await introspect(client);                    // inside the back-off: no attempt
    assert.equal(fake.count("/oauth/introspect"), 2);
    assert.equal(metrics.staleCount("introspection"), 2);
    clock.advance(5_000);
    await introspect(client);                    // back-off over: tries again
    assert.equal(fake.count("/oauth/introspect"), 3);
  });
});

test("the stale window is 30 minutes past freshness, and then the outage is an error", async () => {
  for (const [offsetPastFresh, served] of [
    [0, true],
    [30 * 60_000 - 1, true],
    [30 * 60_000, false],
    [31 * 60_000, false],
  ] as const) {
    await seeded({}, async ({ fake, clock, client }) => {
      fake.introspect = () => ({ status: 503, body: "" });
      clock.advance(30_000 + offsetPastFresh);
      if (served) assert.equal((await introspect(client)).active, true, `+${offsetPastFresh}`);
      else await assert.rejects(introspect(client), unavailable("http_5xx", 503), `+${offsetPastFresh}`);
    });
  }
});

test("stale serving can be turned off", async () => {
  await seeded({ staleIfErrorMs: 0 }, async ({ fake, clock, metrics, client }) => {
    fake.introspect = () => ({ status: 503, body: "" });
    clock.advance(31_000);
    await assert.rejects(introspect(client), unavailable("http_5xx"));
    assert.equal(metrics.staleCount("introspection"), 0);
  });
});

test("a token never outlives its own expiry on the stale path", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    fake.introspect = () => ({ body: activeAnswer({ exp: clock.seconds + 40 }) });
    await introspect(client);
    fake.introspect = () => ({ status: 503, body: "" });
    clock.advance(35_000);
    assert.equal((await introspect(client)).active, true, "5 s before exp it is still the token's");
    clock.advance(5_000);
    await assert.rejects(introspect(client), unavailable("http_5xx"), "at exp it is expired, outage or not");
  });
});

test("an inactive answer is never served stale: an outage cannot revive a refused credential", async () => {
  await withHarness({}, async ({ fake, clock, client }) => {
    fake.introspect = () => ({ body: { active: false } });
    await introspect(client);
    fake.introspect = () => ({ status: 503, body: "" });
    clock.advance(6_000);
    await assert.rejects(introspect(client), unavailable("http_5xx"));
  });
});

test("a credential never seen before gets an error during an outage, not a guess", async () => {
  await seeded({}, async ({ fake, client }) => {
    fake.introspect = () => ({ status: 503, body: "" });
    await assert.rejects(introspect(client, "never-seen"), unavailable("http_5xx", 503));
  });
});

test("a refusal of the client's own credentials is not an outage and is not covered by a stale entry", async () => {
  for (const status of [401, 403]) {
    await seeded({}, async ({ fake, clock, metrics, client }) => {
      fake.introspect = () => ({ status, body: { error: "invalid_client" } });
      clock.advance(31_000);
      await assert.rejects(introspect(client), unavailable("client_rejected", status), String(status));
      assert.equal(metrics.staleCount("introspection"), 0);
    });
  }
});

test("when the upstream recovers the next answer replaces the stale one", async () => {
  await seeded({}, async ({ fake, clock, client }) => {
    fake.introspect = () => ({ status: 503, body: "" });
    clock.advance(31_000);
    assert.equal((await introspect(client)).active, true);
    clock.advance(6_000);
    fake.introspect = () => ({ body: { active: false } });
    assert.equal((await introspect(client)).active, false, "recovered: the revocation lands");
  });
});

test("callers waiting on one failing call all fall back to their stale entry", async () => {
  await seeded({}, async ({ fake, clock, metrics, client }) => {
    fake.introspect = () => ({ status: 503, body: "", delayMs: 50 });
    clock.advance(31_000);
    const results = await Promise.all(Array.from({ length: 5 }, () => introspect(client)));
    assert.ok(results.every((r) => r.active));
    assert.equal(fake.count("/oauth/introspect"), 2, "one seeding call plus one shared failing call");
    assert.equal(metrics.staleCount("introspection"), 5);
  });
});

test("the cache is bounded: the oldest entry makes room", async () => {
  const fake = await FakeIdentity.start();
  try {
    const small = smallIntrospector(fake, new Clock(), 2);
    fake.introspect = () => ({ body: activeAnswer() });
    await small.introspect("a");
    await small.introspect("b");
    await small.introspect("c");          // evicts "a"
    assert.equal(fake.count("/oauth/introspect"), 3);
    await small.introspect("c");
    await small.introspect("b");
    assert.equal(fake.count("/oauth/introspect"), 3, "b and c are still held");
    await small.introspect("a");
    assert.equal(fake.count("/oauth/introspect"), 4, "a was evicted and is asked again");
  } finally {
    await fake.close();
  }
});

test("with negative caching off, refused credentials take no room from the ones that are cached", async () => {
  const fake = await FakeIdentity.start();
  try {
    const small = smallIntrospector(fake, new Clock(), 2, { negativeTtlMs: 0 });
    fake.introspect = (r) => ({ body: String(r.form.get("token")).startsWith("good") ? activeAnswer() : { active: false } });
    await small.introspect("good-1");
    await small.introspect("good-2");
    for (let i = 0; i < 5; i++) await small.introspect(`junk-${i}`);
    const before = fake.count("/oauth/introspect");
    await small.introspect("good-1");
    await small.introspect("good-2");
    assert.equal(fake.count("/oauth/introspect"), before, "the good entries were not pushed out");
  } finally {
    await fake.close();
  }
});

test("with positive caching off nothing positive is kept for the stale path either", async () => {
  await withHarness({ positiveTtlMs: 0 }, async ({ fake, clock, client }) => {
    fake.introspect = () => ({ body: activeAnswer() });
    await introspect(client);
    fake.introspect = () => ({ status: 503, body: "" });
    clock.advance(1_000);
    await assert.rejects(introspect(client), unavailable("http_5xx"));
  });
});
