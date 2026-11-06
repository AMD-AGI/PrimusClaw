// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The delivery link in the kubernetes/BYOK mode, through the real authentication
 * hook. The caller's BYOK key is the key the session's sandbox holds, so it is
 * not a sign-in and the owner presenting it is refused; an identity-provider
 * token is one and is served. This is why Brain leaves `deliver_file` off by
 * default in this mode (brain/src/config.ts): without identity tokens no owner
 * could follow the link. Its own file because the deploy mode is read at import.
 *
 *   DK1 the owner's BYOK key: 403 interactive_sign_in_required, nothing looked up
 *   DK2 the owner's identity token: the file
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

import { FakeIdentity, signJwt, testKey } from "../../utils/test/identity-fake.js";
import { sendJson, startFakeUpstream, type FakeUpstream } from "./support/fake-upstream.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");
const BYOK_KEY = "sk-owner";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const BODY = Buffer.from("report");

let gateway: FakeUpstream;
let fake: FakeIdentity;
let app: FastifyInstance;
let h: Awaited<ReturnType<typeof import("./scenario-harness.js").startHarness>>;
let seedSession: typeof import("./scenario-harness.js").seedSession;
let byokOwner = "";
let asked: string[] = [];
const originalSend = S3Client.prototype.send;

before(async () => {
  gateway = await startFakeUpstream((req, res) =>
    String(req.headers.authorization) === `Bearer ${BYOK_KEY}` ? sendJson(res, 200, { data: [] }) : sendJson(res, 401, { error: "bad key" }));
  fake = await FakeIdentity.start();
  fake.jwks = () => ({ body: { keys: [es.jwk] } });
  process.env.APP_ENV = "production";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "kubernetes";
  delete process.env.SAFE_API_URL;
  delete process.env.CLAW_REQUIRED_PLATFORM_ROLES;
  process.env.AUTH_INTERNAL_TOKEN = "internal-token-for-tests";
  process.env.OPENAI_BASE_URL = gateway.url;
  process.env.BYOK_VERIFY_API_STYLE = "openai";
  for (const k of ["BYOK_VERIFY_MODELS_URL", "MEMORY_LLM_BASE_URL", "ANTHROPIC_BASE_URL", "LLM_KEY_SOURCE"]) delete process.env[k];
  Object.assign(process.env, {
    IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
    CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true",
  });

  const { startIdentityClient } = await import("../src/auth/identity.js");
  startIdentityClient({ info() {}, warn() {}, error() {} });
  const { authMiddleware } = await import("../src/auth/middleware.js");
  const { isKubernetesMode } = await import("../src/config.js");
  assert.ok(isKubernetesMode(), "this file tests the Kubernetes mode");
  const { deriveByokUserId } = await import("../src/auth/byok.js");
  byokOwner = await deriveByokUserId(BYOK_KEY);
  const harness = await import("./scenario-harness.js");
  seedSession = harness.seedSession;
  h = await harness.startHarness();

  S3Client.prototype.send = (async function (command: unknown) {
    if (command instanceof ListObjectsV2Command) {
      asked.push(`list ${command.input.Prefix}`);
      return { Contents: [{ Key: `${command.input.Prefix}report.csv`, LastModified: new Date(), Size: BODY.length }] };
    }
    if (command instanceof GetObjectCommand) {
      asked.push(`get ${command.input.Key}`);
      return { Body: Readable.from([BODY]), ContentLength: BODY.length };
    }
    throw new Error(`unexpected ${(command as object).constructor.name}`);
  }) as typeof S3Client.prototype.send;

  const { registerSessionDeliveryRoutes } = await import("../src/routes/session-deliveries.js");
  app = Fastify();
  await app.register((await import("@fastify/cookie")).default);
  app.addHook("preHandler", authMiddleware);
  await registerSessionDeliveryRoutes(app);
  await app.ready();
});
after(async () => {
  S3Client.prototype.send = originalSend;
  await app?.close();
  await h?.close();
  await Promise.all([gateway?.close(), fake?.close()]);
});
beforeEach(async () => {
  await h.reset();
  asked = [];
});

const idToken = (sub: string) => `Bearer ${signJwt({
  key: es,
  claims: {
    iss: fake.issuer, aud: "claw-api", sub, scope: "openid claw.api", name: sub,
    jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300,
  },
})}`;

test("DK1 the owner's BYOK key is the sandbox's key, not a sign-in: 403 and nothing looked up", async () => {
  await seedSession(h, "s-byok", { userId: byokOwner, agentStatus: "idle" });
  for (const headers of [{ authorization: `Bearer ${BYOK_KEY}` }, { "x-api-key": BYOK_KEY }]) {
    const res = await app.inject({ method: "GET", url: `/v1/sessions/s-byok/deliveries/${ID}`, headers });
    assert.equal(res.statusCode, 403, JSON.stringify(headers));
    assert.equal(res.json().error, "interactive_sign_in_required");
  }
  assert.deepEqual(asked, []);
});

test("DK2 the owner's identity token is a sign-in: the file", async () => {
  await seedSession(h, "s-idp", { userId: "web-user", agentStatus: "idle" });
  const res = await app.inject({ method: "GET", url: `/v1/sessions/s-idp/deliveries/${ID}`, headers: { authorization: idToken("web-user") } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.rawPayload, BODY);
  assert.deepEqual(asked, [`list users/web-user/sessions/s-idp/.deliveries/${ID}/`, `get users/web-user/sessions/s-idp/.deliveries/${ID}/report.csv`]);
});
