// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One event Claw cannot take must not hold up the events behind it.
 *
 * Claw's API answered 500 to every post of a batch that held a NUL (PostgreSQL's jsonb refuses it), the connector posted that
 * batch again for ever, and every later event of the machine, of every session, queued behind it: prompts reached the agents and
 * no answer ever came back. These run the connector against the stand-in Claw answering as that API did.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import test, { after, describe } from "node:test";
import { HttpError, TransportError } from "../src/claw-client.js";
import type { OutEvent } from "../src/outbox.js";
import { quarantineFile } from "../src/paths.js";
import { ISOLATE_AFTER_FAILURES, mayBeContent, PoisonFinder, SET_ASIDE_AFTER_REFUSALS } from "../src/poison.js";
import { storableDeep, storableText } from "../src/redact.js";
import { sleep, type Logger } from "../src/util.js";
import { Harness } from "./support/harness.js";

const R = "�";
const hs: Harness[] = [];
after(async () => { for (const h of hs) await h.close(); });
const make = async (o: Parameters<typeof Harness.create>[0] = {}) => { const h = await Harness.create(o); hs.push(h); return h; };

/** A logger that keeps what was warned. */
const keeping = () => {
  const warned: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const log: Logger = { info() {}, warn(msg, extra) { warned.push({ msg, extra }); }, error() {} };
  return { log, warned };
};
const quarantined = (h: Harness): any[] => {
  try { return fs.readFileSync(quarantineFile(h.dirs), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
/** Every session's events reached Claw in its own order: no event was posted before an earlier one of its session was settled. */
const inSessionOrder = (h: Harness): void => {
  const last = new Map<string, number>();
  for (const p of h.claw.posts.filter((x) => x.status === 200)) {
    for (const e of p.events) {
      assert.ok((last.get(e.session_id) ?? 0) < e.seq, `${e.type} #${e.seq} of ${e.session_id} after #${last.get(e.session_id)}`);
      last.set(e.session_id, e.seq);
    }
  }
};

describe("an event Claw cannot take", () => {
  test("a NUL left in the outbox by an older connector, refused 500 by an older Claw: found, posted made storable, and the events behind it go", async () => {
    const h = await make();
    const sid = await h.newSession();
    const other = await h.newSession();
    await h.connector.drained();
    h.claw.refuseUnstorable = true;
    // As the outbox an older connector wrote: an event whose terminal output has NULs in it, queued before what follows.
    h.connector.outbox.append(sid, "tool_call_update", { toolCallId: "t1", content: [{ type: "terminal", output: "ab\u0000cd" }] });
    h.prompt(sid, "say after");
    h.prompt(other, "say other");
    await h.turnEnd(sid);
    await h.turnEnd(other);
    assert.equal(await h.connector.drained(), true);
    assert.deepEqual(h.messages(sid), ["after"]);
    assert.deepEqual(h.messages(other), ["other"]);
    const stored = h.claw.eventsOf(sid, "tool_call_update").find((e) => e.data.toolCallId === "t1");
    assert.equal(stored?.data.content[0].output, `ab${R}cd`, "posted again with the NUL replaced, not dropped");
    assert.ok(h.claw.posts.filter((p) => p.status === 500).length >= ISOLATE_AFTER_FAILURES, "the old answer really came");
    assert.deepEqual(quarantined(h), [], "nothing set aside: the made-storable post was taken");
    inSessionOrder(h);
  });

  test("an event Claw refuses whatever is done to it is set aside by number and type, never its content, logged once, and the rest go", async () => {
    const { log, warned } = keeping();
    const h = await make({ log });
    const sid = await h.newSession();
    const other = await h.newSession();
    await h.connector.drained();
    h.claw.refuseEvent = (e) => e.data?.poison === true;
    const bad = h.connector.outbox.append(sid, "tool_call_update", { poison: true, output: "private-output-text" });
    h.prompt(sid, "say behind");
    h.prompt(other, "say beside");
    await h.turnEnd(sid);
    await h.turnEnd(other);
    assert.equal(await h.connector.drained(), true, "nothing left queued");
    assert.deepEqual([h.messages(sid), h.messages(other)], [["behind"], ["beside"]]);
    assert.equal(h.claw.eventsOf(sid).some((e) => e.data?.poison), false);
    // The quarantine file is written off the event loop: a moment later.
    const q = await h.claw.until("the quarantine record", () => quarantined(h).length > 0 && quarantined(h));
    assert.equal(q.length, 1);
    assert.deepEqual({ ...q[0], at: undefined }, { at: undefined, session_id: sid, seq: bad.seq, type: "tool_call_update", reason: "http_500_Internal Server Error" });
    const file = fs.readFileSync(quarantineFile(h.dirs), "utf8");
    assert.ok(!file.includes("private-output-text") && !file.includes("poison"), "no content in the quarantine file");
    assert.equal((fs.statSync(quarantineFile(h.dirs)).mode & 0o777).toString(8), "600");
    const told = warned.filter((w) => /set aside/.test(w.msg));
    assert.equal(told.length, 1, "logged once");
    assert.deepEqual(told[0]!.extra, { session_id: sid, seq: bad.seq, type: "tool_call_update", reason: "http_500_Internal Server Error" });
    assert.ok(!JSON.stringify(warned).includes("private-output-text"), "no content in the log");
    assert.ok(h.audit().some((a) => a.kind === "event_quarantined" && a.seq === bad.seq));
    // It was found by splitting: the post that set it aside held it alone.
    assert.ok(h.claw.posts.some((p) => p.status === 500 && p.events.length === 1 && p.events[0]!.seq === bad.seq));
    inSessionOrder(h);
    // And it does not come back after a restart.
    await h.stop();
    h.connect({ log });
    h.start();
    await h.online();
    await sleep(100);
    assert.equal(h.connector.outbox.size, 0);
  });

  test("an event Claw names in `rejected` is set aside the same way: quarantined by number and type", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.rejectType = "agent_message_chunk";
    h.prompt(sid, "say refused text");
    await h.turnEnd(sid);
    assert.equal(await h.connector.drained(), true);
    const q = await h.claw.until("the quarantine record", () => quarantined(h).length > 0 && quarantined(h));
    assert.deepEqual(q.map((x: any) => [x.session_id, x.type, x.reason]), [[sid, "agent_message_chunk", "rejected_invalid_type"]]);
    assert.ok(!fs.readFileSync(quarantineFile(h.dirs), "utf8").includes("refused text"));
  });

  test("a NUL an agent prints never reaches Claw: the event is made storable where it is made", async () => {
    const h = await make();
    const sid = await h.newSession();
    h.claw.refuseUnstorable = true;
    h.prompt(sid, "say a\u0000b \uD800");
    await h.turnEnd(sid);
    assert.deepEqual(h.messages(sid), [`a${R}b ${R}`]);
    assert.deepEqual(h.claw.posts.filter((p) => p.status !== 200), [], "no post was refused");
  });

  test("an outage never sets an event aside: 503s are waited out unsplit, and 500s to every post, an empty one too, lose nothing", async () => {
    const h = await make();
    const sid = await h.newSession();
    await h.connector.drained();
    h.claw.failPosts = 12;
    h.prompt(sid, "chunks 30");
    await h.turnEnd(sid);
    // Nothing is acknowledged meanwhile, so the batch can only grow: a split would post fewer.
    const sizes = h.claw.posts.filter((p) => p.status === 503).map((p) => p.events.length);
    assert.ok(sizes.every((n, i) => i === 0 || n >= sizes[i - 1]!), `a 503 does not split a batch: ${sizes.join(",")}`);
    await h.connector.drained();
    h.claw.failAllPosts = true;
    h.prompt(sid, "chunks 40");
    // Long enough to split down to one event and ask, with an empty post, whether Claw answers: it does not.
    await h.claw.until("an empty post to be refused", () => h.claw.posts.some((p) => p.status === 500 && p.events.length === 0));
    await sleep(300);
    h.claw.failAllPosts = false;
    await h.turnEnd(sid, 2);
    assert.equal(await h.connector.drained(), true);
    assert.deepEqual(h.messages(sid), [...Array.from({ length: 30 }, (_, i) => `c${i + 1}`), ...Array.from({ length: 40 }, (_, i) => `c${i + 1}`)]);
    const seqs = h.claw.eventsOf(sid).map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), "contiguous from 1: nothing set aside");
    assert.deepEqual(quarantined(h), []);
    inSessionOrder(h);
  });
});

describe("PoisonFinder", () => {
  const evs = (n: number): OutEvent[] => Array.from({ length: n }, (_, i) => ({ session_id: "s", seq: i + 1, type: "t", ts: 0, data: { i } }));
  const e500 = new HttpError(500, "Internal Server Error", "/events");
  const all = () => true;

  test("which failures may be about what a post carried", () => {
    assert.equal(mayBeContent(e500), true);
    for (const s of [400, 413, 422]) assert.equal(mayBeContent(new HttpError(s, "x", "/e")), true, String(s));
    for (const s of [401, 403, 404, 408, 409, 429, 502, 503, 504]) assert.equal(mayBeContent(new HttpError(s, "x", "/e")), false, String(s));
    assert.equal(mayBeContent(new TransportError("down")), false);
  });

  test("splits after three 500s of the same first event (or one 4xx), halving down to the one that fails, then posts it made storable", () => {
    const q = evs(8);
    const f = new PoisonFinder();
    const bad = q[5]!;
    let plan = f.plan(q, all);
    for (let i = 1; i < ISOLATE_AFTER_FAILURES; i++) { assert.equal(f.failed(plan, e500), "retry"); assert.equal(f.isolating, false); plan = f.plan(q, all); }
    assert.equal(f.failed(plan, e500), "retry");
    assert.equal(f.isolating, true);
    const tried: number[][] = [];
    const queued = new Set(q);
    for (let step = 0; step < 10; step++) {
      plan = f.plan([...queued], (e) => queued.has(e));
      tried.push(plan.events.map((e) => e.seq));
      if (plan.storable) break;
      if (plan.events.includes(bad)) f.failed(plan, e500);
      else { f.taken(plan); for (const e of plan.events) queued.delete(e); }
    }
    assert.deepEqual(tried, [[1, 2, 3, 4], [5, 6], [5], [6]], "first halves only: never a later event before an earlier one");
    assert.equal(plan.storable, true);
    // Refused alone, made storable: asked whether Claw answers otherwise, and set aside only after refusals each followed by a yes.
    assert.equal(f.failed(plan, e500), "probe");
    assert.equal(f.probed(false), "retry", "Claw is down: nothing is set aside");
    for (let i = 1; i < SET_ASIDE_AFTER_REFUSALS; i++) {
      assert.equal(f.failed(f.plan([...queued], (e) => queued.has(e)), e500), "probe");
      assert.equal(f.probed(true), "retry");
    }
    assert.equal(f.failed(f.plan([...queued], (e) => queued.has(e)), e500), "probe");
    assert.equal(f.probed(true), "set_aside");
    f.setAside();
    assert.equal(f.isolating, false);
    const g = new PoisonFinder();
    const p = g.plan(q, all);
    g.failed(p, new HttpError(400, "bad", "/e"));
    assert.equal(g.isolating, true, "a 4xx splits at once");
  });

  test("an outage (503, no answer) neither counts nor splits; a different first event starts the count again", () => {
    const q = evs(4);
    const f = new PoisonFinder();
    for (let i = 0; i < 10; i++) f.failed(f.plan(q, all), new HttpError(503, "x", "/e"));
    for (let i = 0; i < 10; i++) f.failed(f.plan(q, all), new TransportError("x"));
    assert.equal(f.isolating, false);
    f.failed(f.plan(q, all), e500);
    f.failed(f.plan(q, all), e500);
    f.failed(f.plan(q.slice(1), all), e500);
    assert.equal(f.isolating, false, "two failures of one head and one of another are not three in a row");
  });

  test("a suspect batch whose events were all taken meanwhile ends the search", () => {
    const q = evs(4);
    const f = new PoisonFinder();
    f.failed(f.plan(q, all), new HttpError(422, "x", "/e"));
    assert.equal(f.isolating, true);
    assert.deepEqual(f.plan(q.slice(0, 1), () => false).events.map((e) => e.seq), [1], "nothing suspect is queued any more: the queue as usual");
    assert.equal(f.isolating, false);
  });
});

test("storableText and storableDeep replace NUL and unpaired surrogates in keys and values, and keep whole pairs", () => {
  assert.equal(storableText("a\u0000b\uD800c\uDC00 😀"), `a${R}b${R}c${R} 😀`);
  assert.deepEqual(storableDeep({ ["k\u0000"]: ["v\u0000", 1, null, { x: "\uDBFF" }] }), { [`k${R}`]: [`v${R}`, 1, null, { x: R }] });
  const plain = { a: "plain", n: 2 };
  assert.deepEqual(storableDeep(plain), plain);
});
