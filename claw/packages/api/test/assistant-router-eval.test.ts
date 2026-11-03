// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Router evaluation (`e2e/assistant-router-eval.ts`): that its set is sound, that the loop and the scoring do
 * what they claim, and, when a model is reachable, that the Router reaches the plan's dispatch gate.
 *
 * The first groups need nothing and run everywhere. The last one needs a real model and skips without one:
 *
 *   EVAL_BASE_URL=<gateway root> EVAL_MODEL=<the Router's model> EVAL_KEY_FILE=<path> \
 *     npx tsx --test test/assistant-router-eval.test.ts
 *
 *   R1  the set has at least 60 cases, unique ids, and at least 12 of each of the plan's five kinds
 *   R2  every decision the Router can make is labelled somewhere: create, send, stop, nothing, and a mix
 *   R3  every item a label names exists, and is open where the label sends to it or stops it
 *   R4  the Router is offered exactly the assistant's five tools, and sees the fixture's items in its prompt
 *   R5  the stand-in refuses what the real tools refuse: a long say, a send to a closed item, an unknown item
 *   R6  the loop follows the model's calls to the end, and a refused call changes nothing
 *   R7  scoring accepts the listed alternatives, forgives silence only where allowed, and checks item and language
 *   R8  with `strict` an item reference that is not the real id is refused; without it, "#3" means item 3 and is counted
 *   R9  against a real model the Router's dispatch decisions are at least 95% right, with items named as the real tools
 *       name them (EVAL_STRICT_IDS=0 scores the decisions apart from that); skips without a model
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createAssistantMcpServer } from "../src/assistant/mcp.js";
import { renderRouterSystem, SAY_MAX_CHARS } from "../src/assistant/prompts.js";
import { ASSISTANT_TOOLS_PATTERN } from "../src/assistant/role-profile.js";
import {
  CASES, FIXTURE, itemIdOf, NOTHING, type EvalCase,
} from "./e2e/assistant-router-eval-cases.js";
import {
  effectsOf, fixtureFor, gateReached, manifestOf, messagesLlm, numberFromEnv, pool, resolveItemRef, routerTools, runCase, sameEffects, scoreCase,
  summarize, userTurn, type Block, type Llm, type ModelResponse,
} from "./e2e/assistant-router-eval-lib.js";

const P = "mcp__assistant__";
const use = (name: string, input: Record<string, unknown>, id = `toolu_${Math.random().toString(36).slice(2)}`): Block =>
  ({ type: "tool_use", id, name: `${P}${name}`, input });
const text = (t: string): Block => ({ type: "text", text: t });
const reply = (...content: Block[]): ModelResponse => ({ content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" });

/** A model that answers from a script, one reply per call, and records what it was sent. */
function scripted(replies: ModelResponse[]): { llm: Llm; sent: Array<Parameters<Llm>[0]> } {
  const sent: Array<Parameters<Llm>[0]> = [];
  let i = 0;
  return {
    sent,
    llm: async (req) => {
      sent.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
      const r = replies[i++];
      if (!r) throw new Error("the script ran out of replies");
      return r;
    },
  };
}

const byId = (id: string): EvalCase => {
  const c = CASES.find((x) => x.id === id);
  assert.ok(c, `no case ${id}`);
  return c;
};

test("R1 the set has at least 60 cases, unique ids, and at least 12 of each of the plan's five kinds", () => {
  assert.ok(CASES.length >= 60, `${CASES.length} cases`);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, "ids are unique");
  const count = (kind: string) => CASES.filter((c) => c.kind === kind).length;
  for (const kind of ["new", "followup", "progress", "chat", "clarify"]) {
    assert.ok(count(kind) >= 12, `${kind}: ${count(kind)}`);
  }
  assert.ok(CASES.some((c) => c.lang === "zh") && CASES.some((c) => c.lang === "en"), "both languages");
  for (const c of CASES) assert.ok(c.text.trim().length > 0, c.id);
});

test("R2 every decision the Router can make is labelled somewhere", () => {
  const labels = CASES.flatMap((c) => [c.expect, ...(c.also ?? [])]);
  assert.ok(labels.some((e) => e.creates > 0 && !e.sends.length && !e.stops.length), "create");
  assert.ok(labels.some((e) => e.sends.length > 0 && !e.creates), "send");
  assert.ok(labels.some((e) => e.stops.length > 0 && !e.creates), "stop");
  assert.ok(labels.some((e) => sameEffects(e, NOTHING)), "nothing");
  assert.ok(labels.some((e) => e.creates > 0 && (e.sends.length || e.stops.length)), "a mix");
  assert.ok(CASES.some((c) => c.sayItem != null), "a report relayed with its item");
  assert.ok(CASES.some((c) => c.history?.length), "a case with earlier turns");
  assert.ok(CASES.some((c) => c.kind === "injection") && CASES.some((c) => c.kind === "event"), "untrusted text, a worker's report");
});

test("R3 every item a label names exists, and is open where the label sends to it or stops it", () => {
  for (const c of CASES) {
    const items = fixtureFor(c);
    const open = (seq: number) => items.find((i) => i.seq === seq && i.boardState !== "done");
    for (const e of [c.expect, ...(c.also ?? [])]) {
      for (const seq of [...e.sends, ...e.stops]) assert.ok(open(seq), `${c.id}: #${seq} is not an open item`);
    }
    if (c.sayItem != null) assert.ok(items.some((i) => i.seq === c.sayItem), `${c.id}: sayItem`);
    for (const p of c.patch ?? []) assert.ok(items.some((i) => i.seq === p.seq), `${c.id}: patch #${p.seq}`);
  }
  assert.equal(new Set(FIXTURE.map((i) => i.seq)).size, FIXTURE.length);
  assert.ok(FIXTURE.some((i) => i.boardState === "done") && FIXTURE.some((i) => i.boardState === "needs_you") && FIXTURE.some((i) => i.boardState === "in_progress"));
});

test("R4 the Router is offered exactly the assistant's five tools, and sees the fixture's items in its prompt", async () => {
  const tools = await routerTools();
  assert.deepEqual(tools.map((t) => t.name), ["say", "work_create", "work_recall", "work_send", "work_stop"].map((n) => `${P}${n}`));
  assert.ok(ASSISTANT_TOOLS_PATTERN.startsWith(P));
  for (const t of tools) assert.ok(t.description.length > 0 && (t.input_schema as { type?: string }).type === "object", t.name);
  // The worker's tool is not the router's.
  const worker = createAssistantMcpServer({ sid: "s", mid: "m", task_id: "t", exp: 4102444800, role: "worker", item_id: "i", gen: 1 });
  assert.ok(worker);
  const system = renderRouterSystem(manifestOf(FIXTURE));
  for (const i of FIXTURE) assert.ok(system.includes(`#${i.seq} [${i.boardState}]`), `#${i.seq} is in the prompt`);
  assert.ok(system.includes("work_create") && system.includes("[work_event]"));
  assert.ok(userTurn("hi").startsWith("hi\n\n"), "the user's words come first");
  assert.ok(userTurn("hi").includes("[Session Context]"));
});

test("R5 the stand-in refuses what the real tools refuse", async () => {
  const script = scripted([
    reply(
      use("say", { text: "x".repeat(SAY_MAX_CHARS + 1) }),
      use("work_send", { item_id: itemIdOf(5), text: "more" }),
      use("work_stop", { item_id: itemIdOf(9) }),
      use("work_send", { item_id: "kwi_nope", text: "more" }),
      use("work_recall", { item_id: itemIdOf(2), detail: "worker_tail" }),
      use("nonsense", {}),
    ),
    reply(),
  ]);
  const trace = await runCase(byId("chat-01"), { llm: script.llm, tools: await routerTools() });
  const got = trace.calls.map((c) => `${c.tool}:${c.refused ? (c.result as { error: string }).error : "ok"}`);
  assert.deepEqual(got, [
    "say:text_too_long", "work_send:item_closed", "work_stop:item_closed", "work_send:item_not_found", "work_recall:ok", "nonsense:unknown_tool",
  ]);
  assert.deepEqual(effectsOf(trace), NOTHING, "refused calls change nothing");
  assert.deepEqual(effectsOf(trace, { attempted: true }).sends, [5], "but are visible as what was attempted");
});

test("R6 the loop follows the model's calls to the end, and a repeated title is one item", async () => {
  const create = { title: "Archive logs", brief: "Archive the logs." };
  const script = scripted([
    reply(use("work_create", create, "a1"), use("work_create", create, "a2")),
    reply(use("say", { text: "已接手：#10。", item_id: itemIdOf(10) }, "b1")),
    reply(text("Told the user.")),
  ]);
  const trace = await runCase(byId("new-01"), { llm: script.llm, tools: await routerTools() });
  assert.equal(trace.turns, 3);
  assert.equal(trace.exhausted, false);
  assert.equal(trace.stray, "Told the user.", "text outside a tool is kept apart from what was said");
  assert.deepEqual(effectsOf(trace), { creates: 1, sends: [], stops: [] });
  assert.equal((trace.calls[0]?.result as { seq: number }).seq, 10, "numbering continues from the fixture");
  assert.equal((trace.calls[1]?.result as { deduplicated: boolean }).deduplicated, true);
  // An item made in this turn can be named by the id the call returned.
  assert.equal(trace.calls[2]?.refused, false);
  assert.deepEqual(trace.calls[2]?.ref, { seq: 10, exact: true });
  // The second call carries both results, in the order the calls were made.
  const results = script.sent[1]?.messages.at(-1)?.content as Array<{ tool_use_id: string }>;
  assert.deepEqual(results.map((r) => r.tool_use_id), ["a1", "a2"]);
  // Every call is made with the system prompt of the fixture, and the tools.
  assert.ok(script.sent.every((s) => s.system.includes("Work items") && s.tools.length === 5));
  const score = scoreCase(byId("new-01"), trace);
  assert.ok(score.dispatchOk && score.turnOk);
});

test("R6b a model that never stops calling tools is cut at the turn budget, and a failed model call is an error, not a pass", async () => {
  const forever = scripted(Array.from({ length: 20 }, () => reply(use("work_recall", { item_id: "1", detail: "summary" }))));
  const cut = await runCase(byId("pro-02"), { llm: forever.llm, tools: await routerTools(), maxTurns: 3 });
  assert.equal(cut.turns, 3);
  assert.equal(cut.exhausted, true);
  const dead = await runCase(byId("chat-01"), { llm: async () => { throw new Error("HTTP 503"); }, tools: await routerTools() });
  assert.equal(dead.error, "HTTP 503");
  const score = scoreCase(byId("chat-01"), dead);
  assert.equal(score.dispatchOk, false, "nothing was decided, so nothing was right");
  assert.equal(summarize([score]).errors, 1);
});

test("R7 scoring accepts the listed alternatives, forgives silence only where allowed, and checks item and language", async () => {
  const tools = await routerTools();
  const run = (c: EvalCase, ...calls: Block[]) => runCase(c, { llm: scripted([reply(...calls), reply()]).llm, tools });

  // dup-01: nothing, or a send to #1; a create is the one wrong answer.
  const dup = byId("dup-01");
  assert.ok(scoreCase(dup, await run(dup, use("say", { text: "That is already #1." }))).dispatchOk);
  assert.ok(scoreCase(dup, await run(dup, use("work_send", { item_id: "1", text: "hurry" }), use("say", { text: "Passed to #1." }))).dispatchOk);
  assert.equal(scoreCase(dup, await run(dup, use("work_create", { title: "Fix flaky", brief: "again" }), use("say", { text: "#10" }))).dispatchOk, false);

  // chat-02 may be answered with silence; chat-01 may not.
  assert.ok(scoreCase(byId("chat-02"), await run(byId("chat-02"))).turnOk);
  const silent = scoreCase(byId("chat-01"), await run(byId("chat-01")));
  assert.ok(silent.dispatchOk && !silent.spokeOk && !silent.turnOk, "no effect is right, but the user heard nothing");

  // evt-02: the reply must be about item 3.
  const evt = byId("evt-02");
  assert.equal(scoreCase(evt, await run(evt, use("say", { text: "#3 needs a choice." }))).sayItemOk, false);
  assert.ok(scoreCase(evt, await run(evt, use("say", { text: "#3 needs a choice.", item_id: "3" }))).sayItemOk);
  assert.equal(scoreCase(evt, await run(evt, use("say", { text: "#3 needs a choice.", item_id: "4" }))).sayItemOk, false);

  // Language: a Chinese message answered in English is a miss of the turn, not of the dispatch.
  const zh = byId("pro-01");
  const wrong = scoreCase(zh, await run(zh, use("say", { text: "Four items are running." })));
  assert.ok(wrong.dispatchOk && !wrong.langOk && !wrong.turnOk);
  assert.ok(scoreCase(zh, await run(zh, use("say", { text: "有 4 件在进行。" }))).turnOk);
  const en = byId("pro-02");
  assert.equal(scoreCase(en, await run(en, use("say", { text: "进行中。" }))).langOk, false);

  // Several effects are compared as sets.
  const mix = byId("mul-01");
  const both = await run(mix, use("work_stop", { item_id: "4", reason: "replaced" }), use("work_create", { title: "Q4 forecast", brief: "summarise" }), use("say", { text: "Done." }));
  assert.ok(scoreCase(mix, both).dispatchOk);
  const half = await run(mix, use("work_create", { title: "Q4 forecast", brief: "summarise" }), use("say", { text: "Done." }));
  assert.equal(scoreCase(mix, half).dispatchOk, false);

  // A reply written in the same step as a work call, before its result, is counted; one beside a refused call is told apart.
  const fol11 = byId("fol-11");
  const before = scoreCase(fol11, await run(fol11, use("work_send", { item_id: "5", text: "add" }), use("say", { text: "已转给 #5。", item_id: "5" })));
  assert.deepEqual([before.saidBeforeResult, before.saidBesideRefusal], [1, 1]);
  const after = scoreCase(dup, await runCase(dup, {
    llm: scripted([reply(use("work_send", { item_id: "1", text: "hurry" })), reply(use("say", { text: "Passed to #1." })), reply()]).llm, tools,
  }));
  assert.deepEqual([after.saidBeforeResult, after.saidBesideRefusal], [0, 0]);

  const sum = summarize([scoreCase(dup, await run(dup, use("say", { text: "x" }))), silent]);
  assert.deepEqual([sum.total, sum.dispatchOk, sum.turnOk], [2, 2, 1]);
  assert.deepEqual(sum.byKind.duplicate, { total: 1, dispatchOk: 1 });
});

test("R8 with strict an item reference that is not the real id is refused; without it, \"#3\" means item 3 and is counted", async () => {
  const items = FIXTURE.map((i) => ({ ...i }));
  assert.deepEqual(resolveItemRef(itemIdOf(3), items), { seq: 3, exact: true });
  for (const ref of ["3", "#3", " #3 ", "item 3", "Item #3"]) assert.deepEqual(resolveItemRef(ref, items), { seq: 3, exact: false }, ref);
  for (const ref of ["#99", "kwi_other", "three", "", undefined, 3]) assert.equal(resolveItemRef(ref, items).seq, null, String(ref));
  assert.equal(resolveItemRef("#3", items, true).seq, null);
  assert.equal(resolveItemRef(itemIdOf(3), items, true).seq, 3);

  const tools = await routerTools();
  const call = () => scripted([reply(use("work_send", { item_id: "#3", text: "weekly" }), use("say", { text: "Sent to #3.", item_id: "#3" })), reply()]).llm;
  const lenient = await runCase(byId("fol-04"), { llm: call(), tools });
  assert.deepEqual(effectsOf(lenient).sends, [3]);
  const s = scoreCase(byId("fol-04"), lenient);
  assert.ok(s.dispatchOk);
  assert.equal(s.inexactRefs, 2);
  const strict = await runCase(byId("fol-04"), { llm: call(), tools, strictIds: true });
  assert.deepEqual(effectsOf(strict).sends, [], "refused, so nothing was sent");
  assert.deepEqual(scoreCase(byId("fol-04"), strict).refusals, ["work_send:item_not_found", "say:item_not_found"]);
  assert.equal(scoreCase(byId("fol-04"), strict).inexactRefs, 2, "counted whether or not the call was refused");
  // With the real id from the conversation, strict passes.
  const exact = await runCase(byId("fol-16"), {
    llm: scripted([reply(use("work_send", { item_id: itemIdOf(8), text: "also hands" }), use("say", { text: "Added." })), reply()]).llm, tools, strictIds: true,
  });
  assert.deepEqual(effectsOf(exact).sends, [8]);
  // The earlier turns are in what the model is sent, with the id the earlier work_create returned.
  const sent = scripted([reply()]);
  await runCase(byId("fol-16"), { llm: sent.llm, tools });
  assert.ok(JSON.stringify(sent.sent[0]?.messages).includes(itemIdOf(8)));
  assert.equal(sent.sent[0]?.messages.at(-1)?.role, "user");
});

test("R8b the model call is the Messages request, retries only what may pass, and never puts the key anywhere else", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }> = [];
  const answers = [
    new Response("overloaded", { status: 529 }),
    new Response(JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" }), { status: 200 }),
  ];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return answers.shift() as Response;
  }) as typeof fetch;
  try {
    const llm = messagesLlm({ baseUrl: "https://gw.example/api/", model: "m-1", apiKey: () => "k-secret", timeoutMs: 5000 });
    const out = await llm({ system: "SYS", messages: [{ role: "user", content: "hi" }], tools: await routerTools() });
    assert.equal(out.stop_reason, "end_turn");
    assert.equal(seen.length, 2, "one retry after a 5xx");
    assert.equal(seen[0]?.url, "https://gw.example/api/v1/messages");
    assert.equal(seen[0]?.headers["x-api-key"], "k-secret");
    assert.equal(seen[0]?.body.model, "m-1");
    assert.deepEqual(seen[0]?.body.system, [{ type: "text", text: "SYS" }]);
    assert.equal(seen[0]?.body.tools.length, 5);
    assert.ok(!JSON.stringify(seen[0]?.body).includes("k-secret"));

    answers.push(new Response("bad request", { status: 400 }));
    seen.length = 0;
    await assert.rejects(llm({ system: "S", messages: [], tools: [] }), /HTTP 400/);
    assert.equal(seen.length, 1, "a 4xx is final");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("R8b2 a failure the gateway words with the key in it is kept without the key", async () => {
  const realFetch = globalThis.fetch;
  const calls: number[] = [];
  globalThis.fetch = (async () => {
    calls.push(1);
    if (calls.length === 1) return new Response("invalid x-api-key: k-secret-123", { status: 401 });
    throw new Error("connect failed for key k-secret-123");
  }) as typeof fetch;
  try {
    const llm = messagesLlm({ baseUrl: "https://gw.example", model: "m", apiKey: () => "k-secret-123", attempts: 1 });
    await assert.rejects(llm({ system: "S", messages: [], tools: [] }), (err: Error) => {
      assert.match(err.message, /HTTP 401: invalid x-api-key: <redacted>/);
      assert.ok(!err.message.includes("k-secret-123"));
      return true;
    });
    const second = messagesLlm({ baseUrl: "https://gw.example", model: "m", apiKey: () => "k-secret-123", attempts: 1 });
    await assert.rejects(second({ system: "S", messages: [], tools: [] }), (err: Error) => {
      assert.match(err.message, /connect failed for key <redacted>/);
      return true;
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("R8d a setting that is not a number in range is refused rather than read as NaN, and no runs is not a pass", () => {
  assert.equal(numberFromEnv(undefined, "EVAL_RUNS", 1, 1), 1);
  assert.equal(numberFromEnv("  ", "EVAL_RUNS", 1, 1), 1);
  assert.equal(numberFromEnv("3", "EVAL_RUNS", 1, 1), 3);
  assert.equal(numberFromEnv("0.9", "EVAL_GATE", 0.95, 0, 1), 0.9);
  for (const bad of ["abc", "NaN", "Infinity", "0", "-2"]) assert.throws(() => numberFromEnv(bad, "EVAL_RUNS", 1, 1), /EVAL_RUNS/, bad);
  assert.throws(() => numberFromEnv("5", "EVAL_CONCURRENCY", 2, 1, 4), /EVAL_CONCURRENCY/);
  assert.throws(() => numberFromEnv("1.5", "EVAL_GATE", 0.95, 0, 1), /EVAL_GATE/);

  assert.equal(gateReached([1, 0.96], 2, 0.95), true);
  assert.equal(gateReached([1, 0.94], 2, 0.95), false, "one run under the gate");
  assert.equal(gateReached([], 0, 0.95), false, "no runs");
  assert.equal(gateReached([], Number.NaN, 0.95), false, "a count that is not a number");
  assert.equal(gateReached([1], 3, 0.95), false, "fewer runs than were asked for");
});

test("R8c the pool keeps the order of the results and the bound on what is in flight", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await pool([5, 1, 4, 2, 3], 2, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, n));
    inFlight--;
    return n * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30]);
  assert.ok(peak <= 2);
});

const liveKey = process.env.EVAL_KEY ?? (process.env.EVAL_KEY_FILE ? "file" : "");
const liveSkip = process.env.EVAL_BASE_URL && process.env.EVAL_MODEL && liveKey
  ? false
  : "needs EVAL_BASE_URL, EVAL_MODEL and EVAL_KEY or EVAL_KEY_FILE: a real model";

test("R9 against a real model the Router's dispatch decisions are at least 95% right", { skip: liveSkip, timeout: 3_600_000 }, async () => {
  const key = () => process.env.EVAL_KEY?.trim() || readFileSync(process.env.EVAL_KEY_FILE as string, "utf8").trim();
  const llm = messagesLlm({ baseUrl: process.env.EVAL_BASE_URL as string, model: process.env.EVAL_MODEL as string, apiKey: key });
  const tools = await routerTools();
  const strictIds = process.env.EVAL_STRICT_IDS !== "0";
  const scores = await pool(CASES, 2, async (c) => scoreCase(c, await runCase(c, { llm, tools, strictIds })));
  const sum = summarize(scores);
  const misses = scores.filter((s) => !s.dispatchOk).map((s) => s.id);
  assert.ok(sum.dispatchOk / sum.total >= Number(process.env.EVAL_GATE || 0.95), `${sum.dispatchOk}/${sum.total}; missed: ${misses.join(", ")}`);
});
