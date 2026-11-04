// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The measuring parts of the end-to-end script (`e2e/assistant-p1-lib.ts`): a receiver that verifies what it is
 * sent, and the arithmetic the verdict rests on. The scenario itself needs a deployment and a model; these do not.
 *
 *   B1  the receiver accepts a correctly signed delivery and records it, with the item snapshot
 *   B2  it refuses a bad signature, a stale timestamp, a header that disagrees with the body, and everything before it has a secret
 *   B3  while rejecting it answers 500 and records nothing as received, and takes deliveries again afterwards
 *   B4  an event accepted twice is reported as a duplicate, one accepted once is not
 *   B5  the percentile is nearest-rank; the table says which interjection was too slow and which got no answer
 *   B6  `until` returns what the probe found, null at the deadline, and never answers "found" for a probe that never did;
 *       the deadline is strict: an answer that came after it, or a deadline already past, is null
 *   B7  a run tag is the one given, or a fresh one per run: two runs never share task names
 *   B8  a soak round counts as its own only items numbered after the round began that no earlier round took
 *   B9  the sandbox count is of this run's sessions only, and only of sandboxes not yet stopped; an unreadable list throws
 *   B10 cleanup runs after an early return, an exception and success alike, latest first, each despite another failing;
 *       the exit code is 0 only when the scenario finished with nothing failed
 *   B11 a round's item is the one whose title names its task, not a task whose name merely contains it
 *   B12 a round waits only as long as it takes for the user's last hour plus the round to fit the message cap
 *   B13 an idempotent request is repeated on 5xx or a failed send, not on an answer, and gives up after its tries
 *   B14 the answer to a message is the first say its own turn made, whether or not it offers an item to accept; a say
 *       another turn made first (a worker's report passed on) is not it, and neither is one the session has no turn for
 */
import assert from "node:assert/strict";
import test from "node:test";

import { EVENT_ID_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, signPayload } from "../src/notifications/signing.js";
import {
  aliveSandboxes, answerTo, duplicateEventIds, itemNamed, latencyMs, newItemsSince, percentile, renderTimings, retry5xx, runTag, sayPacingWaitMs,
  settle, startReceiver, until,
} from "./e2e/assistant-p1-lib.js";

const SECRET = "s".repeat(64);
const payload = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  event_id: id, type: "assistant.say", occurred_at: new Date().toISOString(), user_id: "u1", text: "hello",
  item: { item_id: "kwi_1", seq: 1, title: "t", board_state: "needs_you", result_version: 1, can_accept: true }, ...extra,
});
async function deliver(port: number, body: string, o: { secret?: string; ts?: number; eventId?: string; path?: string } = {}) {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  return fetch(`http://127.0.0.1:${port}${o.path ?? "/hook"}`, {
    method: "POST",
    headers: {
      [TIMESTAMP_HEADER]: String(ts), [SIGNATURE_HEADER]: signPayload(o.secret ?? SECRET, ts, body),
      [EVENT_ID_HEADER]: o.eventId ?? JSON.parse(body).event_id, "content-type": "application/json",
    },
    body,
  });
}

test("B1 a correctly signed delivery is accepted and recorded", async () => {
  const r = await startReceiver(0, "127.0.0.1");
  try {
    r.setSecret(SECRET);
    const res = await deliver(r.port, payload("e1"));
    assert.equal(res.status, 200);
    assert.equal(r.received.length, 1);
    assert.deepEqual({ id: r.received[0].eventId, type: r.received[0].type, fallback: r.received[0].fallback, can: r.received[0].item?.can_accept }, { id: "e1", type: "assistant.say", fallback: false, can: true });
    assert.equal(r.received[0].verified, true);
    await deliver(r.port, payload("e2", { type: "work_item.needs_you", fallback: true }));
    assert.equal(r.received[1].fallback, true);
  } finally { await r.close(); }
});

test("B2 what is not signed for the subscription is refused", async () => {
  const r = await startReceiver(0, "127.0.0.1");
  try {
    assert.equal((await deliver(r.port, payload("e0"))).status, 401, "before it has a secret nothing verifies");
    r.setSecret(SECRET);
    assert.equal((await deliver(r.port, payload("e1"), { secret: "x".repeat(64) })).status, 401);
    assert.equal((await deliver(r.port, payload("e2"), { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
    assert.equal((await deliver(r.port, payload("e3"), { eventId: "another" })).status, 400);
    assert.equal((await deliver(r.port, "not json", { eventId: "x" })).status, 400);
    assert.equal((await deliver(r.port, payload("e4"), { path: "/elsewhere" })).status, 404);
    assert.equal(r.received.length, 0);
    assert.equal(r.refused.length, 6);
  } finally { await r.close(); }
});

test("B3 while rejecting it answers 500 and records nothing as received", async () => {
  const r = await startReceiver(0, "127.0.0.1");
  try {
    r.setSecret(SECRET);
    r.setRejecting(true);
    assert.equal((await deliver(r.port, payload("e1"))).status, 500);
    assert.equal(r.received.length, 0);
    r.setRejecting(false);
    assert.equal((await deliver(r.port, payload("e1"))).status, 200);
    assert.equal(r.received.length, 1, "the retry is received once");
  } finally { await r.close(); }
});

test("B4 an event accepted twice is a duplicate", () => {
  const at = Date.now();
  const mk = (eventId: string) => ({ at, eventId, type: "assistant.say", text: "", fallback: false, verified: true });
  assert.deepEqual(duplicateEventIds([mk("a"), mk("b"), mk("a"), mk("a")]), ["a"]);
  assert.deepEqual(duplicateEventIds([mk("a"), mk("b")]), []);
  assert.deepEqual(duplicateEventIds([]), []);
});

test("B5 the percentile is nearest-rank and the table names the slow and the missing", () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([5], 95), 5);
  const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
  assert.equal(percentile(twenty, 95), 1900);
  assert.equal(percentile(twenty, 100), 2000);
  assert.equal(percentile([300, 100, 200], 50), 200);
  const table = renderTimings([
    { label: "fast", sentAt: 1_000, answeredAt: 3_000 },
    { label: "slow", sentAt: 1_000, answeredAt: 11_000 },
    { label: "none", sentAt: 1_000, answeredAt: null },
  ], 10_000);
  assert.match(table, /fast .*2000ms\s+ok/);
  assert.match(table, /slow .*10000ms\s+TOO SLOW/);
  assert.match(table, /none .*NO ANSWER/);
  assert.equal(latencyMs({ label: "x", sentAt: 5, answeredAt: 9 }), 4);
  assert.equal(latencyMs({ label: "x", sentAt: 5, answeredAt: null }), null);
});

test("B6 until returns what was found, and null at the deadline", async () => {
  let calls = 0;
  assert.equal(await until(() => (++calls >= 3 ? "found" : undefined), Date.now() + 2000, 1), "found");
  assert.equal(calls, 3);
  const started = Date.now();
  assert.equal(await until(() => undefined, started + 60, 5), null);
  assert.ok(Date.now() - started >= 60, "it waited for the deadline");
  assert.equal(await until(() => false, Date.now() + 10, 1), false, "false is an answer: only undefined means not yet");
  let probed = 0;
  assert.equal(await until(() => { probed++; return "late"; }, Date.now() - 1, 1), null, "a deadline already past is null");
  assert.equal(probed, 0, "and nothing is probed after it");
  const slow = () => new Promise<string>((r) => setTimeout(() => r("ready"), 40));
  assert.equal(await until(slow, Date.now() + 10, 1), null, "an answer that arrives after the deadline is not on time");
  assert.equal(await until(slow, Date.now() + 500, 1), "ready", "one that arrives before it is");
});

test("B7 a run tag is the one given, or fresh per run", () => {
  assert.equal(runTag("soak3"), "soak3");
  assert.equal(runTag("  soak3 \n"), "soak3");
  assert.equal(runTag(undefined, 1_000_000), "r" + (1_000_000).toString(36));
  assert.equal(runTag("", 1_000_000), runTag(undefined, 1_000_000));
  assert.notEqual(runTag(undefined, 1_000_000), runTag(undefined, 1_000_001), "two runs started apart do not share names");
});

test("B8 a round takes only items numbered after it began, and none an earlier round took", () => {
  const board = [{ item_id: "k5", seq: 5 }, { item_id: "k7", seq: 7 }, { item_id: "k6", seq: 6 }, { item_id: "k8", seq: 8 }];
  assert.deepEqual(newItemsSince(board, 5, new Set()).map((i) => i.item_id), ["k6", "k7", "k8"], "in number order");
  assert.deepEqual(newItemsSince(board, 5, new Set(["k7"])).map((i) => i.item_id), ["k6", "k8"], "an earlier round's item is not taken");
  assert.deepEqual(newItemsSince(board, 8, new Set()), [], "nothing after the floor");
  assert.deepEqual(newItemsSince([{ item_id: "k9", seq: "9" as unknown as number }], 8, new Set()).map((i) => i.item_id), ["k9"], "a number sent as a string still counts");
});

test("B9 the sandbox count is of this run's live sandboxes only", () => {
  const w = (name: string, sid: string | null, phase?: string) => ({
    metadata: { name, labels: (sid ? { "primus-claw/session-id": sid } : {}) as Record<string, string> }, ...(phase ? { status: { phase } } : {}),
  });
  const list = { items: [
    w("mine-running", "s1", "Running"), w("mine-pending", "s2", "Pending"), w("mine-new", "s2"),
    w("mine-stopped", "s1", "Stopped"), w("mine-failed", "s1", "Failed"), w("mine-done", "s2", "Succeeded"),
    w("other-running", "s9", "Running"), w("unlabelled", null, "Running"),
  ] };
  assert.deepEqual(aliveSandboxes(list, new Set(["s1", "s2"])), ["mine-running", "mine-pending", "mine-new"]);
  assert.deepEqual(aliveSandboxes(list, new Set()), [], "an empty run owns nothing, not the unlabelled one");
  assert.throws(() => aliveSandboxes({} as never, new Set(["s1"])), /no items/, "an unreadable list is not zero sandboxes");
});

test("B10 cleanup runs whatever happened, and the exit code says whether it all passed", async () => {
  const runWith = async (scenario: () => Promise<"finished" | void>, failingCleanup = false) => {
    const order: string[] = [];
    const failures: string[] = [];
    const cleanups = [
      { what: "first", run: async () => { order.push("first"); } },
      { what: "second", run: async () => { order.push("second"); if (failingCleanup) throw new Error("boom"); } },
      { what: "third", run: async () => { order.push("third"); } },
    ];
    const code = await settle(() => scenario.call(null), cleanups, failures);
    return { code, order, failures };
  };
  const ok = await runWith(async () => "finished");
  assert.deepEqual(ok, { code: 0, order: ["third", "second", "first"], failures: [] });

  const early = await runWith(async () => { /* a check failed and the scenario returned */ });
  assert.equal(early.code, 1, "an early return never exits 0");
  assert.deepEqual(early.order, ["third", "second", "first"]);
  assert.match(early.failures[0], /ended before it finished/);

  const thrown = await runWith(async () => { throw new Error("network down"); });
  assert.equal(thrown.code, 1);
  assert.deepEqual(thrown.order, ["third", "second", "first"]);
  assert.match(thrown.failures[0], /network down/);

  const badCleanup = await runWith(async () => "finished", true);
  assert.equal(badCleanup.code, 1, "a cleanup that failed fails the run");
  assert.deepEqual(badCleanup.order, ["third", "second", "first"], "the cleanups after it still run");
  assert.match(badCleanup.failures[0], /cleanup: second: boom/);

  const failures = ["the board shows A as in progress"];
  assert.equal(await settle(async () => undefined, [], failures), 1);
  assert.deepEqual(failures, ["the board shows A as in progress"], "a recorded failure is not doubled by the early-return note");
});

test("B11 a round's item is the one its title names", () => {
  const items = [{ title: "Task soak3-S13a: write s13a.txt" }, { title: "Task soak3-S1ab: write" }, { title: "Task soak3-S1b: write s1b.txt" }];
  assert.equal(itemNamed(items, "S1a"), undefined, "S13a and S1ab are other tasks");
  assert.equal(itemNamed(items, "S1b")?.title, "Task soak3-S1b: write s1b.txt");
  assert.equal(itemNamed(items, "s13A")?.title, "Task soak3-S13a: write s13a.txt", "case does not matter");
  assert.equal(itemNamed([{ title: "S2a" }], "S2a")?.title, "S2a", "at the start and end of the title");
  assert.equal(itemNamed([{ title: "Task S2a.txt" }], "S2a")?.title, "Task S2a.txt");
  assert.equal(itemNamed([{ title: "anything" }], "a.*"), undefined, "the name is literal");
  assert.equal(itemNamed([{ title: "Task soak3-XS1a: write" }], "S1a"), undefined, "XS1a is another task");
});

test("B12 a round waits until the last hour plus the round fit the cap", () => {
  const H = 3_600_000;
  const now = 10 * H;
  assert.equal(sayPacingWaitMs([], now, 120, 8), 0);
  const at = (n: number, from: number, step: number) => Array.from({ length: n }, (_, i) => from + i * step);
  assert.equal(sayPacingWaitMs(at(112, now - 1000 * 112, 1000), now, 120, 8), 0, "112 + 8 is exactly the cap");
  const full = at(113, now - 50 * 60_000, 1000);
  assert.equal(sayPacingWaitMs(full, now, 120, 8), full[0] + H - now + 1000, "one over: wait until the oldest leaves the hour");
  assert.equal(sayPacingWaitMs([...full, ...full.slice(0, 2)], now, 120, 8), full[1] + H - now + 1000, "three over: until the third oldest leaves");
  assert.equal(sayPacingWaitMs(at(200, now - 3 * H, 1000), now, 120, 8), 0, "messages older than an hour do not count");
  assert.equal(sayPacingWaitMs([], now, 5, 8), Number.POSITIVE_INFINITY, "a round that alone exceeds the cap never fits");
});

test("B13 an idempotent request is repeated on 5xx and on a failed send only", async () => {
  const seq = (statuses: Array<number | Error>) => {
    let i = 0;
    return { calls: () => i, call: async () => { const s = statuses[i++]; if (s instanceof Error) throw s; return s; } };
  };
  const a = seq([503, new Error("reset"), 200]);
  assert.equal(await retry5xx(a.call, 3, 1), 200);
  assert.equal(a.calls(), 3);
  const b = seq([404]);
  assert.equal(await retry5xx(b.call, 3, 1), 404, "an answer is not retried");
  assert.equal(b.calls(), 1);
  const c = seq([500, 502, 503, 200]);
  assert.equal(await retry5xx(c.call, 3, 1), 503, "it gives up after its tries with the last status");
  assert.equal(c.calls(), 3);
  const d = seq([new Error("down"), new Error("down")]);
  assert.equal(await retry5xx(d.call, 2, 1), 599, "a request that could not be sent is a failure");
});

test("B14 the answer to a message is the say its own turn made", () => {
  const item = (canAccept: boolean) => ({ item_id: "kwi_1", seq: 1, title: "t", board_state: "needs_you", result_version: 1, can_accept: canAccept });
  const say = (eventId: string, at: number, canAccept?: boolean) => ({
    at, eventId, type: "assistant.say", text: "x", fallback: false, verified: true, ...(canAccept === undefined ? {} : { item: item(canAccept) }),
  });
  const said = (sayId: string, turn?: string) => ({ data: { type: "AssistantSay", say_id: sayId, ...(turn ? { turn_message_id: turn } : {}) } });
  const session = [
    { data: { type: "toolUsed", say_id: "s-q" } },
    said("s-report", "claw-pending-301"),
    said("s-q", "claw-1"),
    said("s-q2", "claw-1"),
    said("s-old"),
  ];
  // Rounds 3 and 19 of soak 6: the reply offered the finished item, and was counted as no answer.
  const received = [say("s-old", 1), say("s-report", 2, true), say("s-q", 3, true), say("s-q2", 4)];
  assert.equal(answerTo("claw-1", session, received)?.eventId, "s-q", "its own say, though it offers an item to accept");
  assert.equal(answerTo("claw-pending-301", session, received)?.eventId, "s-report");
  assert.equal(answerTo("claw-2", session, received), undefined, "a message no turn has answered has no answer");
  assert.equal(answerTo("claw-1", session, received.slice(0, 2)), undefined, "the answer is not yet received");
  assert.equal(answerTo("claw-1", [], received), undefined, "an unread session answers nothing");
});
