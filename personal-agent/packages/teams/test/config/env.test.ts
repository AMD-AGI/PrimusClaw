// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The Teams settings for Service Bus: a namespace reached as the worker's own identity, or the connection strings. */
import assert from "node:assert/strict";
import test from "node:test";
import { TeamsConfigError, teamsSettingsFromEnv, type Env } from "../../src/config/env.js";

const TENANT = "00000000-0000-0000-0000-0000000000b2";
const ISSUER = "https://oidc.example.com/prod";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const SUBJECT = "claw-teams-agent-kv";
const NAMESPACE = "example-ns.servicebus.windows.net";

function refused(pattern: RegExp | string): (e: unknown) => boolean {
  return (e: unknown) =>
    e instanceof TeamsConfigError && (typeof pattern === "string" ? e.message === pattern : pattern.test(e.message));
}

test("with a namespace service bus needs no connection string and both queues use the worker identity", () => {
  const s = teamsSettingsFromEnv({
    SERVICEBUS_NAMESPACE: NAMESPACE.toUpperCase(),
    WORKER_IDENTITY_CLIENT_ID: CLIENT_ID,
    WORKER_IDENTITY_SUBJECT: SUBJECT,
    BOT_TENANT_ID: TENANT,
    BOT_ASSERTION_ISSUER: `${ISSUER}/`,
    BOT_ASSERTION_KEY_FILE: "/etc/claw-bot/private-key.pem",
  });
  assert.equal(s.bus.namespace, NAMESPACE);
  assert.equal(s.bus.listenConnectionString, "");
  assert.equal(s.bus.sendConnectionString, "");
  assert.deepEqual(s.workerIdentity, {
    clientId: CLIENT_ID,
    tenantId: TENANT,
    issuer: ISSUER,
    subject: SUBJECT,
    keyFile: "/etc/claw-bot/private-key.pem",
  });
});

test("without a namespace the connection strings are used as before", () => {
  const s = teamsSettingsFromEnv({ SERVICEBUS_LISTEN_CONNECTION_STRING: "l", SERVICEBUS_SEND_CONNECTION_STRING: "s" });
  assert.equal(s.workerIdentity, undefined);
  assert.equal(s.bus.namespace, "");
  assert.equal(s.bus.listenConnectionString, "l");
  assert.equal(s.bus.sendConnectionString, "s");
  assert.throws(() => teamsSettingsFromEnv({}), refused(/SERVICEBUS_LISTEN_CONNECTION_STRING/));
});

for (const namespace of ["sb://example-ns.servicebus.windows.net/", "primus-safe", "primus-safe.example.com"]) {
  test(`a namespace that is not a host name refuses to start: ${namespace}`, () => {
    const env: Env = { SERVICEBUS_NAMESPACE: namespace };
    assert.throws(() => teamsSettingsFromEnv(env), refused(/SERVICEBUS_NAMESPACE must be/));
  });
}

test("a namespace without the worker identity refuses to start", () => {
  assert.throws(
    () => teamsSettingsFromEnv({ SERVICEBUS_NAMESPACE: NAMESPACE }),
    refused(
      "SERVICEBUS_NAMESPACE needs the worker identity: set WORKER_IDENTITY_CLIENT_ID, BOT_TENANT_ID, " +
        "BOT_ASSERTION_ISSUER, WORKER_IDENTITY_SUBJECT, BOT_ASSERTION_KEY_FILE",
    ),
  );
});

test("the install link is read from the environment and must be https", () => {
  const base = {
    SERVICEBUS_LISTEN_CONNECTION_STRING: "x",
    SERVICEBUS_SEND_CONNECTION_STRING: "y",
  };
  assert.equal(teamsSettingsFromEnv(base).installHintUrl, "");
  assert.equal(
    teamsSettingsFromEnv({ ...base, TEAMS_INSTALL_HINT_URL: " https://teams.microsoft.com/l/app/x " }).installHintUrl,
    "https://teams.microsoft.com/l/app/x",
  );
  assert.throws(
    () => teamsSettingsFromEnv({ ...base, TEAMS_INSTALL_HINT_URL: "teams.microsoft.com/l/app/x" }),
    /TEAMS_INSTALL_HINT_URL/,
  );
});

test("a word of teams streaming that only an object's prototype knows is a typo that stops the worker", () => {
  // (Python: named.get("constructor", "") is "", so the setting is refused)
  for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.throws(
      () =>
        teamsSettingsFromEnv({
          SERVICEBUS_LISTEN_CONNECTION_STRING: "l",
          SERVICEBUS_SEND_CONNECTION_STRING: "s",
          TEAMS_STREAMING: word,
        }),
      TeamsConfigError,
      word,
    );
  }
});
