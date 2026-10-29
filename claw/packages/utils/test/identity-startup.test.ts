// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The start-up helpers API and Brain share. Each process only supplies its own
 * metrics, so what a given environment does is decided, and tested, here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IdentityClient, buildIdentityClient, startIdentityClient, type IdentityProcessMetrics } from "../src/index.js";
import { RecordingMetrics, FakeIdentity, testKey } from "./identity-fake.js";

interface Logged { level: string; fields: Record<string, unknown>; message: string }

function recordingLog(): { log: Parameters<typeof buildIdentityClient>[1]; lines: Logged[] } {
  const lines: Logged[] = [];
  const at = (level: string) => (fields: Record<string, unknown>, message: string): void => {
    lines.push({ level, fields, message });
  };
  return { log: { info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

function processMetrics(): IdentityProcessMetrics & { identity: RecordingMetrics; enabled: boolean[] } {
  const enabled: boolean[] = [];
  return { identity: new RecordingMetrics(), enabled, setIdentityClientEnabled: (v) => { enabled.push(v); } };
}

const ENABLED = {
  IDENTITY_CLIENT_ENABLED: "true",
  IDENTITY_ISSUER_URL: "https://idp.example.com",
  IDENTITY_CLIENT_ID: "svc-claw",
  IDENTITY_CLIENT_SECRET: "secret-value",
};

test("with nothing configured there is no client, the gauge says off, and nothing is logged", () => {
  const { log, lines } = recordingLog();
  const m = processMetrics();
  assert.equal(buildIdentityClient({}, log, m), null);
  assert.deepEqual(m.enabled, [false]);
  assert.deepEqual(lines, []);
});

test("switched on without what it needs, it refuses to build and says what is missing", () => {
  const { log, lines } = recordingLog();
  const m = processMetrics();
  assert.throws(
    () => buildIdentityClient({ IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: "https://idp.example.com" }, log, m),
    /IDENTITY_CLIENT_ID is required.*IDENTITY_CLIENT_SECRET is required/,
  );
  const line = lines.find((l) => l.message === "startup.identity_client_refused");
  assert.ok(line);
  assert.equal(line.level, "error");
  assert.equal((line.fields.errors as string[]).length, 2);
  assert.deepEqual(m.enabled, [true], "it was asked for, even though it could not be built");
});

test("a refused numeric setting is logged and the default used; the secret is never logged", () => {
  const { log, lines } = recordingLog();
  const m = processMetrics();
  const client = buildIdentityClient({ ...ENABLED, IDENTITY_REQUEST_TIMEOUT_MS: "banana" }, log, m);
  assert.ok(client instanceof IdentityClient);
  assert.deepEqual(m.enabled, [true]);
  const line = lines.find((l) => l.message === "startup.config_refused");
  assert.ok(line);
  assert.equal(line.level, "error");
  assert.match(String((line.fields.refused as string[])[0]), /IDENTITY_REQUEST_TIMEOUT_MS=banana/);
  assert.ok(!JSON.stringify(lines).includes("secret-value"));
});

test("the client reports into the metrics the process gave it", async () => {
  const fake = await FakeIdentity.start();
  try {
    fake.introspect = () => ({ body: { active: true, sub: "u1" } });
    const m = processMetrics();
    const client = buildIdentityClient({
      ...ENABLED, IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_INTROSPECTION_URL: `${fake.issuer}/oauth/introspect`,
    }, recordingLog().log, m);
    assert.ok(client);
    await client.introspect("some-session-token");
    await client.introspect("some-session-token");
    assert.equal(m.identity.cacheCount("introspection", "miss"), 1);
    assert.equal(m.identity.cacheCount("introspection", "hit"), 1);
    assert.equal(m.identity.upstreamCount("introspection", "ok"), 1);
  } finally {
    await fake.close();
  }
});

test("start-up reads discovery and the key set in the background and says when it is ready", async () => {
  const fake = await FakeIdentity.start();
  try {
    fake.jwks = () => ({ body: { keys: [testKey("ES256", "es-1").jwk] } });
    const { log, lines } = recordingLog();
    const client = startIdentityClient({ ...ENABLED, IDENTITY_ISSUER_URL: fake.issuer }, log, processMetrics());
    assert.ok(client instanceof IdentityClient);
    assert.equal(lines.length, 0, "returns before the read finishes");
    for (let i = 0; i < 100 && !lines.some((l) => l.message === "identity.client_ready"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(lines.some((l) => l.message === "identity.client_ready" && l.level === "info"), JSON.stringify(lines));
    assert.equal(fake.count("/.well-known/openid-configuration"), 1);
    assert.equal(fake.count("/.well-known/jwks.json"), 1);
  } finally {
    await fake.close();
  }
});

test("a warm-up that fails is a warning with the reason, never a throw", async () => {
  const { log, lines } = recordingLog();
  const client = startIdentityClient(
    { ...ENABLED, IDENTITY_ISSUER_URL: "http://127.0.0.1:9", IDENTITY_REQUEST_TIMEOUT_MS: "200" }, log, processMetrics(),
  );
  assert.ok(client instanceof IdentityClient);
  for (let i = 0; i < 100 && !lines.some((l) => l.message === "identity.warmup_failed"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const line = lines.find((l) => l.message === "identity.warmup_failed");
  assert.ok(line, JSON.stringify(lines));
  assert.equal(line.level, "warn");
  assert.equal(typeof line.fields.reason, "string");
  assert.ok(!lines.some((l) => l.message === "identity.client_ready"));
});

test("start-up with the client off builds nothing and warms nothing", () => {
  const { log, lines } = recordingLog();
  assert.equal(startIdentityClient({}, log, processMetrics()), null);
  assert.deepEqual(lines, []);
});
