// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The ingress: the route, the token check and the queue contract with the worker.
 *
 * A port of the Python Function's tests/test_ingress.py (test names match; parametrized cases are subtests; the
 * outbound part is test/outbound.test.ts). These pin what must not move: the route and its auth level, the token
 * audience, the queue and session the worker reads and the invoke answers Teams expects.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { ACK_TYPE } from "../src/outbound.js";
import { PLACEHOLDER_CARD, UNAVAILABLE_CARD } from "../src/replies.js";
import { readSettings } from "../src/settings.js";
import {
  bodyOf,
  CONVERSATION,
  FULL_ENV,
  MESSAGE,
  SERVICE_URL,
  claims as withClaims,
  encodeJwt,
  json,
  type Loaded,
  load as loadWith,
  noNetwork,
  now,
  post,
  rsaKey,
  defined,
  nth,
} from "./helpers.js";
import { brokenEnqueue, functions, refuseTokens, wired } from "./wiring.js";

const sha = (value: string) => `h:${createHash("sha256").update(value, "utf8").digest("hex")}`;

// --- the deployed shape ------------------------------------------------------

test("test_deployed_function_names_and_bindings_are_stable", () => {
  const { ingress } = loadWith(FULL_ENV);
  const fns = functions(ingress);
  assert.deepEqual([...fns.keys()].sort(), ["messages", "outbound"]);
  const http = defined(fns.get("messages"));
  // The bot's messaging endpoint is https://<app>/api/messages; Bot Framework sends no function key.
  assert.equal(http.trigger, "httpTrigger");
  assert.equal(http.options.route, "messages");
  assert.deepEqual(http.options.methods, ["POST"]);
  assert.equal(http.options.authLevel, "anonymous");
  const trigger = defined(fns.get("outbound"));
  assert.equal(trigger.trigger, "serviceBusTrigger");
  assert.deepEqual(
    [trigger.options.queueName, trigger.options.connection],
    ["primusclaw-outbound", "PRIMUSCLAW_OUTBOUND_SERVICEBUS"],
  );
});

test("test_unset_outbound_connection_does_not_break_start", async () => {
  const { ingress } = loadWith({ PRIMUSCLAW_BOT_APP_ID: "claw-app" }, { fetch: noNetwork });
  assert.deepEqual([...functions(ingress).keys()], ["messages"]);
  assert.equal((await post(ingress, { type: "message" }, {})).status, 401);
});

test("test_overridden_queue_names_are_honoured", () => {
  const { ingress } = loadWith({
    ...FULL_ENV,
    PRIMUSCLAW_SERVICEBUS_QUEUE: "claw-in",
    PRIMUSCLAW_OUTBOUND_QUEUE: "claw-out",
  });
  assert.equal(ingress.settings.inboundQueue, "claw-in");
  assert.equal(defined(functions(ingress).get("outbound")).options["queueName"], "%PRIMUSCLAW_OUTBOUND_QUEUE%");
});

// The queue names and the ack type agreed with the worker, which owns them: the public worker's (personal-agent
// packages/teams/src/config/env.ts INBOUND_QUEUE/OUTBOUND_QUEUE defaults, assembly/inbound.ts DELIVERED), written out
// here since OS4-g deleted the Python worker whose source this test used to read.
const WORKER_CONTRACT = {
  delivered: "primusclaw.delivered",
  inboundQueue: "primusclaw-inbound",
  outboundQueue: "primusclaw-outbound",
};

test("test_the_worker_contract_has_not_drifted", () => {
  const settings = readSettings({ PRIMUSCLAW_BOT_APP_ID: "claw-app" });
  assert.equal(ACK_TYPE, WORKER_CONTRACT.delivered);
  assert.equal(settings.inboundQueue, WORKER_CONTRACT.inboundQueue);
  assert.equal(settings.outboundQueueExpression, WORKER_CONTRACT.outboundQueue);
});

// --- authentication ----------------------------------------------------------

test("test_inbound_validates_against_the_bots_audience", async () => {
  const w = wired();
  assert.equal((await post(w.ingress, MESSAGE)).status, 200);
  assert.deepEqual(
    w.validated.map((kw) => kw.app_id),
    ["claw-app"],
  );
  assert.deepEqual(
    w.validated.map((kw) => kw.service_url),
    [SERVICE_URL],
  );
});

test("test_inbound_rejects_when_token_invalid", async () => {
  const w = wired();
  refuseTokens(w.ingress);
  assert.equal((await post(w.ingress, MESSAGE)).status, 401);
  assert.deepEqual(w.bus.sent, []);
});

test("test_unauthenticated_requests_get_401_and_queue_nothing", async (t) => {
  const cases: Record<string, string>[] = [
    {},
    { Authorization: "" },
    { Authorization: "Basic abc" },
    { Authorization: "Bearer " },
  ];
  for (const headers of cases) {
    await t.test(JSON.stringify(headers), async () => {
      // The real validate(): no stub, and no network either (a token-less request needs none; "Bearer " finds the
      // signing keys unreachable and is refused all the same).
      const { ingress, bus } = loadWith(FULL_ENV, { fetch: noNetwork });
      bus.fail = () => assert.fail("a rejected request must not touch Service Bus");
      assert.equal((await post(ingress, MESSAGE, headers)).status, 401);
    });
  }
});

test("test_a_body_that_is_not_an_activity_is_refused_after_authentication", async (t) => {
  for (const body of ["", "not json", "[1, 2]", '"text"', "null"]) {
    await t.test(JSON.stringify(body), async () => {
      const w = wired();
      assert.equal((await post(w.ingress, Buffer.from(body))).status, 400);
      assert.deepEqual(w.bus.sent, []);
      // ... and an unauthenticated caller learns nothing about the body: it is a 401 whatever it sent.
      refuseTokens(w.ingress);
      assert.equal((await post(w.ingress, Buffer.from(body))).status, 401);
    });
  }
});

test("test_an_unconfigured_app_id_fails_closed", async () => {
  const { ingress, bus } = loadWith({ ...FULL_ENV, PRIMUSCLAW_BOT_APP_ID: "" }, { fetch: noNetwork });
  bus.fail = () => assert.fail("must not enqueue");
  assert.equal((await post(ingress, MESSAGE)).status, 401);
});

// --- the queue contract with the worker ---------------------------------------

test("test_activity_is_queued_as_raw_json_on_the_conversations_session", async () => {
  const w = wired();
  assert.equal(
    (await post(w.ingress, MESSAGE, { Authorization: "Bearer x", "x-correlation-id": "corr-1" })).status,
    200,
  );
  assert.equal(w.bus.sent.length, 1);
  const { conn, queue, message } = nth(w.bus.sent, 0);
  assert.deepEqual([conn, queue], ["cs-claw-in", "primusclaw-inbound"]);
  // A Buffer: the SDK sends a Buffer as it is, where it would JSON-encode a string a second time.
  assert.ok(Buffer.isBuffer(message.body));
  assert.deepEqual(bodyOf(message), MESSAGE);
  // Exactly the bytes Python's json.dumps(activity) wrote.
  assert.equal(
    message.body.toString("utf8"),
    '{"type": "message", "id": "a1", "serviceUrl": "https://smba.trafficmanager.net/teams", ' +
      '"conversation": {"id": "19:abc@thread.v2"}}',
  );
  assert.equal(message.contentType, "application/json");
  assert.equal(message.sessionId, "19:abc@thread.v2");
  assert.equal(message.messageId, "a1");
  assert.equal(message.correlationId, "corr-1");
});

test("test_a_long_teams_conversation_id_maps_to_one_stable_bounded_session", async () => {
  const w = wired();
  const longId = `a:${"x".repeat(160)}`;
  const activity = { ...MESSAGE, conversation: { id: longId }, id: "m".repeat(200) };
  assert.equal((await post(w.ingress, activity)).status, 200);
  assert.equal((await post(w.ingress, { ...activity, id: "other" })).status, 200);
  const [first, second] = w.bus.sent.map((s) => s.message);
  const expected = sha(longId);
  assert.equal(defined(first).sessionId, expected);
  assert.equal(defined(second).sessionId, expected);
  assert.ok(expected.length <= 128);
  assert.equal(defined(first).messageId, sha("m".repeat(200)));
  assert.equal((bodyOf(defined(first)) as typeof activity).conversation.id, longId); // the worker reads the real id from the body
});

test("test_an_activity_without_a_conversation_still_gets_a_session", async () => {
  const w = wired();
  const reply = await post(
    w.ingress,
    { type: "conversationUpdate", serviceUrl: SERVICE_URL },
    { Authorization: "Bearer x", "x-correlation-id": "corr-9" },
  );
  assert.equal(reply.status, 200);
  assert.equal(nth(w.bus.sent, 0).message.sessionId, "corr-9");
});

test("test_a_message_that_cannot_be_queued_is_a_500", async () => {
  const w = wired();
  brokenEnqueue(w.ingress);
  assert.equal((await post(w.ingress, MESSAGE)).status, 500);
});

// --- invokes -----------------------------------------------------------------

const FEEDBACK_INVOKE = {
  type: "invoke",
  name: "message/submitAction",
  id: "f1",
  replyToId: "answer-1",
  serviceUrl: SERVICE_URL,
  conversation: CONVERSATION,
  value: { actionName: "feedback", actionValue: { reaction: "like", feedback: '{"feedbackText": ""}' } },
};

test("test_feedback_invoke_is_queued_and_answered_with_an_empty_200", async () => {
  // The thumbs under an answer send message/submitAction. Teams rejects a composeExtension result or a card for it
  // ("Unable to reach app"); it wants a bare 200, and the worker handles the feedback out of band.
  const w = wired();
  const reply = await post(w.ingress, FEEDBACK_INVOKE);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.length, 0);
  assert.notEqual(reply.contentType, "application/json");
  assert.deepEqual(
    w.bus.sent.map((s) => [s.conn, s.queue]),
    [["cs-claw-in", "primusclaw-inbound"]],
  );
  assert.deepEqual(bodyOf(nth(w.bus.sent, 0).message), FEEDBACK_INVOKE);
});

test("test_feedback_invoke_still_needs_a_valid_token", async () => {
  const w = wired();
  refuseTokens(w.ingress);
  assert.equal((await post(w.ingress, FEEDBACK_INVOKE)).status, 401);
  assert.deepEqual(w.bus.sent, []);
});

test("test_feedback_invoke_that_cannot_be_queued_is_a_500_not_a_card", async () => {
  // A card in answer to this invoke is what Teams rejects, so a failed enqueue reports the failure honestly instead
  // of returning the "unavailable" card.
  const w = wired();
  brokenEnqueue(w.ingress);
  const reply = await post(w.ingress, FEEDBACK_INVOKE);
  assert.equal(reply.status, 500);
  assert.equal(reply.body.length, 0);
});

const CARD_ACTION = {
  type: "invoke",
  name: "adaptiveCard/action",
  id: "c1",
  serviceUrl: SERVICE_URL,
  conversation: CONVERSATION,
  value: { action: { verb: "primusclaw.feedback" } },
};

test("test_card_action_invoke_is_queued_and_answered_with_the_placeholder_card", async () => {
  const w = wired();
  const reply = await post(w.ingress, CARD_ACTION);
  assert.equal(reply.status, 200);
  assert.equal(reply.contentType, "application/json");
  assert.deepEqual(json(reply), {
    statusCode: 200,
    type: "application/vnd.microsoft.card.adaptive",
    value: PLACEHOLDER_CARD,
  });
  assert.deepEqual(
    w.bus.sent.map((s) => [s.conn, s.queue]),
    [["cs-claw-in", "primusclaw-inbound"]],
  );
  assert.deepEqual(bodyOf(nth(w.bus.sent, 0).message), CARD_ACTION);
});

test("test_the_placeholder_card_is_static_and_promises_no_change_to_itself", async () => {
  // Teams mobile does not redraw the worker's edit of this message, so on a phone the placeholder can stay for good:
  // it must not spin (a ProgressRing) and must not say the work is still going on.
  const w = wired();
  const card = PLACEHOLDER_CARD;
  assert.ok(!JSON.stringify(card).includes("ProgressRing") && !JSON.stringify(card).includes("Working on it"));
  assert.deepEqual(
    card.body.map((b) => [b.type, b.text]),
    [["TextBlock", "Got it — the result appears below."]],
  );
  assert.ok(!("actions" in card)); // (nothing to press on a card that stays)
  const served = (json(await post(w.ingress, CARD_ACTION)) as { value: unknown }).value;
  assert.deepEqual(served, card);
});

test("test_card_action_invoke_that_cannot_be_queued_gets_the_unavailable_card", async () => {
  const w = wired();
  brokenEnqueue(w.ingress);
  const reply = await post(w.ingress, CARD_ACTION);
  assert.equal(reply.status, 200);
  assert.deepEqual((json(reply) as { value: unknown }).value, UNAVAILABLE_CARD);
});

test("test_other_invokes_get_the_empty_compose_result_and_are_not_queued", async (t) => {
  for (const name of [
    "composeExtension/query",
    "composeExtension/submitAction",
    "task/fetch",
    "task/submit",
    "message/fetchTask",
    "signin/verifyState",
    "",
  ]) {
    await t.test(name || "(empty)", async () => {
      const w = wired();
      const activity = { type: "invoke", name, id: "i1", serviceUrl: SERVICE_URL, conversation: CONVERSATION };
      const reply = await post(w.ingress, activity);
      assert.equal(reply.status, 200);
      assert.deepEqual(json(reply), { composeExtension: { type: "result", attachments: [] } });
      assert.deepEqual(w.bus.sent, []);
    });
  }
});

test("test_an_invoke_name_with_a_line_break_is_logged_on_one_line", async () => {
  // The name is the caller's: a line break in it would start a forged log line (CWE-117).
  const w = wired();
  const activity = {
    type: "invoke",
    name: "task/fetch\r\nINFO forged line",
    id: "i1",
    serviceUrl: SERVICE_URL,
    conversation: CONVERSATION,
  };
  const reply = await post(w.ingress, activity);
  assert.equal(reply.status, 200);
  assert.deepEqual(
    w.log.messages().filter((m) => m.includes("no sync transport")),
    ["no sync transport for invoke task/fetchINFO forged line; returning empty result"],
  );
});

test("test_an_invoke_name_that_is_not_a_string_gets_the_empty_compose_result", async (t) => {
  // A list or a dict as the name used to raise TypeError in the lookup of the known invokes: a 500.
  for (const name of [7, ["x"], { a: 1 }, [], true]) {
    await t.test(JSON.stringify(name), async () => {
      const w = wired();
      const activity = { type: "invoke", name, id: "i1", serviceUrl: SERVICE_URL, conversation: CONVERSATION };
      const reply = await post(w.ingress, activity);
      assert.equal(reply.status, 200);
      assert.deepEqual(json(reply), { composeExtension: { type: "result", attachments: [] } });
      assert.deepEqual(w.bus.sent, []);
    });
  }
});

// --- a refused request leaves one structured security event, never the token (security review) ---------------------

const APP_ID = "claw-app";
const SIGNING_KEY = rsaKey();

/** function_app with the real validate(); only the signing-key fetch and Service Bus are faked. */
function realAuth(): Loaded {
  const loaded = loadWith(FULL_ENV);
  loaded.ingress.auth.jwks = {
    client: () => Promise.resolve({ getSigningKeyFromJwt: () => Promise.resolve(SIGNING_KEY.jwk) }),
  };
  return loaded;
}

function token(overrides: Record<string, unknown> = {}, key = SIGNING_KEY): string {
  return encodeJwt(
    withClaims(
      { iss: "https://api.botframework.com", aud: APP_ID, exp: now() + 600, serviceurl: SERVICE_URL },
      overrides,
    ),
    key,
  );
}

test("test_a_valid_request_is_queued_and_logs_no_security_event", async () => {
  const r = realAuth();
  assert.equal((await post(r.ingress, MESSAGE, { Authorization: `Bearer ${token()}` })).status, 200);
  assert.equal(r.bus.sent.length, 1);
  assert.deepEqual(r.log.events(), []);
});

test("test_a_refusal_is_one_structured_event_with_reason_host_and_client_ip", async (t) => {
  const withoutServiceUrl = Object.fromEntries(Object.entries(MESSAGE).filter(([k]) => k !== "serviceUrl"));
  const cases: [Record<string, unknown>, Record<string, unknown>, string, string | null][] = [
    [{ serviceurl: null }, MESSAGE, "service_url", "smba.trafficmanager.net"],
    [
      { serviceurl: "https://evil.example.com/" },
      { ...MESSAGE, serviceUrl: "https://evil.example.com/" },
      "service_url",
      "evil.example.com",
    ],
    [{}, withoutServiceUrl, "service_url", null],
    [{ aud: "someone-elses-bot" }, MESSAGE, "audience", "smba.trafficmanager.net"],
    [{ exp: 1 }, MESSAGE, "expired", "smba.trafficmanager.net"],
    [{ iss: "https://sts.windows.net/t/" }, MESSAGE, "issuer", "smba.trafficmanager.net"],
  ];
  for (const [overrides, activity, reason, host] of cases) {
    await t.test(`${reason} ${JSON.stringify(overrides)}`, async () => {
      const r = realAuth();
      const tok = token(overrides);
      const headers = { Authorization: `Bearer ${tok}`, "X-Forwarded-For": "198.51.100.9, 203.0.113.7:51234" };
      assert.equal((await post(r.ingress, activity, headers)).status, 401);
      assert.deepEqual(r.bus.sent, []);
      const expected: Record<string, unknown> = { event: "token_rejected", reason, client_ip: "203.0.113.7" };
      if (host) expected.service_url_host = host;
      assert.deepEqual(r.log.events(), [expected]);
      const records = r.log.records.filter((rec) => rec.logger === "clawy.security");
      assert.equal(records.length, 1);
      assert.equal(nth(records, 0).level, "warning");
      const logged = r.log.text;
      assert.ok(!logged.includes(tok) && !logged.includes(nth(tok.split("."), 1)) && !logged.includes("Bearer"));
    });
  }
});

test("test_a_valid_token_with_a_body_that_is_not_an_activity_is_a_400_not_a_token_refusal", async (t) => {
  // The real validate(): the token is good, so this is a bad request, not a token refusal, and it must not be
  // counted in the token_rejected alert as a serviceUrl failure.
  for (const body of ["not json", "[1, 2]", "null"]) {
    await t.test(body, async () => {
      const r = realAuth();
      assert.equal((await post(r.ingress, Buffer.from(body), { Authorization: `Bearer ${token()}` })).status, 400);
      assert.deepEqual(r.bus.sent, []);
      assert.deepEqual(r.log.events(), []);
    });
  }
});

test("test_a_bad_token_with_a_body_that_is_not_an_activity_is_still_a_401", async (t) => {
  const cases: [Record<string, unknown>, string][] = [
    [{ aud: "someone-elses-bot" }, "audience"],
    [{ exp: 1 }, "expired"],
  ];
  for (const [overrides, reason] of cases) {
    await t.test(reason, async () => {
      const r = realAuth();
      const headers = { Authorization: `Bearer ${token(overrides)}` };
      assert.equal((await post(r.ingress, Buffer.from("not json"), headers)).status, 401);
      assert.deepEqual(r.bus.sent, []);
      assert.deepEqual(r.log.events(), [{ event: "token_rejected", reason }]);
      assert.equal((await post(r.ingress, Buffer.from("not json"), {})).status, 401);
    });
  }
});

test("test_a_request_without_a_token_is_logged_as_missing_token", async () => {
  const r = realAuth();
  assert.equal((await post(r.ingress, MESSAGE, { "X-Forwarded-For": "[2001:db8::7]:443" })).status, 401);
  assert.deepEqual(r.log.events(), [
    {
      event: "token_rejected",
      reason: "missing_token",
      service_url_host: "smba.trafficmanager.net",
      client_ip: "2001:db8::7",
    },
  ]);
});

test("test_a_token_with_a_bad_signature_is_logged_without_the_token", async () => {
  const r = realAuth();
  const tok = token({}, rsaKey());
  assert.equal((await post(r.ingress, MESSAGE, { Authorization: `Bearer ${tok}` })).status, 401);
  assert.deepEqual(r.log.events(), [
    { event: "token_rejected", reason: "bad_signature", service_url_host: "smba.trafficmanager.net" },
  ]);
  assert.ok(!r.log.text.includes(tok));
});

test("test_the_client_ip_is_the_last_forwarded_entry", async (t) => {
  const cases: [string, string | null][] = [
    ["203.0.113.7", "203.0.113.7"],
    ["203.0.113.7:4431", "203.0.113.7"],
    ["10.0.0.1, 203.0.113.7:4431", "203.0.113.7"], // what the caller wrote first is not trusted
    ["[2001:db8::7]:443", "2001:db8::7"],
    ["2001:db8::7", "2001:db8::7"],
    ["", null],
    ["not-an-address", null],
  ];
  for (const [forwarded, expected] of cases) {
    await t.test(forwarded || "(empty)", async () => {
      const r = realAuth();
      await post(r.ingress, MESSAGE, { "X-Forwarded-For": forwarded });
      const events = r.log.events();
      assert.equal(events.length, 1);
      assert.equal(nth(events, 0).client_ip, expected ?? undefined);
    });
  }
});
