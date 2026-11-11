// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The bot's token with an app registration's client secret (the client credentials grant). A fake Entra token endpoint
 * and a fake Connector behind one injected fetch; the clock is a fake, so expiry is exact.
 */
import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import { TokenError } from "../../src/connector/errors.js";
import { ConnectorOutbox } from "../../src/connector/outbox.js";
import { ClientSecretTokenProvider } from "../../src/connector/tokens/client-secret.js";
import { BOT_CONNECTOR_SCOPE } from "../../src/connector/tokens/federated.js";
import { FakeClock } from "../../../../test-support/clock.js";
import { envelope, FakeTeams, json, Queue, RecordingLogger, settle, type Answer } from "./fakes.js";

const CLIENT_ID = "00000000-0000-0000-0000-0000000000c1";
const TENANT = "00000000-0000-0000-0000-0000000000c2";
const SECRET = "Sx8Q~not-a-real-secret.but-shaped~like_one";
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`;

function clock(): FakeClock {
  return new FakeClock(1_800_000_000_000);
}

function provider(fake: FakeTeams, logger = new RecordingLogger(), scope?: string): ClientSecretTokenProvider {
  return new ClientSecretTokenProvider({
    clientId: CLIENT_ID,
    tenantId: TENANT,
    clientSecret: SECRET,
    clock: fake.clock,
    fetch: fake.fetch,
    logger,
    ...(scope ? { scope } : {}),
  });
}

/** An Entra refusal whose description echoes the secret, as a careless server might. */
function entraError(status: number, error: string, code: number): Response {
  return json(status, {
    error,
    error_description: `AADSTS${String(code)}: Invalid client secret provided: '${SECRET}'`,
    error_codes: [code],
  });
}

test("the token comes from entra for the client credentials grant with the secret", async () => {
  const fake = new FakeTeams(clock());
  assert.equal(await provider(fake).get(), "fed-token-1");
  const [request, ...rest] = fake.tokenRequests;
  assert.equal(rest.length, 0);
  assert.equal(request?.method, "POST");
  assert.equal(request.url, TOKEN_URL);
  assert.equal(request.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(fake.form(), {
    grant_type: "client_credentials",
    client_id: CLIENT_ID,
    client_secret: SECRET,
    scope: "https://api.botframework.com/.default",
  });
  assert.equal(BOT_CONNECTOR_SCOPE, "https://api.botframework.com/.default");
});

test("a secret with form-reserved characters is encoded and reaches entra whole", async () => {
  const fake = new FakeTeams(clock());
  const secret = "a+b&c=d e%f~g";
  await new ClientSecretTokenProvider({
    clientId: CLIENT_ID,
    tenantId: TENANT,
    clientSecret: secret,
    clock: fake.clock,
    fetch: fake.fetch,
  }).get();
  assert.equal(fake.form()["client_secret"], secret);
  assert.ok(!(fake.tokenRequests[0]?.body ?? "").includes("&c=d"));
});

test("another scope is asked for when one is given", async () => {
  const fake = new FakeTeams(clock());
  await provider(fake, new RecordingLogger(), "https://graph.microsoft.com/.default").get();
  assert.equal(fake.form()["scope"], "https://graph.microsoft.com/.default");
});

test("the client secret token is cached until five minutes before it expires then fetched again", async () => {
  const fake = new FakeTeams(clock());
  fake.expiresIn = 3600;
  const tokens = provider(fake);
  assert.equal(await tokens.get(), "fed-token-1");
  await fake.clock.advance((3600 - 301) * 1000);
  assert.equal(await tokens.get(), "fed-token-1"); // cached
  assert.equal(fake.tokenRequests.length, 1);
  await fake.clock.advance(2000);
  assert.equal(await tokens.get(), "fed-token-2"); // within five minutes of expiry: a fresh one
  assert.equal(fake.tokenRequests.length, 2);
  assert.equal(fake.form(1)["client_secret"], SECRET);
});

test("concurrent callers share one client secret fetch", async () => {
  const fake = new FakeTeams(clock());
  const tokens = provider(fake);
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5].map(() => tokens.get())), Array(5).fill("fed-token-1"));
  assert.equal(fake.tokenRequests.length, 1);
});

test("a 401 from the connector invalidates the client secret token and the send is retried", async () => {
  const fake = new FakeTeams(clock());
  fake.answers = [new Response(null, { status: 401 }), json(201, { id: "teams-9" })];
  const queue = new Queue();
  const outbox = new ConnectorOutbox({ tokens: provider(fake), fallback: queue, clock: fake.clock, fetch: fake.fetch });
  assert.deepEqual(await settle(fake.clock, outbox.publish(envelope("hi"))), { activityId: "teams-9" });
  assert.deepEqual(queue.sent, []);
  assert.deepEqual(
    fake.calls.map((c) => c.headers["authorization"]),
    ["Bearer fed-token-1", "Bearer fed-token-2"],
  );
});

const REFUSED: [string, number, string, number][] = [
  ["401 invalid client secret", 401, "invalid_client", 7000215],
  ["401 expired secret", 401, "invalid_client", 7000222],
  ["400 unknown application", 400, "unauthorized_client", 700016],
  ["400 unknown tenant", 400, "invalid_request", 90002],
];

for (const [name, status, error, code] of REFUSED) {
  test(`a refusal by entra is not transient and never shows the secret: ${name}`, async () => {
    const fake = new FakeTeams(clock());
    fake.entra = [entraError(status, error, code)];
    const logger = new RecordingLogger();
    await assert.rejects(provider(fake, logger).get(), (e: unknown) => {
      assert.ok(e instanceof TokenError);
      assert.equal(e.transient, false);
      assert.equal(e.message, `Entra ID answered ${String(status)} (${error}: AADSTS${String(code)})`);
      assert.ok(!inspect(e).includes(SECRET));
      return true;
    });
    assert.ok(!logger.text().includes(SECRET));
  });
}

const BUSY: [string, Answer][] = [
  ["429", new Response(null, { status: 429 })],
  ["503", new Response(null, { status: 503 })],
  ["unreachable", new TypeError(`fetch failed for client_secret=${SECRET}`)],
];

for (const [name, answer] of BUSY) {
  test(`a busy or unreachable entra is transient for the client secret: ${name}`, async () => {
    const fake = new FakeTeams(clock());
    fake.entra = [answer];
    await assert.rejects(provider(fake).get(), (e: unknown) => {
      assert.ok(e instanceof TokenError && e.transient);
      assert.ok(!e.message.includes(SECRET));
      return true;
    });
  });
}

test("an answer without a token is refused", async () => {
  const fake = new FakeTeams(clock());
  fake.entra = [json(200, { token_type: "Bearer" })];
  await assert.rejects(provider(fake).get(), /without a usable token/);
});

test("a refused client secret sends the message to the queue after one try", async () => {
  const fake = new FakeTeams(clock());
  fake.entra = [entraError(401, "invalid_client", 7000215)];
  const queue = new Queue();
  const logger = new RecordingLogger();
  const outbox = new ConnectorOutbox({
    tokens: provider(fake, logger),
    fallback: queue,
    clock: fake.clock,
    fetch: fake.fetch,
    logger,
  });
  assert.equal(await settle(fake.clock, outbox.publish(envelope("hi"))), undefined);
  assert.equal(queue.sent.length, 1);
  assert.equal(fake.tokenRequests.length, 1);
  assert.deepEqual(fake.calls, []);
  assert.ok(!logger.text().includes(SECRET));
});

test("a missing setting is refused at construction without echoing a value", () => {
  const fake = new FakeTeams(clock());
  const base = { clientId: CLIENT_ID, tenantId: TENANT, clientSecret: SECRET, clock: fake.clock };
  for (const [key, name] of [
    ["clientId", "client id"],
    ["tenantId", "tenant id"],
    ["clientSecret", "client secret"],
  ] as const) {
    assert.throws(() => new ClientSecretTokenProvider({ ...base, [key]: "" }), {
      message: `the client secret token needs the ${name}`,
    });
  }
});

test("the client secret and the token are never logged or shown", async () => {
  const fake = new FakeTeams(clock());
  const logger = new RecordingLogger();
  const tokens = provider(fake, logger);
  await tokens.get();
  const text = logger.text();
  assert.ok(text.includes("bot connector token fetched with the client secret"));
  assert.ok(!text.includes("fed-token-1"));
  assert.ok(!text.includes(SECRET));
  assert.ok(!inspect(tokens, { showHidden: true, depth: 5 }).includes(SECRET));
  assert.ok(!JSON.stringify(tokens).includes(SECRET));
});
