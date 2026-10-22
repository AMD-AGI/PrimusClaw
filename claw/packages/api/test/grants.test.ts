// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { createServer } from "node:http";

import { atSecond, jwksDocument, signAttestation } from "../src/grants/attestation.js";
import { computeCaps } from "../src/grants/caps.js";
import { grantCallerFromEnv, GrantClientError } from "../src/grants/client.js";
import { grantEnv } from "../src/grants/env.js";
import { extendAppRunGrant, openAppRunGrant, revokeAppRunGrant, type GrantRuntime } from "../src/grants/lifecycle.js";
import type { Querier } from "../src/infra/db.js";

function pem(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

test("signAttestation is ES256 and the previous key stays in the JWKS", () => {
  const current = pem();
  const previous = pem();
  const env = {
    GRANT_SIGNING_KEY: current,
    GRANT_SIGNING_KID: "claw-2",
    GRANT_SIGNING_PREVIOUS_KEY: previous,
    GRANT_SIGNING_PREVIOUS_KID: "claw-1",
  };
  const expiresAt = atSecond(new Date(Date.now() + 3600_000));
  const token = signAttestation({
    grantId: "gr-01",
    userId: "u-1",
    workspaces: ["top-models"],
    kinds: ["Sandbox"],
    maxGpusPerSandbox: 8,
    expiresAt,
  }, env);
  const [header, payload, sig] = token.split(".");
  const head = JSON.parse(Buffer.from(header, "base64url").toString()) as { alg: string; kid: string };
  const body = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss: string; aud: string; exp: number; jti: string };
  assert.equal(head.alg, "ES256");
  assert.equal(head.kid, "claw-2");
  assert.equal(body.iss, "primus-claw");
  assert.equal(body.aud, "agent-sandbox-workload");
  assert.equal(body.jti, "gr-01");
  assert.equal(body.exp, Math.floor(expiresAt.getTime() / 1000));
  const ok = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: createPublicKey(current), dsaEncoding: "ieee-p1363" },
    Buffer.from(sig, "base64url"),
  );
  assert.equal(ok, true);
  const doc = jwksDocument(env);
  assert.deepEqual(doc.keys.map((k) => k.kid), ["claw-2", "claw-1"]);
  assert.equal(doc.keys[0].crv, "P-256");
});

test("computeCaps takes the smaller of demand and the platform ceiling", () => {
  const start = new Date("2026-10-22T00:00:00Z");
  const caps = computeCaps(
    { placement: { max_parallel_tests: 32 }, hardware: { tp: 8 }, budget: { max_gpu_hours: 100, max_hours: 4 }, multibranch: { max_branches: 3 } },
    { devMaxSandboxes: 2, devMaxGpus: 2 },
    { measurement: { maxSandboxes: 16, maxGpus: 64 }, subrun: { maxSandboxes: 8, maxGpus: 8 }, gpuHoursBudget: 10, maxSandboxSeconds: 600 },
    start,
    [1, 8],
  );
  assert.equal(caps.roles.measurement.maxSandboxes, 16);
  assert.equal(caps.roles.measurement.maxGpus, 64);
  assert.equal(caps.roles.subrun.maxSandboxes, 3);
  assert.equal(caps.roles.dev.maxSandboxes, 2);
  assert.equal(caps.gpuHoursBudget, 10);
  assert.equal(caps.maxSandboxSeconds, 600);
  assert.equal(caps.maxGpusPerSandbox, 8);
  assert.equal(caps.expiresAt.toISOString(), "2026-10-22T04:30:00.000Z");
});

test("grantEnv maps the three role keys", () => {
  const env = grantEnv({
    apiUrl: "https://api.example",
    sandboxUrl: "https://sbx.example",
    keys: { measurement: "e2b_a", subrun: "e2b_b", dev: "e2b_c" },
  });
  assert.equal(env.E2B_API_URL, "https://api.example");
  assert.equal(env.HYPERLOOM_SANDBOX_KEY_MEASUREMENT, "e2b_a");
  assert.equal(env.HYPERLOOM_SANDBOX_KEY_SUBRUN, "e2b_b");
  assert.equal(env.HYPERLOOM_SANDBOX_KEY_DEV, "e2b_c");
});

test("grant client sends the service-account token and surfaces the reason", async () => {
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer sa-token") {
      res.writeHead(401).end("{}");
      return;
    }
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 429, reason: "grant_quota_exceeded", message: "grant_quota_exceeded: measurement 1/1 sandboxes" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    const caller = grantCallerFromEnv({
      SANDBOX_GRANT_URL: `http://127.0.0.1:${address.port}`,
      SANDBOX_GRANT_TOKEN: "sa-token",
    });
    await assert.rejects(
      () => caller.issue(issueBody()),
      (err: unknown) => err instanceof GrantClientError && err.reason === "grant_quota_exceeded" && err.status === 429,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("open reuses keys, extend moves expiry, and a keyless replay issues a new id", async () => {
  const key = pem();
  const mem = memoryGrants();
  const seen: string[] = [];
  const rt: GrantRuntime = {
    now: () => new Date("2026-10-22T00:00:00Z"),
    sign: (claims) => signAttestation(claims, { GRANT_SIGNING_KEY: key, GRANT_SIGNING_KID: "claw-1" }),
    caller: () => ({
      async issue(body) {
        seen.push(body.grantId);
        if (seen.length === 1) return { grantId: body.grantId, status: 200 };
        return { grantId: body.grantId, status: 201, keys: { measurement: "e2b_m", subrun: "e2b_s", dev: "e2b_d" } };
      },
      async extend() {},
      async revoke() {},
    }),
    seal: (plain) => `seal:${plain}`,
    open: (sealed) => sealed.replace(/^seal:/, ""),
    apiUrl: "https://api.example",
    sandboxUrl: "https://sbx.example",
    platformCapsRaw: JSON.stringify({ measurement: { maxSandboxes: 4, maxGpus: 8 } }),
  };
  const input = {
    appRunId: "ar-1",
    userId: "u-1",
    userName: "alice",
    workspaces: ["top-models"],
    platformKey: "ak-test",
    sessionId: "s-1",
    templates: [{ name: "runner", perGpuCount: [1] }],
  };
  const first = await openAppRunGrant(input, rt, mem.transact);
  assert.equal(first.reused, false);
  assert.equal(seen.length, 2);
  assert.notEqual(first.grantId, seen[0]);
  assert.equal(first.env.HYPERLOOM_SANDBOX_KEY_MEASUREMENT, "e2b_m");
  const second = await openAppRunGrant(input, rt, mem.transact);
  assert.equal(second.reused, true);
  assert.equal(second.grantId, first.grantId);
  assert.equal(seen.length, 2);
  const extended = await extendAppRunGrant("ar-1", new Date("2026-10-24T00:00:00Z"), rt, mem.transact);
  assert.equal(extended.expiresAt, "2026-10-24T00:00:00.000Z");
  await revokeAppRunGrant("ar-1", rt, mem.transact);
  const reissued = await openAppRunGrant(input, rt, mem.transact);
  assert.equal(reissued.reused, false);
  assert.equal(seen.length, 3);
  assert.equal(reissued.env.HYPERLOOM_SANDBOX_KEY_DEV, "e2b_d");
});

function issueBody() {
  return {
    grantId: "gr-1",
    owner: { userId: "u", userName: "a", workspaces: ["w"] },
    platformKey: "ak",
    issuer: { sessionId: "s", appRunId: "ar" },
    roles: { measurement: { templates: ["runner"], maxSandboxes: 1, maxGpus: 1 } },
    templates: [{ name: "runner" }],
    gpuHoursBudget: 1,
    maxSandboxSeconds: 60,
    expiresAt: new Date().toISOString(),
    attestation: "tok",
  };
}

function memoryGrants() {
  let row: Record<string, unknown> | null = null;
  return {
    transact: async <T>(run: (query: Querier) => Promise<T>): Promise<T> => run(async (sql, params = []) => {
      if (sql.includes("SELECT")) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 } as Awaited<ReturnType<Querier>>;
      }
      if (sql.includes("INSERT")) {
        row = {
          app_run_id: params[0], grant_id: params[1], user_id: params[2], session_id: params[3],
          expires_at: params[4], keys_ciphertext: "", attestation: "", state: "pending",
          claims: JSON.parse(String(params[5])),
        };
        return { rows: [], rowCount: 1 } as Awaited<ReturnType<Querier>>;
      }
      if (sql.includes("state = 'revoked'")) {
        if (row) row = { ...row, state: "revoked", keys_ciphertext: "" };
        return { rows: [], rowCount: 1 } as Awaited<ReturnType<Querier>>;
      }
      if (sql.includes("SET expires_at")) {
        if (row) row = { ...row, expires_at: params[1], attestation: params[2] };
        return { rows: [], rowCount: 1 } as Awaited<ReturnType<Querier>>;
      }
      if (sql.includes("UPDATE")) {
        if (row) {
          row = {
            ...row,
            grant_id: params[1],
            expires_at: params[2],
            keys_ciphertext: params[3],
            attestation: params[4],
            state: "active",
            claims: JSON.parse(String(params[5])),
            user_id: params[6],
            session_id: params[7],
          };
        }
        return { rows: [], rowCount: 1 } as Awaited<ReturnType<Querier>>;
      }
      throw new Error(sql);
    }),
  };
}
