// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The Python built-ins the client relies on, the Connector's answers, the time limits and the lanes. */
import assert from "node:assert/strict";
import test from "node:test";
import { DeadlineError } from "../../src/connector/errors.js";
import { Lanes } from "../../src/connector/lanes.js";
import { pyFloat, pyInt, pyQuote, pyTruthy, rstripSlash } from "../../src/connector/py-parse.js";
import { buildRequest } from "../../src/connector/request.js";
import { answerId, errorCode, memberList, retryAfterMs } from "../../src/connector/response.js";
import { raceAbort, reasonOf, startTimer } from "../../src/connector/timer.js";
import { entraCodes } from "../../src/connector/tokens/federated.js";
import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { envelope, reference } from "./fakes.js";

test("py quote keeps python's safe characters and percent-encodes utf-8", () => {
  assert.equal(pyQuote("a b/c~d!'()*", ""), "a%20b%2Fc~d%21%27%28%29%2A");
  assert.equal(pyQuote("19:x/y;m=1@t", ":@;="), "19:x%2Fy;m=1@t");
  assert.equal(pyQuote("é😀"), "%C3%A9%F0%9F%98%80");
  assert.equal(pyQuote("a/b"), "a/b");
  assert.throws(() => pyQuote("\uD800"), RangeError);
});

test("py float, int and truthiness follow python", () => {
  assert.deepEqual(
    ["3", " 2.5 ", "1_0", "1e1", ".5", "3.", "-1", "inf", "-Infinity", "x", "", "1__0", "0x10"].map(pyFloat),
    [3, 2.5, 10, 10, 0.5, 3, -1, Infinity, -Infinity, undefined, undefined, undefined, undefined],
  );
  assert.ok(Number.isNaN(pyFloat("nan")));
  assert.deepEqual([86399, "86399", " 7 ", 2.9, true, false, "2.5", null, {}, Infinity, "1_000"].map(pyInt), [
    86399,
    86399,
    7,
    2,
    1,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
    1000,
  ]);
  assert.deepEqual([0, "", [], {}, null, undefined, false, 1, "x", [0], { a: 1 }].map(pyTruthy), [
    false,
    false,
    false,
    false,
    false,
    false,
    false,
    true,
    true,
    true,
    true,
  ]);
  assert.equal(rstripSlash("https://x//"), "https://x");
});

test("the connector's answers are read for the id, the code, the retry after and the members", () => {
  assert.equal(answerId('{"id":"a1"}'), "a1");
  assert.equal(answerId('{"id":7}'), "7");
  assert.deepEqual(["{}", '{"id":""}', "[1]", "nope", ""].map(answerId), Array(5).fill(undefined));
  assert.equal(errorCode(JSON.stringify({ error: { code: "X".repeat(80), message: "secret" } })), "X".repeat(60));
  assert.deepEqual(['{"error":"flat"}', "[]", "nope", '{"error":{}}'].map(errorCode), ["", "", "", ""]);
  assert.deepEqual(["3", "0", "-1", "nan", "Wed, 21 Oct 2015 07:28:00 GMT", null].map(retryAfterMs), [
    3000,
    0,
    undefined,
    undefined,
    undefined,
    undefined,
  ]);
  assert.equal(retryAfterMs("inf"), Infinity);
  assert.deepEqual(memberList('[{"id":"a"},1]'), [{ id: "a" }]);
  assert.deepEqual(memberList("null"), []);
  assert.equal(memberList("<html>"), undefined);
});

test("entra codes show the error and up to three codes, never the description", () => {
  const body = (value: unknown): string => JSON.stringify(value);
  assert.equal(entraCodes(body({ error: "invalid_client", error_codes: [700213] })), " (invalid_client: AADSTS700213)");
  assert.equal(entraCodes(body({ error_codes: [1, "2", 3, 4] })), " (AADSTS1,AADSTS2,AADSTS3)");
  assert.equal(entraCodes(body({ error: "e".repeat(50) })), ` (${"e".repeat(40)})`);
  assert.deepEqual(
    [
      body({}),
      body({ error_codes: ["x"] }),
      body({ error_codes: "1" }),
      "[]",
      "not json",
      body({ error_codes: null }),
    ].map(entraCodes),
    ["", "", "", "", "", ""],
  );
});

test("a request is refused when the envelope cannot be addressed", () => {
  const bad = [
    { operation: "send", reference: "x", activity: {} },
    { operation: "send", reference: { serviceUrl: "https://smba.trafficmanager.net/" }, activity: {} },
    { ...envelope(), operation: "update" },
    { ...envelope(), operation: "archive" },
    { ...envelope(), reference: { ...reference(), conversation: "19:abc" } },
    { ...envelope(), reference: reference("19:\uD800") },
  ];
  for (const e of bad)
    assert.throws(
      () => buildRequest(e),
      (err: unknown) => err instanceof Error,
      JSON.stringify(e),
    );
});

test("a reply posts into the thread and the reference's locale and channel fill in", () => {
  const ref = { ...reference(), locale: "zh-CN" };
  const reply = buildRequest({ ...envelope("x", { ref }), operation: "reply" });
  assert.ok(reply.url.endsWith("/activities/root-1"));
  assert.equal(reply.payload?.["locale"], "zh-CN");
  const kept = buildRequest({ ...envelope("x", { ref }), activity: { text: "x", locale: "en-US" } });
  assert.equal(kept.payload?.["locale"], "en-US");
  assert.equal(kept.payload["type"], "message");
  const bare = buildRequest({
    operation: "REPLY",
    reference: { serviceUrl: "https://smba.trafficmanager.net/", conversation: { id: "c" } },
    activity: { type: "message" },
  });
  assert.ok(bare.url.endsWith("/conversations/c/activities"));
  assert.equal(bare.payload?.["from"], null);
  assert.equal(bare.payload["recipient"], null);
  assert.equal(bare.payload["channelId"], undefined);
  const defaulted = buildRequest({ reference: reference(), activity: {} });
  assert.equal(defaulted.method, "POST");
});

test("a timer aborts its signal at its time, a disposed one never does", async () => {
  const clock = new FakeClock();
  const timer = startTimer(clock, 100, "too slow");
  const disposed = startTimer(clock, 100, "never");
  disposed.dispose();
  await clock.advance(100);
  assert.ok(timer.signal.aborted);
  assert.ok(reasonOf(timer.signal) instanceof DeadlineError);
  assert.equal(reasonOf(timer.signal).message, "too slow");
  assert.equal(disposed.signal.aborted, false);
  const parent = new AbortController();
  const child = startTimer(clock, 1000, "child", parent.signal);
  parent.abort("plain reason");
  assert.ok(child.signal.aborted);
  assert.ok(reasonOf(child.signal) instanceof DeadlineError); // a reason that is not an Error
  child.dispose();
});

test("race abort ends a wait when the signal aborts and passes the work's result otherwise", async () => {
  const controller = new AbortController();
  assert.equal(await raceAbort(controller.signal, Promise.resolve(1)), 1);
  const never = new Promise<number>(() => undefined);
  const raced = raceAbort(controller.signal, never);
  controller.abort(new Error("stop"));
  await assert.rejects(raced, /stop/);
  await assert.rejects(raceAbort(controller.signal, Promise.reject(new Error("late"))), /stop/);
});

test("lanes run one key's work in arrival order and forget the key afterwards", async () => {
  const lanes = new Lanes();
  const order: string[] = [];
  let open = (): void => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const first = lanes.hold("a", async () => {
    await gate;
    order.push("a1");
  });
  const second = lanes.hold("a", () => Promise.resolve(order.push("a2")));
  const other = lanes.hold("b", () => Promise.resolve(order.push("b1")));
  const waiting = new AbortController();
  const third = lanes.hold("a", () => Promise.resolve(order.push("never")), waiting.signal);
  const fourth = lanes.hold("a", () => Promise.resolve(order.push("a4")));
  await flushMicrotasks();
  assert.equal(lanes.size, 1); // "b" ran and was forgotten; "a" is held
  waiting.abort(new Error("gave up"));
  await assert.rejects(third, /gave up/);
  open();
  await Promise.all([first, second, other, fourth]);
  assert.deepEqual(order, ["b1", "a1", "a2", "a4"]);
  assert.equal(lanes.size, 0);
});
