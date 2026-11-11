/**
 * How the ingress Function reaches Service Bus: managed identity first, the queue SAS connection string as the
 * fallback. A port of ingress-function/tests/test_servicebus_connection.py (test names match).
 *
 * Both queues must work in both shapes: the inbound sender is built by the app (`newClient`), the outbound trigger's
 * connection is resolved by the Functions host from the setting named in the binding, which reads either a connection
 * string under the name itself or `<name>__fullyQualifiedNamespace` for an identity-based connection.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CLIENT_OPTIONS } from "../src/servicebus.js";
import { defined, load as loadWith, type Loaded, MESSAGE, nth, post } from "./helpers.js";
import { functions } from "./wiring.js";

const NAMESPACE = "example-bus.servicebus.windows.net";
const SAS =
  "Endpoint=sb://example-bus.servicebus.windows.net/;SharedAccessKeyName=fn-send;SharedAccessKey=not-a-real-key";
const IDENTITY_ENV = {
  PRIMUSCLAW_BOT_APP_ID: "bot-uami-client-id",
  PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: NAMESPACE,
  PRIMUSCLAW_OUTBOUND_SERVICEBUS__fullyQualifiedNamespace: NAMESPACE,
  PRIMUSCLAW_OUTBOUND_SERVICEBUS__credential: "managedidentity",
  PRIMUSCLAW_OUTBOUND_SERVICEBUS__clientId: "bot-uami-client-id",
};
// The recommended setup: the app's own system-assigned identity on both queues, no client id anywhere.
const SYSTEM_IDENTITY_ENV = {
  PRIMUSCLAW_BOT_APP_ID: "bot-uami-client-id",
  PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: NAMESPACE,
  PRIMUSCLAW_SERVICEBUS__credential: "managedidentity",
  PRIMUSCLAW_OUTBOUND_SERVICEBUS__fullyQualifiedNamespace: NAMESPACE,
  PRIMUSCLAW_OUTBOUND_SERVICEBUS__credential: "managedidentity",
};
const SAS_ENV = {
  PRIMUSCLAW_BOT_APP_ID: "bot-uami-client-id",
  PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING: SAS,
  PRIMUSCLAW_OUTBOUND_SERVICEBUS: SAS,
};

function load(env: Record<string, string>): Loaded {
  const loaded = loadWith(env);
  loaded.ingress.validate = () => Promise.resolve({});
  return loaded;
}

// --- identity-based ----------------------------------------------------------

test("test_identity_inbound_sender_uses_the_namespace_and_the_bots_managed_identity", async () => {
  const { ingress, bus } = load(IDENTITY_ENV);
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal(bus.built.length, 1);
  const [{ kind, target, clientId }] = bus.built as [(typeof bus.built)[0]];
  assert.deepEqual([kind, target], ["identity", NAMESPACE]);
  // Default identity: the bot's user-assigned identity, already assigned to the app.
  assert.equal(clientId, "bot-uami-client-id");
  // AMQP over WebSockets, as the Python sender's TransportType.AmqpOverWebsocket.
  assert.equal(CLIENT_OPTIONS.webSocketOptions?.webSocket, globalThis.WebSocket);
  assert.deepEqual(
    bus.sent.map((s) => s.queue),
    ["primusclaw-inbound"],
  );
});

test("test_identity_client_id_can_name_another_identity", async () => {
  const { ingress, bus } = load({ ...IDENTITY_ENV, PRIMUSCLAW_SERVICEBUS__clientId: "other-uami" });
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal(nth(bus.built, 0).clientId, "other-uami");
});

test("test_identity_accepts_an_sb_url_for_the_namespace", async () => {
  const { ingress, bus } = load({
    ...IDENTITY_ENV,
    PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: `sb://${NAMESPACE}/`,
  });
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal(nth(bus.built, 0).target, NAMESPACE);
});

test("test_identity_wins_over_a_leftover_connection_string_and_says_so", async () => {
  const { ingress, bus, log } = load({ ...IDENTITY_ENV, PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING: SAS });
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.deepEqual(
    bus.built.map((b) => b.kind),
    ["identity"],
  );
  assert.ok(log.text.includes("PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING is ignored"));
  assert.ok(!log.text.includes("not-a-real-key"));
});

test("test_identity_outbound_trigger_is_registered_on_the_same_connection_setting", () => {
  const { ingress } = load(IDENTITY_ENV);
  const fns = functions(ingress);
  assert.deepEqual([...fns.keys()].sort(), ["messages", "outbound"]);
  // The host resolves PRIMUSCLAW_OUTBOUND_SERVICEBUS__fullyQualifiedNamespace from this name.
  assert.deepEqual(
    [defined(fns.get("outbound")).options["queueName"], defined(fns.get("outbound")).options["connection"]],
    ["primusclaw-outbound", "PRIMUSCLAW_OUTBOUND_SERVICEBUS"],
  );
});

test("test_a_connection_string_in_the_namespace_setting_is_refused_without_echoing_it", async () => {
  const { ingress, bus, log } = load({ ...IDENTITY_ENV, PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: SAS });
  assert.equal((await post(ingress, MESSAGE)).status, 500);
  assert.deepEqual(bus.built, []);
  assert.deepEqual(bus.sent, []);
  assert.ok(!log.text.includes("not-a-real-key"));
});

test("test_identity_without_any_client_id_is_refused", () => {
  const env = Object.fromEntries(Object.entries(IDENTITY_ENV).filter(([k]) => k !== "PRIMUSCLAW_BOT_APP_ID"));
  const { ingress, bus } = load(env);
  assert.throws(() => ingress.newClient(), /clientId/);
  assert.deepEqual(bus.built, []);
});

// --- system-assigned identity ------------------------------------------------

test("test_credential_managedidentity_without_client_id_uses_the_system_assigned_identity", async () => {
  const { ingress, bus } = load(SYSTEM_IDENTITY_ENV);
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal(bus.built.length, 1);
  assert.deepEqual([nth(bus.built, 0).kind, nth(bus.built, 0).target], ["identity", NAMESPACE]);
  // Not the bot's identity, although PRIMUSCLAW_BOT_APP_ID is set.
  assert.equal(nth(bus.built, 0).clientId, null);
  assert.deepEqual(
    bus.sent.map((s) => s.queue),
    ["primusclaw-inbound"],
  );
});

test("test_credential_value_is_case_insensitive_like_the_host", async () => {
  const { ingress, bus } = load({ ...SYSTEM_IDENTITY_ENV, PRIMUSCLAW_SERVICEBUS__credential: " ManagedIdentity " });
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal(nth(bus.built, 0).clientId, null);
});

test("test_system_assigned_identity_does_not_need_the_bot_app_id", () => {
  const env = Object.fromEntries(Object.entries(SYSTEM_IDENTITY_ENV).filter(([k]) => k !== "PRIMUSCLAW_BOT_APP_ID"));
  const { ingress, bus } = load(env);
  ingress.newClient();
  assert.equal(nth(bus.built, 0).clientId, null);
});

test("test_credential_with_client_id_uses_that_user_assigned_identity", async () => {
  const { ingress, bus } = load({ ...SYSTEM_IDENTITY_ENV, PRIMUSCLAW_SERVICEBUS__clientId: "other-uami" });
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.equal(nth(bus.built, 0).clientId, "other-uami");
});

test("test_an_unknown_credential_value_is_refused", () => {
  const { ingress, bus } = load({ ...SYSTEM_IDENTITY_ENV, PRIMUSCLAW_SERVICEBUS__credential: "connectionstring" });
  assert.throws(() => ingress.newClient(), /__credential/);
  assert.deepEqual(bus.built, []);
});

test("test_system_identity_outbound_trigger_is_registered", () => {
  const { ingress } = load(SYSTEM_IDENTITY_ENV);
  const fns = functions(ingress);
  assert.deepEqual([...fns.keys()].sort(), ["messages", "outbound"]);
  assert.equal(defined(fns.get("outbound")).options["connection"], "PRIMUSCLAW_OUTBOUND_SERVICEBUS");
});

// --- connection string fallback ----------------------------------------------

test("test_connection_string_inbound_sender_is_the_fallback", async () => {
  const { ingress, bus } = load(SAS_ENV);
  assert.equal((await post(ingress, MESSAGE)).status, 200);
  assert.deepEqual(bus.built, [{ kind: "connection_string", target: SAS, clientId: null }]);
  assert.equal(CLIENT_OPTIONS.webSocketOptions?.webSocket, globalThis.WebSocket);
  assert.deepEqual(
    bus.sent.map((s) => s.queue),
    ["primusclaw-inbound"],
  );
});

test("test_connection_string_outbound_trigger_is_registered", () => {
  const { ingress } = load(SAS_ENV);
  const fns = functions(ingress);
  assert.deepEqual([...fns.keys()].sort(), ["messages", "outbound"]);
  assert.equal(defined(fns.get("outbound")).options["connection"], "PRIMUSCLAW_OUTBOUND_SERVICEBUS");
});

// --- neither -----------------------------------------------------------------

test("test_no_service_bus_settings_keep_the_route_up_and_fail_the_enqueue", async () => {
  const { ingress, bus } = load({ PRIMUSCLAW_BOT_APP_ID: "bot-uami-client-id" });
  assert.deepEqual([...functions(ingress).keys()], ["messages"]);
  // Teams retries a 500; nothing was built or sent.
  assert.equal((await post(ingress, MESSAGE)).status, 500);
  assert.deepEqual(bus.built, []);
  assert.deepEqual(bus.sent, []);
});
