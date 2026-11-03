// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/sessions/:id/deliveries/:deliveryId`: the link a client gives the user
 * for a file the agent delivered.
 *
 * The real route on a PGlite session table; the object store is the SDK with
 * `send` intercepted, so the key asked for is the one the route built.
 *
 *   D1 the signed-in owner gets the file, named and typed from its name
 *   D2 only a sign-in: every key method (the sandbox holds the owner's key) is 403, before anything is looked up
 *   D3 another user's session, an administrator, a missing session, a malformed id, a missing object: the same 404
 *   D4 past DELIVERY_TTL_DAYS the link is gone (410), the object is not read
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

process.env.CLAW_DEPLOY_MODE = "kubernetes";

const { registerSessionDeliveryRoutes, SIGNED_IN_METHODS } = await import("../src/routes/session-deliveries.js");
const { recordRequestCredential } = await import("../src/auth/request-credential.js");
const { DELIVERY_TTL_DAYS } = await import("../src/config.js");
const { startHarness, seedSession } = await import("./scenario-harness.js");
type Harness = Awaited<ReturnType<typeof startHarness>>;

const OWNER = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
const OTHER = { userId: "u-2", userName: "u-2", roles: ["default"], platformKey: "pk2", virtualKey: "vk2" };
const ADMIN = { userId: "adm", userName: "adm", roles: ["system-admin"], platformKey: "pk3", virtualKey: "vk3" };
const SID = "s-deliver";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const KEY = `users/u-1/sessions/${SID}/.deliveries/${ID}/CPU vs GPU.png`;
const BODY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

let h: Harness;
let objects: Map<string, Date>;
let asked: string[];
const originalSend = S3Client.prototype.send;

before(async () => {
  h = await startHarness();
  S3Client.prototype.send = (async function (command: unknown) {
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      asked.push(`list ${prefix}`);
      return { Contents: [...objects].filter(([k]) => k.startsWith(prefix)).map(([Key, LastModified]) => ({ Key, LastModified })) };
    }
    if (command instanceof GetObjectCommand) {
      asked.push(`get ${command.input.Key}`);
      return { Body: Readable.from([BODY]), ContentLength: BODY.length, ContentType: "application/octet-stream" };
    }
    throw new Error("unexpected S3 command");
  }) as typeof S3Client.prototype.send;
});
beforeEach(async () => {
  await h.reset();
  objects = new Map([[KEY, new Date()]]);
  asked = [];
  await seedSession(h, SID, { userId: OWNER.userId, agentStatus: "idle" });
});
after(async () => {
  S3Client.prototype.send = originalSend;
  await h.close();
});

async function get(url: string, user: typeof OWNER = OWNER, method: string | null = "cookie") {
  const app: FastifyInstance = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: typeof OWNER }).user = user;
    if (method !== null) recordRequestCredential(req, method);
  });
  await registerSessionDeliveryRoutes(app);
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url });
    return { status: res.statusCode, headers: res.headers, raw: res.rawPayload, json: () => res.json() as any };
  } finally {
    await app.close();
  }
}
const link = (sid = SID, id = ID) => `/v1/sessions/${sid}/deliveries/${id}`;

test("D1 the signed-in owner gets the file, typed and named from its name, never cached", async () => {
  for (const method of SIGNED_IN_METHODS) {
    const res = await get(link(), OWNER, method);
    assert.equal(res.status, 200, method);
    assert.deepEqual(res.raw, BODY);
    assert.equal(res.headers["content-type"], "image/png");
    assert.equal(res.headers["content-disposition"], "attachment; filename*=UTF-8''CPU%20vs%20GPU.png");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["cache-control"], "private, no-store");
  }
  assert.deepEqual([...SIGNED_IN_METHODS].sort(), ["cookie", "identity_token"]);
  assert.deepEqual(asked.slice(0, 2), [`list users/u-1/sessions/${SID}/.deliveries/${ID}/`, `get ${KEY}`]);
});

test("D2 a key is not a sign-in: the sandbox's key cannot follow the link, and nothing is looked up for it", async () => {
  for (const method of ["api_key", "x_api_key", "query_token", "connector_token", null]) {
    const res = await get(link(), OWNER, method);
    assert.equal(res.status, 403, String(method));
    assert.equal(res.json().error, "interactive_sign_in_required");
  }
  assert.deepEqual(asked, []);
});

test("D3 not the owner, an administrator, no session, a malformed id, no object: one 404", async () => {
  const rows: Array<[string, typeof OWNER]> = [
    [link(), OTHER],
    [link(), ADMIN],
    [link("s-none"), OWNER],
    [link(SID, "..%2F..%2Fother"), OWNER],
    [link(SID, ID.toUpperCase()), OWNER],
    [link(SID, "1f8fad5b-d9cb-469f-a165-70867728950e"), OWNER],
  ];
  for (const [url, user] of rows) {
    const res = await get(url, user);
    assert.equal(res.status, 404, `${url} as ${user.userId}`);
    assert.equal(res.json().error, "delivery not found");
  }
  assert.ok(!asked.some((a) => a.startsWith("get ")), "nothing was read");
  assert.ok(!asked.some((a) => a.includes("..") || a.includes(ID.toUpperCase())), "an id that is not one never reaches the store");
});

test("D4 past the TTL the link is gone and the object is not read", async () => {
  objects = new Map([[KEY, new Date(Date.now() - (DELIVERY_TTL_DAYS * 24 + 1) * 3600_000)]]);
  const res = await get(link());
  assert.equal(res.status, 410);
  assert.equal(res.json().error, "delivery_expired");
  assert.ok(!asked.some((a) => a.startsWith("get ")));
});
