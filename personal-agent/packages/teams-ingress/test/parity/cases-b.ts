// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The parity cases of keys and settings, Service Bus, the deployed shape and the outbound trigger. */
import { APP, CONV, type Kit } from "./kit.js";

export function part7(k: Kit): void {
  // --- X-Forwarded-For --------------------------------------------------------------------------------------------
  for (const forwarded of [
    "203.0.113.7",
    "203.0.113.7:4431",
    "10.0.0.1, 203.0.113.7:4431",
    "[2001:db8::7]:443",
    "2001:db8::7",
    "",
    "not-an-address",
    "[::ffff:1.2.3.4]:1",
    "::ffff:23.45.67.89",
    "abcd:2345::",
    "23.45.67.89",
    "::1",
    "fe80::1%eth0",
    "1:2:3:4:5:6:7:8",
    "1::",
    "::",
    "0:0:0:0:0:0:0:1",
    "2001:0db8:0000:0000:0000:ff00:0042:8329",
    "01.2.3.4",
    "256.1.1.1",
    "1.2.3",
    "1:2:3:4:5:6:7:8:9",
    "::1.2.3.4",
    "[2001:db8::7",
    "2001:db8::7]:443",
  ]) {
    k.http(`X-Forwarded-For ${JSON.stringify(forwarded)}`, k.message(), { "X-Forwarded-For": forwarded });
  }
  k.sb("identity, bot's identity", { PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: k.NS });
  k.sb("identity, another client id", {
    PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: k.NS,
    PRIMUSCLAW_SERVICEBUS__clientId: "other-uami",
  });
  k.sb("identity, sb:// URL", { PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: `sb://${k.NS}/` });
  k.sb("identity, padded namespace", { PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: `  ${k.NS}/ ` });
  k.sb("identity wins over a connection string", {
    PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: k.NS,
    PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING: k.SAS,
  });
  k.sb("connection string in the namespace setting", { PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: k.SAS });
  k.sb("system-assigned identity", {
    PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: k.NS,
    PRIMUSCLAW_SERVICEBUS__credential: "managedidentity",
  });
  k.sb("credential in mixed case", {
    PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: k.NS,
    PRIMUSCLAW_SERVICEBUS__credential: " ManagedIdentity ",
  });
  k.sb("credential with a client id", {
    PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: k.NS,
    PRIMUSCLAW_SERVICEBUS__credential: "managedidentity",
    PRIMUSCLAW_SERVICEBUS__clientId: "other-uami",
  });
}

export function part8(k: Kit): void {
  k.sb("unknown credential", {
    PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: k.NS,
    PRIMUSCLAW_SERVICEBUS__credential: "connectionstring",
  });
  k.sb("connection string", { PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING: k.SAS });
  k.sb("queue name overridden", {
    PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING: k.SAS,
    PRIMUSCLAW_SERVICEBUS_QUEUE: "claw-in",
  });
  k.sb("nothing set", {});
  k.http("identity without any client id", k.message(), k.bearer(k.tok()), {
    env: {
      BOT_OPENID_CONFIG_URL: "{base}/openid/ok",
      PRIMUSCLAW_BOT_APP_ID: "",
      PRIMUSCLAW_SERVICEBUS__fullyQualifiedNamespace: k.NS,
    },
  });
  k.http("send fails once, retried", k.message(), k.bearer(k.tok()), { failSends: [1] });
  k.http("send fails twice: 500", k.message(), k.bearer(k.tok()), { failSends: [1, 1] });
  k.http("card action, send fails twice: unavailable card", k.card, k.bearer(k.tok()), { failSends: [1, 1] });
  k.http("feedback, send fails twice: 500", k.feedback, k.bearer(k.tok()), { failSends: [1, 1] });
  k.http("card action, nothing set: unavailable card", k.card, k.bearer(k.tok()), {
    env: { BOT_OPENID_CONFIG_URL: "{base}/openid/ok", PRIMUSCLAW_BOT_APP_ID: APP },
  });
  // --- the deployed shape -----------------------------------------------------------------------------------------
  k.http("outbound queue name overridden", k.message(), k.bearer(k.tok()), {
    env: { ...k.outEnv, PRIMUSCLAW_OUTBOUND_QUEUE: "claw-out" },
  });
  k.http("outbound by identity", k.message(), k.bearer(k.tok()), {
    env: { ...k.httpEnv, PRIMUSCLAW_OUTBOUND_SERVICEBUS__fullyQualifiedNamespace: k.NS },
  });
  k.http("outbound queue setting empty", k.message(), k.bearer(k.tok()), {
    env: { ...k.outEnv, PRIMUSCLAW_OUTBOUND_QUEUE: "" },
  });
  k.outbound("send", { operation: "send", reference: k.REF, activity: { text: "hi" } });
  k.outbound("send, operation missing", { reference: k.REF, activity: { text: "hi" } });
  k.outbound("reply", { operation: "reply", reference: k.REF, activity: { text: "x" } });
  k.outbound("reply without activityId", {
    operation: "reply",
    reference: { ...k.REF, activityId: "" },
    activity: { text: "x" },
  });
  k.outbound("update", { operation: "update", activity_id: "act-9", reference: k.REF, activity: { text: "x" } });
  k.outbound("update with an id in the activity", {
    operation: "update",
    activity_id: "act-9",
    reference: k.REF,
    activity: { id: "old" },
  });
  k.outbound("typing", { operation: "send", reference: k.REF, activity: { type: "typing" } });
  k.outbound("operation in upper case", { operation: "REPLY", reference: k.REF, activity: {} });
  k.outbound("operation a number", { operation: 5, reference: k.REF, activity: {} });
  k.outbound("delete", { operation: "delete", reference: k.REF, activity: {} });
  k.outbound("ack", { operation: "send", reference: k.REF, activity: { text: "x" }, ack: "ack-1" });
  k.outbound("ack a number", { operation: "send", reference: k.REF, activity: { text: "x" }, ack: 7 });
}

export function part9(k: Kit): void {
  k.outbound("ack, long conversation id", {
    operation: "send",
    reference: { ...k.REF, conversation: { id: `a:${"y".repeat(150)}` } },
    activity: {},
    ack: "ack-2",
  });
  k.outbound("update is not acked", {
    operation: "update",
    activity_id: "a",
    reference: k.REF,
    activity: { text: "x" },
    ack: "ack-1",
  });
  k.outbound(
    "ack, answer without an id",
    { operation: "send", reference: k.REF, activity: {}, ack: "ack-1" },
    { connector: [{ status: 200, body: "{}" }] },
  );
  k.outbound(
    "ack, answer id empty",
    { operation: "send", reference: k.REF, activity: {}, ack: "ack-1" },
    { connector: [{ status: 200, body: '{"id": ""}' }] },
  );
  k.outbound(
    "ack, answer id a number",
    { operation: "send", reference: k.REF, activity: {}, ack: "ack-1" },
    { connector: [{ status: 201, body: '{"id": 5}' }] },
  );
  k.outbound(
    "ack, answer id a float",
    { operation: "send", reference: k.REF, activity: {}, ack: "ack-1" },
    { connector: [{ status: 200, body: '{"id": 1.0}' }] },
  );
  k.outbound(
    "ack, answer not JSON",
    { operation: "send", reference: k.REF, activity: {}, ack: "ack-1" },
    { connector: [{ status: 200, body: "OK" }] },
  );
  k.outbound(
    "ack, answer empty",
    { operation: "send", reference: k.REF, activity: {}, ack: "ack-1" },
    { connector: [{ status: 202, body: "" }] },
  );
  k.outbound(
    "ack, answer a list",
    { operation: "send", reference: k.REF, activity: {}, ack: "ack-1" },
    { connector: [{ status: 200, body: "[1]" }] },
  );
  k.outbound(
    "ack, answer an empty list",
    { operation: "send", reference: k.REF, activity: {}, ack: "ack-1" },
    { connector: [{ status: 200, body: "[]" }] },
  );
}

export function part10(k: Kit): void {
  k.outbound(
    "ack, the bus fails",
    { operation: "send", reference: k.REF, activity: {}, ack: "ack-1" },
    { failSends: [1, 1] },
  );
  for (const status of [401, 429, 500, 503, 403, 404, 400]) {
    k.outbound(
      `connector answers ${String(status)}`,
      { operation: "send", reference: k.REF, activity: { text: "x" } },
      { connector: [{ status, body: '{"error": {"code": "BadArgument", "message": "MESSAGE-MARK"}}' }] },
    );
  }
  for (const body of [
    '{"error": {"code": "MESSAGE-MARK 7731 with spaces"}}',
    '{"error": "MESSAGE-MARK-7731"}',
    "{}",
    "[1]",
    "not json",
    '{"error": {"code": 5}}',
    '{"error": {"code": "Conversation.NotFound_1-x"}}',
  ]) {
    k.outbound(
      `refusal body ${body}`,
      { operation: "send", reference: k.REF, activity: {} },
      { connector: [{ status: 403, body }] },
    );
  }
  k.outbound(
    "refusal code of 64 characters",
    { operation: "send", reference: k.REF, activity: {} },
    { connector: [{ status: 400, body: JSON.stringify({ error: { code: `A${"b".repeat(63)}` } }) }] },
  );
  k.outbound(
    "refusal code of 65 characters",
    { operation: "send", reference: k.REF, activity: {} },
    { connector: [{ status: 400, body: JSON.stringify({ error: { code: `A${"b".repeat(64)}` } }) }] },
  );
  k.outbound(
    "connection refused",
    { operation: "send", reference: k.REF, activity: {} },
    { connector: [{ error: true }] },
  );
  k.outbound(
    "redirect status 302",
    { operation: "send", reference: k.REF, activity: {} },
    { connector: [{ status: 302, body: "" }] },
  );
  k.outbound(
    "activity with NaN",
    Buffer.from(`{"operation": "send", "reference": ${JSON.stringify(k.REF)}, "activity": {"v": NaN}}`),
  );
  k.outbound("activity with its own from, type and locale", {
    operation: "send",
    reference: { ...k.REF, locale: "en-US" },
    activity: { type: "message", from: { id: "x" }, locale: "fr-FR", text: "t" },
  });
}

export function part11(k: Kit): void {
  k.outbound("reference with a locale", {
    operation: "send",
    reference: { ...k.REF, locale: "en-US" },
    activity: { text: "t" },
  });
  k.outbound("reference without bot and user", {
    operation: "send",
    reference: { serviceUrl: k.REF.serviceUrl, conversation: CONV },
    activity: { text: "t" },
  });
  k.outbound("reference conversation id a number", {
    operation: "send",
    reference: { ...k.REF, conversation: { id: 42 } },
    activity: {},
  });
  k.outbound("ids with path characters", {
    operation: "reply",
    reference: { ...k.REF, conversation: { id: "19:a/../b?x=1#f é" }, activityId: "r/1 ü" },
    activity: {},
  });
  k.outbound("update id with path characters", {
    operation: "update",
    activity_id: "a/b?c",
    reference: k.REF,
    activity: {},
  });
  k.outbound("serviceUrl with spaces and slashes", {
    operation: "send",
    reference: { ...k.REF, serviceUrl: "  https://smba.trafficmanager.net/teams///  " },
    activity: {},
  });
  k.outbound("unicode in the activity", {
    operation: "send",
    reference: k.REF,
    activity: { text: "你好 \u{1F600}", "2": 1, a: 2 },
  });
  for (const [name, envelope] of k.envelopes) k.outbound(`envelope: ${name}`, envelope);
}

export function part12(k: Kit): void {
  for (const serviceUrl of [
    "http://smba.trafficmanager.net/teams",
    "https://attacker.trafficmanager.net/teams",
    "https://evil.example.com",
    "https://smba.trafficmanager.net.evil.com/teams",
    "https://evilbotframework.com",
    "https://user:pw@smba.trafficmanager.net/teams",
    "https://smba.trafficmanager.net:8443/teams",
    "https://smba.trafficmanager.net/emea/",
    "https://webchat.botframework.com/",
    "https://smba.infra.gov.teams.microsoft.us/gcch",
    "https://SMBA.trafficmanager.net/teams",
    "https://[v1.x.botframework.com]/",
  ]) {
    k.outbound(`outbound serviceUrl ${serviceUrl}`, {
      operation: "send",
      reference: { ...k.REF, serviceUrl },
      activity: {},
    });
  }
  for (const body of ["nope", "[]", "null", "5", '"s"', "", "{"])
    k.outbound(`body ${JSON.stringify(body)}`, Buffer.from(body));
  k.outbound("body invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d]));
  k.outbound("body with a BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("{}")]));
  k.outbound(
    "identity endpoint fails",
    { operation: "send", reference: k.REF, activity: {} },
    { env: k.msi("msi500") },
  );
  k.outbound(
    "identity endpoint without a token",
    { operation: "send", reference: k.REF, activity: {} },
    { env: k.msi("msiNoToken") },
  );
  k.outbound(
    "identity endpoint with absolute expiry",
    { operation: "send", reference: k.REF, activity: {} },
    { env: k.msi("msiExpiresOn") },
  );
  k.outbound(
    "identity endpoint with a string expiry",
    { operation: "send", reference: k.REF, activity: {} },
    { env: k.msi("msiStringExpiry") },
  );
  k.outbound(
    "bot app id unset",
    { operation: "send", reference: k.REF, activity: {} },
    { env: { ...k.outEnv, PRIMUSCLAW_BOT_APP_ID: "" } },
  );
  k.outbound(
    "no identity header: IMDS",
    { operation: "send", reference: { ...k.REF, serviceUrl: "https://evil.example.com" }, activity: {} },
    { env: { ...k.outEnv, IDENTITY_HEADER: "" } },
  );
}
