// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The super-agent evaluation's loading, reading and grading, offline (`test/e2e/sa-eval-lib.ts`, `sa-eval-cases/`).
 *
 *   S1  route: answer, item, review, confirm; a refused work_create started nothing
 *   S2  the final answer is the last say about the case's item once it left "in progress"; without one, the last say of the
 *       case's own turns; a say of another turn is never the case's. Cards are what a channel would draw
 *   S3  internal text fails a case wherever it was shown; with no_ids a bare item number fails, "#12 title" does not
 *   S4  latency budgets: a missing reply fails, a late one fails, one on time passes; each turn is held to its own
 *   S5  route, tools (glob and alternatives), work_create on a read-only question, cards, items closed; baseline skips
 *       what it has not, and says so
 *   S6  facts: the value must be named (a number on its own), every value of a list; an oracle that read nothing fails; a
 *       claim with no value is skipped; an api oracle's value never appears in the result
 *   S7  cleanup, scrub, SSE frames across chunk boundaries, pick
 *   S8  loading: bad lines are reported, not run; selection by id/area/subdirectory, variants left out
 *   S9  the seed set: at least 20 cases, unique ids, the regression case as specified, every case fails an empty observation
 *   S10 pass@1 is a mean over cases, pass^k counts cases that passed every attempt
 *   S11 the identity gate: no acknowledgement, a wrong one, a denied identity or an enabled subscription refuses the run
 *   S13 content only a judge can grade is never a pass without a judge; a judge's FAIL fails it; recordings drop oracle values
 *   S12 the last turn: the items a turn started are read from its own calls' answers; a dry-run plan; recordings parse
 *   S14 a request an item holds for its person: the case says how to answer it; held, on time, answered, waited, and how the
 *       call ended are each graded, and a baseline skips them; read off the worker's events
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ToolCall } from "./e2e/agent-eval-lib.js";
import {
  apiQuery, caseSays, cardsOf, forRecording, heldCallRan, heldRequest, holdAnswers, identityRefusal, itemsStartedBy, needsJudge, parseRecordings, planOf, verdictOf, cleanupOf, finalSay, grade, loadCases, names, parseCases, passed, pick, routeOf, saysOf, scrub, select,
  sseFrames, toolPattern, totals, turnCalls, turnsOf, type CaseResult, type EvalCase, type ItemSeen, type LiveEvent, type Observed,
} from "./e2e/sa-eval-lib.js";

const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), "e2e", "sa-eval-cases");

const call = (name: string, ok: boolean | null = true): ToolCall => ({ id: name, name, input: {}, ok, result: "", at: 0 });
const item = (over: Partial<ItemSeen> = {}): ItemSeen => ({
  item_id: "i1", seq: 7, title: "t", kind: "task", board_state: "in_progress", can_accept: false, result_version: 0, outcome: null, ...over,
});
const say = (at: number, turn: string, text: string, extra: Record<string, unknown> = {}): LiveEvent => ({
  at, eventId: `s${at}`, data: { type: "AssistantSay", say_id: `s${at}`, turn_message_id: turn, text, ...extra },
});
const observed = (over: Partial<Observed> = {}): Observed => ({
  mode: "assistant", route: "answer", cards: "none", calls: [], shown: ["ok"], final: "ok", firstReplyMs: 1000, finalMs: 2000, replyMs: [1000],
  items: [], factValues: [], ...over,
});
const caseOf = (over: Partial<EvalCase> = {}): EvalCase => ({ id: "c", pipeline: "catalog", area: "x", lang: "zh", turns: [{ user: "q" }], ...over });
const failed = (c: EvalCase, o: Observed): string[] => grade(c, o).filter((x) => !x.pass).map((x) => x.name);

test("S1 route", () => {
  assert.equal(routeOf([], [call("mcp__assistant__say")], []), "answer");
  assert.equal(routeOf([], [call("mcp__assistant__work_create", false)], []), "answer");
  assert.equal(routeOf([item()], [], []), "item");
  assert.equal(routeOf([], [call("mcp__assistant__work_create")], []), "item");
  assert.equal(routeOf([item({ kind: "review" })], [call("mcp__assistant__work_create")], []), "review");
  assert.equal(routeOf([], [call("mcp__assistant__review_start")], []), "review");
  assert.equal(routeOf([], [], saysOf([say(1, "m1", "run it?", { confirm_action: { name: "github" } })])), "confirm");
});

test("S2 final answer, what was shown, cards", () => {
  const events: LiveEvent[] = [
    say(1, "m1", "on it"),
    say(2, "other", "someone else's item is ready", { item: { item_id: "x9", board_state: "needs_you", can_accept: true } }),
    say(3, "pending-1", "still working", { item: { item_id: "i1", board_state: "in_progress" } }),
    say(4, "pending-2", "here is the result", { item: { item_id: "i1", board_state: "needs_you", can_accept: true } }),
  ];
  const says = saysOf(events);
  assert.equal(finalSay(says, ["m1"], ["i1"])?.text, "here is the result");
  assert.equal(finalSay(says, ["m1"], [])?.text, "on it");
  assert.equal(finalSay(says, ["nope"], []), null);
  const mine = caseSays(says, ["m1"], ["i1"]);
  assert.deepEqual(mine.map((s) => s.at), [1, 3, 4]);
  assert.equal(cardsOf(mine), "accept");
  assert.equal(cardsOf(caseSays(says, ["m1"], [])), "none");
  const calls = turnCalls([
    { at: 1, eventId: "a", data: { type: "toolUsed", tool: "mcp__autopilot__get_status", status: "start", actionId: "t1", message_id: "m1" } },
    { at: 2, eventId: "b", data: { type: "toolUsed", tool: "mcp__autopilot__get_status", status: "success", actionId: "t1", message_id: "m1" } },
    { at: 3, eventId: "c", data: { type: "toolUsed", tool: "mcp__assistant__work_create", status: "start", actionId: "t2", message_id: "m2" } },
  ], ["m1"]);
  assert.deepEqual(calls.map((c) => [c.name, c.ok]), [["mcp__autopilot__get_status", true]]);
});

test("S3 internal text and naming", () => {
  const c = caseOf();
  for (const leak of ["I called mcp__autopilot__get_status", "work_create done", "[work_event] ready", "item_id 3f2a",
    "id 0b8f5c4e-1d2a-4c3b-9e8f-7a6b5c4d3e2f", "claw-pending-474"]) {
    assert.ok(failed(c, observed({ shown: ["fine", leak] })).some((n) => n.startsWith("no internal text")), leak);
  }
  const named = caseOf({ style: { no_ids: true } });
  assert.deepEqual(failed(named, observed({ shown: ["已接手，编号 #178"] })), ["items named by title"]);
  assert.deepEqual(failed(named, observed({ shown: ["好的，在做 #178。"] })), ["items named by title"]);
  assert.deepEqual(failed(named, observed({ shown: ["#12 修复登录超时 已完成"] })), []);
  assert.deepEqual(failed(c, observed({ shown: ["Autopilot 现在有 12 台节点。"] })), []);
});

test("S4 latency budgets", () => {
  const c = caseOf({ latency_budget_s: { first: 5, final: 10, each: 10 } });
  assert.deepEqual(failed(c, observed({ firstReplyMs: 3_000, finalMs: 9_000, replyMs: [3_000, 4_000] })), []);
  assert.deepEqual(failed(c, observed({ firstReplyMs: null, finalMs: null, replyMs: [null] })), ["first reply <= 5s", "final <= 10s", "each reply <= 10s"]);
  assert.deepEqual(failed(c, observed({ firstReplyMs: 5_001, finalMs: 10_001, replyMs: [1_000, 12_000] })), ["first reply <= 5s", "final <= 10s", "each reply <= 10s"]);
});

test("S5 route, tools, cards, items closed; baseline skips", () => {
  const c = caseOf({ route: "answer", tools_must: ["mcp__autopilot__get_*"], cards: "none" });
  assert.deepEqual(failed(c, observed({ calls: [call("mcp__autopilot__get_status")] })), []);
  assert.deepEqual(failed(c, observed({ route: "item", cards: "accept", calls: [call("mcp__assistant__work_create")] })),
    ["route=answer", "tool mcp__autopilot__get_*", "no tool mcp__assistant__work_create", "cards=none"]);
  assert.deepEqual(failed(c, observed({ calls: [call("mcp__autopilot__apply_pool_limits")] })), ["tool mcp__autopilot__get_*"]);
  assert.ok(toolPattern("bash|web_fetch").test("web_fetch"));
  assert.ok(!toolPattern("bash|web_fetch").test("bash_output"));
  assert.ok(!toolPattern("mcp__safe__workload_list").test("mcp__safe__workload_list_all"));
  const base = grade(c, observed({ mode: "baseline", route: undefined, cards: undefined, calls: [call("mcp__autopilot__get_status")] }));
  assert.equal(base.find((x) => x.name === "route=answer")?.skipped, true);
  assert.equal(base.find((x) => x.name === "cards=none")?.skipped, true);
  assert.ok(passed(base));
  const clarify = caseOf({ route: "clarify" });
  assert.deepEqual(failed(clarify, observed({ final: "哪个集群？" })), []);
  assert.deepEqual(failed(clarify, observed({ final: "好的" })), ["route=clarify"]);
  const stop = caseOf({ items_closed: true });
  assert.deepEqual(failed(stop, observed({ items: [] })), ["items closed"]);
  assert.deepEqual(failed(stop, observed({ items: [item({ board_state: "in_progress" })] })), ["items closed"]);
  assert.deepEqual(failed(stop, observed({ items: [item({ board_state: "done", outcome: "stopped" })] })), []);
  const zh = caseOf({ style: { reply_lang: "follow_user" } });
  assert.deepEqual(failed(zh, observed({ final: "There are 12 nodes." })), ["reply in zh"]);
  assert.deepEqual(failed(zh, observed({ final: "Autopilot 现在有 12 台节点。" })), []);
});

test("S6 facts", () => {
  const c = caseOf({ facts: [
    { claim: "sum", oracle: { kind: "static", value: "1060" } },
    { claim: "packages", oracle: { kind: "api", query: "/v1/x#data.*.name" } },
    { claim: "judge only" },
  ] });
  assert.ok(names("和是 1060。", "1060"));
  assert.ok(!names("和是 10600", "1060"));
  assert.ok(names("Brain and API", "api"));
  const ok = grade(c, observed({ final: "1060; api, brain", factValues: [["1060"], ["api", "brain"], null] }));
  assert.ok(passed(ok));
  assert.equal(ok.find((x) => x.name === "fact judge only")?.skipped, true);
  assert.equal(ok.find((x) => x.name === "fact packages")?.detail, "expected 2 oracle value(s)");   // never the value itself
  assert.deepEqual(failed(c, observed({ final: "1061; api", factValues: [["1060"], ["api", "brain"], null] })), ["fact sum", "fact packages"]);
  assert.deepEqual(failed(c, observed({ final: "1060", factValues: [["1060"], [], null] })), ["fact packages"]);
});

test("S7 cleanup, scrub, frames, pick", () => {
  assert.deepEqual(cleanupOf(item({ board_state: "needs_you", can_accept: true, result_version: 3 })), { op: "accept", version: 3 });
  assert.deepEqual(cleanupOf(item({ board_state: "needs_you" })), { op: "stop" });
  assert.deepEqual(cleanupOf(item({ board_state: "in_progress" })), { op: "stop" });
  assert.equal(cleanupOf(item({ board_state: "done" })), null);
  const key = "ak-" + "x".repeat(40);
  assert.equal(scrub(`bearer ${key} and ak-${"y".repeat(20)}`, [key]), "bearer <redacted> and <redacted>");
  const first = sseFrames("id: 1\nevent: AssistantSay\ndata: {\"a\":1}\n\nid: 2\nevent: Ass");
  assert.deepEqual(first.frames, [{ id: "1", event: "AssistantSay", data: "{\"a\":1}" }]);
  const second = sseFrames(first.rest + "istantSay\ndata: {}\n\n: keepalive\n\n");
  assert.deepEqual(second.frames, [{ id: "2", event: "AssistantSay", data: "{}" }]);
  assert.deepEqual(pick({ data: [{ name: "a" }, { name: "b" }] }, "data.*.name"), ["a", "b"]);
  assert.deepEqual(pick({ data: [1, 2, 3] }, "data.length"), ["3"]);
  assert.deepEqual(pick({ name: "n" }, "missing"), []);
  assert.deepEqual(apiQuery({ kind: "api", query: "/v1/me#name" }), { path: "/v1/me", at: "name" });
  assert.equal(apiQuery({ kind: "api", query: "claw_work_items of the eval user" }), null);   // a description: judge only
  assert.equal(apiQuery({ kind: "static", value: "1" }), null);
});

test("S8 loading and selection", () => {
  const got = parseCases([
    JSON.stringify(caseOf({ id: "a" })),
    "// a comment",
    "{not json",
    JSON.stringify(caseOf({ id: "b", turns: [{ user: "x" }, { user: "y" }] })),
    JSON.stringify(caseOf({ id: "c", route: "maybe" as never })),
  ].join("\n"), "f.jsonl");
  assert.deepEqual(got.cases.map((c) => c.id), ["a"]);
  assert.equal(got.bad.length, 3);
  const dir = mkdtempSync(join(tmpdir(), "sa-eval-"));
  mkdirSync(join(dir, "real"));
  mkdirSync(join(dir, "catalog"));
  writeFileSync(join(dir, "real", "r.jsonl"), JSON.stringify(caseOf({ id: "r1", pipeline: "real" })) + "\n");
  writeFileSync(join(dir, "catalog", "c.jsonl"), [caseOf({ id: "c1", area: "safe" }), caseOf({ id: "c2", variant_of: "c1" }), caseOf({ id: "r1" })].map((c) => JSON.stringify(c)).join("\n"));
  const all = loadCases(dir);
  assert.deepEqual(all.bad, ["duplicate id r1"]);
  assert.deepEqual(select(all.cases, new Set(), new Set(["catalog"]), false).map((c) => c.id), ["c1", "r1"]);
  assert.deepEqual(select(all.cases, new Set(["safe"]), new Set(), true).map((c) => c.id), ["c1"]);
  assert.deepEqual(turnsOf(caseOf({ needs: "EVAL_OTHER_PERSON", turns: [{ user: "for {EVAL_OTHER_PERSON}" }] }), {}), null);
  assert.deepEqual(turnsOf(caseOf({ needs: "EVAL_OTHER_PERSON", turns: [{ user: "for {EVAL_OTHER_PERSON}" }] }), { EVAL_OTHER_PERSON: "Ana" }), [{ user: "for Ana" }]);
});

test("S9 the seed set", () => {
  const { cases, bad } = loadCases(SEED_DIR);
  assert.deepEqual(bad, []);
  assert.ok(cases.length >= 20, `${cases.length} cases`);
  const reg = cases.find((c) => c.turns[0]?.user === "autopilot现在有几台节点");
  assert.ok(reg, "the regression case is in the set");
  assert.equal(reg!.route, "answer");
  assert.ok(reg!.tools_must?.some((p) => toolPattern(p).test("mcp__autopilot__get_status")));
  assert.equal(reg!.latency_budget_s?.final, 10);
  assert.equal(reg!.style?.no_ids, true);
  for (const area of ["autopilot", "dispatron", "pulse", "safe", "agent-board", "github", "review", "general"]) assert.ok(cases.some((c) => c.area === area), area);
  assert.ok(cases.some((c) => c.route === "item") && cases.some((c) => c.turns.length > 1));
  for (const c of cases) if (c.route === "answer") assert.ok(c.tools_must_not?.includes("mcp__assistant__work_create") || c.area === "chitchat", c.id);
  // An observation with nothing in it passes no case.
  const empty = observed({ route: undefined, cards: undefined, calls: [], shown: [], final: "", firstReplyMs: null, finalMs: null, replyMs: [], items: [], factValues: [] });
  for (const c of cases) assert.equal(passed(grade(c, empty)), false, c.id);
});

test("S10 pass@1 and pass^k", () => {
  const attempt = (pass: boolean, ms = 1000) => ({ pass, checks: [], tools: [], final: null, finalChars: 0, firstReplyMs: ms, finalMs: ms * 2, items: [] });
  const r = (id: string, attempts: ReturnType<typeof attempt>[], over: Partial<CaseResult> = {}): CaseResult => ({ id, area: "k", pipeline: "catalog", mode: "assistant", hash: "h", attempts, ...over });
  const t = totals([r("a", [attempt(true), attempt(true), attempt(true)]), r("b", [attempt(true), attempt(false), attempt(false)]), r("s", [], { skipped: "x" })]);
  assert.equal(t.all!.cases, 2);
  assert.equal(t.all!.passAllK, 1);
  assert.ok(Math.abs(t.all!.passAt1 - (1 + 1 / 3) / 2) < 1e-9);
  assert.equal(t.all!.finalP50Ms, 2000);
});

test("S11 the identity gate", () => {
  const me = { name: "Eval Bot", email: "eval-bot@example.com" };
  const ack = { EVAL_IDENTITY_ACK: "test:eval-bot@example.com" };
  assert.equal(identityRefusal(me, [], ack), null);
  assert.equal(identityRefusal(me, [], { EVAL_IDENTITY_ACK: "test:Eval Bot" }), null);
  assert.match(identityRefusal(me, [], {})!, /EVAL_IDENTITY_ACK/);
  assert.match(identityRefusal(me, [], { EVAL_IDENTITY_ACK: "eval-bot@example.com" })!, /EVAL_IDENTITY_ACK/);   // not marked test:
  assert.match(identityRefusal(me, [], { EVAL_IDENTITY_ACK: "test:someone@example.com" })!, /EVAL_IDENTITY_ACK/);   // another identity
  assert.match(identityRefusal(me, [], { ...ack, EVAL_IDENTITY_DENY: "a@example.com, EVAL-BOT@example.com" })!, /DENY/);
  assert.match(identityRefusal(me, [{ enabled: true, event_types: ["run.completed"] }], ack)!, /subscription/);
  assert.match(identityRefusal(me, [{ event_types: [] }], ack)!, /subscription/);   // enabled unless it says it is not
  assert.equal(identityRefusal(me, [{ enabled: false }], ack), null);
  assert.equal(identityRefusal(me, [{ enabled: true }], { ...ack, EVAL_ALLOW_SUBSCRIBED: "1" }), null);
  assert.match(identityRefusal({}, [], ack)!, /names nobody/);
});

test("S12 last turn, plan, recordings", () => {
  const created = { ...call("mcp__assistant__work_create"), result: JSON.stringify({ ok: true, item_id: "i2", seq: 8, deduplicated: false }) };
  const refused = { ...call("mcp__assistant__work_create", false), result: JSON.stringify({ item_id: "i1" }) };
  const items = [item({ item_id: "i1", seq: 7 }), item({ item_id: "i2", seq: 8 }), item({ item_id: "i3", seq: 9 })];
  assert.deepEqual(itemsStartedBy([created, refused, call("mcp__assistant__say")], items).map((i) => i.seq), [8]);
  assert.deepEqual(itemsStartedBy([{ ...call("mcp__assistant__work_send"), result: "{\"item_id\":\"i3\"}" }], items), []);   // sent to, not started
  const plan = planOf([caseOf({ id: "a", route: "answer", facts: [{ claim: "n", oracle: { kind: "api", query: "/v1/me#name" } }, { claim: "j" }] }),
    caseOf({ id: "b", modes: ["assistant"] })], "baseline", {});
  assert.match(plan[0]!, /^a {2}1 turn\(s\) {2}route=answer .*facts=api,judge/);
  assert.match(plan[1]!, /skip \(assistant only\)/);
  const rec = { case_id: "a", mode: "assistant", attempt: 1, at: "t", observed: observed() };
  assert.deepEqual(parseRecordings(`${JSON.stringify(rec)}\n\n${JSON.stringify({ case_id: "x" })}\n`).map((r) => r.case_id), ["a"]);
});

test("S13 judge-only content and recordings", () => {
  const judged = caseOf({ facts: [{ claim: "the node count" }] });
  const plain = caseOf({ facts: [{ claim: "sum", oracle: { kind: "static", value: "1060" } }] });
  assert.equal(needsJudge(judged), true);
  assert.equal(needsJudge(plain), false);
  assert.equal(needsJudge(caseOf({ rubric: "r" })), true);
  const ok = grade(judged, observed({ factValues: [null] }));
  assert.ok(passed(ok));
  assert.deepEqual(verdictOf(judged, ok, null), { pass: false, unjudged: true });
  assert.deepEqual(verdictOf(judged, ok, { pass: false }), { pass: false });
  assert.deepEqual(verdictOf(judged, ok, { pass: true }), { pass: true });
  assert.deepEqual(verdictOf(plain, grade(plain, observed({ final: "1060", factValues: [["1060"]] })), null), { pass: true });
  const withOracle = caseOf({ facts: [{ claim: "n", oracle: { kind: "api", query: "/v1/me#name" } }, { claim: "s", oracle: { kind: "static", value: "1" } }] });
  assert.deepEqual(forRecording(withOracle, observed({ factValues: [["Secret Name"], ["1"]] })).factValues, [null, ["1"]]);
  // Offline, that oracle was not read: the fact is unverified and the attempt is not a pass, however right the rest is.
  const offline = grade(withOracle, observed({ final: "1", factValues: [null, ["1"]] }));
  assert.equal(offline.find((x) => x.name === "fact n")?.unverified, true);
  assert.deepEqual(verdictOf(withOracle, offline, null), { pass: false, unjudged: true });
  const r: CaseResult = { id: "a", area: "k", pipeline: "catalog", mode: "assistant", hash: "h",
    attempts: [{ pass: false, unjudged: true, checks: [], tools: [], final: null, finalChars: 0, firstReplyMs: 1, finalMs: 2, items: [] }] };
  assert.equal(totals([r]).all!.unjudged, 1);
  assert.equal(totals([r]).all!.passAllK, 0);
});

test("S14 a request an item holds for its person", () => {
  const bad = (hold: unknown) => parseCases(JSON.stringify({ id: "h", turns: [{ user: "q" }], hold }), "f").bad;
  assert.deepEqual(bad({ tool: "mcp__safe__workload_stop", decide: "allow" }), []);
  assert.match(bad({ decide: "allow" })[0]!, /hold without a tool/);
  assert.match(bad({ tool: "t", decide: "maybe" })[0]!, /hold decide maybe/);
  assert.match(bad({ tool: "ask_user_question", decide: "answer" })[0]!, /hold answer without answers/);
  assert.match(bad({ tool: "t", decide: "deny", wait_s: 9000 })[0]!, /hold wait_s 9000/);

  const allow = caseOf({ hold: { tool: "mcp__safe__workload_*", decide: "allow", wait_s: 1800 } });
  const good = { tool: "mcp__safe__workload_stop", cardMs: 1200, answered: 200, heldAfterWait: true, ran: true };
  assert.deepEqual(failed(allow, observed({ hold: good })), []);
  assert.deepEqual(failed(allow, observed({})), [
    "held mcp__safe__workload_*", "held within 5s", "answer taken", "still held after 1800s", "held call ran",
  ], "a case whose item never held anything fails every hold check");
  assert.deepEqual(failed(allow, observed({ hold: { ...good, cardMs: 9000, heldAfterWait: false, ran: null } })),
    ["held within 5s", "still held after 1800s", "held call ran"]);
  assert.deepEqual(failed(allow, observed({ hold: { ...good, tool: "mcp__dispatron__post_runs" } })), ["held mcp__safe__workload_*"]);
  const deny = caseOf({ hold: { tool: "mcp__agent-board__issue_write", decide: "deny" } });
  assert.deepEqual(failed(deny, observed({ hold: { ...good, tool: "mcp__agent-board__issue_write", heldAfterWait: null, ran: false } })), []);
  assert.deepEqual(failed(deny, observed({ hold: { ...good, tool: "mcp__agent-board__issue_write", ran: true } })), ["held call did not run"]);
  const base = grade(deny, observed({ mode: "baseline", route: undefined, cards: undefined }));
  assert.ok(base.filter((x) => x.name.startsWith("held")).every((x) => x.skipped), "a plain session has no item to hold");

  const rows = [
    { event_type: "permissionRequest", created_at: "", data: { type: "permissionRequest", tool_use_id: "tu-1", tool: "mcp__safe__workload_stop", ts: 1000 } },
    { event_type: "userQuestion", created_at: "", data: { type: "userQuestion", actionId: "tu-q", ts: 2000, questions: [{ id: "q1", options: [{ id: "a", label: "mi355x" }] }, { id: "q2", options: [] }] } },
  ];
  assert.deepEqual(heldRequest(rows, "tu-1"), { ts: 1000, tool: "mcp__safe__workload_stop", questions: null });
  assert.equal(heldRequest(rows, "tu-q")?.tool, "ask_user_question");
  assert.equal(heldRequest(rows, "tu-x"), null);
  assert.equal(heldCallRan(rows, "tu-1"), null, "nothing has happened yet");
  const allowed = [...rows, { event_type: "toolUsed", created_at: "", data: { type: "toolUsed", actionId: "tu-1", status: "start" } },
    { event_type: "toolUsed", created_at: "", data: { type: "toolUsed", actionId: "tu-1", status: "success" } }];
  assert.equal(heldCallRan(allowed, "tu-1"), true);
  const denied = [...rows, { event_type: "decisionResult", created_at: "", data: { type: "decisionResult", tool_use_id: "tu-1", decision: "deny" } },
    { event_type: "toolUsed", created_at: "", data: { type: "toolUsed", actionId: "tu-1", status: "error" } }];
  assert.equal(heldCallRan(denied, "tu-1"), false);
  assert.deepEqual(holdAnswers({ tool: "ask_user_question", decide: "answer", answers: { "*": "" } }, heldRequest(rows, "tu-q")?.questions), { q1: "mi355x" });
  assert.deepEqual(holdAnswers({ tool: "ask_user_question", decide: "answer", answers: { q1: "mi300x" } }, null), { q1: "mi300x" });
});
