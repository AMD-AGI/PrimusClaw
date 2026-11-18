// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The IMDS token source's answers and errors, the cache's short-lived tokens, and the assertion key's checks. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { TokenError } from "../../src/connector/errors.js";
import { AssertionKeyError, loadAssertionKey } from "../../src/connector/tokens/assertion.js";
import { parseTokenAnswer } from "../../src/connector/tokens/cached.js";
import { FederatedTokenProvider } from "../../src/connector/tokens/federated.js";
import { ImdsTokenProvider } from "../../src/connector/tokens/imds.js";
import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { CLIENT_ID, FakeTeams, json, RecordingLogger } from "./fakes.js";

function imds(fake: FakeTeams, logger = new RecordingLogger()): ImdsTokenProvider {
  return new ImdsTokenProvider(CLIENT_ID, { clock: fake.clock, fetch: fake.fetch, logger });
}

test("imds statuses that are worth another try are transient and the others are not", async () => {
  for (const [status, transient] of [
    [404, true],
    [410, true],
    [429, true],
    [500, true],
    [400, false],
    [403, false],
  ] as const) {
    const fake = new FakeTeams(new FakeClock());
    fake.imdsStatus = status;
    await assert.rejects(imds(fake).get(), (e: unknown) => {
      return e instanceof TokenError && e.transient === transient && e.message === `IMDS answered ${String(status)}`;
    });
  }
});

test("an imds answer without a usable token is a refusal", async () => {
  for (const body of [
    { expires_in: "60" },
    { access_token: "", expires_in: "60" },
    { access_token: "t", expires_in: "x" },
    [],
  ]) {
    const fake = new FakeTeams(new FakeClock());
    const provider = new ImdsTokenProvider(CLIENT_ID, {
      clock: fake.clock,
      fetch: () => Promise.resolve(json(200, body)),
    });
    await assert.rejects(provider.get(), (e: unknown) => {
      return e instanceof TokenError && !e.transient && e.message === "IMDS answered without a usable token";
    });
  }
});

test("an unreachable or hanging imds is transient", async () => {
  const clock = new FakeClock();
  const down = new ImdsTokenProvider(CLIENT_ID, {
    clock,
    fetch: () => Promise.reject(new TypeError("fetch failed")),
  });
  await assert.rejects(
    down.get(),
    (e: unknown) => e instanceof TokenError && e.transient && /unreachable \(TypeError\)/.test(e.message),
  );
  const fake = new FakeTeams(clock);
  fake.imdsDelayMs = 60_000;
  const hanging = assert.rejects(imds(fake).get(), (e: unknown) => {
    return e instanceof TokenError && e.transient && /TimeoutError/.test(e.message);
  });
  await flushMicrotasks(); // the request is out
  await clock.advance(5_000); // IMDS's own timeout
  await hanging;
  assert.throws(() => new ImdsTokenProvider("", { clock }), /client id is required/);
});

test("a short-lived token is kept for half its life and logged by its lifetime only", async () => {
  const fake = new FakeTeams(new FakeClock());
  fake.expiresIn = 400;
  const logger = new RecordingLogger();
  const provider = imds(fake, logger);
  assert.equal(await provider.get(), "token-1");
  assert.equal(provider.validForMs(), 200_000);
  await fake.clock.advance(200_000);
  assert.equal(provider.validForMs(), 0);
  assert.equal(await provider.get(), "token-2");
  assert.deepEqual(logger.records[0]?.fields, { validForS: 400 });
  assert.ok(!logger.text().includes("token-"));
  provider.invalidate("token-2");
  assert.equal(provider.validForMs(), 0);
  await provider.close();
});

test("a token answer is read with python's int for its lifetime", () => {
  assert.deepEqual(parseTokenAnswer('{"access_token":"t","expires_in":"3599"}'), { token: "t", expiresIn: 3599 });
  assert.deepEqual(parseTokenAnswer('{"access_token":"t","expires_in":3599.9}'), { token: "t", expiresIn: 3599 });
  assert.deepEqual(["nope", '{"access_token":5,"expires_in":1}', '{"access_token":"t"}'].map(parseTokenAnswer), [
    undefined,
    undefined,
    undefined,
  ]);
});

test("the assertion key must be an unencrypted rsa private key", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encrypted = rsa.privateKey.export({ format: "pem", type: "pkcs8", cipher: "aes-256-cbc", passphrase: "pw" });
  assert.throws(
    () => loadAssertionKey(encrypted),
    (e: unknown) => e instanceof AssertionKeyError && /PEM/.test(e.message),
  );
  const publicPem = rsa.publicKey.export({ format: "pem", type: "spki" });
  assert.throws(() => loadAssertionKey(publicPem), AssertionKeyError);
  const ed = generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
  assert.throws(() => loadAssertionKey(ed), /not an RSA key/);
  const pem = rsa.privateKey.export({ format: "pem", type: "pkcs1" });
  assert.equal(loadAssertionKey(Buffer.from(pem)).kid.length, 43);
});

test("the federated token needs every setting and logs another scope with its client", async () => {
  const fake = new FakeTeams(new FakeClock());
  const keyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
  const base = { clientId: "c", tenantId: "t/x", keyPem, issuer: "https://i", subject: "s", clock: fake.clock };
  for (const [field, name] of [
    ["clientId", "client id"],
    ["tenantId", "tenant id"],
    ["issuer", "issuer"],
    ["subject", "subject"],
  ] as const) {
    assert.throws(() => new FederatedTokenProvider({ ...base, [field]: "" }), new RegExp(`needs the ${name}`));
  }
  const logger = new RecordingLogger();
  const vault = new FederatedTokenProvider({
    ...base,
    fetch: fake.fetch,
    logger,
    scope: "https://vault.azure.net/.default",
  });
  await vault.get();
  assert.equal(fake.tokenRequests[0]?.url, "https://login.microsoftonline.com/t%2Fx/oauth2/v2.0/token");
  assert.equal(vault.clientId, "c");
  assert.deepEqual(logger.records[0], {
    level: "info",
    message: "token fetched by workload identity federation",
    fields: { scope: "https://vault.azure.net/.default", clientId: "c", validForS: 86399 },
  });
});
