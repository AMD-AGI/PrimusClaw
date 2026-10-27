// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The grant client: the attestation verifies, a replay without keys is discarded,
 * and an unknown revoke is success.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  GRANT_AUDIENCE, GRANT_ISSUER, GRANT_KID, GrantHttpError, GrantKeysMissingError, GrantSigner,
  SandboxGrantClient, buildSandboxGrant, loadGrantSigner, type SandboxGrantMaterial,
} from "../src/sandbox-grant.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const signer = loadGrantSigner(pem);
const NOW = new Date("2026-10-27T00:00:00.000Z");

const material = (): SandboxGrantMaterial => ({
  grantId: "gr-01arz3ndektsv4rrffq69g5fav",
  appRunId: "task-1",
  sessionId: "sess-1",
  userId: "user-1",
  userName: "ada",
  platformKey: "pk-1",
  workspaces: ["ws-b", "ws-a"],
  limits: { max_sandboxes: 4, max_gpus: 8, gpu_hours: 10, max_runtime_sec: 3600 },
  templates: [{ name: "runner", per_gpu_count: [1, 8], image: "img:1", data_plane: { mode: "sealed" } }],
  roles: { measurement: ["runner"], subrun: ["runner"] },
});

function client(handler: (req: { method: string; url: string; body: unknown }) => { status: number; json?: unknown } | Promise<{ status: number; json?: unknown }>): SandboxGrantClient {
  const fetchImpl: typeof fetch = async (url, init) => {
    const answered = await handler({
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(answered.json === undefined ? null : JSON.stringify(answered.json), { status: answered.status });
  };
  return new SandboxGrantClient({ signer, token: () => "tok", fetch: fetchImpl, now: () => NOW, baseUrl: "http://grant.local/internal/v1/grants" });
}

test("the attestation is ES256 and matches the issue body", () => {
  const built = buildSandboxGrant(material(), NOW);
  const token = signer.sign(built.claims, NOW);
  const [h, p, s] = token.split(".");
  const header = JSON.parse(Buffer.from(h!, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
  assert.equal(header.kid, GRANT_KID);
  assert.equal(header.alg, "ES256");
  assert.equal(payload.iss, GRANT_ISSUER);
  assert.equal(payload.aud, GRANT_AUDIENCE);
  assert.equal(payload.jti, material().grantId);
  assert.equal(payload.sub, "user-1");
  assert.deepEqual(payload.workspaces, ["ws-a", "ws-b"]);
  assert.deepEqual(payload.kinds, ["Sandbox"]);
  assert.equal(payload.maxGpusPerSandbox, 8);
  assert.equal(payload.exp, NOW.getTime() / 1000 + 3600);
  const verify = createVerify("SHA256");
  verify.update(`${h}.${p}`);
  verify.end();
  assert.equal(verify.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url")), true);
  assert.equal((built.body.expiresAt as string), new Date(NOW.getTime() + 3600 * 1000).toISOString());
  const roles = built.body.roles as Record<string, { maxSandboxes: number; maxGpus: number }>;
  assert.equal(roles.measurement.maxSandboxes, 4);
  assert.equal(roles.measurement.maxGpus, 8);
  assert.equal(roles.dev, undefined);
  const tpl = (built.body.templates as Array<{ spec: { data_plane: { mode: string } } }>)[0]!;
  assert.equal(tpl.spec.data_plane.mode, "sealed");
});

test("a role that is not declared is not issued", () => {
  assert.throws(() => buildSandboxGrant({ ...material(), roles: {} }, NOW), /no sandbox role/);
  assert.throws(() => buildSandboxGrant({ ...material(), platformKey: "" }, NOW), /platform key/);
});

test("201 returns the keys", async () => {
  const c = client(async (req) => {
    assert.equal(req.method, "POST");
    assert.equal((req.body as { attestation: string }).attestation.split(".").length, 3);
    return { status: 201, json: { grantId: material().grantId, keys: { measurement: "e2b_a", subrun: "e2b_b" } } };
  });
  const issued = await c.issue(material());
  assert.equal(issued.keys.measurement, "e2b_a");
  assert.equal(issued.keys.subrun, "e2b_b");
});

test("200 without keys revokes that id and fails", async () => {
  const calls: string[] = [];
  const c = client(async (req) => {
    calls.push(req.method);
    if (req.method === "POST") return { status: 200, json: { grantId: material().grantId } };
    assert.equal(req.method, "DELETE");
    assert.ok(req.url.endsWith(encodeURIComponent(material().grantId)));
    return { status: 200, json: { grantId: material().grantId } };
  });
  await assert.rejects(() => c.issue(material()), (err: unknown) => err instanceof GrantKeysMissingError);
  assert.deepEqual(calls, ["POST", "DELETE"]);
});

test("a lost response is retried once, and a second 200 without keys still revokes", async () => {
  let posts = 0;
  const methods: string[] = [];
  const c = client(async (req) => {
    methods.push(req.method);
    if (req.method === "POST") {
      posts += 1;
      if (posts === 1) throw new Error("socket hang up");
      return { status: 200, json: { grantId: material().grantId } };
    }
    return { status: 404 };
  });
  await assert.rejects(() => c.issue(material()), (err: unknown) => err instanceof GrantKeysMissingError);
  assert.equal(posts, 2);
  assert.deepEqual(methods, ["POST", "POST", "DELETE"]);
});

test("revoke of an unknown id succeeds, and extend sends a later exp", async () => {
  const seen: Array<{ method: string; exp?: number }> = [];
  const c = client(async (req) => {
    const token = (req.body as { attestation?: string } | undefined)?.attestation;
    const exp = token ? JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).exp as number : undefined;
    seen.push({ method: req.method, exp });
    if (req.method === "DELETE") return { status: 404 };
    if (req.method === "GET") return { status: 200, json: { state: "active", grantId: material().grantId } };
    return { status: 200, json: { expiresAt: "2026-10-27T02:00:00.000Z" } };
  });
  await c.revoke(material().grantId);
  assert.equal(await c.inspect(material().grantId), "active");
  const extended = await c.extend(material(), new Date("2026-10-27T02:00:00.000Z"));
  assert.equal(extended.expiresAt, "2026-10-27T02:00:00.000Z");
  assert.equal(seen.find((s) => s.method === "PATCH")!.exp, Date.parse("2026-10-27T02:00:00.000Z") / 1000);
  await assert.rejects(() => c.extend(material(), NOW), (err: unknown) => err instanceof GrantHttpError);
});

test("GET 404 is missing and a revoked copy stays revoked", async () => {
  const c = client(async (req) => {
    assert.equal(req.method, "GET");
    return req.url.endsWith("gone")
      ? { status: 404 }
      : { status: 200, json: { state: "revoked" } };
  });
  assert.equal(await c.inspect("gone"), "missing");
  assert.equal(await c.inspect("revoked"), "revoked");
});

test("reissue of a 200 without keys does not revoke the id", async () => {
  const methods: string[] = [];
  const c = client(async (req) => {
    methods.push(req.method);
    if (req.method === "POST") return { status: 200, json: { grantId: material().grantId } };
    return { status: 200 };
  });
  await assert.rejects(() => c.issue(material(), undefined, "reissue"), (err: unknown) => err instanceof GrantKeysMissingError);
  assert.deepEqual(methods, ["POST"]);
});

test("a client is not opened without an explicit grant url", async () => {
  const { openSandboxGrantClient } = await import("../src/sandbox-grant.js");
  const prevKey = process.env.GRANT_SIGNING_KEY;
  const prevUrl = process.env.AGENT_SANDBOX_GRANT_URL;
  process.env.GRANT_SIGNING_KEY = pem;
  delete process.env.AGENT_SANDBOX_GRANT_URL;
  try {
    assert.equal(openSandboxGrantClient(), null);
    process.env.AGENT_SANDBOX_GRANT_URL = "http://grant.local/internal/v1/grants";
    assert.ok(openSandboxGrantClient());
  } finally {
    if (prevKey === undefined) delete process.env.GRANT_SIGNING_KEY;
    else process.env.GRANT_SIGNING_KEY = prevKey;
    if (prevUrl === undefined) delete process.env.AGENT_SANDBOX_GRANT_URL;
    else process.env.AGENT_SANDBOX_GRANT_URL = prevUrl;
  }
});

test("the signer rejects a non-EC key", () => {
  assert.throws(() => new GrantSigner(publicKey), /EC private key/);
});
