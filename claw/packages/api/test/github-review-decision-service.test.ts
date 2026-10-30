// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A service answering a held merge for the user it acts for, through the real authentication hook over real HTTP.
 *
 * A chat integration (Clawy's worker) is a service client of the identity provider. When a person presses Merge on their card it exchanges its
 * own client credentials for an access token that acts as that person (RFC 8693: `sub` is the user, `act.sub` and `client_id` the
 * service) and calls Claw with it. Claw takes that only from a client an operator has named
 * (`CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS`), only for the user the token names, and records who stood behind the answer.
 *
 *   S1  an allowed service client answers for the acting user: an allow merges once, and the record names the user and the service
 *   S2  a deny is final, and recorded the same way
 *   S3  a client that is not named is refused, and so is every client while the list is empty; ids are compared exactly
 *   S4  an allowed client holds a token for someone else: refused, nothing happens
 *   S5  the key a sandbox holds is refused with a service allowed, as a Bearer key and as an x-api-key
 *   S6  a person's own access token (no actor in it) is still the person's answer
 *   S7  a token that names an actor and no client is refused; the service's own token (its own subject) cannot answer
 *   S8  the classifier, as a table
 *
 * The environment is set before the modules that read it at load time are imported.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { FakeIdentity, signJwt, testKey } from "../../utils/test/identity-fake.js";

const PR = "AMD-AGI/demo#7";
const CLAWY = "clawy-worker";
const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");
const log = { info() {}, warn() {}, error() {} };

/** SaFE as far as authentication uses it: `ak-<id>` and `Token=ck-<id>` verify to user `<id>`. */
async function startSafe(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const q = JSON.parse(body || "{}") as { apiKey?: string; cookie?: string };
      const id = q.apiKey?.startsWith("ak-") ? q.apiKey.slice(3) : /Token=ck-([^;]+)/.exec(q.cookie ?? "")?.[1];
      if (!id || !["u-bob", "u-alice"].includes(id)) { res.writeHead(401).end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { id, name: id, roles: ["default"], platformKey: "", virtualKey: `vk-${id}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

describe("a service an operator allowed answers a held merge for the user its token names", () => {
  let safe: Awaited<ReturnType<typeof startSafe>>;
  let fake: FakeIdentity;
  let app: FastifyInstance;
  let base = "";
  let env: import("./support/review-env.js").ReviewEnv;
  let closeShared: () => Promise<void>;
  let reviewEnv: typeof import("./support/review-env.js").reviewEnv;
  let credential: typeof import("./support/review-env.js").credential;
  let HEAD = "";

  before(async () => {
    safe = await startSafe();
    fake = await FakeIdentity.start();
    fake.jwks = () => ({ body: { keys: [es.jwk] } });
    Object.assign(process.env, {
      SAFE_API_URL: safe.url, AUTH_INTERNAL_TOKEN: "t",
      IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
      CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true",
    });
    delete process.env.CLAW_DEPLOY_MODE;
    delete process.env.CLAW_INSECURE_DEV_AUTH;
    delete process.env.CLAW_IDENTITY_TOKEN_INTROSPECT;
    const { startIdentityClient } = await import("../src/auth/identity.js");
    startIdentityClient(log);
    ({ closeShared, reviewEnv, credential } = await import("./support/review-env.js"));
    ({ HEAD } = await import("./support/fake-github.js"));
  });
  after(async () => {
    await app?.close();
    await fake?.close();
    await safe?.close();
    await closeShared?.();
  });

  /** An access token as the identity provider issues it. An exchanged one (a service acting for a user) carries `bid` and `act`; a person's own grant carries `gid`. */
  const exchanged = (sub: string, client: string | undefined = CLAWY, over: Record<string, unknown> = {}): string => mint({ sub, client_id: client, act: { sub: client ?? CLAWY }, bid: 7, ...over });
  const personal = (sub: string): string => mint({ sub, client_id: "claw-web", gid: "g-1" });
  function mint(over: Record<string, unknown>): string {
    const claims: Record<string, unknown> = {
      iss: fake.issuer, aud: "claw-api", scope: "openid claw.api", jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
    };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    return signJwt({ key: es, claims });
  }

  /** The routes behind the real authentication hook, on a service and a fake GitHub of their own. */
  async function boot(settings: Record<string, string> = { CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS: CLAWY }): Promise<void> {
    await app?.close();
    const { authMiddleware } = await import("../src/auth/middleware.js");
    const { registerGithubReviewRoutes } = await import("../src/github-review/mcp.js");
    env = await reviewEnv(settings);
    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    await registerGithubReviewRoutes(app, { enabled: true, settings: () => env.settings, db: env.db, service: env.service });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }

  /** A merge held for `u-bob` (the acting user), asked for by `u-alice`. */
  async function hold(settings?: Record<string, string>): Promise<string> {
    await boot(settings);
    env.identity.answer = async () => credential({ delegation: true });
    env.gh.files = [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" }];
    env.gh.graphql.mergeStateStatus = "BLOCKED";
    env.gh.onReview = (r) => { if (r.event === "APPROVE") env.gh.graphql.mergeStateStatus = "CLEAN"; };
    const held = await env.service.mergePr(env.actor, { pr: PR, head_sha: HEAD });
    assert.equal(held.body.status, "confirmation_required");
    return held.body.confirmation_id as string;
  }
  const row = async (id: string) => (await env.sql("SELECT status, decided_by, decided_via, result FROM claw_github_confirmations WHERE confirmation_id = $1", [id]))[0] as Record<string, any>;
  const puts = () => env.gh.calls.filter((c) => c.method === "PUT").length;
  async function decide(id: string, headers: Record<string, string>, decision: string = "allow"): Promise<{ status: number; body: any }> {
    const r = await fetch(`${base}/v1/github-review/confirmations/${id}/decision`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ decision }),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  test("S1 an allowed service client answers for the acting user: the merge happens once, and the record names the user and the service", async () => {
    const id = await hold();
    const r = await decide(id, bearer(exchanged("u-bob")));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "merged");
    assert.equal(puts(), 1);
    const c = await row(id);
    assert.equal(c.status, "merged");
    assert.equal(c.decided_by, "u-bob", "the subject is the acting user, the person the service acted for");
    assert.deepEqual(c.decided_via, { kind: "service", client_id: CLAWY, act_sub: CLAWY });
    assert.equal(c.result.by, "service");
    assert.equal(c.result.client_id, CLAWY);
    const audit = await env.sql("SELECT arguments FROM claw_github_audit WHERE tool = 'gh_pr_merge' AND arguments ? 'confirmation_id'");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.arguments.decided_by_service, CLAWY, "the audit row of the merge says who answered");
    // Who answered is on the listing too, for the person's own view.
    const listed = await fetch(`${base}/v1/github-review/confirmations?session_id=s-1&status=merged`, { headers: bearer(personal("u-bob")) });
    const items = ((await listed.json()) as any).items as any[];
    assert.deepEqual(items.map((i) => [i.decided_by, i.decided_via?.client_id]), [["u-bob", CLAWY]]);
    // Used once: the same answer again does not merge again.
    const again = await decide(id, bearer(exchanged("u-bob")));
    assert.notEqual(again.body.status, "merged");
    assert.equal(puts(), 1);
  });

  test("S2 a deny by the service is final and recorded the same way", async () => {
    const id = await hold();
    const r = await decide(id, bearer(exchanged("u-bob")), "deny");
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "denied");
    const c = await row(id);
    assert.equal(c.status, "denied");
    assert.deepEqual(c.decided_via, { kind: "service", client_id: CLAWY, act_sub: CLAWY });
    assert.deepEqual(c.result, { by: "service", client_id: CLAWY, act_sub: CLAWY });
    assert.equal(puts(), 0);
    assert.notEqual((await decide(id, bearer(exchanged("u-bob")))).body.status, "merged", "a denied merge cannot be allowed afterwards");
  });

  test("S3 a client that is not named is refused, every client is while the list is empty, and ids are compared exactly", async () => {
    const id = await hold();
    for (const client of ["some-other-service", `${CLAWY}-2`, `${CLAWY}x`, "clawy", CLAWY.toUpperCase(), ` ${CLAWY}`, `${CLAWY} `]) {
      for (const decision of ["allow", "deny"]) {
        const r = await decide(id, bearer(exchanged("u-bob", client)), decision);
        assert.equal(r.status, 403, `${JSON.stringify(client)} ${decision}`);
        assert.equal(r.body.error, "service_client_not_allowed", `${JSON.stringify(client)} ${decision}`);
      }
    }
    assert.equal((await row(id)).status, "pending", "the confirmation is untouched");
    assert.equal(env.gh.writes.length, 0);
    assert.equal(puts(), 0);
    // With nothing named, the client that was allowed a moment ago is refused as well.
    const none = await hold({});
    assert.equal((await decide(none, bearer(exchanged("u-bob")))).body.error, "service_client_not_allowed");
    assert.equal((await row(none)).status, "pending");
    assert.equal(puts(), 0);
  });

  test("S4 an allowed client holding a token for someone else cannot answer: the confirmation is the acting user's", async () => {
    const id = await hold();
    const r = await decide(id, bearer(exchanged("u-alice")));
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "only_the_acting_user_can_decide");
    const c = await row(id);
    assert.equal(c.status, "pending");
    assert.equal(c.decided_via, null);
    assert.equal(puts(), 0);
  });

  test("S5 the key a sandbox holds is refused with a service allowed, as a Bearer key and as an x-api-key, and so is a service's key", async () => {
    const id = await hold();
    for (const headers of [bearer("ak-u-bob"), { "x-api-key": "ak-u-bob" }]) {
      for (const decision of ["allow", "deny"]) {
        const r = await decide(id, headers, decision);
        assert.equal(r.status, 403, `${Object.keys(headers)[0]} ${decision}`);
        assert.equal(r.body.error, "interactive_sign_in_required");
      }
    }
    assert.equal((await row(id)).status, "pending");
    assert.equal(env.gh.writes.length, 0);
    assert.equal(puts(), 0);
  });

  test("S6 a person's own access token (no actor in it) is still the person's answer, recorded as theirs", async () => {
    const id = await hold();
    const r = await decide(id, bearer(personal("u-bob")), "deny");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.status, "denied");
    const c = await row(id);
    assert.equal(c.decided_via, null);
    assert.deepEqual(c.result, { by: "actor" });
    // Naming a service's client id on a token with no actor does not make it a service's: it is a person's, as before, and decides alike.
    const second = await hold();
    assert.equal((await decide(second, bearer(mint({ sub: "u-bob", client_id: CLAWY, gid: "g-1" })), "deny")).status, 200);
    assert.equal((await row(second)).decided_via, null);
  });

  test("S7 a token that names an actor and no client is refused, and the service's own token, whose subject is the service, cannot answer", async () => {
    const id = await hold();
    const noClient = await decide(id, bearer(mint({ sub: "u-bob", act: { sub: CLAWY }, bid: 7 })));
    assert.equal(noClient.status, 403);
    assert.equal(noClient.body.error, "service_client_not_allowed");
    const own = await decide(id, bearer(mint({ sub: CLAWY, client_id: CLAWY, act: { sub: CLAWY }, bid: 7 })));
    assert.equal(own.status, 403);
    assert.equal(own.body.error, "only_the_acting_user_can_decide");
    assert.equal((await row(id)).status, "pending");
    assert.equal(puts(), 0);
  });

  test("S8 the classifier: who is a person, who is a service, who is neither", async () => {
    const { classifyDecisionCaller } = await import("../src/github-review/mcp.js");
    const service = { delegation: { actorSub: CLAWY, clientId: CLAWY } };
    const rows: Array<[string, string | null, Parameters<typeof classifyDecisionCaller>[1], readonly string[], unknown]> = [
      ["a browser session", "cookie", {}, [], { ok: true, via: null }],
      ["a browser session never reads the list, even when its user object carries a delegation", "cookie", service, [], { ok: true, via: null }],
      ["a person's token", "identity_token", { delegation: { clientId: "claw-web" } }, [], { ok: true, via: null }],
      ["a token with no delegation at all", "identity_token", {}, [], { ok: true, via: null }],
      ["an allowed service", "identity_token", service, [CLAWY], { ok: true, via: { clientId: CLAWY, actorSub: CLAWY } }],
      ["a service among several", "identity_token", service, ["a", CLAWY, "b"], { ok: true, via: { clientId: CLAWY, actorSub: CLAWY } }],
      ["a service not on the list", "identity_token", service, ["a"], { ok: false, error: "service_client_not_allowed" }],
      ["a service with the list empty", "identity_token", service, [], { ok: false, error: "service_client_not_allowed" }],
      ["an actor and no client", "identity_token", { delegation: { actorSub: CLAWY } }, [CLAWY], { ok: false, error: "service_client_not_allowed" }],
      ["an api key", "api_key", service, [CLAWY], { ok: false, error: "interactive_sign_in_required" }],
      ["an x-api-key", "x_api_key", service, [CLAWY], { ok: false, error: "interactive_sign_in_required" }],
      ["a connector token", "connector_token", service, [CLAWY], { ok: false, error: "interactive_sign_in_required" }],
      ["no recorded method", null, service, [CLAWY], { ok: false, error: "interactive_sign_in_required" }],
    ];
    for (const [name, method, user, allowed, want] of rows) assert.deepEqual(classifyDecisionCaller(method, user, allowed), want, name);
  });
});
