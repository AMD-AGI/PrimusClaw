// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The ingress's security event keeps text out of the log. A port of the Python Function's
 * tests/test_security_events.py (test names match). The helper is core's (securityEventRecord, with its field table);
 * the ingress logs its one event, token_rejected, through it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  InvariantError,
  SECURITY_EVENTS,
  SECURITY_FIELDS,
  SECURITY_LOGGER,
  securityEventRecord,
} from "@primusclaw/personal-agent";

import { tokenRejected } from "../src/ingress.js";
import { b64url, Caplog } from "./helpers.js";

// A JWT's shape, built here: no token literal in the source.
const JWT = [b64url('{"alg":"RS256"}'), b64url('{"sub":"x"}'), b64url("signaturesignature")].join(".");

test("test_token_rejected_is_a_structured_warning", () => {
  const log = new Caplog();
  const record = tokenRejected(log.sink, {
    reason: "bad_signature",
    service_url_host: "smba.trafficmanager.net",
    client_ip: "203.0.113.7",
  });
  assert.equal(log.records.length, 1);
  const [rec] = log.records;
  assert.equal(rec?.level, "warning");
  assert.equal(rec.logger, "clawy.security");
  assert.deepEqual(JSON.parse(rec.message), record);
  assert.deepEqual(record, {
    event: "token_rejected",
    reason: "bad_signature",
    service_url_host: "smba.trafficmanager.net",
    client_ip: "203.0.113.7",
  });
});

test("test_a_token_never_reaches_the_log", async (t) => {
  const cases: Record<string, string>[] = [
    { token: JWT },
    { authorization: `Bearer ${JWT}` },
    { reason: `signature failed for ${JWT}` },
    { client_ip: `203.0.113.7, ${JWT}` },
    { correlation_id: JWT },
    { service_url_host: `https://evil.example/${JWT}` },
    { client_ip: `2001:db8::1%${JWT}` },
    { client_ip: "abcd:2345::" },
    { client_ip: "23.45.67.89" },
  ];
  for (const fields of cases) {
    await t.test(JSON.stringify(fields), () => {
      const log = new Caplog();
      const record = tokenRejected(log.sink, { reason: "expired", ...fields });
      const expected = [
        ...new Set(
          Object.keys(fields).map((name) => (Object.hasOwn(SECURITY_FIELDS, name) ? name : "<unknown_field>")),
        ),
      ].sort();
      assert.deepEqual(record.dropped, expected);
      assert.ok(!log.text.includes(JWT) && !log.text.includes("Bearer"));
    });
  }
});

test("test_unknown_event_raises", () => {
  assert.throws(() => securityEventRecord("token_refused" as "token_rejected"), InvariantError);
  assert.equal(SECURITY_EVENTS.token_rejected, "warn");
  assert.equal(SECURITY_LOGGER, "clawy.security");
});
