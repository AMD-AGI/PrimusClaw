// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Resolving a user's third-party credential from the identity provider.
 *
 * The properties are about a secret that is handed out for one use: it is asked
 * for per use and never remembered, a refusal is told apart from an outage (a
 * caller that read "could not ask" as "not bound" would tell a user to bind again
 * during an outage), and the request carries who it is for and why.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IdentityClient, IdentityCredentialRefusedError, IdentityUnavailableError, readIdentityConfig } from "../src/index.js";
import { CLIENT_ID, Clock, FakeIdentity, harness, settingsFor, type Harness } from "./identity-fake.js";

const GRANT = {
  token: "gho_0123456789abcdefghijklmnopqrstuvwxyzAB", provider_login: "octo", kind: "oauth",
  scopes: ["public_repo"], delegation: true, expires_at: "2027-01-01T00:00:00Z",
};

async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const h = await harness();
  try { await run(h); } finally { await h.fake.close(); }
}

test("the request names the user, the provider, who asked and why, and authenticates as the client", async () => {
  await withHarness(async ({ fake, client }) => {
    fake.resolveCredential = () => ({ body: GRANT });
    const got = await client.resolveExternalCredential({ userId: "u-1", provider: "github", requesterUserId: "u-2", purpose: "gh_pr_merge" });
    const r = fake.last("/oauth/external-credentials/resolve");
    assert.equal(r.method, "POST");
    assert.match(String(r.headers["content-type"]), /application\/json/);
    assert.deepEqual(JSON.parse(r.body), { user_id: "u-1", provider: "github", requester_user_id: "u-2", purpose: "gh_pr_merge" });
    assert.match(String(r.headers.authorization), /^Basic /);
    assert.equal(Buffer.from(String(r.headers.authorization).replace(/^Basic /, ""), "base64").toString("utf8").split(":")[0], CLIENT_ID);
    assert.equal(got.token, GRANT.token);
    assert.equal(got.providerLogin, "octo");
    assert.equal(got.kind, "oauth");
    assert.deepEqual(got.scopes, ["public_repo"]);
    assert.equal(got.delegation, true);
    assert.equal(got.expiresAt, Date.parse("2027-01-01T00:00:00Z"));
  });
});

test("members the caller did not give are not sent", async () => {
  await withHarness(async ({ fake, client }) => {
    fake.resolveCredential = () => ({ body: GRANT });
    await client.resolveExternalCredential({ userId: "u-1", provider: "github" });
    assert.deepEqual(JSON.parse(fake.last("/oauth/external-credentials/resolve").body), { user_id: "u-1", provider: "github" });
  });
});

test("nothing is cached: every use asks again, so an unbind takes effect on the next one", async () => {
  await withHarness(async ({ fake, client }) => {
    fake.resolveCredential = () => ({ body: GRANT });
    await client.resolveExternalCredential({ userId: "u-1", provider: "github" });
    await client.resolveExternalCredential({ userId: "u-1", provider: "github" });
    assert.equal(fake.count("/oauth/external-credentials/resolve"), 2);
    fake.resolveCredential = () => ({ status: 404, body: { error: "not_bound" } });
    await assert.rejects(client.resolveExternalCredential({ userId: "u-1", provider: "github" }), IdentityCredentialRefusedError);
  });
});

test("a delegation flag that is not exactly true is false, and a missing expiry is null", async () => {
  await withHarness(async ({ fake, client }) => {
    for (const delegation of [undefined, "true", 1, null]) {
      fake.resolveCredential = () => ({ body: { ...GRANT, delegation, expires_at: undefined } });
      const got = await client.resolveExternalCredential({ userId: "u-1", provider: "github" });
      assert.equal(got.delegation, false, String(delegation));
      assert.equal(got.expiresAt, null);
    }
  });
});

test("not_bound and expired are decisions, not outages", async () => {
  await withHarness(async ({ fake, client, metrics }) => {
    for (const [status, code] of [[404, "not_bound"], [410, "expired"]] as const) {
      fake.resolveCredential = () => ({ status, body: { error: code } });
      await assert.rejects(client.resolveExternalCredential({ userId: "u-1", provider: "github" }), (err: unknown) => {
        assert.ok(err instanceof IdentityCredentialRefusedError, String(err));
        assert.equal(err.code, code);
        assert.equal(err.status, status);
        return true;
      });
    }
    assert.equal(metrics.upstreamCount("credential", "refused"), 2);
  });
});

test("every way of not getting an answer is unavailable, never a refusal", async () => {
  await withHarness(async ({ fake, client }) => {
    const cases: Array<[string, () => import("./identity-fake.js").Reply, string]> = [
      ["a 5xx", () => ({ status: 503, body: "down" }), "http_5xx"],
      ["a 429", () => ({ status: 429, body: "slow down" }), "rate_limited"],
      ["our client being refused", () => ({ status: 401, body: { error: "invalid_client" } }), "client_rejected"],
      ["a 403", () => ({ status: 403, body: "no" }), "client_rejected"],
      ["a 4xx with no OAuth body", () => ({ status: 404, body: "<html>" }), "http_4xx"],
      ["a 200 that is not JSON", () => ({ body: "ok" }), "bad_response"],
      ["a 200 with no token", () => ({ body: { ...GRANT, token: "" } }), "bad_response"],
      ["a dropped connection", () => ({ destroy: true }), "network"],
      ["a redirect", () => ({ status: 302, headers: { Location: "http://127.0.0.1:1/x" } }), "network"],
    ];
    for (const [name, reply, reason] of cases) {
      fake.resolveCredential = reply;
      await assert.rejects(client.resolveExternalCredential({ userId: "u-1", provider: "github" }), (err: unknown) => {
        assert.ok(err instanceof IdentityUnavailableError, `${name}: ${String(err)}`);
        assert.equal(err.reason, reason, name);
        return true;
      });
    }
  });
});

test("a user id and a provider are required", async () => {
  await withHarness(async ({ fake, client }) => {
    await assert.rejects(client.resolveExternalCredential({ userId: "", provider: "github" }), TypeError);
    await assert.rejects(client.resolveExternalCredential({ userId: "u-1", provider: "" }), TypeError);
    assert.equal(fake.requests.length, 0);
  });
});

test("the resolve address is taken from the token endpoint, pinned when told, and the issuer's own otherwise", async () => {
  const fake = await FakeIdentity.start();
  try {
    fake.resolveCredential = () => ({ body: GRANT });
    // Derived: discovery names the token endpoint and the path is swapped.
    const derived = new IdentityClient(settingsFor(fake), { now: new Clock().now });
    await derived.resolveExternalCredential({ userId: "u-1", provider: "github" });
    assert.equal(fake.count("/oauth/external-credentials/resolve"), 1);
    // Pinned: the operator's address wins, and no discovery is needed for it.
    const pinned = new IdentityClient(settingsFor(fake, { tokenUrl: "http://127.0.0.1:1/oauth/token", credentialResolveUrl: `${fake.issuer}/oauth/external-credentials/resolve` }), { now: new Clock().now });
    await pinned.resolveExternalCredential({ userId: "u-1", provider: "github" });
    assert.equal(fake.count("/oauth/external-credentials/resolve"), 2);
    // A token endpoint that does not end in /oauth/token: the issuer's path.
    const other = new IdentityClient(settingsFor(fake, { tokenUrl: "http://127.0.0.1:1/somewhere/else" }), { now: new Clock().now });
    await other.resolveExternalCredential({ userId: "u-1", provider: "github" });
    assert.equal(fake.count("/oauth/external-credentials/resolve"), 3);
  } finally {
    await fake.close();
  }
});

test("IDENTITY_CREDENTIAL_RESOLVE_URL is read, and a bad one refuses the client", () => {
  const base = { IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: "https://id.example.com", IDENTITY_CLIENT_ID: "svc-a", IDENTITY_CLIENT_SECRET: "s" };
  const ok = readIdentityConfig({ ...base, IDENTITY_CREDENTIAL_RESOLVE_URL: "http://identity.svc:8080/oauth/external-credentials/resolve" });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.settings?.credentialResolveUrl, "http://identity.svc:8080/oauth/external-credentials/resolve");
  assert.equal(readIdentityConfig(base).settings?.credentialResolveUrl, undefined);
  const bad = readIdentityConfig({ ...base, IDENTITY_CREDENTIAL_RESOLVE_URL: "https://u:p@id.example.com/x" });
  assert.equal(bad.settings, null);
  assert.match(bad.errors.join(), /IDENTITY_CREDENTIAL_RESOLVE_URL/);
});
