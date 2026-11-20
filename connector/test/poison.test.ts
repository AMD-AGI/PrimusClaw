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
import { failureKind, ISOLATE_AFTER_FAILURES, mayBeContent, PoisonFinder, SET_ASIDE_AFTER_REFUSALS, type PoisonPlan } from "../src/poison.js";
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
    assert.deepEqual({ ...q[0], at: undefined }, { at: undefined, session_id: sid, seq: bad.seq, type: "tool_call_update", reason: "http_500_22023" });
    const file = fs.readFileSync(quarantineFile(h.dirs), "utf8");
    assert.ok(!file.includes("private-output-text") && !file.includes("poison"), "no content in the quarantine file");
    assert.equal((fs.statSync(quarantineFile(h.dirs)).mode & 0o777).toString(8), "600");
    const told = warned.filter((w) => /set aside/.test(w.msg));
    assert.equal(told.length, 1, "logged once");
    assert.deepEqual(told[0]!.extra, { session_id: sid, seq: bad.seq, type: "tool_call_update", reason: "http_500_22023" });
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
    // Long enough to split down to one event, which a 500 that names nothing never sets aside.
    await h.claw.until("a post of one event to be refused", () => h.claw.posts.some((p) => p.status === 500 && p.events.length === 1), 15_000);
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

describe("a Claw that answers 500 now and then", () => {
  test("never sets an event aside: half the posts fail with a 500 that names no event, and every event still arrives, in order", async () => {
    const h = await make();
    const sid = await h.newSession();
    const other = await h.newSession();
    await h.connector.drained();
    const rnd = seeded(7);
    h.claw.flaky = () => rnd() < 0.5;
    for (let round = 1; round <= 3; round++) {
      h.prompt(sid, "chunks 25");
      h.prompt(other, "chunks 25");
      await h.turnEnd(sid, round);
      await h.turnEnd(other, round);
    }
    h.claw.flaky = null;
    assert.equal(await h.connector.drained(), true);
    const want = Array.from({ length: 3 }, () => Array.from({ length: 25 }, (_, i) => `c${i + 1}`)).flat();
    assert.deepEqual([h.messages(sid), h.messages(other)], [want, want], "every chunk, and every turn's end");
    for (const s of [sid, other]) {
      const seqs = h.claw.eventsOf(s).map((e) => e.seq);
      assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), "contiguous from 1: nothing set aside");
    }
    assert.ok(h.claw.posts.filter((p) => p.status === 500).length >= 10, "the 500s really came");
    assert.deepEqual(quarantined(h), []);
    assert.equal(h.audit().some((a) => a.kind === "event_quarantined"), false);
    inSessionOrder(h);
  });
  test("a burst of such 500s, long enough to split a batch down to one event, sets nothing aside: the turn's end arrives", async () => {
    const h = await make();
    const sid = await h.newSession();
    await h.connector.drained();
    let burst = 30;
    h.claw.flaky = () => burst-- > 0;
    h.prompt(sid, "chunks 30");
    await h.claw.until("the burst to end", () => burst < 0, 20_000);
    await h.turnEnd(sid);
    assert.equal(await h.connector.drained(), true);
    assert.deepEqual(h.messages(sid), Array.from({ length: 30 }, (_, i) => `c${i + 1}`));
    assert.ok(h.claw.posts.some((p) => p.status === 500 && p.events.length === 1), "the batch was split down to one event");
    const seqs = h.claw.eventsOf(sid).map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, i) => i + 1), "contiguous from 1: nothing set aside");
    assert.deepEqual(quarantined(h), []);
    inSessionOrder(h);
  });
});

describe("PoisonFinder", () => {
  const evs = (n: number): OutEvent[] => Array.from({ length: n }, (_, i) => ({ session_id: "s", seq: i + 1, type: "t", ts: 0, data: { i } }));
  /** A 500 the database gave for a value it cannot hold (22P05: a NUL in jsonb), and one that names nothing (a deadlock). */
  const e500 = new HttpError(500, "Internal Server Error", "/events", "22P05");
  const plain500 = new HttpError(500, "Internal Server Error", "/events", "40P01");
  const all = () => true;

  test("which failures may be about what a post carried", () => {
    assert.equal(failureKind(e500), "content");
    assert.equal(failureKind(new HttpError(500, "x", "/e", "54000")), "content", "a value too large");
    for (const e of [plain500, new HttpError(500, "Internal Server Error", "/e"), new HttpError(500, "x", "/e", "XX000")]) {
      assert.equal(failureKind(e), "unknown", e.message);
      assert.equal(mayBeContent(e), true, "may split a batch");
    }
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

  test("a 500 that names no event splits a batch but never sets the event it narrows to aside, however often it comes", () => {
    const q = evs(4);
    const f = new PoisonFinder();
    for (let i = 0; i < ISOLATE_AFTER_FAILURES; i++) f.failed(f.plan(q, all), plain500);
    assert.equal(f.isolating, true, "split, which costs only smaller posts");
    let plan = f.plan(q, all);
    for (let i = 0; i < 5 && !plan.storable; i++) { f.failed(plan, plain500); plan = f.plan(q, all); }
    assert.deepEqual([plan.storable, plan.events.map((e) => e.seq)], [true, [1]]);
    for (let i = 0; i < 20; i++) assert.equal(f.failed(f.plan(q, all), plain500), "retry", "no probe, so never set aside");
    // A refusal the database names, then a plain 500, then one more: not two in a row.
    assert.equal(f.failed(f.plan(q, all), e500), "probe");
    assert.equal(f.probed(true), "retry");
    assert.equal(f.failed(f.plan(q, all), plain500), "retry");
    assert.equal(f.failed(f.plan(q, all), e500), "probe");
    assert.equal(f.probed(true), "retry", "the count started again");
    assert.equal(f.failed(f.plan(q, all), e500), "probe");
    assert.equal(f.probed(true), "set_aside");
  });

  // The sender's loop, run against a Claw that fails a share of posts with a 500 that names nothing, an empty post too.
  const simulate = (p: number, rnd: () => number, poison: Set<number>, n = 60) => {
    const queued = evs(n);
    const f = new PoisonFinder();
    const setAside: number[] = [];
    const delivered: number[] = [];
    const post = (pl: PoisonPlan): unknown => {
      if (rnd() < p) return plain500;
      if (pl.events.some((e) => poison.has(e.seq))) return e500;
      return null;
    };
    for (let steps = 0; queued.length > 0; steps++) {
      assert.ok(steps < 10_000, "the loop ends");
      const plan = f.plan(queued.slice(0, 20), (e) => queued.includes(e));
      const err = post(plan);
      if (!err) {
        f.taken(plan);
        for (const e of plan.events) { delivered.push(e.seq); queued.splice(queued.indexOf(queued.find((x) => x.seq === e.seq)!), 1); }
        continue;
      }
      let v = f.failed(plan, err);
      if (v === "probe") v = f.probed(rnd() >= p);
      if (v === "set_aside") { const ev = plan.events[0]!; f.setAside(); setAside.push(ev.seq); queued.splice(queued.findIndex((x) => x.seq === ev.seq), 1); }
    }
    return { setAside, delivered };
  };

  test("simulated: 500s that name nothing, at 20% and at 50% of posts, never cost an event; an event the database refuses still goes aside", () => {
    const rnd = seeded(42);
    for (const p of [0, 0.2, 0.5]) {
      for (let run = 0; run < 200; run++) {
        const { setAside, delivered } = simulate(p, rnd, new Set());
        assert.deepEqual(setAside, [], `p=${p} run ${run}: a fine event was set aside`);
        assert.deepEqual(delivered, Array.from({ length: 60 }, (_, i) => i + 1), "all of them, in order");
      }
      for (let run = 0; run < 50; run++) {
        const { setAside, delivered } = simulate(p, rnd, new Set([17, 41]));
        assert.deepEqual(setAside, [17, 41], `p=${p} run ${run}`);
        assert.deepEqual(delivered, Array.from({ length: 60 }, (_, i) => i + 1).filter((s) => s !== 17 && s !== 41));
      }
    }
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

/** A small deterministic random number generator (mulberry32), so a failing run is the same run again. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
