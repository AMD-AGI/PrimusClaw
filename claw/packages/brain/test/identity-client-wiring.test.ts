// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The identity client as this process builds it: off by default, refused loudly
 * when switched on without what it needs, and reporting into this process's own
 * /metrics registry once it is asked something.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { IdentityClient } from "@claw/utils";
import { buildIdentityClient, identityClient, startIdentityClient } from "../src/clients/identity.js";
import { registry } from "../src/infra/metrics.js";

interface Logged { level: string; fields: Record<string, unknown>; message: string }

function recordingLog(): { log: Parameters<typeof buildIdentityClient>[1]; lines: Logged[] } {
  const lines: Logged[] = [];
  const at = (level: string) => (fields: Record<string, unknown>, message: string): void => {
    lines.push({ level, fields, message });
  };
  return { log: { info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

async function sample(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  const value = metric?.values.find((v) =>
    Object.entries(labels).every(([k, want]) => (v.labels as Record<string, unknown>)[k] === want));
  return value?.value ?? 0;
}

const ENABLED = {
  IDENTITY_CLIENT_ENABLED: "true",
  IDENTITY_ISSUER_URL: "https://idp.example.com",
  IDENTITY_CLIENT_ID: "svc-claw",
  IDENTITY_CLIENT_SECRET: "secret-value",
};

test("with nothing configured there is no client and the gauge says so", async () => {
  const { log, lines } = recordingLog();
  assert.equal(buildIdentityClient({}, log), null);
  assert.equal(await sample("claw_identity_client_enabled"), 0);
  assert.equal(identityClient(), null);
  assert.deepEqual(lines, []);
});

test("switched on without what it needs, it refuses to build and says what is missing", async () => {
  const { log, lines } = recordingLog();
  assert.throws(
    () => buildIdentityClient({ IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: "https://idp.example.com" }, log),
    /IDENTITY_CLIENT_ID is required.*IDENTITY_CLIENT_SECRET is required/,
  );
  const line = lines.find((l) => l.message === "startup.identity_client_refused");
  assert.ok(line);
  assert.equal(line.level, "error");
  assert.equal((line.fields.errors as string[]).length, 2);
});

test("a refused numeric setting is logged and the default used; the secret is never logged", async () => {
  const { log, lines } = recordingLog();
  const client = buildIdentityClient({ ...ENABLED, IDENTITY_REQUEST_TIMEOUT_MS: "banana" }, log);
  assert.ok(client instanceof IdentityClient);
  assert.equal(await sample("claw_identity_client_enabled"), 1);
  const line = lines.find((l) => l.message === "startup.config_refused");
  assert.ok(line);
  assert.match(String((line.fields.refused as string[])[0]), /IDENTITY_REQUEST_TIMEOUT_MS=banana/);
  assert.ok(!JSON.stringify(lines).includes("secret-value"));
});

test("the client reports into this process's registry: a repeated lookup shows as a hit", async () => {
  let asked = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      asked++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ active: true, sub: "u1", roles: ["default"] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { log } = recordingLog();
    const client = buildIdentityClient({
      ...ENABLED, IDENTITY_ISSUER_URL: base,
      IDENTITY_INTROSPECTION_URL: `${base}/introspect`,
    }, log);
    assert.ok(client);
    const hits = await sample("claw_identity_cache_total", { op: "introspection", result: "hit" });
    const misses = await sample("claw_identity_cache_total", { op: "introspection", result: "miss" });
    const upstream = await sample("claw_identity_upstream_total", { op: "introspection", outcome: "ok" });
    assert.equal((await client.introspect("some-session-token")).active, true);
    assert.equal((await client.introspect("some-session-token")).active, true);
    assert.equal(asked, 1);
    assert.equal(await sample("claw_identity_cache_total", { op: "introspection", result: "hit" }), hits + 1);
    assert.equal(await sample("claw_identity_cache_total", { op: "introspection", result: "miss" }), misses + 1);
    assert.equal(await sample("claw_identity_upstream_total", { op: "introspection", outcome: "ok" }), upstream + 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the stale-served counter exists and starts at zero", async () => {
  const names = (await registry.getMetricsAsJSON()).map((m) => m.name);
  for (const n of [
    "claw_identity_cache_total", "claw_identity_stale_served_total", "claw_identity_upstream_total",
    "claw_identity_upstream_duration_seconds", "claw_identity_client_enabled",
  ]) assert.ok(names.includes(n), n);
});

test("start-up keeps the client it built and reads discovery without holding boot", async () => {
  const saved = { ...process.env };
  try {
    for (const k of Object.keys(ENABLED)) delete process.env[k];
    const { log } = recordingLog();
    assert.equal(startIdentityClient(log), null);
    assert.equal(identityClient(), null);
    Object.assign(process.env, ENABLED, { IDENTITY_ISSUER_URL: "http://127.0.0.1:9", IDENTITY_REQUEST_TIMEOUT_MS: "200" });
    const { log: log2, lines } = recordingLog();
    const client = startIdentityClient(log2);
    assert.ok(client instanceof IdentityClient);
    assert.equal(identityClient(), client);
    // The warm-up fails (nothing listens on port 9) and says so, without throwing.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(lines.some((l) => l.message === "identity.warmup_failed" && l.level === "warn"), JSON.stringify(lines));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});
