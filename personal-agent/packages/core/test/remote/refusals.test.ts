// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What a refusal from Claw's remote-agents API means for a person, in the chat's language (`remote/refusals.ts`).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

import { ClawError, isErrorWord } from "../../src/claw/errors.js";
import type { Lang } from "../../src/locales/lang.js";
import { remoteAgentText } from "../../src/locales/remote-agents.js";
import { type Connector, connectorFrom } from "../../src/remote/model.js";
import {
  REFUSALS,
  Reconnecting,
  type RefusalErrors,
  STATUS_REFUSALS,
  failureText,
  idempotencyKey,
  saidIn,
  withReason,
} from "../../src/remote/refusals.js";

const NOW = 1_762_700_000;
const withheld: string[] = [];
const errors: RefusalErrors = {
  looksInternal: (text) => /gateway|brain/u.test(text),
  withhold: (where, detail) => {
    withheld.push(`${where}:${String(detail)}`);
    return "0123abcd";
  },
};
const say = (err: ClawError, lang: Lang = "en"): string => failureText(err, errors, NOW, lang);
const en = remoteAgentText.in("en");
const CJK = /[一-鿿]/u;

const machine = (fields: { last_seen_at?: string }): Connector =>
  connectorFrom({ connector_id: "c1", name: "dev-pod", online: false, ...fields });

test("what a refusal from claw means for a person", () => {
  const cases: [number, string, string][] = [
    [409, '{"ok":false,"error":"connector_offline"}', en.offline],
    [409, '{"ok":false,"error":"session_closed"}', "That session has ended."],
    [404, '{"ok":false,"error":"agent_not_found"}', "I could not find that agent on that machine."],
    [404, '{"ok":false,"error":"not_found"}', "I could not find that (it may have been removed)."],
    [429, "", "limiting remote agent requests"],
    [401, "", "rejected your linked key"],
    [403, "", "rejected your linked key"],
    [400, '{"ok":false,"error":"invalid_cwd"}', "did not accept that (invalid_cwd)"],
    [500, "oops", "could not take that (error 500)"],
  ];
  for (const [status, body, expected] of cases) assert.ok(say(new ClawError(status, body)).includes(expected), body);
});

test("claw error code reads the error word and nothing else", () => {
  assert.equal(new ClawError(409, '{"ok":false,"error":"connector_offline"}').code, "connector_offline");
  assert.equal(new ClawError(500, "<html>").code, "");
  assert.equal(new ClawError(500, "[1]").code, "");
  assert.equal(new ClawError(500).code, "");
});

test("a refusal cut short still names its error", () => {
  // Claw's 409 connector_outdated carries `data`: the body is longer than the 200 characters a ClawError keeps.
  const body =
    '{"ok":false,"error":"connector_outdated","data":{"version":"0.1.2","version_status":"unsupported","upgrade_command":' +
    '"npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install","minimum_version":"0.1.3"}}';
  const err = new ClawError(409, body.slice(0, 200));
  assert.equal(err.code, "connector_outdated");
  assert.equal(say(err), en.outdated);
  assert.equal(new ClawError(409, '{"ok":false,"error":"Bad Thing","data":').code, "");
  assert.equal(new ClawError(500, "<html>").code, "");
});

test("a stopped review never repeats an error that is not a plain word", () => {
  assert.ok(isErrorWord("already_merged") && !isErrorWord("bad input private_token_value") && !isErrorWord(""));
});

test("a code that names a service or is no plain word is withheld under a reference", () => {
  withheld.length = 0;
  assert.equal(
    say(new ClawError(400, '{"ok":false,"error":"brain_gateway"}')),
    "PrimusClaw did not accept that (ref 0123abcd).",
  );
  assert.equal(
    say(new ClawError(400, '{"ok":false,"error":"Bad Thing"}'), "zh"),
    "PrimusClaw 没有接受这个请求（ref 0123abcd）。",
  );
  assert.deepEqual(withheld, ["remote_api_400:brain_gateway", "remote_api_400:Bad Thing"]);
});

/** One refusal per branch `failureText` has. */
function refusals(): ClawError[] {
  const errs = [...REFUSALS.keys()].map((key) => {
    const [status, code] = key.split(" ");
    return new ClawError(Number(status), JSON.stringify({ ok: false, error: code }));
  });
  errs.push(...[...STATUS_REFUSALS.keys()].map((status) => new ClawError(status, "")));
  errs.push(
    new Reconnecting(machine({ last_seen_at: new Date(NOW * 1000).toISOString() })),
    new Reconnecting(machine({})),
    new ClawError(400, '{"ok":false,"error":"invalid_cwd"}'),
    new ClawError(400, '{"ok":false,"error":"Bad Thing"}'),
    new ClawError(500, "oops"),
  );
  return errs;
}

// a command to copy, a slash command, an error code
const CODE_SPANS = /`[^`]+`|\/[a-z]+\b|\b[a-z]+_[a-z_]+\b/gu;

test("every refusal is said in the chat language", () => {
  for (const err of refusals()) {
    const english = say(err);
    const chinese = say(err, "zh");
    assert.equal(say(err, "en"), english);
    assert.ok(!CJK.test(english), english);
    assert.ok(CJK.test(chinese) && chinese !== english, chinese);
    for (const span of english.match(CODE_SPANS) ?? []) assert.ok(chinese.includes(span), `${span} in ${chinese}`);
  }
});

test("every table sentence and fixed reply has its chinese", () => {
  const fixed = [
    "notEnabled",
    "unreachable",
    "unreachableTail",
    "stopFirst",
    "notAttached",
    "sessionGone",
    "approvalInactive",
    "approvalAnswered",
    "whichSession",
    "whichSessionOrAgent",
    "backToPrimusclaw",
  ] as const;
  for (const sentence of new Set([...REFUSALS.values(), ...STATUS_REFUSALS.values(), ...fixed])) {
    assert.ok(CJK.test(saidIn("zh", sentence)), sentence);
    assert.equal(saidIn("en", sentence), en[sentence]);
  }
});

test("one message makes one idempotency key that claw accepts", () => {
  const keys = {
    sha1Hex: (text: string) => createHash("sha1").update(text).digest("hex"),
    hexId: () => randomUUID().replaceAll("-", ""),
  };
  const key = idempotencyKey(keys, "aad-a", "activity-1");
  assert.equal(key, idempotencyKey(keys, "aad-a", "activity-1"));
  assert.match(key, /^[A-Za-z0-9._:-]{1,64}$/u);
  // (the same key the Python worker made for the same message: a message redelivered across the switch queues one prompt)
  assert.equal(key, `clawy-${createHash("sha1").update("aad-a:activity-1").digest("hex")}`);
  assert.notEqual(key, idempotencyKey(keys, "aad-a", "activity-2"));
  assert.notEqual(key, idempotencyKey(keys, "aad-b", "activity-1"));
  // no activity id: never one key for two messages
  assert.notEqual(idempotencyKey(keys, "aad-a", ""), idempotencyKey(keys, "aad-a", ""));
});

test("a long run of full stops in a reason is trimmed in linear time", () => {
  const reason = ".".repeat(50_000) + "x";
  const started = performance.now();
  assert.equal(withReason("It failed", `${reason}..`), `It failed: ${reason}.`); // (Python's with_reason)
  assert.ok(performance.now() - started < 500, `${String(performance.now() - started)} ms`);
});
