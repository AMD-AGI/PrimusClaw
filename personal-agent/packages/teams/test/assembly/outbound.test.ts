// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** How the worker reaches Teams, as its settings say, and the settings that cannot work stopping it at start. */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
import { FederatedTokenProvider } from "../../src/connector/tokens/federated.js";
import { ImdsTokenProvider } from "../../src/connector/tokens/imds.js";
import { inboundFiles } from "../../src/inbound/attachments.js";
import { TeamsFileFetcher } from "../../src/inbound/fetcher.js";
import { ServiceBusOutbox } from "../../src/servicebus/outbox.js";
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

test("federated settings that cannot work refuse to start", () => {
  assert.throws(
    () =>
      teamsSettingsFromEnv({
        ...BASE,
        OUTBOUND_MODE: "direct",
        BOT_MSI_CLIENT_ID: CLIENT_ID,
        BOT_TOKEN_SOURCE: "secret",
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
    SERVICEBUS_NAMESPACE: "clawy.servicebus.windows.net",
    WORKER_IDENTITY_CLIENT_ID: "w-1",
    WORKER_IDENTITY_SUBJECT: "system:serviceaccount:ns:w",
    BOT_TENANT_ID: "tenant-1",
    BOT_ASSERTION_ISSUER: "https://issuer.example",
    BOT_ASSERTION_KEY_FILE: "/k.pem",
  });
  const credential = workerCredential(identity, deps({ "/k.pem": KEY_PEM }));
  assert.ok(credential);
  const [inbound, outbound] = busConnections(identity, credential);
  assert.deepEqual(inbound, { namespace: "clawy.servicebus.windows.net", credential });
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
