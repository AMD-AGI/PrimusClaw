// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who presented the token. A service that acts for a user gets an access token
 * through RFC 8693 token exchange: `sub` is the user, `act.sub` the service, and
 * `client_id` the client the token was issued to. The caller is the user, as it
 * always was; the actor and the client are recorded beside it, for the audit
 * trail, and grant nothing.
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";

import { FakeIdentity, activeAnswer, signJwt, testKey } from "../../utils/test/identity-fake.js";
import { verifyIdentityAccessToken } from "../src/auth/identity-token.js";
import { startIdentityClient } from "../src/auth/identity.js";
import type { CredentialOutcome } from "../src/auth/middleware.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");
const log = { info() {}, warn() {}, error() {} };
let fake: FakeIdentity;

before(async () => {
  fake = await FakeIdentity.start();
  fake.jwks = () => ({ body: { keys: [es.jwk] } });
  fake.introspect = (r) => ({ body: activeAnswer({ sub: JSON.parse(Buffer.from((r.form.get("token") ?? "").split(".")[1], "base64url").toString()).sub }) });
});
after(async () => { await fake.close(); });
beforeEach(() => {
  Object.assign(process.env, {
    IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw",
    IDENTITY_CLIENT_SECRET: "s3cret", CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true",
  });
  startIdentityClient(log);
});

const mint = (over: Record<string, unknown> = {}): string => {
  const claims: Record<string, unknown> = {
    iss: fake.issuer, aud: "claw-api", sub: "u-1", client_id: "dispatron", scope: "claw.api",
    jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
  };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return signJwt({ key: es, claims });
};

async function user(token: string) {
  const req = { headers: { authorization: `Bearer ${token}` } } as unknown as FastifyRequest;
  const out: CredentialOutcome = await verifyIdentityAccessToken(req, null, "/a2a");
  assert.equal(out.status, "verified", JSON.stringify(out));
  return (out as Extract<CredentialOutcome, { status: "verified" }>).user;
}

describe("the actor and the client are recorded, and the user is still the user", () => {
  const cases: Array<[string, Record<string, unknown>, { actorSub?: string; clientId?: string } | undefined]> = [
    ["an exchanged token names both", { act: { sub: "svc-dispatch" } }, { actorSub: "svc-dispatch", clientId: "dispatron" }],
    ["a token with no actor names its client", {}, { clientId: "dispatron" }],
    ["a token with neither says nothing", { client_id: undefined }, undefined],
    ["a blank actor is no actor", { act: { sub: "  " } }, { clientId: "dispatron" }],
    ["an actor that is not an object is ignored", { act: "svc-dispatch" }, { clientId: "dispatron" }],
    ["an actor with a non-string sub is ignored", { act: { sub: 7 } }, { clientId: "dispatron" }],
    ["a client id that is not a string is ignored", { client_id: 7 }, undefined],
  ];
  for (const [name, claims, want] of cases) {
    test(name, async () => {
      const u = await user(mint(claims));
      assert.equal(u.userId, "u-1", "the caller is the subject, whatever the actor");
      assert.deepEqual(u.delegation, want);
      assert.deepEqual(u.roles, ["default"], "and the actor brings no role");
    });
  }

  test("the actor is clipped, the client id is the whole claim", async () => {
    const u = await user(mint({ act: { sub: "a".repeat(500) }, client_id: "c".repeat(500) }));
    assert.equal(u.delegation?.actorSub?.length, 128);
    // An allowlist compares it: two clients whose ids share a prefix are two clients.
    assert.equal(u.delegation?.clientId, "c".repeat(500));
  });
});
