// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The outbound trigger: the fallback delivery path (the worker's OUTBOUND_MODE=servicebus). A port of the Python
 * Function's tests/test_ingress.py, its outbound part (test names match; parametrized cases are subtests).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { own } from "@primusclaw/personal-agent";

import {
  bodyOf,
  CONVERSATION,
  defined,
  fakeResponse,
  MESSAGE,
  nth,
  post,
  REFERENCE,
  rejects,
  SERVICE_URL,
} from "./helpers.js";
import { runOutbound, wired } from "./wiring.js";

const sha = (value: string): string => `h:${createHash("sha256").update(value, "utf8").digest("hex")}`;

// --- outbound fallback ---------------------------------------------------------

test("test_outbound_signs_in_as_the_bots_identity", async () => {
  const w = wired();
  await runOutbound(w.ingress, { operation: "send", reference: REFERENCE, activity: { text: "hi" } });
  assert.equal(w.http.tokensAsked.length, 1);
  const { url, params, headers } = nth(w.http.tokensAsked, 0);
  assert.equal(url, "http://identity.local/token");
  assert.deepEqual(headers, { "x-identity-header": "hdr" });
  assert.equal(params.resource, "https://api.botframework.com");
  assert.equal(params.client_id, "claw-app");
  assert.equal(w.http.calls.length, 1);
  const call = nth(w.http.calls, 0);
  assert.deepEqual([call.method, call.url], ["POST", `${SERVICE_URL}/v3/conversations/19:abc@thread.v2/activities`]);
  assert.equal(call.headers.authorization, "Bearer tok-claw-app");
  assert.ok(call.json.type === "message" && call.json.text === "hi");
  assert.deepEqual(call.json.from, { id: "28:bot" });
  assert.deepEqual(call.json.recipient, { id: "29:user" });
  assert.equal(call.json.channelId, "msteams");
});

test("test_outbound_operations", async (t) => {
  const cases: [Record<string, unknown>, string, string, Record<string, unknown>][] = [
    [{ operation: "send" }, "POST", "/activities", {}],
    [{ operation: "reply" }, "POST", "/activities/reply-to-1", {}],
    [{ operation: "update", activity_id: "act-9" }, "PUT", "/activities/act-9", { id: "act-9" }],
    [{ operation: "send", activity: { type: "typing" } }, "POST", "/activities", { type: "typing" }],
  ];
  for (const [envelope, method, suffix, checked] of cases) {
    await t.test(JSON.stringify(envelope), async () => {
      const w = wired();
      await runOutbound(w.ingress, { reference: REFERENCE, activity: { text: "x" }, ...envelope });
      assert.equal(w.http.calls.length, 1);
      const call = nth(w.http.calls, 0);
      assert.equal(call.method, method);
      assert.equal(call.url, `${SERVICE_URL}/v3/conversations/19:abc@thread.v2${suffix}`);
      assert.deepEqual(Object.fromEntries(Object.keys(checked).map((k) => [k, own(call.json, k)])), checked);
    });
  }
});

test("test_the_token_is_reused_until_it_is_dropped", async () => {
  const w = wired();
  for (let i = 0; i < 3; i++) await runOutbound(w.ingress, { reference: REFERENCE, activity: { text: "x" } });
  assert.equal(w.http.tokensAsked.length, 1);
  assert.equal(w.http.calls.length, 3);
});

test("test_ack_goes_back_to_the_inbound_queue_with_the_delivered_type", async () => {
  const w = wired();
  await runOutbound(w.ingress, { operation: "send", reference: REFERENCE, activity: { text: "x" }, ack: "ack-1" });
  assert.equal(w.bus.sent.length, 1);
  const { conn, queue, message } = nth(w.bus.sent, 0);
  assert.deepEqual([conn, queue], ["cs-claw-in", "primusclaw-inbound"]);
  assert.deepEqual(bodyOf(message), { type: "primusclaw.delivered", ack: "ack-1", activity_id: "posted-1" });
  assert.equal(message.sessionId, "19:abc@thread.v2");
  assert.equal(message.correlationId, "ack-1");
});

test("test_ack_for_a_long_conversation_id_uses_the_same_session_as_the_inbound_message", async () => {
  const w = wired();
  const longId = `a:${"y".repeat(150)}`;
  const reference = { ...REFERENCE, conversation: { id: longId } };
  await runOutbound(w.ingress, { operation: "send", reference, activity: { text: "x" }, ack: "ack-2" });
  assert.equal((await post(w.ingress, { ...MESSAGE, conversation: { id: longId } })).status, 200);
  const [ack, inbound] = w.bus.sent.map((s) => s.message);
  assert.equal(defined(ack).sessionId, sha(longId));
  assert.equal(defined(inbound).sessionId, sha(longId));
});

test("test_update_is_not_acked", async () => {
  const w = wired();
  await runOutbound(w.ingress, {
    operation: "update",
    activity_id: "a",
    reference: REFERENCE,
    activity: { text: "x" },
    ack: "ack-1",
  });
  assert.deepEqual(w.bus.sent, []);
});

test("test_a_failed_ack_does_not_fail_the_delivery", async () => {
  // The message is already posted; raising would make the trigger retry and post it twice.
  const w = wired();
  w.bus.fail = () => {
    throw new Error("bus down");
  };
  await runOutbound(w.ingress, { operation: "send", reference: REFERENCE, activity: { text: "x" }, ack: "ack-1" });
  assert.equal(w.http.calls.length, 1);
});

test("test_unauthorized_connector_drops_token_and_retries", async () => {
  const w = wired();
  w.http.connector = () => fakeResponse(401);
  await rejects(w.ingress.deliverOutbound({ operation: "send", reference: REFERENCE, activity: {} }), /rejected/);
  assert.equal(w.ingress.tokens.token, null);
});

test("test_throttling_and_server_errors_are_retried_by_the_trigger", async (t) => {
  for (const status of [429, 500, 503]) {
    await t.test(String(status), async () => {
      const w = wired();
      w.http.connector = () => fakeResponse(status);
      await rejects(
        w.ingress.deliverOutbound({ operation: "send", reference: REFERENCE, activity: {} }),
        new RegExp(String(status)),
      );
    });
  }
});

test("test_a_refusal_by_the_connector_is_raised", async () => {
  const w = wired();
  w.http.connector = () => fakeResponse(403);
  await rejects(w.ingress.deliverOutbound({ operation: "send", reference: REFERENCE, activity: {} }), /failed 403/);
});

test("test_a_refusal_logs_the_status_and_the_connectors_code_never_the_body", async () => {
  // A Connector refusal can quote the activity it refused (the user's message, a card's text): only the status and
  // the error code reach the log.
  const w = wired();
  const mark = `MESSAGE-MARK-7731 my key is ${["ak", "q7Lm2Xv9Rt4Bn8Wc3Yp6"].join("-")}`;
  const refusal = { error: { code: "BadArgument", message: `Activity text '${mark}' is invalid` } };
  w.http.connector = () => fakeResponse(400, refusal);
  await rejects(
    w.ingress.deliverOutbound({ operation: "send", reference: REFERENCE, activity: { text: mark } }),
    /failed 400/,
  );
  const text = w.log.text;
  assert.ok(text.includes("bot connector send failed 400 (BadArgument)"));
  assert.ok(!text.includes("MESSAGE-MARK-7731") && !text.includes("ak-"));
});

test("test_a_refusal_without_an_identifier_shaped_code_logs_a_dash", async (t) => {
  for (const body of [{ error: { code: "MESSAGE-MARK 7731 with spaces" } }, { error: "MESSAGE-MARK-7731" }, {}]) {
    await t.test(JSON.stringify(body), async () => {
      const w = wired();
      w.http.connector = () => fakeResponse(403, body);
      await rejects(w.ingress.deliverOutbound({ operation: "send", reference: REFERENCE, activity: {} }), /failed 403/);
      const text = w.log.text;
      assert.ok(text.includes("bot connector send failed 403 (-)") && !text.includes("MESSAGE-MARK"));
    });
  }
});

test("test_outbound_body_must_be_a_json_object", async () => {
  const w = wired();
  await rejects(w.ingress.outbound(Buffer.from("nope")), /outbound body is not JSON/);
  await rejects(w.ingress.outbound(Buffer.from("[]")), /must be an object/);
});

test("test_an_envelope_that_cannot_be_addressed_is_refused_before_a_token_is_minted", async (t) => {
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ reference: [1], activity: {} }, /needs reference and activity objects/],
    [{ reference: REFERENCE, activity: [1] }, /needs reference and activity objects/],
    [{ activity: {} }, /missing serviceUrl or id/],
    [{ reference: { conversation: CONVERSATION }, activity: {} }, /missing serviceUrl or id/],
    [{ reference: { serviceUrl: SERVICE_URL }, activity: {} }, /missing serviceUrl or id/],
    [{ reference: { serviceUrl: SERVICE_URL, conversation: "19:abc" }, activity: {} }, /missing serviceUrl or id/],
    [{ operation: "update", reference: REFERENCE, activity: {} }, /update needs activity_id/],
    [{ operation: "delete", reference: REFERENCE, activity: {} }, /unknown outbound operation/],
  ];
  for (const [envelope, message] of cases) {
    await t.test(JSON.stringify(envelope), async () => {
      const w = wired();
      await rejects(w.ingress.deliverOutbound(envelope as never), message);
      assert.deepEqual(w.http.tokensAsked, []);
      assert.deepEqual(w.http.calls, []);
    });
  }
});

test("test_the_bot_token_is_never_sent_to_a_host_that_is_not_microsofts", async (t) => {
  for (const serviceUrl of [
    "http://smba.trafficmanager.net/teams", // not https
    "https://attacker.trafficmanager.net/teams", // anyone can register names under trafficmanager.net
    "https://evil.example.com",
    "https://smba.trafficmanager.net.evil.com/teams", // a suffix trick
    "https://evilbotframework.com", // the suffix must start at a label boundary
    "https://user:pw@smba.trafficmanager.net/teams",
    "https://smba.trafficmanager.net:8443/teams",
  ]) {
    await t.test(serviceUrl, async () => {
      const w = wired();
      const reference = { ...REFERENCE, serviceUrl };
      await rejects(
        w.ingress.deliverOutbound({ operation: "send", reference, activity: {} }),
        /not a Bot Connector host/,
      );
      assert.deepEqual(w.http.tokensAsked, []);
      assert.deepEqual(w.http.calls, []);
    });
  }
});

test("test_microsofts_connector_hosts_are_accepted", async (t) => {
  for (const serviceUrl of [
    "https://smba.trafficmanager.net/emea/",
    "https://webchat.botframework.com/",
    "https://smba.infra.gov.teams.microsoft.us/gcch",
    "https://SMBA.trafficmanager.net/teams",
  ]) {
    await t.test(serviceUrl, async () => {
      const w = wired();
      await w.ingress.deliverOutbound({ operation: "send", reference: { ...REFERENCE, serviceUrl }, activity: {} });
      assert.equal(w.http.calls.length, 1);
    });
  }
});

test("test_ids_with_path_characters_stay_inside_their_path_segment", async () => {
  const w = wired();
  const reference = { ...REFERENCE, conversation: { id: "19:a/../b?x=1#f" }, activityId: "r/1" };
  await w.ingress.deliverOutbound({ operation: "reply", reference, activity: {} });
  assert.equal(w.http.calls.length, 1);
  assert.equal(nth(w.http.calls, 0).url, `${SERVICE_URL}/v3/conversations/19:a%2F..%2Fb%3Fx=1%23f/activities/r%2F1`);
});
