// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** How the worker reaches Teams, as its settings say, and the settings that cannot work stopping it at start. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { inspect } from "node:util";
import { test } from "node:test";

import { FakeClock } from "../../../../test-support/clock.js";
import {
  botTokenSource,
  busConnections,
  gateOutbound,
  productionOutbound,
  StartupError,
  workerCredential,
} from "../../src/assembly/outbound.js";
import { teamsSettingsFromEnv, TeamsConfigError, styleFromEnv, type Env } from "../../src/config/env.js";
import { STREAM_SCOPES } from "../../src/config/style.js";
import { ConnectorOutbox } from "../../src/connector/outbox.js";
import { ClientSecretTokenProvider } from "../../src/connector/tokens/client-secret.js";
import { FederatedTokenProvider } from "../../src/connector/tokens/federated.js";
import { ImdsTokenProvider } from "../../src/connector/tokens/imds.js";
import { inboundFiles } from "../../src/inbound/attachments.js";
import { TeamsFileFetcher } from "../../src/inbound/fetcher.js";
import { ServiceBusOutbox } from "../../src/servicebus/outbox.js";
import { RecordingLogger } from "../connector/fakes.js";
import { FakeBus } from "../servicebus/fakes.js";
import { own } from "@primusclaw/personal-agent";

const CLIENT_ID = "00000000-0000-0000-0000-0000000000a1";
const KEY_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
const BASE: Env = {
  SERVICEBUS_LISTEN_CONNECTION_STRING: "Endpoint=sb://x/;SharedAccessKeyName=l;SharedAccessKey=k",
  SERVICEBUS_SEND_CONNECTION_STRING: "Endpoint=sb://x/;SharedAccessKeyName=s;SharedAccessKey=k",
};
const FEDERATED: Env = {
  ...BASE,
  OUTBOUND_MODE: "direct",
  BOT_MSI_CLIENT_ID: CLIENT_ID,
  BOT_TOKEN_SOURCE: "federated",
  BOT_TENANT_ID: "tenant-1",
  BOT_ASSERTION_ISSUER: "https://issuer.example/",
  BOT_ASSERTION_SUBJECT: "system:serviceaccount:ns:worker",
};
const deps = (files: Record<string, string> = {}) => ({
  clock: new FakeClock(),
  readFile: (path: string): Buffer => {
    const content = own(files, path);
    if (content === undefined) throw Object.assign(new Error("absent"), { code: "ENOENT" });
    return Buffer.from(content);
  },
});

test("the default outbound mode is the queue and changes nothing", () => {
  for (const env of [BASE, { ...BASE, OUTBOUND_MODE: "servicebus" }, { ...BASE, OUTBOUND_MODE: " " }]) {
    const settings = teamsSettingsFromEnv(env);
    assert.equal(settings.outboundMode, "queue");
    const built = productionOutbound(settings, new FakeBus(), deps());
    assert.ok(built.outbox instanceof ServiceBusOutbox);
    assert.equal(built.tokens, undefined);
  }
});

test("direct mode uses the connector with the queue behind it", () => {
  const settings = teamsSettingsFromEnv({ ...BASE, OUTBOUND_MODE: "Direct", BOT_MSI_CLIENT_ID: CLIENT_ID });
  assert.equal(settings.bot.msiClientId, CLIENT_ID);
  const built = productionOutbound(settings, new FakeBus(), deps());
  assert.ok(built.outbox instanceof ConnectorOutbox);
  assert.ok(built.tokens instanceof ImdsTokenProvider);
});

test("direct mode without the identity and an unknown mode refuse to start", () => {
  assert.throws(() => teamsSettingsFromEnv({ ...BASE, OUTBOUND_MODE: "direct" }), /BOT_MSI_CLIENT_ID/);
  assert.throws(() => teamsSettingsFromEnv({ ...BASE, OUTBOUND_MODE: "true" }), /OUTBOUND_MODE/);
});

test("the token source defaults to imds", () => {
  const settings = teamsSettingsFromEnv({ ...BASE, OUTBOUND_MODE: "direct", BOT_MSI_CLIENT_ID: CLIENT_ID });
  assert.equal(settings.bot.tokenSource, "imds");
  assert.ok(botTokenSource(settings, deps()) instanceof ImdsTokenProvider);
});

test("federated selects the federated provider with the mounted key", () => {
  const settings = teamsSettingsFromEnv({ ...FEDERATED, BOT_ASSERTION_KEY_FILE: "/var/run/key.pem" });
  assert.equal(settings.bot.assertionIssuer, "https://issuer.example"); // (the trailing slash is dropped)
  const tokens = botTokenSource(settings, deps({ "/var/run/key.pem": KEY_PEM }));
  assert.ok(tokens instanceof FederatedTokenProvider);
});

const APP_ID = "00000000-0000-0000-0000-0000000000c1";
const CLIENT_SECRET = "Sx8Q~not-a-real-secret.but-shaped~like_one";
const SECRET: Env = {
  ...BASE,
  OUTBOUND_MODE: "direct",
  BOT_CLIENT_ID: APP_ID,
  BOT_TENANT_ID: "tenant-1",
  BOT_CLIENT_SECRET: CLIENT_SECRET,
};

test("a client secret alone selects the client secret provider", () => {
  for (const env of [SECRET, { ...SECRET, BOT_TOKEN_SOURCE: "Secret" }, { ...SECRET, BOT_TOKEN_SOURCE: " " }]) {
    const settings = teamsSettingsFromEnv(env);
    assert.equal(settings.bot.tokenSource, "secret");
    assert.equal(settings.bot.clientSecret, CLIENT_SECRET);
    const logger = new RecordingLogger();
    const tokens = botTokenSource(settings, { ...deps(), logger });
    assert.ok(tokens instanceof ClientSecretTokenProvider);
    assert.equal(tokens.clientId, APP_ID);
    assert.ok(logger.text().includes("bot token source: secret"));
    assert.ok(!logger.text().includes(CLIENT_SECRET));
  }
});

test("the client secret is not shown in a dump of the settings", () => {
  const settings = teamsSettingsFromEnv(SECRET);
  assert.ok(!JSON.stringify(settings).includes(CLIENT_SECRET));
  assert.ok(!inspect(settings, { depth: 5 }).includes(CLIENT_SECRET));
});

test("an explicit token source wins over a client secret, with a warning", () => {
  const imds = teamsSettingsFromEnv({ ...SECRET, BOT_TOKEN_SOURCE: "imds", BOT_MSI_CLIENT_ID: CLIENT_ID });
  assert.equal(imds.bot.tokenSource, "imds");
  assert.equal(imds.bot.clientSecret, "");
  const logger = new RecordingLogger();
  assert.ok(botTokenSource(imds, { ...deps(), logger }) instanceof ImdsTokenProvider);
  const warned = logger.records.filter((r) => r.level === "warn");
  assert.deepEqual(
    warned.map((r) => [r.message, r.fields]),
    [["BOT_CLIENT_SECRET is set but not used: BOT_TOKEN_SOURCE names another source", { tokenSource: "imds" }]],
  );
  assert.ok(!logger.text().includes(CLIENT_SECRET));
  const federated = teamsSettingsFromEnv({
    ...FEDERATED,
    BOT_CLIENT_SECRET: CLIENT_SECRET,
    BOT_ASSERTION_KEY_FILE: "/k.pem",
  });
  assert.equal(federated.bot.tokenSource, "federated");
  assert.ok(botTokenSource(federated, deps({ "/k.pem": KEY_PEM })) instanceof FederatedTokenProvider);
  // without a client secret nothing changes and nothing is warned
  const plain = new RecordingLogger();
  botTokenSource(teamsSettingsFromEnv({ ...BASE, OUTBOUND_MODE: "direct", BOT_MSI_CLIENT_ID: CLIENT_ID }), {
    ...deps(),
    logger: plain,
  });
  assert.deepEqual(
    plain.records.filter((r) => r.level === "warn"),
    [],
  );
});

test("client secret settings that cannot work refuse to start", () => {
  for (const missing of ["BOT_CLIENT_ID", "BOT_TENANT_ID"]) {
    const env = Object.fromEntries(Object.entries(SECRET).filter(([k]) => k !== missing));
    assert.throws(() => teamsSettingsFromEnv(env), new RegExp(`${missing} is required`));
  }
  assert.throws(
    () => teamsSettingsFromEnv({ ...SECRET, BOT_TOKEN_SOURCE: "secret", BOT_CLIENT_SECRET: "" }),
    /BOT_CLIENT_SECRET is required/,
  );
  // (BOT_MSI_CLIENT_ID is not needed with a client secret)
  assert.equal(teamsSettingsFromEnv(SECRET).bot.msiClientId, "");
  for (const env of [
    { ...SECRET, OUTBOUND_MODE: "servicebus" },
    { ...SECRET, OUTBOUND_MODE: "servicebus", BOT_TOKEN_SOURCE: "secret" },
  ]) {
    assert.throws(
      () => teamsSettingsFromEnv(env),
      (e: unknown) =>
        e instanceof TeamsConfigError &&
        /needs OUTBOUND_MODE=direct/.test(e.message) &&
        !e.message.includes(CLIENT_SECRET),
    );
  }
});

test("federated settings that cannot work refuse to start", () => {
  assert.throws(
    () =>
      teamsSettingsFromEnv({
        ...BASE,
        OUTBOUND_MODE: "direct",
        BOT_MSI_CLIENT_ID: CLIENT_ID,
        BOT_TOKEN_SOURCE: "password",
      }),
    /BOT_TOKEN_SOURCE/,
  );
  assert.throws(() => teamsSettingsFromEnv({ ...BASE, BOT_TOKEN_SOURCE: "federated" }), /OUTBOUND_MODE=direct/);
  for (const missing of ["BOT_TENANT_ID", "BOT_ASSERTION_ISSUER", "BOT_ASSERTION_SUBJECT"]) {
    const env = Object.fromEntries(Object.entries(FEDERATED).filter(([k]) => k !== missing));
    assert.throws(() => teamsSettingsFromEnv({ ...env, BOT_ASSERTION_KEY_FILE: "/x" }), new RegExp(missing));
  }
  assert.throws(() => teamsSettingsFromEnv(FEDERATED), /BOT_ASSERTION_KEY_FILE/);
  assert.throws(
    () => teamsSettingsFromEnv({ ...FEDERATED, BOT_ASSERTION_ISSUER: "http://x", BOT_ASSERTION_KEY_FILE: "/x" }),
    /https/,
  );
  const absent = teamsSettingsFromEnv({ ...FEDERATED, BOT_ASSERTION_KEY_FILE: "/absent.pem" });
  assert.throws(() => botTokenSource(absent, deps()), /BOT_ASSERTION_KEY_FILE cannot be read/);
  const bad = teamsSettingsFromEnv({ ...FEDERATED, BOT_ASSERTION_KEY_FILE: "/bad.pem" });
  assert.throws(
    () => botTokenSource(bad, deps({ "/bad.pem": "not a key" })),
    (e: unknown) => {
      return e instanceof StartupError && e.message.startsWith("BOT_ASSERTION_KEY_FILE");
    },
  );
});

test("each kind of chat has its own switch", () => {
  for (const [raw, personal, group] of [
    ["", true, true],
    ["personal", true, false],
    ["groupChat", false, true],
    ["1:1, group", true, true],
    ["off", false, false],
  ] as const) {
    const style = styleFromEnv({ TEAMS_STREAMING: raw });
    assert.equal(style.streaming.has("personal"), personal, raw);
    assert.equal(style.streaming.has("groupChat"), group, raw);
  }
  assert.deepEqual([...styleFromEnv({}).streaming].sort(), [...STREAM_SCOPES].sort());
});

test("the teams streaming setting is read and a typo stops the worker", () => {
  assert.throws(() => styleFromEnv({ TEAMS_STREAMING: "personal,team" }), TeamsConfigError);
  assert.throws(() => styleFromEnv({ TEAMS_STREAMING: "," }), TeamsConfigError);
  assert.throws(() => styleFromEnv({ TEAMS_AI_LABEL: "maybe" }), /TEAMS_AI_LABEL must be on or off/);
  assert.equal(styleFromEnv({ TEAMS_AI_LABEL: "OFF", TEAMS_CITATIONS: "yes" }).aiLabel, false);
  assert.equal(styleFromEnv({ TEAMS_CITATIONS: "yes" }).citations, true);
});

test("the gate's test entry goes to its recording connector only, with no queue and a made-up token", async () => {
  const built = gateOutbound(
    { connectorUrl: "http://127.0.0.1:8082", runId: "run-9", filesPrefix: "http://127.0.0.1:8082/gate-files/" },
    deps(),
  );
  assert.ok(built.outbox instanceof ConnectorOutbox);
  assert.equal(await built.tokens?.get(), "release-gate-run-9-not-a-token");
  assert.doesNotThrow(() => {
    built.policy.check("http://127.0.0.1:8082/");
  });
  assert.throws(() => {
    built.policy.check("https://smba.trafficmanager.net/emea/");
  });
  await built.close();
});

test("with a namespace both queues use the worker identity; without one the connection strings", () => {
  const plain = teamsSettingsFromEnv(BASE);
  assert.deepEqual(busConnections(plain, undefined), [
    BASE["SERVICEBUS_LISTEN_CONNECTION_STRING"],
    BASE["SERVICEBUS_SEND_CONNECTION_STRING"],
  ]);
  const identity = teamsSettingsFromEnv({
    SERVICEBUS_NAMESPACE: "personal-agent.servicebus.windows.net",
    WORKER_IDENTITY_CLIENT_ID: "w-1",
    WORKER_IDENTITY_SUBJECT: "system:serviceaccount:ns:w",
    BOT_TENANT_ID: "tenant-1",
    BOT_ASSERTION_ISSUER: "https://issuer.example",
    BOT_ASSERTION_KEY_FILE: "/k.pem",
  });
  const credential = workerCredential(identity, deps({ "/k.pem": KEY_PEM }));
  assert.ok(credential);
  const [inbound, outbound] = busConnections(identity, credential);
  assert.deepEqual(inbound, { namespace: "personal-agent.servicebus.windows.net", credential });
  assert.equal(inbound, outbound);
  assert.throws(() => busConnections(identity, undefined), StartupError);
  assert.equal(workerCredential(plain, deps()), undefined);
});

test("an attached image is fetched with the federated token", async () => {
  const calls: Array<{ url: string; auth: string }> = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push({ url, auth });
    if (url.startsWith("https://login.microsoftonline.com/")) {
      return Promise.resolve(Response.json({ access_token: "fed-token-1", expires_in: 3600 }));
    }
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x72]);
    return Promise.resolve(new Response(png, { headers: { "content-type": "image/png" } }));
  };
  const clock = new FakeClock();
  const settings = teamsSettingsFromEnv({ ...FEDERATED, BOT_ASSERTION_KEY_FILE: "/k.pem" });
  const tokens = botTokenSource(settings, { ...deps({ "/k.pem": KEY_PEM }), clock, fetch: fakeFetch });
  const fetcher = new TeamsFileFetcher({ fetch: fakeFetch, clock, tokens });
  const url = "https://smba.trafficmanager.net/amer/v3/attachments/abc/views/original";
  const { files } = inboundFiles({ attachments: [{ contentType: "image/png", contentUrl: url }] });
  const [file] = files;
  assert.ok(file);
  const fetched = await fetcher.fetchFile(file);
  assert.ok(fetched.ok);
  const connector = calls.filter((c) => c.url === url);
  assert.deepEqual(
    connector.map((c) => c.auth),
    ["Bearer fed-token-1"],
  );
});
