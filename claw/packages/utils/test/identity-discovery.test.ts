// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * OIDC discovery: the document is fetched once and trusted only for the issuer
 * it was asked about, the addresses it advertises are the ones credentials go
 * to, and an operator can pin them instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IdentityClient, IdentityUnavailableError } from "../src/index.js";
import { defaultDiscoveryUrl } from "../src/identity/discovery.js";
import { FakeIdentity, activeAnswer, harness, settingsFor, testKey, type Harness } from "./identity-fake.js";

async function withHarness(over: Parameters<typeof harness>[0], run: (h: Harness) => Promise<void>): Promise<void> {
  const h = await harness(over);
  try { await run(h); } finally { await h.fake.close(); }
}

const unavailable = (reason: string) => (err: unknown): boolean => {
  assert.ok(err instanceof IdentityUnavailableError, String(err));
  assert.equal(err.reason, reason);
  return true;
};

test("discovery is read once and its introspection endpoint is the one used", async () => {
  await withHarness({}, async ({ fake, client }) => {
    fake.introspect = () => ({ body: activeAnswer() });
    for (let i = 0; i < 5; i++) await client.introspect(`token-${i}`);
    assert.equal(fake.count("/.well-known/openid-configuration"), 1);
    assert.equal(fake.count("/oauth/introspect"), 5);
  });
});

test("discovery is a plain GET of the well-known path under the issuer", async () => {
  await withHarness({}, async ({ fake, client }) => {
    fake.introspect = () => ({ body: activeAnswer() });
    await client.introspect("t");
    const r = fake.last("/.well-known/openid-configuration");
    assert.equal(r.method, "GET");
    assert.equal(r.headers.authorization, undefined, "no credential goes to the unauthenticated document");
  });
});

test("an issuer with a trailing slash still finds the document", async () => {
  const fake = await FakeIdentity.start();
  try {
    fake.discovery = () => ({ body: { ...fake.discoveryDocument(), issuer: `${fake.issuer}/` } });
    fake.introspect = () => ({ body: activeAnswer() });
    const client = new IdentityClient(settingsFor(fake, { issuerUrl: `${fake.issuer}/` }));
    assert.equal((await client.introspect("t")).active, true);
  } finally {
    await fake.close();
  }
});

test("the default discovery address drops every trailing slash and nothing else", () => {
  const well = "/.well-known/openid-configuration";
  assert.equal(defaultDiscoveryUrl("https://idp.example.com"), `https://idp.example.com${well}`);
  assert.equal(defaultDiscoveryUrl("https://idp.example.com/"), `https://idp.example.com${well}`);
  assert.equal(defaultDiscoveryUrl("https://idp.example.com/realms/a///"), `https://idp.example.com/realms/a${well}`);
  assert.equal(defaultDiscoveryUrl("https://idp.example.com//realms//a"), `https://idp.example.com//realms//a${well}`);
  assert.equal(defaultDiscoveryUrl(""), well);
  assert.equal(defaultDiscoveryUrl("///"), well);
});

test("a long run of slashes in the issuer is trimmed in linear time", () => {
  // `issuer.replace(/\/+$/, "")` takes ~0.8 s on this input (quadratic); a scan from the end takes microseconds.
  const issuer = `https://idp.example.com${"/".repeat(30_000)}x`;
  const started = process.hrtime.bigint();
  assert.equal(defaultDiscoveryUrl(issuer), `${issuer}/.well-known/openid-configuration`);
  assert.equal(defaultDiscoveryUrl(`${"/".repeat(30_000)}`), "/.well-known/openid-configuration");
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 250, `took ${ms.toFixed(0)} ms`);
});

test("a document whose issuer is not the configured one is not used", async () => {
  await withHarness({}, async ({ fake, client }) => {
    fake.discovery = () => ({ body: { ...fake.discoveryDocument(), issuer: "https://someone-else.example.com" } });
    await assert.rejects(client.introspect("t"), unavailable("bad_response"));
    assert.equal(fake.count("/oauth/introspect"), 0, "no credential may be sent on the strength of it");
  });
});

test("an advertised endpoint that is not a plain http(s) address is refused", async () => {
  const bad = [
    "ftp://idp.example.com/introspect",
    "javascript:alert(1)",
    "https://user:pass@idp.example.com/introspect",
    "not a url",
  ];
  for (const endpoint of bad) {
    await withHarness({}, async ({ fake, client }) => {
      fake.discovery = () => ({ body: { ...fake.discoveryDocument(), introspection_endpoint: endpoint } });
      await assert.rejects(client.introspect("t"), unavailable("bad_response"), endpoint);
      assert.equal(fake.count("/oauth/introspect"), 0, endpoint);
    });
  }
  await withHarness({}, async ({ fake, client }) => {
    fake.discovery = () => ({ body: { ...fake.discoveryDocument(), introspection_endpoint: 42 } });
    await assert.rejects(client.introspect("t"), unavailable("bad_response"));
  });
});

test("a document without the endpoint needed is a configuration error, not a guess", async () => {
  await withHarness({}, async ({ fake, client }) => {
    const doc = fake.discoveryDocument();
    delete doc.introspection_endpoint;
    fake.discovery = () => ({ body: doc });
    await assert.rejects(client.introspect("t"), unavailable("not_configured"));
  });
});

test("a failing discovery fetch is unavailable, whatever it said", async () => {
  const cases: Array<[string, { status?: number; body?: unknown }, string]> = [
    ["503", { status: 503, body: "" }, "http_5xx"],
    ["404", { status: 404, body: "nope" }, "http_4xx"],
    ["401 is a refusal, not a rejected client: no credentials were sent", { status: 401, body: "" }, "http_4xx"],
    ["not JSON", { body: "<html>" }, "bad_response"],
    ["JSON array", { body: [] }, "bad_response"],
  ];
  for (const [name, reply, reason] of cases) {
    await withHarness({}, async ({ fake, client }) => {
      fake.discovery = () => reply;
      await assert.rejects(client.introspect("t"), unavailable(reason), name);
    });
  }
});

test("pinned addresses need no discovery at all", async () => {
  const fake = await FakeIdentity.start();
  try {
    const client = new IdentityClient(settingsFor(fake, {
      introspectionUrl: `${fake.issuer}/oauth/introspect`,
      tokenUrl: `${fake.issuer}/oauth/token`,
      jwksUrl: `${fake.issuer}/.well-known/jwks.json`,
    }));
    fake.discovery = () => ({ status: 500, body: "down" });
    fake.introspect = () => ({ body: activeAnswer() });
    fake.jwks = () => ({ body: { keys: [testKey("ES256", "k1").jwk] } });
    await client.warmup();
    assert.equal((await client.introspect("t")).active, true);
    assert.equal(fake.count("/.well-known/openid-configuration"), 0);
  } finally {
    await fake.close();
  }
});

test("a pinned address wins over the advertised one", async () => {
  const fake = await FakeIdentity.start();
  const pinned = await FakeIdentity.start();
  try {
    pinned.introspect = () => ({ body: activeAnswer({ sub: "from-pinned" }) });
    fake.introspect = () => ({ body: activeAnswer({ sub: "from-advertised" }) });
    const client = new IdentityClient(settingsFor(fake, { introspectionUrl: `${pinned.issuer}/oauth/introspect` }));
    const r = await client.introspect("t");
    assert.ok(r.active);
    assert.equal(r.sub, "from-pinned");
    assert.equal(fake.count("/oauth/introspect"), 0);
  } finally {
    await pinned.close();
    await fake.close();
  }
});

test("discovery is re-read after its refresh interval and survives a failing refresh", async () => {
  await withHarness({ keysRefreshMs: 60_000 }, async ({ fake, clock, metrics, client }) => {
    fake.introspect = () => ({ body: activeAnswer() });
    await client.introspect("t1");
    clock.advance(59_999);
    await client.introspect("t2");
    assert.equal(fake.count("/.well-known/openid-configuration"), 1);
    clock.advance(1);
    fake.discovery = () => ({ status: 503, body: "" });
    // The refresh fails; the document held is used and the failure is counted.
    await client.introspect("t3");
    assert.equal(fake.count("/.well-known/openid-configuration"), 2);
    assert.equal(metrics.staleCount("discovery"), 1);
    assert.equal(fake.count("/oauth/introspect"), 3);
  });
});

test("a discovery document is not served stale for ever", async () => {
  await withHarness({ keysRefreshMs: 60_000, keysStaleIfErrorMs: 120_000 }, async ({ fake, clock, client }) => {
    fake.introspect = () => ({ body: activeAnswer() });
    await client.introspect("t1");
    fake.discovery = () => ({ status: 503, body: "" });
    clock.advance(60_000 + 119_999);
    await client.introspect("t2");
    clock.advance(1);
    await assert.rejects(client.introspect("t3"), unavailable("http_5xx"));
  });
});
