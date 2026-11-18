// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The bot's token by workload identity federation (port of test_federated_token.py): the worker signs an assertion with
 * its own key and Entra ID trades it for the managed identity's Bot Connector token. A fake Entra token endpoint and a
 * fake Connector behind one injected fetch; the clock is a fake, so expiry is exact.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { TokenError } from "../../src/connector/errors.js";
import { ConnectorOutbox } from "../../src/connector/outbox.js";
import { ASSERTION_AUDIENCE, jwkThumbprint, loadAssertionKey } from "../../src/connector/tokens/assertion.js";
import { BOT_CONNECTOR_SCOPE, FederatedTokenProvider } from "../../src/connector/tokens/federated.js";
import { FakeClock } from "../../../../test-support/clock.js";
import { envelope, FakeTeams, json, Queue, RecordingLogger, settle, type Answer } from "./fakes.js";

const CLIENT_ID = "00000000-0000-0000-0000-0000000000a1";
const TENANT = "00000000-0000-0000-0000-0000000000b2";
const ISSUER = "https://oidc.example.com/prod";
const SUBJECT = "claw-teams-agent";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const KEY_PEM = KEYS.privateKey.export({ format: "pem", type: "pkcs8" });

function clock(): FakeClock {
  return new FakeClock(1_800_000_000_000);
}

function provider(
  fake: FakeTeams,
  logger = new RecordingLogger(),
  keyPem: string | Buffer = KEY_PEM,
): FederatedTokenProvider {
  return new FederatedTokenProvider({
    clientId: CLIENT_ID,
    tenantId: TENANT,
    keyPem,
    issuer: ISSUER,
    subject: SUBJECT,
    clock: fake.clock,
    fetch: fake.fetch,
    logger,
  });
}

function decode(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

function entraError(status: number, error: string, code: number): Response {
  return json(status, {
    error,
    error_description: `AADSTS${String(code)}: the request said secret-ish things`,
    error_codes: [code],
  });
}

// --- success ---

test("the token comes from entra for a signed assertion the federated credential accepts", async () => {
  const fake = new FakeTeams(clock());
  const tokens = provider(fake);
  assert.equal(await tokens.get(), "fed-token-1");
  const [request, ...rest] = fake.tokenRequests;
  assert.equal(rest.length, 0);
  assert.equal(request?.method, "POST");
  assert.equal(request.url, TOKEN_URL);
  assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
  const form = fake.form();
  assert.equal(form["grant_type"], "client_credentials");
  assert.equal(form["client_id"], CLIENT_ID);
  assert.equal(form["scope"], BOT_CONNECTOR_SCOPE);
  assert.equal(BOT_CONNECTOR_SCOPE, "https://api.botframework.com/.default");
  assert.equal(form["client_assertion_type"], "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
  const [head, claims, signature] = (form["client_assertion"] ?? "").split(".");
  assert.deepEqual(decode(head), { alg: "RS256", typ: "JWT", kid: tokens.keyId });
  const body = decode(claims);
  assert.deepEqual([body["iss"], body["sub"], body["aud"]], [ISSUER, SUBJECT, ASSERTION_AUDIENCE]);
  assert.equal(body["iat"], 1_800_000_000 - 60);
  assert.equal(body["nbf"], body["iat"]);
  assert.equal((body["exp"] as number) - body["iat"], 600);
  assert.ok(body["jti"]);
  // the signature verifies with the public key the JWKS publishes
  const signed = Buffer.from(`${head ?? ""}.${claims ?? ""}`);
  assert.ok(verify("sha256", signed, KEYS.publicKey, Buffer.from(signature ?? "", "base64url")));
});

test("the key id is the rfc7638 thumbprint of the public key", () => {
  // RFC 7638 section 3.1's example key and thumbprint
  const n =
    "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMs" +
    "tn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5h" +
    "ajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw";
  assert.equal(jwkThumbprint({ n, e: "AQAB" }), "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs");
  // and the key id of a loaded key is the thumbprint of its public JWK
  const jwk = KEYS.publicKey.export({ format: "jwk" });
  assert.equal(loadAssertionKey(KEY_PEM).kid, jwkThumbprint({ n: jwk.n ?? "", e: jwk.e ?? "" }));
});

// --- refresh ---

test("the token is cached until five minutes before it expires then fetched with a new assertion", async () => {
  const fake = new FakeTeams(clock());
  fake.expiresIn = 3600;
  const tokens = provider(fake);
  assert.equal(await tokens.get(), "fed-token-1");
  await fake.clock.advance((3600 - 301) * 1000);
  assert.equal(await tokens.get(), "fed-token-1"); // cached
  assert.equal(fake.tokenRequests.length, 1);
  await fake.clock.advance(2000);
  assert.equal(await tokens.get(), "fed-token-2"); // within five minutes of expiry: a fresh one
  const [first, second] = [0, 1].map((i) => decode(fake.form(i)["client_assertion"]?.split(".")[1]));
  assert.notEqual(first?.["jti"], second?.["jti"]); // an assertion is never reused
  assert.ok((second?.["iat"] as number) > (first?.["iat"] as number));
});

test("concurrent callers share one fetch", async () => {
  const fake = new FakeTeams(clock());
  const tokens = provider(fake);
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(() => tokens.get())), Array(5).fill("fed-token-1"));
  assert.equal(fake.tokenRequests.length, 1);
});

// --- 401 from the Connector invalidates ---

function outbox(fake: FakeTeams, queue: Queue): ConnectorOutbox {
  return new ConnectorOutbox({ tokens: provider(fake), fallback: queue, clock: fake.clock, fetch: fake.fetch });
}

test("a 401 from the connector invalidates the token and the send is retried with a fresh one", async () => {
  const fake = new FakeTeams(clock());
  fake.answers = [new Response(null, { status: 401 }), json(201, { id: "teams-9" })];
  const queue = new Queue();
  const delivered = await settle(fake.clock, outbox(fake, queue).publish(envelope("hi")));
  assert.deepEqual(delivered, { activityId: "teams-9" });
  assert.deepEqual(queue.sent, []);
  assert.deepEqual(
    fake.calls.map((c) => c.headers["authorization"]),
    ["Bearer fed-token-1", "Bearer fed-token-2"],
  );
  assert.equal(fake.tokenRequests.length, 2);
});

test("invalidate keeps a newer token", async () => {
  const fake = new FakeTeams(clock());
  const tokens = provider(fake);
  const old = await tokens.get();
  tokens.invalidate(old);
  const fresh = await tokens.get();
  tokens.invalidate(old); // a late caller with the old token must not drop the new one
  assert.deepEqual([fresh, await tokens.get()], ["fed-token-2", "fed-token-2"]);
  assert.equal(fake.tokenRequests.length, 2);
});

// --- errors ---

const REFUSALS: [string, Answer][] = [
  ["no federated credential matches the subject", entraError(400, "invalid_client", 700213)],
  ["nor the issuer", entraError(401, "invalid_client", 700211)],
  ["the identity has no federated credential at all", entraError(400, "invalid_request", 70025)],
  ["no token in the answer", json(200, { token_type: "Bearer" })],
];

for (const [name, response] of REFUSALS) {
  test(`a refusal is not transient and names only the code: ${name}`, async () => {
    const fake = new FakeTeams(clock());
    fake.entra = [response];
    const error = await provider(fake)
      .get()
      .then(
        () => assert.fail("no TokenError"),
        (e: unknown) => e,
      );
    assert.ok(error instanceof TokenError);
    assert.equal(error.transient, false);
    assert.ok(!error.message.includes("secret-ish"));
    const status = (response as Response).status;
    if (status !== 200) {
      assert.ok(error.message.includes(`answered ${String(status)}`) && error.message.includes("AADSTS"));
    }
  });
}

const BUSY: [string, Answer][] = [
  ["429", new Response(null, { status: 429 })],
  ["503", new Response(null, { status: 503 })],
  ["unreachable", new TypeError("fetch failed")],
];

for (const [name, answer] of BUSY) {
  test(`a busy or unreachable entra is transient: ${name}`, async () => {
    const fake = new FakeTeams(clock());
    fake.entra = [answer];
    await assert.rejects(provider(fake).get(), (e: unknown) => e instanceof TokenError && e.transient);
  });
}

test("a refused token sends the message to the queue after one try without retrying entra", async () => {
  const fake = new FakeTeams(clock());
  fake.entra = [entraError(401, "invalid_client", 700213)];
  const queue = new Queue();
  assert.equal(await settle(fake.clock, outbox(fake, queue).publish(envelope("hi"))), undefined);
  assert.equal(queue.sent.length, 1);
  assert.equal(fake.tokenRequests.length, 1);
  assert.deepEqual(fake.calls, []);
});

test("a key that is not an rsa private key is refused at construction", () => {
  const fake = new FakeTeams(clock());
  assert.throws(() => provider(fake, undefined, "not a key"), /PEM/);
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" });
  assert.throws(() => provider(fake, undefined, ec), /RSA/);
  assert.throws(
    () =>
      new FederatedTokenProvider({
        clientId: CLIENT_ID,
        tenantId: TENANT,
        keyPem: KEY_PEM,
        issuer: "http://example",
        subject: SUBJECT,
        clock: fake.clock,
      }),
    /https/,
  );
});

test("the token and the assertion are never logged", async () => {
  const fake = new FakeTeams(clock());
  const logger = new RecordingLogger();
  await provider(fake, logger).get();
  const assertion = fake.form()["client_assertion"] ?? "";
  const text = logger.text();
  assert.ok(text.includes("bot connector token fetched by workload identity federation"));
  assert.ok(!text.includes("fed-token-1"));
  assert.ok(!text.includes(assertion) && !text.includes(assertion.split(".")[2] ?? "-"));
});
