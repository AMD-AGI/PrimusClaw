// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who may answer a held merge, through the real authentication hook over real HTTP.
 *
 * A session's sandbox holds its owner's own key (`SAFE_API_KEY`, `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`). In a session that acts as its owner a model that has just been given a
 * `confirmation_id` could answer it itself with that key. And the key reaches SaFE, whose built-in
 * sign-in lets an `ak-` key set the owner's password and then log in with it: the session cookie that
 * returns is verified as the person's own browser session. The decision route therefore takes neither a
 * key nor a cookie: the way the caller was authenticated is read from what the real hook recorded, not
 * from a stand-in, and only an identity provider's access token is a person's answer (the person's own
 * and an allowed service's are in github-review-decision-service.test.ts).
 *
 *   X1  the key a sandbox holds, as `Authorization: Bearer` and as `x-api-key`, is refused and the confirmation is untouched
 *   X2  the sandbox's key signs itself in at SaFE (the two requests that did it) and its cookie is refused, for an allow and for a deny
 *   X3  the same goes for a browser session of the person, whoever it is
 *   X4  a key in the query string is no credential here at all
 *
 * The environment is set before the modules that read it at load time are imported.
 */
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

const PR = "AMD-AGI/demo#7";

/**
 * SaFE as far as authentication uses it: `ak-<id>` and `Token=ck-<id>` verify to user `<id>`; the calls are counted.
 *
 * Its built-in sign-in is there too, as it is in a default deployment: `PATCH /api/v1/users/<id>` with that user's own `ak-` key sets the
 * password (no current password is asked: the default role lets an owner update their own user), and `POST /api/v1/login` with the password
 * returns a session token, which `verify` accepts as a cookie. That is the whole of what a sandbox holding `SAFE_API_KEY` needs.
 */
async function startSafe(): Promise<{ url: string; calls: string[]; close(): Promise<void> }> {
  const calls: string[] = [];
  const passwords = new Map<string, string>();
  const minted = new Map<string, string>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const json = (status: number, value: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const q = JSON.parse(body || "{}") as { apiKey?: string; cookie?: string; password?: string; name?: string };
      const patched = /^\/api\/v1\/users\/([^/]+)$/.exec(req.url ?? "");
      if (req.method === "PATCH" && patched) {
        calls.push("set_password");
        const key = /^Bearer (ak-.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
        if (!key || key !== `ak-${patched[1]}` || !q.password) return json(401, {});
        passwords.set(patched[1] as string, q.password);
        return json(200, {});
      }
      if (req.method === "POST" && req.url === "/api/v1/login") {
        calls.push("login");
        if (!q.name || !q.password || passwords.get(q.name) !== q.password) return json(401, {});
        const token = `sess-${minted.size + 1}`;
        minted.set(token, q.name);
        return json(200, { data: { Token: token } });
      }
      calls.push(q.apiKey ? "api_key" : "cookie");
      const fromCookie = /Token=([^;]+)/.exec(q.cookie ?? "")?.[1];
      const id = q.apiKey?.startsWith("ak-") ? q.apiKey.slice(3) : fromCookie?.startsWith("ck-") ? fromCookie.slice(3) : minted.get(fromCookie ?? "");
      if (!id || !["u-bob", "u-alice"].includes(id)) return json(401, {});
      json(200, { data: { id, name: id, roles: ["default"], platformKey: "", virtualKey: `vk-${id}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

describe("a held merge is answered by a signed-in person, not by a key", () => {
  let safe: Awaited<ReturnType<typeof startSafe>>;
  let app: FastifyInstance;
  let base = "";
  let env: import("./support/review-env.js").ReviewEnv;
  let closeShared: () => Promise<void>;
  let reviewEnv: typeof import("./support/review-env.js").reviewEnv;
  let credential: typeof import("./support/review-env.js").credential;
  let HEAD = "";

  before(async () => {
    safe = await startSafe();
    Object.assign(process.env, { SAFE_API_URL: safe.url, AUTH_INTERNAL_TOKEN: "t" });
    delete process.env.CLAW_DEPLOY_MODE;
    delete process.env.CLAW_INSECURE_DEV_AUTH;
    delete process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED;
    ({ closeShared, reviewEnv, credential } = await import("./support/review-env.js"));
    ({ HEAD } = await import("./support/fake-github.js"));
  });
  after(async () => {
    await app?.close();
    await safe?.close();
    await closeShared?.();
  });

  /** The routes behind the real authentication hook, on a service and a fake GitHub of their own. */
  async function boot(): Promise<void> {
    await app?.close();
    const { authMiddleware } = await import("../src/auth/middleware.js");
    const { registerGithubReviewRoutes } = await import("../src/github-review/mcp.js");
    env = await reviewEnv();
    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    await registerGithubReviewRoutes(app, { enabled: true, settings: () => env.settings, db: env.db, service: env.service });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  }

  /** A merge held for `u-bob` (the acting user), asked for by `u-alice`, as the first test of the confirmation group sets it up. */
  async function hold(): Promise<string> {
    await boot();
    env.identity.answer = async () => credential({ delegation: true });
    env.gh.files = [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" }];
    env.gh.graphql.mergeStateStatus = "BLOCKED";
    env.gh.onReview = (r) => { if (r.event === "APPROVE") env.gh.graphql.mergeStateStatus = "CLEAN"; };
    const held = await env.service.mergePr(env.actor, { pr: PR, head_sha: HEAD });
    assert.equal(held.body.status, "confirmation_required");
    return held.body.confirmation_id as string;
  }
  const status = async (id: string) => (await env.sql("SELECT status FROM claw_github_confirmations WHERE confirmation_id = $1", [id]))[0]?.status;
  const puts = () => env.gh.calls.filter((c) => c.method === "PUT").length;
  async function decide(id: string, headers: Record<string, string>, decision: string = "allow", query = ""): Promise<{ status: number; body: any }> {
    const r = await fetch(`${base}/v1/github-review/confirmations/${id}/decision${query}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ decision }),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  }

  test("X1 the acting user's own key, the one the sandbox holds, gets 403 as a Bearer key and as an x-api-key, whatever it says, and nothing happens", async () => {
    const id = await hold();
    for (const headers of [{ authorization: "Bearer ak-u-bob" }, { "x-api-key": "ak-u-bob" }]) {
      for (const decision of ["allow", "deny"]) {
        const r = await decide(id, headers, decision);
        assert.equal(r.status, 403, `${Object.keys(headers)[0]} ${decision}`);
        assert.equal(r.body.error, "interactive_sign_in_required");
      }
    }
    assert.equal(safe.calls.includes("api_key"), true, "the key was verified as the acting user's: it is the method that is refused, not the key");
    assert.equal(await status(id), "pending");
    assert.equal(env.gh.writes.length, 0);
    assert.equal(puts(), 0);
  });

  test("X2 the sandbox's key signs itself in at SaFE, and the session cookie it gets is no answer: an allow and a deny are refused, and nothing happens", async () => {
    const id = await hold();
    const key = "ak-u-bob"; // what the sandbox holds as SAFE_API_KEY, next to SAFE_API_URL
    const password = "chosen-by-the-model";
    const set = await fetch(`${safe.url}/api/v1/users/u-bob`, { method: "PATCH", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(set.status, 200, "SaFE lets the key set the password");
    const login = await fetch(`${safe.url}/api/v1/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "u-bob", password }) });
    assert.equal(login.status, 200, "and then signs in with it");
    const token = ((await login.json()) as { data: { Token: string } }).data.Token;
    for (const decision of ["allow", "deny"]) {
      const r = await decide(id, { cookie: `Token=${token}` }, decision);
      assert.equal(r.status, 403, decision);
      assert.equal(r.body.error, "interactive_sign_in_required");
    }
    assert.equal(safe.calls.at(-1), "cookie", "the cookie was verified by SaFE as the acting user's own session: it is the way it was obtained that is refused");
    assert.equal(await status(id), "pending");
    assert.equal(env.gh.writes.length, 0);
    assert.equal(puts(), 0);
  });

  test("X3 a browser session of the person is no answer either, whoever it is: the credential is judged before the confirmation is looked up", async () => {
    const id = await hold();
    for (const user of ["u-bob", "u-alice"]) {
      const r = await decide(id, { cookie: `Token=ck-${user}` });
      assert.equal(r.status, 403, user);
      assert.equal(r.body.error, "interactive_sign_in_required");
    }
    assert.equal((await decide("00000000-0000-4000-8000-000000000000", { cookie: "Token=ck-u-bob" })).status, 403);
    assert.equal(await status(id), "pending");
    assert.equal(puts(), 0);
  });

  test("X4 a key in the query string is no credential on this route", async () => {
    const id = await hold();
    const viaQuery = await decide(id, {}, "allow", "?token=ak-u-bob");
    assert.equal(viaQuery.status, 401);
    assert.equal(await status(id), "pending");
    assert.equal(puts(), 0);
  });
});
