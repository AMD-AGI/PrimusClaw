// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The deployment's read-only GitHub App (`github-mcp/public-read.ts`), with GitHub stood in for.
 *
 *   R1 its settings are all three or none: none is no App; some is refused at start, as is an id that is not a number or a key that
 *      cannot be read or is not a PEM private key
 *   R2 a token is asked for with the App's own token (RS256, signed with its key, issued by its id, ten minutes at most) for that
 *      installation, with metadata: read alone
 *   R3 a token is kept until five minutes before it expires, made once for callers that ask at the same time, and made again once
 *      dropped (GitHub answered 401 with it)
 *   R4 a token that comes back with any permission but metadata: read, an answer that is not 201, or no token is never used, and
 *      a token that came back but is not used is revoked
 *   R5 with CLAW_GITHUB_PUBLIC_READ_REPOSITORIES a token is asked for those repositories alone, and one that reaches a repository
 *      GitHub does not say is public, or others than those asked for, is revoked and never used
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, test } from "node:test";

import { PublicReadTokens, publicReadConfigErrors, readPublicReadSettings } from "../src/github-mcp/public-read.js";

const API = "https://github.api.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ENV = { CLAW_GITHUB_PUBLIC_READ_APP_ID: "123", CLAW_GITHUB_PUBLIC_READ_INSTALLATION_ID: "456", CLAW_GITHUB_PUBLIC_READ_KEY_FILE: "/k.pem" };

function github(answer: (n: number) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; auth: string; body: unknown }> = [];
  const revoked: string[] = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const auth = new Headers(init.headers).get("authorization") ?? "";
    if (init.method === "DELETE") {
      assert.equal(String(input), `${API}/installation/token`);
      revoked.push(auth);
      return new Response(null, { status: 204 });
    }
    calls.push({ url: String(input), auth, body: JSON.parse(String(init.body)) });
    await new Promise((r) => setTimeout(r, 5));
    const a = answer(calls.length);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, revoked, fetchImpl };
}
const minted = (n: number, expires = "2026-11-09T16:00:00Z", permissions: unknown = { metadata: "read" }, repositories?: unknown) =>
  ({ status: 201, body: { token: `ghs_token${n}`, expires_at: expires, permissions, repository_selection: "selected", ...(repositories ? { repositories } : {}) } });

describe("the deployment's read-only GitHub App", () => {
  test("R1 all three settings or none", () => {
    assert.equal(readPublicReadSettings({}), null);
    assert.deepEqual(publicReadConfigErrors({}), []);
    assert.deepEqual(readPublicReadSettings(ENV), { appId: "123", installationId: "456", keyFile: "/k.pem" });
    assert.deepEqual(publicReadConfigErrors(ENV, () => PEM), []);
    const partial = publicReadConfigErrors({ CLAW_GITHUB_PUBLIC_READ_APP_ID: "123" }, () => PEM);
    assert.equal(partial.length, 1);
    assert.match(partial[0]!, /CLAW_GITHUB_PUBLIC_READ_INSTALLATION_ID, CLAW_GITHUB_PUBLIC_READ_KEY_FILE must be set/);
    assert.equal(readPublicReadSettings({ CLAW_GITHUB_PUBLIC_READ_APP_ID: "123" }), null);
    assert.deepEqual(publicReadConfigErrors({ ...ENV, CLAW_GITHUB_PUBLIC_READ_APP_ID: "app" }, () => PEM), ["CLAW_GITHUB_PUBLIC_READ_APP_ID must be a number"]);
    assert.deepEqual(publicReadConfigErrors(ENV, () => { throw new Error("ENOENT"); }), ["CLAW_GITHUB_PUBLIC_READ_KEY_FILE cannot be read"]);
    assert.deepEqual(publicReadConfigErrors(ENV, () => "not a key"), ["CLAW_GITHUB_PUBLIC_READ_KEY_FILE does not hold a PEM private key"]);
    assert.deepEqual(readPublicReadSettings({ ...ENV, CLAW_GITHUB_PUBLIC_READ_REPOSITORIES: " Hyperloom , Other " })?.repositories, ["Hyperloom", "Other"]);
    assert.deepEqual(publicReadConfigErrors({ ...ENV, CLAW_GITHUB_PUBLIC_READ_REPOSITORIES: "Hyperloom" }, () => PEM), []);
    assert.deepEqual(publicReadConfigErrors({ ...ENV, CLAW_GITHUB_PUBLIC_READ_REPOSITORIES: "AMD-AGI/Hyperloom" }, () => PEM),
      ["CLAW_GITHUB_PUBLIC_READ_REPOSITORIES must be repository names (no owner), separated by commas"]);
    assert.equal(publicReadConfigErrors({ CLAW_GITHUB_PUBLIC_READ_REPOSITORIES: "Hyperloom" }).length, 1, "repositories alone are refused");
  });

  test("R2 a token is asked for with the App's own signed token, for metadata: read alone", async () => {
    const gh = github((n) => minted(n));
    const now = Date.parse("2026-11-09T15:00:00Z");
    const tokens = new PublicReadTokens(readPublicReadSettings(ENV)!, API, { fetchImpl: gh.fetchImpl, now: () => now, readKey: async () => PEM });
    assert.equal(await tokens.token(), "ghs_token1");
    assert.equal(gh.calls.length, 1);
    assert.equal(gh.calls[0]!.url, `${API}/app/installations/456/access_tokens`);
    assert.deepEqual(gh.calls[0]!.body, { permissions: { metadata: "read" } });
    const jwt = gh.calls[0]!.auth.replace(/^Bearer /, "");
    const [h, p, sig] = jwt.split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    assert.equal(claims.iss, "123");
    assert.ok(claims.exp - claims.iat <= 600 && claims.iat <= now / 1000 && claims.exp > now / 1000);
    assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig!, "base64url")), "signed with the App's key");
    assert.equal(JSON.stringify(tokens), "{}");
    assert.equal(String(tokens), "[PublicReadTokens]");
  });

  test("R3 a token is kept until shortly before it expires, made once at a time, and made again once dropped", async () => {
    const gh = github((n) => minted(n, n === 1 ? "2026-11-09T16:00:00Z" : "2026-11-09T17:00:00Z"));
    let now = Date.parse("2026-11-09T15:00:00Z");
    const tokens = new PublicReadTokens(readPublicReadSettings(ENV)!, API, { fetchImpl: gh.fetchImpl, now: () => now, readKey: async () => PEM });
    assert.deepEqual(await Promise.all([tokens.token(), tokens.token(), tokens.token()]), ["ghs_token1", "ghs_token1", "ghs_token1"]);
    assert.equal(gh.calls.length, 1, "one token for callers at the same time");
    now = Date.parse("2026-11-09T15:54:59Z");
    assert.equal(await tokens.token(), "ghs_token1");
    now = Date.parse("2026-11-09T15:55:00Z");
    assert.equal(await tokens.token(), "ghs_token2", "made again five minutes before it expires");
    tokens.drop("ghs_token1");
    assert.equal(await tokens.token(), "ghs_token2", "dropping another token keeps this one");
    tokens.drop("ghs_token2");
    assert.equal(await tokens.token(), "ghs_token3");
    assert.equal(gh.calls.length, 3);
  });

  test("R4 a token with any other permission, a refusal or no token is never used", async () => {
    const make = (answer: (n: number) => { status: number; body: unknown }) => {
      const gh = github(answer);
      return { gh, tokens: new PublicReadTokens(readPublicReadSettings(ENV)!, API, { fetchImpl: gh.fetchImpl, now: () => Date.parse("2026-11-09T15:00:00Z"), readKey: async () => PEM }) };
    };
    for (const permissions of [{ metadata: "read", issues: "write" }, { metadata: "read", issues: "read" }, { metadata: "write" }, { contents: "read" }, {}, null]) {
      const { gh, tokens } = make((n) => minted(n, "2026-11-09T16:00:00Z", permissions));
      await assert.rejects(tokens.token(), /permissions other than metadata: read/, JSON.stringify(permissions));
      assert.deepEqual(gh.revoked, ["token ghs_token1"], `revoked: ${JSON.stringify(permissions)}`);
    }
    await assert.rejects(make(() => ({ status: 422, body: { message: "no" } })).tokens.token(), /GitHub answered 422/);
    await assert.rejects(make(() => ({ status: 201, body: { expires_at: "2026-11-09T16:00:00Z", permissions: { metadata: "read" } } })).tokens.token(), /no token/);
    // A refusal is not kept: the next call asks again.
    const { gh, tokens } = make((n) => (n === 1 ? { status: 500, body: {} } : minted(n)));
    await assert.rejects(tokens.token());
    assert.equal(await tokens.token(), "ghs_token2");
    assert.equal(gh.calls.length, 2);
  });

  test("R5 a token limited to the named repositories, and refused when it reaches more or anything not public", async () => {
    const env = { ...ENV, CLAW_GITHUB_PUBLIC_READ_REPOSITORIES: "Hyperloom" };
    const make = (answer: (n: number) => { status: number; body: unknown }) => {
      const gh = github(answer);
      return { gh, tokens: new PublicReadTokens(readPublicReadSettings(env)!, API, { fetchImpl: gh.fetchImpl, now: () => Date.parse("2026-11-09T15:00:00Z"), readKey: async () => PEM }) };
    };
    const hl = { name: "Hyperloom", full_name: "AMD-AGI/Hyperloom", private: false };
    const ok = make((n) => minted(n, undefined, undefined, [hl]));
    assert.equal(await ok.tokens.token(), "ghs_token1");
    assert.deepEqual(ok.gh.calls[0]!.body, { permissions: { metadata: "read" }, repositories: ["Hyperloom"] });
    assert.deepEqual(ok.gh.revoked, []);
    for (const repositories of [[{ ...hl, private: true }], [{ name: "Hyperloom", full_name: "AMD-AGI/Hyperloom" }], [hl, { name: "Other", full_name: "AMD-AGI/Other", private: false }], [{ name: "Other", full_name: "AMD-AGI/Other", private: false }], []]) {
      const { gh, tokens } = make((n) => minted(n, undefined, undefined, repositories));
      await assert.rejects(tokens.token(), /it is not used/, JSON.stringify(repositories));
      assert.deepEqual(gh.revoked, ["token ghs_token1"], JSON.stringify(repositories));
    }
    // Not limited by name: a token GitHub says reaches a private repository is refused all the same.
    const gh = github((n) => minted(n, undefined, undefined, [{ ...hl, private: true }]));
    const tokens = new PublicReadTokens(readPublicReadSettings(ENV)!, API, { fetchImpl: gh.fetchImpl, now: () => Date.parse("2026-11-09T15:00:00Z"), readKey: async () => PEM });
    await assert.rejects(tokens.token(), /a repository GitHub does not say is public/);
    assert.deepEqual(gh.calls[0]!.body, { permissions: { metadata: "read" } });
  });
});
