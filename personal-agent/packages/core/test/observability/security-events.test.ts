// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { describe, it } from "node:test";
import {
  SECURITY_FIELD_CATEGORIES,
  SECURITY_FIELDS,
  InvariantError,
  SECURITY_EVENTS,
  SECURITY_LOGGER,
  SecurityLog,
  noMetrics,
  type LogFields,
  type Logger,
  type MetricsPort,
  type SecurityEventName,
  type SecurityEventRecord,
} from "../../src/index.js";
import { own } from "../../src/own.js";

// Values that must never reach a log line. Each is handed to the helper in the field a careless caller might use.
const LINK_CODE = "K7PQ2XMZ";
const SAFE_KEY = "ak-" + "Zq8".repeat(10);
const b64url = (raw: string): string => Buffer.from(raw).toString("base64url");
const JWT = ['{"alg":"RS256"}', '{"sub":"x"}', "signaturesignature"].map(b64url).join("."); // built: no token literal
const GITHUB_TOKEN = "ghp_" + "a1B2".repeat(9);
const SAS =
  "Endpoint=sb://ns.servicebus.windows.net/;SharedAccessKeyName=worker-send;SharedAccessKey=" + "x".repeat(44);
const MESSAGE = "please merge PR 42, my password is hunter2";
const HMAC_SECRET = "s3cr3t-hmac-value-0123456789abcdef";
const AAD = "9f1c2e3d-0000-4000-8000-000000000abc";
const CORRELATION = "6f9619ff8b86d011b42d00c04fc964ff";
const FORBIDDEN = [LINK_CODE, SAFE_KEY, JWT, GITHUB_TOKEN, SAS, MESSAGE, HMAC_SECRET, "hunter2", "Bearer"];
/** The link-code alphabet (the store's CODE_ALPHABET) and length. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface Line {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

/** A logger that keeps every line with the fields bound to it, and metrics that keep every record. */
function capture() {
  const lines: Line[] = [];
  const counted: SecurityEventRecord[] = [];
  const make = (bound: LogFields): Logger => {
    const at =
      (level: string) =>
      (message: string, fields: LogFields = {}): void => {
        lines.push({ level, message, fields: { ...bound, ...fields } });
      };
    return {
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      child: (fields) => make({ ...bound, ...fields }),
    };
  };
  const metrics: MetricsPort = { ...noMetrics, securityEvent: (record) => counted.push(record) };
  const log = new SecurityLog(make({}), metrics);
  const everything = (): string => lines.map((l) => `${l.level} ${l.message} ${JSON.stringify(l.fields)}`).join("\n");
  return { lines, counted, log, everything };
}

describe("security events", () => {
  it("is one JSON record per event, the event first, at its level", () => {
    for (const [event, level] of Object.entries(SECURITY_EVENTS)) {
      const { lines, counted, log } = capture();
      const returned = log.event(event as SecurityEventName, { aad_object_id: AAD, outcome: "success" });
      assert.equal(lines.length, 1);
      const [line] = lines;
      assert.ok(line);
      assert.equal(line.level, level);
      assert.equal(line.fields["logger"], SECURITY_LOGGER);
      const body = JSON.parse(line.message) as Record<string, unknown>;
      assert.equal(Object.keys(body)[0], "event");
      assert.deepEqual(body, returned);
      assert.deepEqual(counted, [returned]);
      assert.deepEqual(body, { event, aad_object_id: AAD, outcome: "success" });
      assert.equal(line.message, `{"event":"${event}","aad_object_id":"${AAD}","outcome":"success"}`);
    }
  });

  it("is a closed list of events", () => {
    const { lines, log } = capture();
    for (const event of ["link_atempt", "", "LINK_ATTEMPT", MESSAGE, "toString", "__proto__"]) {
      assert.throws(() => log.event(event as SecurityEventName), InvariantError);
    }
    assert.deepEqual(lines, []);
    for (const event of [
      "link_attempt",
      "link_lockout",
      "token_rejected",
      "approval_answered",
      "pr_merged",
      "rate_limited",
      "key_unlinked",
    ]) {
      assert.ok(Object.hasOwn(SECURITY_EVENTS, event), event);
    }
  });

  it("logs the alert-worthy events as warnings", () => {
    const warnings = Object.entries(SECURITY_EVENTS)
      .filter(([, level]) => level === "warn")
      .map(([event]) => event)
      .sort();
    assert.deepEqual(warnings, ["link_lockout", "rate_limited", "token_rejected"]);
  });
});

describe("security event values", () => {
  it("keeps the values of allowed fields", () => {
    const { log } = capture();
    const record = log.event("pr_merged", {
      aad_object_id: AAD.toUpperCase(),
      activity_id: "1730700000000",
      conversation_id: "19:abc_def@thread.v2;messageid=1730700000000",
      session_id: "sess_123",
      run_id: "run-9",
      approval_id: "ap.7",
      correlation_id: CORRELATION,
      outcome: "merged",
      reason: "user_request",
      scope: "user",
      operation: "pr_merge",
      decision: "confirm",
      repo: "AMD-AGI/Primus",
      pr_number: 42,
      branch: "release/v1.2",
      tool: "mcp__github__merge_pull_request",
      github_login: "octo-cat",
      service_url_host: "SMBA.TrafficManager.net",
      client_ip: " 2001:db8::1 ",
      count: 3,
      limit: 5,
      window_seconds: 600,
      retry_after_seconds: 0,
      status: 401,
    });
    assert.equal(record["service_url_host"], "smba.trafficmanager.net");
    assert.equal(record["aad_object_id"], AAD);
    assert.equal(record["client_ip"], "2001:db8::1");
    assert.equal(record["pr_number"], 42);
    assert.equal(record["branch"], "release/v1.2");
    assert.equal(record.dropped, undefined);
    assert.deepEqual(
      Object.keys(record)
        .filter((k) => k !== "event")
        .sort(),
      Object.keys(SECURITY_FIELDS).sort(),
    );
  });

  it("leaves out null and undefined silently", () => {
    const { log } = capture();
    assert.deepEqual(
      log.event("key_unlinked", { aad_object_id: null, session_id: undefined, reason: "user_request" }),
      {
        event: "key_unlinked",
        reason: "user_request",
      },
    );
  });
});

const FORBIDDEN_FIELDS: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  // fields that are not on the list, whatever they hold
  { code: LINK_CODE },
  { link_code: LINK_CODE },
  { text: MESSAGE },
  { message: MESSAGE },
  { key: SAFE_KEY },
  { api_key: SAFE_KEY },
  { token: JWT },
  { authorization: "Bearer " + JWT },
  { secret: HMAC_SECRET },
  { connection_string: SAS },
  { tool_input: JSON.stringify({ command: MESSAGE }) },
  { error: new Error(MESSAGE) },
  // allowed fields handed something that is not their shape
  { activity_id: MESSAGE },
  { outcome: MESSAGE },
  { reason: "wrong code " + LINK_CODE },
  { repo: MESSAGE },
  { branch: MESSAGE },
  { tool: MESSAGE },
  { github_login: GITHUB_TOKEN },
  { service_url_host: "https://smba.trafficmanager.net/teams/?token=" + JWT },
  { client_ip: MESSAGE },
  { client_ip: "2001:db8::1%k7pq-2xmz" },
  { client_ip: "fe80::1%" + SAFE_KEY },
  { client_ip: "203.0.113.7:443" },
  // an address is checked after it is normalised, like every other value: its groups can spell a code
  { client_ip: "abcd:2345::" },
  { client_ip: "ABCD:2345:0:0:0:0:0:0" },
  { client_ip: "2001:db8:abcd:2345::1" },
  { client_ip: "23.45.67.89" },
  { client_ip: "::ffff:23.45.67.89" },
  // a key glued to other letters or digits is still a key
  { session_id: "x" + SAFE_KEY },
  { branch: "fix/x" + SAFE_KEY },
  { tool: "9" + SAFE_KEY.replace("ak-", "sk-") },
  { correlation_id: "Bearer " + JWT },
  { pr_number: "42; " + MESSAGE },
  { count: true },
  { count: -1 },
  { status: 401.5 },
  // categories take only their listed values
  { outcome: "please_merge" },
  { reason: "k7pq2xmz" },
  { operation: "Pr_Merge" },
  { decision: "yes" },
  { scope: ["user"] },
  // ids of a fixed shape
  { aad_object_id: "u1" },
  { aad_object_id: LINK_CODE },
  { correlation_id: "c0ffee" },
  { correlation_id: "k7pq2xmz-k7pq2xmz" },
  // a /link code in a field that otherwise takes it: as printed, as typed, or inside a longer value
  { activity_id: LINK_CODE },
  { session_id: LINK_CODE.toLowerCase() },
  { run_id: "K7PQ-2XMZ" },
  { approval_id: "k7pq_2xmz" },
  { conversation_id: "link:" + LINK_CODE },
  { activity_id: "a/" + LINK_CODE },
  { branch: LINK_CODE },
  { branch: "fix/" + LINK_CODE },
  { tool: LINK_CODE },
  { github_login: LINK_CODE },
  { repo: "org/" + LINK_CODE },
  { branch: "fix/k7pq-2xmz" },
  { repo: "org/k7pq2xmz" },
  { github_login: "k7pq2xmz" },
  { tool: "mcp__k7pq__2xmz" },
  { conversation_id: "19:k7__pq2x.mz@thread" },
  { session_id: "s;K7P;Q2X;MZ" },
  { correlation_id: "abcde234-aaaaaaa" },
  { correlation_id: "a---------------" },
  { correlation_id: "abcde234" },
  // allowed fields handed a credential that happens to fit the id shape
  { session_id: SAFE_KEY },
  { activity_id: JWT },
  { run_id: GITHUB_TOKEN },
  { correlation_id: SAS },
  { conversation_id: "x".repeat(300) },
];

describe("security event fields", () => {
  it("never lets forbidden content reach the log", () => {
    for (const fields of FORBIDDEN_FIELDS) {
      const { lines, log, everything } = capture();
      const record = log.event("link_attempt", { aad_object_id: AAD, outcome: "wrong", ...fields });
      const names = Object.keys(fields).map((name) =>
        Object.hasOwn(SECURITY_FIELDS, name) ? name : "<unknown_field>",
      );
      assert.deepEqual(record.dropped, [...new Set(names)].sort(), JSON.stringify(fields));
      for (const name of Object.keys(fields)) assert.equal(own(record, name), undefined);
      const logged = everything();
      for (const value of Object.values(fields)) {
        const text = value instanceof Error ? value.message : typeof value === "string" ? value : "";
        if (text.length >= 8) {
          assert.ok(!logged.includes(text) && !logged.toLowerCase().includes(text.toLowerCase()), text);
        }
      }
      for (const secret of FORBIDDEN) assert.ok(!logged.includes(secret), secret);
      assert.deepEqual(JSON.parse(lines[0]?.message ?? ""), record);
    }
  });

  it("refuses every generated link code in every string field", () => {
    const numbers = new Set(["pr_number", "count", "limit", "window_seconds", "retry_after_seconds", "status"]);
    const own = new Set(["client_ip", "service_url_host", "aad_object_id", "correlation_id"]);
    const stringFields = Object.keys(SECURITY_FIELDS).filter(
      (name) => !Object.hasOwn(SECURITY_FIELD_CATEGORIES, name) && !numbers.has(name) && !own.has(name),
    );
    const { log, everything } = capture();
    let code = "";
    for (let i = 0; i < 200; i++) {
      code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
      const record = log.event("link_attempt", Object.fromEntries(stringFields.map((name) => [name, code])));
      assert.deepEqual(record, { event: "link_attempt", dropped: [...stringFields].sort() });
    }
    assert.ok(!everything().includes(code));
  });
});

describe("security event ids", () => {
  it("keeps real ids", () => {
    const ids = {
      conversation_id: "19:meeting_abcdef23-4567-89ab-cdef-23456789abcd@thread.v2",
      approval_id: "19:5f3c2a@thread.tacv2",
      activity_id: "f:abcdef2345678",
      session_id: "a:1BcDeFgHiJkLmNoPqRsTuVwXyZ",
      run_id: "550e8400-e29b-41d4-a716-446655440000",
      correlation_id: "abcde234-5f6a-4b7c-8d9e-0f1a2b3c4d5e", // a uuid whose first group is code letters
    };
    const record = capture().log.event("approval_answered", {
      decision: "approve",
      tool: "Bash",
      branch: "main",
      github_login: "octocat",
      repo: "AMD-AGI/Primus",
      ...ids,
    });
    assert.equal(record.dropped, undefined);
    for (const [name, value] of Object.entries(ids)) assert.equal(own(record, name), value);
  });

  it("keeps a real client address, normalised", () => {
    for (const [given, logged] of [
      ["203.0.113.7", "203.0.113.7"],
      ["52.96.0.1", "52.96.0.1"],
      ["2001:db8::1", "2001:db8::1"],
      ["2603:1061:14:1::12", "2603:1061:14:1::12"],
      ["FD00:0:0:0:0:0:0:1", "fd00::1"],
      ["::ffff:52.96.0.1", "::ffff:52.96.0.1"],
    ] as const) {
      const record = capture().log.event("token_rejected", { reason: "expired", client_ip: given });
      assert.equal(record.dropped, undefined, given);
      assert.equal(record["client_ip"], logged);
    }
  });

  it("drops an 8-character segment of the code alphabet as a code", () => {
    // The price of refusing typed codes: such a value cannot be told from one, so it is not logged.
    const record = capture().log.event("approval_answered", {
      approval_id: "deadbeef",
      branch: "feat/releases",
      github_login: "zhangsan",
    });
    assert.deepEqual(record.dropped, ["approval_id", "branch", "github_login"]);
  });

  it("does not log a field name that is itself text", () => {
    const { log, everything } = capture();
    const record = log.event("link_attempt", { [`the code is ${LINK_CODE}`]: 1, Outcome: "ok", k7pq2xmz: 1 });
    assert.deepEqual(record, { event: "link_attempt", dropped: ["<unknown_field>"] });
    const logged = everything();
    for (const text of [LINK_CODE, "Outcome", "k7pq2xmz"]) assert.ok(!logged.includes(text), text);
  });
});
