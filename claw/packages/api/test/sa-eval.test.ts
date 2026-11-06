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
 *   S22 a request an item holds for its person: the case says how to answer it; held, on time, answered, waited, and how the
 *       call ended are each graded, and a baseline skips them; read off the worker's events
 *   S14 placeholders: `{NAME}` and `{{a.b}}`, several in one case, filled in turns, claims, values, oracle queries and the rubric;
 *       a case with one unfilled is skipped and names every one missing
 *   S15 oracles: Claw API, GitHub and MCP reads are runnable (an MCP one only for a router read); a description is graded by the
 *       judge, which is shown it, so a case with no rubric is no longer unjudged for good
 *   S16 no false denial: the assistant saying it cannot reach something, with no failed call, fails any case; after a failed
 *       call, in a case that may refuse, or said of a system rather than of itself, it does not
 *   S17 the static check: a tools_must no tool of the arm matches is reported (the router without GitHub: "my open PRs"),
 *       unless blocked; an assistant-only case that runs in baseline; a description written as a value; the seed set is clean
 *   S18 a turn ends on a stream with its main agent's executionStats or failed status (the stream never carries exec_complete),
 *       in stored events with its exec_complete; what a plain session showed is its main agent's messages
 *   S19 the say cap: the wait before a case keeps the hour's counted says and the reserve within the budget; fallbacks are not
 *       counted; says from the stream, the stored events and an earlier run's log are counted once each; a say refused for the
 *       cap is counted
 *   S21 the stream showed everything a case is graded on: every stored event of its turns and of what was said about its items,
 *       a turn's exec_complete aside; stored events that could not be read are a gap
 *   S20 sharing an identity: a running or recently active assistant session refuses the run; a session is deleted only when a GET
 *       then answers 404, a refusal ends the attempt
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ToolCall } from "./e2e/agent-eval-lib.js";
import * as readTools from "../src/assistant/read-tools.js";
import {
  BUILTIN_TOOLS, CAPABILITY_DENIAL, SELF_INABILITY, fill, oracleMcpTarget, filledCase, judgeFacts, judgePrompt, missingVars, oracleMayRun, oracleQuery, placeholdersOf, reachable, staticFindings,
  type Arms,
  apiQuery, caseSays, cardsOf, forRecording, heldCallRan, heldRequest, holdAnswers, identityRefusal, itemsStartedBy, needsJudge, parseRecordings, planOf, verdictOf, cleanupOf, finalSay, grade, loadCases, names, parseCases, passed, pick, routeOf, saysOf, scrub, select,
  sseFrames, toolPattern, totals, turnCalls, turnsOf, type CaseResult, type EvalCase, type ItemSeen, type LiveEvent, type Observed,
  assistantInUse, capRefusedSays, countedSays, judgeVerdict, countedSaysOf, deleteSessionConfirmed, endedTurns, mergeSays, messagesOf, parseSayLog, sayWaitMs, storedTurnEnds, streamMissed, turnEnded,
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
  assert.equal(routeOf([], [], saysOf([say(1, "m1", "create it?", { confirm_write: { confirmation_id: "c1", kind: "trigger_create" } })])), "confirm");
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
  // work_create found an open item with the same title: it was there before, and is the run's only if the run already knew it.
  const dedup = { ...call("mcp__assistant__work_create"), result: "{\"ok\":true,\"item_id\":\"i2\",\"seq\":8,\"deduplicated\":true}" };
  assert.deepEqual(itemsStartedBy([dedup], items), [], "another's item is not the run's");
  assert.deepEqual(itemsStartedBy([dedup], items, new Set(["i2"])).map((i) => i.seq), [8], "the run's own, found again");
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
  // Where a judge is configured it grades every case: its FAIL (the no-false-denial rule) fails one with nothing else for it.
  assert.deepEqual(verdictOf(plain, grade(plain, observed({ final: "1060", factValues: [["1060"]] })), { pass: false }), { pass: false });
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

test("S22 a request an item holds for its person", () => {
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

test("S14 placeholders, several to a case", () => {
  const vars = { repo: "o/r", "user.gh": "octo", EVAL_GH_LOGIN: "octo", EVAL_VAR_PR_A: "12" };
  assert.deepEqual(placeholdersOf("{{repo}} {{ user.gh }} {EVAL_GH_LOGIN} {notone} {{repo}}"), ["repo", "user.gh", "EVAL_GH_LOGIN"]);
  assert.equal(fill("{{repo}}#{{pr_a}} by {{user.gh}} / {EVAL_GH_LOGIN} / {{missing}}", vars), "o/r#12 by octo / octo / {{missing}}");
  const c = caseOf({
    turns: [{ user: "看一下 {{repo}} 我还有哪些没合的 PR" }], rubric: "lists {{user.gh}}'s PRs",
    facts: [{ claim: "PRs of {{user.gh}}", oracle: { kind: "api", query: "gh:/search/issues?q=is:pr+author:{{user.gh}}+repo:{{repo}}#items.*.number" } },
      { claim: "the PR", oracle: { kind: "static", value: "{{pr_a}}" } }],
  });
  assert.deepEqual(missingVars(c, {}), ["pr_a", "repo", "user.gh"], "every missing one, not the first");
  assert.equal(filledCase(c, {}), null);
  assert.equal(turnsOf(c, { repo: "o/r" }), null);
  const f = filledCase(c, vars)!;
  assert.equal(f.turns[0]!.user, "看一下 o/r 我还有哪些没合的 PR");
  assert.equal(f.rubric, "lists octo's PRs");
  assert.equal(f.facts![0]!.oracle!.query, "gh:/search/issues?q=is:pr+author:octo+repo:o/r#items.*.number");
  assert.equal(f.facts![1]!.oracle!.value, "12", "EVAL_VAR_<NAME> fills {{name}}");
  // `needs`: one or several, environment or run variables.
  assert.deepEqual(missingVars(caseOf({ needs: ["EVAL_X", "repo"] }), { repo: "a" }), ["EVAL_X"]);
  assert.deepEqual(missingVars(caseOf({ needs: "EVAL_X" }), { EVAL_X: "1" }), []);
  assert.match(planOf([c], "assistant", {})[0]!, /skip \(needs pr_a, repo, user\.gh\)/);
  assert.match(planOf([c], "assistant", vars)[0]!, /facts=github,value/);
});

test("S15 runnable oracles, and what the judge is shown", () => {
  assert.deepEqual(oracleQuery({ kind: "api", query: "/v1/me#name" }), { via: "claw", path: "/v1/me", at: "name" });
  assert.deepEqual(oracleQuery({ kind: "api", query: "gh:/search/issues?q=is:pr+is:open#total_count" }), { via: "github", path: "/search/issues?q=is:pr+is:open", at: "total_count" });
  assert.deepEqual(oracleQuery({ kind: "api", query: "mcp:safe/node_get?name=n1&limit=3&ready=true#phase" }),
    { via: "mcp", server: "safe", tool: "node_get", args: { name: "n1", limit: 3, ready: true }, at: "phase" });
  assert.deepEqual(oracleQuery({ kind: "api", query: "mcp:safe/opsjob_list#0.phase" }), { via: "mcp", server: "safe", tool: "opsjob_list", args: {}, at: "0.phase" });
  assert.equal(oracleQuery({ kind: "api", query: "gh:/search/issues?q=author:{{user.gh}}#total_count" }), null, "an unfilled placeholder is not run");
  assert.equal(oracleQuery({ kind: "api", query: "github search is:pr is:open author:me -> numbers" }), null);
  assert.equal(oracleQuery({ kind: "static", value: "1" }), null);
  // An MCP oracle runs only a tool the router may read.
  const reads = ["mcp__safe__node_get", "mcp__autopilot__get_*"];
  assert.ok(oracleMayRun(oracleQuery({ kind: "api", query: "mcp:safe/node_get?name=n#x" })!, reads));
  assert.ok(oracleMayRun(oracleQuery({ kind: "api", query: "mcp:autopilot/get_status#x" })!, reads));
  assert.ok(!oracleMayRun(oracleQuery({ kind: "api", query: "mcp:safe/workload_delete?id=w#x" })!, reads));
  assert.ok(oracleMayRun(oracleQuery({ kind: "api", query: "/v1/me#x" })!, []));
  // Where an MCP oracle may send the key: https on an allowed host, and only into Brain's placeholder.
  const hosts = ["claw.example"];
  const ok = oracleMcpTarget({ url: "https://claw.example/safe/mcp", token: "<SAFE_API_KEY>", headers: { "X-Via": "eval", "X-Key": "<SAFE_API_KEY>" } }, hosts, "ak-1");
  assert.ok(typeof ok !== "string");
  assert.deepEqual(ok.headers, { "X-Via": "eval", "X-Key": "ak-1", authorization: "Bearer ak-1" });
  assert.deepEqual((oracleMcpTarget({ url: "https://claw.example/x" }, hosts, "ak-1") as { headers: object }).headers, {}, "no token: no key");
  for (const url of ["https://evil.example/mcp", "http://claw.example/mcp", "https://claw.example.evil.example/mcp", "not a url", ""]) {
    assert.equal(typeof oracleMcpTarget({ url, token: "<SAFE_API_KEY>" }, hosts, "ak-1"), "string", url);
  }
  // A described read is the judge's: it is shown the claim and the description. Before, such a fact without a rubric was never judged.
  const described = caseOf({ facts: [{ claim: "covers every open PR", oracle: { kind: "api", query: "github search is:pr is:open author:me -> numbers" } }] });
  assert.equal(needsJudge(described), true);
  assert.deepEqual(judgeFacts(described), ["covers every open PR (checked against: github search is:pr is:open author:me -> numbers)"]);
  const prompt = judgePrompt(described, [{ user: "我有几个开着的 PR" }], "3 个");
  assert.match(prompt, /The reply must state: covers every open PR \(checked against: github search/);
  assert.match(prompt, /Always: The reply must not say that it cannot reach or do something/);
  assert.doesNotMatch(judgePrompt(caseOf({ may_deny: true, rubric: "refuses" }), [{ user: "rm -rf /" }], "no"), /Always:/);
  // The judge is given what the rule needs: the tools the case expects and every call of the turn with whether it failed.
  const withCalls = judgePrompt(caseOf({ tools_must: ["mcp__github__issue_search"] }), [{ user: "我有几个开着的 PR" }], "我读不了 GitHub",
    [{ ...call("mcp__github__issue_search", false), result: "secret-ish output" }, call("web_search")]);
  assert.match(withCalls, /Tools it has for this request: mcp__github__issue_search\n/);
  assert.match(withCalls, /Tool calls it made in this turn: mcp__github__issue_search \(failed\), web_search \(ok\)\n/);
  assert.doesNotMatch(withCalls, /secret-ish/, "no tool output");
  assert.equal(needsJudge(caseOf({ facts: [{ claim: "n", oracle: { kind: "api", query: "gh:/x#y" } }] })), false, "a runnable oracle needs no judge");
  // Offline, a GitHub or MCP oracle was not read either: unverified, never a pass.
  const gh = caseOf({ facts: [{ claim: "n", oracle: { kind: "api", query: "gh:/x#y" } }] });
  assert.deepEqual(verdictOf(gh, grade(gh, observed({ factValues: [null] })), null), { pass: false, unjudged: true });
  assert.deepEqual(forRecording(gh, observed({ factValues: [["42"]] })).factValues, [null], "an oracle's value is not recorded");
});

test("S16 no false denial of a capability", () => {
  const c = caseOf({ route: "answer" });
  const denied = (final: string, calls: ToolCall[] = [], over: Partial<EvalCase> = {}) =>
    grade(caseOf({ ...c, ...over }), observed({ final, calls })).find((x) => x.name === "no false denial")?.unverified === true;
  // The words of the first form are what a check names; "not connected" carries no verb, so it is reported by its own words.
  assert.ok(denied("I'm not connected to GitHub, so I can't pull the open PRs.", [call("mcp__github__issue_search")]),
    "a GitHub call that succeeded does not excuse it");
  for (const text of ["我读不了 GitHub，没法看你的 PR。", "抱歉，我无法访问 GitHub。", "我这边没有 GitHub 的工具。", "我目前不能联网。", "我没有权限查看这个 workspace",
    "我看不到你的 GitHub 仓库。", "I can't access GitHub from here.", "I don't have access to the internet.", "I'm unable to browse the web.",
    "I have no tools for that.", "I can't view GitHub from here.", "I cannot see your pull requests.", "I'm not able to view the web.",
    "I cannot view the latest pull requests on GitHub.", "I'm not connected to GitHub, so I can't pull the open PRs.",
    "I'm unable to retrieve your pull requests from GitHub.", "I don't have a connection to SaFE.", "我连不上 GitHub，没法拉取 PR。",
    "I have no way to reach the web from here.", "I do not currently have access to GitHub.", "I'm not currently connected to SaFE.",
    "I can't check GitHub for you right now.", "我无法查看你的 GitHub PR。"]) {
    assert.ok(denied(text), text);
    assert.ok(CAPABILITY_DENIAL.test(text) || SELF_INABILITY.test(text), text);
  }
  // Said after a call to what it denies failed, it may be true; in a case where refusing is right, it is not this failure.
  assert.ok(!denied("我无法访问 GitHub：令牌被拒绝了。", [call("mcp__github__issue_search", false)]));
  assert.ok(!denied("I can't access the web right now.", [call("web_fetch", false)]));
  assert.ok(!denied("我无法访问它，请稍后再试。", [call("mcp__safe__node_list", false)]), "names nothing: any failed call may be the one");
  // A failure of one system never excuses denying another.
  assert.ok(denied("我读到了 SaFE 的数据，但我无法访问 GitHub。", [call("mcp__safe__workload_list"), call("mcp__dispatron__get_runs", false)]));
  assert.ok(denied("我无法访问 SaFE。", [call("mcp__safe__workload_list"), call("mcp__dispatron__get_runs", false)]));
  assert.ok(!denied("Dispatron 有 3 个运行。我无法访问 SaFE。", [call("mcp__safe__workload_list", false)]), "the sentence of the denial, not the first one");
  assert.ok(denied("我无法访问 SaFE。Dispatron 那边也有问题。", [call("mcp__dispatron__get_runs", false)]));
  assert.ok(!denied("我不能读取 ~/.ssh 下的文件。", [], { may_deny: true }));
  // A fact about a system, or "found nothing", is not a denial.
  for (const text of ["node-7 无法访问，已经离线 2 小时。", "没有找到失败的运行。", "我查到 3 个开着的 PR。", "I don't see any failed runs today.", "The node cannot reach the registry.",
    "I can't see any failed runs today.", "我看不到失败的运行。", "I can't see any failures on the dashboard.",
    "I can't find any open PRs of yours on GitHub.", "我无法确定 SaFE 上这个节点何时恢复。", "I can't tell why the run failed; its log ends early.",
    "I can't delete that workload on SaFE without your approval.", "我不能直接删除 SaFE 上的 workload，需要你确认。",
    "GitHub returned 20 results; I can't rule out additional open PRs beyond this page.", "I can't be sure every SaFE node reported in time.",
    "GitHub returned 20 results; I'm unable to verify whether there are additional open PRs beyond this page.",
    "I am not able to determine from the SaFE events why the pod restarted.",
    "GitHub returned 20 results; I can't check whether there are additional open PRs beyond this page.",
    "I cannot check if more PRs exist on GitHub past the first page.", "GitHub 返回了 20 条；我无法查看是否还有更多 PR。",
    "I cannot check GitHub to see if more PRs exist.", "我无法查看 GitHub 是否还有更多 PR。"]) {
    assert.ok(!denied(text), text);
  }
  // A failed shell command excuses a GitHub denial only when it failed at GitHub: a line of its answer is a failure that names
  // GitHub, whatever program reached it.
  const bash = (command: string, answer = ""): ToolCall => ({ ...call("bash", false), input: { command }, result: answer });
  const excused: Array<[string, string]> = [
    ["gh pr list --author @me", "HTTP 401: Bad credentials (https://api.github.com/graphql)"],
    ["GH_TOKEN=x /usr/bin/gh api user", "gh: Bad credentials (HTTP 401)"],
    ["cd repo && git fetch origin", "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com"],
    ["git remote show origin", "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403"],
    ["git --git-dir /repo/.git fetch", "remote: Repository not found.\nfatal: repository 'https://github.com/o/r/' not found"],
    ["curl -s https://api.github.com/repos/o/r", '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest"}'],
    ["python3 list_prs.py", 'requests.exceptions.HTTPError: 401 Client Error: Unauthorized for url: https://api.github.com/search/issues'],
    ["node prs.mjs", 'Error: GitHub answered 403 for https://api.github.com/repos/o/r/pulls'],
  ];
  for (const [cmd, answer] of excused) assert.ok(!denied("I can't access GitHub.", [bash(cmd, answer)]), cmd);
  const notGithub: Array<[string, string]> = [
    ["python missing.py", "python: can't open file 'missing.py'"],
    // A GitHub URL a local command printed, beside another command's failure.
    ["git remote -v && cat README-missing", "origin\thttps://github.com/o/r.git (fetch)\norigin\thttps://github.com/o/r.git (push)\ncat: README-missing: No such file or directory"],
    ["gh --version; false", "gh version 2.97.0 (2026-10-01)\nhttps://github.com/cli/cli/releases/tag/v2.97.0"],
    // A GitHub URL on one line and another command's error on the next are not one failure at GitHub.
    ["git remote -v && make build", "origin\thttps://github.com/o/r.git (fetch)\nmake: *** [Makefile:3: build] Error 1"],
    ["echo git status; false", "git status"],
    ["git status", "fatal: not a git repository (or any of the parent directories): .git"],
    ["cd /tmp && git status && git push origin HEAD", "fatal: not a git repository (or any of the parent directories): .git"],
    ["echo see github.com; false", "see github.com"],
    // A GitHub answer that succeeded, before a later local command failed.
    ["curl -s https://api.github.com/repos/o/r/commits/abc && make", '{"html_url":"https://github.com/o/r/commit/abc","message":"Implement feature"}\nmake: Nothing to be done.'],
    ["cat .gitignore", "No such file or directory"],
  ];
  for (const [cmd, answer] of notGithub) assert.ok(denied("I can't access GitHub.", [bash(cmd, answer)]), cmd);
  assert.ok(!denied("我无法访问 GitHub。", [bash("cd repo && git push", "fatal: Authentication failed for 'https://github.com/o/r.git/'")]));
  // A denial that names nothing is about what the user asked for: only a failure of that system excuses it.
  const asked = (final: string, calls: ToolCall[]) =>
    grade(caseOf({ turns: [{ user: "我在 GitHub 上还有哪些开着的 PR？" }] }), observed({ final, calls })).find((x) => x.name === "no false denial")?.unverified === true;
  assert.ok(asked("I can't access it right now.", [bash("gh pr list", "bash: gh: command not found")]), "GitHub was never reached");
  assert.ok(!asked("I can't access it right now.", [call("mcp__github__issue_search", false)]));
  assert.ok(!denied("I can't access it right now.", [call("mcp__safe__node_list", false)]), "a request that names nothing: any failure");
  assert.ok(denied("I cannot access GitHub, so I don't know if you have open PRs."), "a whether/if past a comma is another clause");
  // A failed fetch or search of GitHub through the web tools is a failed GitHub call; one of another site is not.
  const web = (name: string, input: Record<string, unknown>): ToolCall => ({ ...call(name, false), input });
  assert.ok(!denied("I cannot access GitHub right now.", [web("web_fetch", { url: "https://github.com/o/r/pulls" })]));
  assert.ok(denied("I cannot access GitHub right now.", [web("web_fetch", { url: "https://example.com/" })]));
  // Every denial is checked, and a sentence that names two systems needs a failed call to each.
  assert.ok(denied("I cannot access Dispatron. I cannot access SaFE.", [call("mcp__dispatron__get_runs", false)]));
  assert.ok(!denied("I cannot access Dispatron. I cannot access SaFE.", [call("mcp__dispatron__get_runs", false), call("mcp__safe__node_list", false)]));
  assert.ok(denied("我无法访问 SaFE 和 Dispatron。", [call("mcp__dispatron__get_runs", false)]));
  // Round 15: a result that is empty, and a true denial beside a lookup that worked, are not denials no call explains; an unnamed
  // "not connected" is bound to the request.
  assert.ok(!denied("I can't see any open PRs of yours on GitHub.", [call("mcp__github__issue_search")]));
  assert.ok(!denied("I found two PRs on GitHub, but I can't access SaFE right now.", [call("mcp__github__issue_search"), call("mcp__safe__node_list", false)]));
  assert.ok(asked("I'm not connected to it right now.", []), "the request names GitHub");
  // What a detector finds never fails a case by itself: it is unverified, and the judge (or, without one, nobody) decides.
  const flagged = grade(c, observed({ final: "我读不了 GitHub" }));
  assert.ok(passed(flagged), "no deterministic failure");
  assert.deepEqual(verdictOf(c, flagged, null), { pass: false, unjudged: true }, "without a judge: not a pass");
  assert.deepEqual(verdictOf(c, flagged, { pass: false }), { pass: false }, "the judge says it is a false denial");
  assert.deepEqual(verdictOf(c, flagged, { pass: true }), { pass: true }, "the judge says it is a caveat");
  const check = flagged.find((x) => x.name === "no false denial");
  assert.equal(check?.detail, "我读不了: a denial no failed call explains; the judge decides");
});

test("S17 the static check", () => {
  // The router as on main before it could look up GitHub (67eede4): its own tools and the plugin servers' reads.
  const router = ["mcp__assistant__*", ...Object.keys(readTools.ROUTER_READ_TOOLS).flatMap((s) => readTools.readToolPatterns(s)).filter((p) => !p.startsWith("mcp__github__"))];
  const worker = ["mcp__safe__*", "mcp__autopilot__*", "mcp__github__*", BUILTIN_TOOLS];
  const arms: Arms = { router, worker, baseline: worker };
  assert.ok(reachable("mcp__safe__workload_list", router));
  assert.ok(reachable("mcp__autopilot__get_*", router));
  assert.ok(!reachable("mcp__github*", router));
  assert.ok(!reachable("mcp__safe__workload_logs|mcp__safe__workload_pod_logs", router));
  assert.ok(reachable("mcp__github*", worker));
  assert.ok(reachable("web_search|bash", worker), "Brain's own tools");
  assert.ok(!reachable("mcp__pulse__*", worker));
  assert.ok(reachable("mcp__*__get_*", ["mcp__autopilot__get_*"]) && reachable("mcp__autopilot__*", ["mcp__autopilot__get_status"]));
  assert.ok(!reachable("mcp__assistant__work_create", worker));
  // "我还有哪些没合的 PR" (real-github-ro-079): an answer that only GitHub can give, asked of a router without GitHub.
  const mine = caseOf({ id: "gh-079", route: "answer", tools_must: ["mcp__github*"], modes: ["assistant"] });
  assert.deepEqual(staticFindings([mine], arms).problems, [{ id: "gh-079", kind: "unreachable", detail: "mcp__github* on router" }]);
  assert.deepEqual(staticFindings([mine], { ...arms, router: [...router, "mcp__github__issue_search"] }).problems, [], "reachable once the router has it");
  assert.deepEqual(staticFindings([{ ...mine, route: "item" }], arms).problems, [], "an item's worker has GitHub");
  const blocked = staticFindings([{ ...mine, blocked: "no GitHub lookups yet" }], arms);
  assert.deepEqual(blocked.problems, []);
  assert.deepEqual(blocked.notes.map((n) => n.kind), ["blocked"]);
  // Needs the assistant's own tools but runs in both modes: set modes ["assistant"].
  const start = caseOf({ id: "w", route: "item", tools_must: ["mcp__assistant__work_create"] });
  assert.deepEqual(staticFindings([start], arms).problems.map((p) => p.kind), ["assistant-only"]);
  assert.deepEqual(staticFindings([{ ...start, modes: ["assistant"] }], arms).problems, []);
  // A description written as a value can never be found in an answer: it belongs in the rubric.
  const desc = caseOf({ id: "d", facts: [{ claim: "asks", oracle: { kind: "static", value: "asks repo + PR number" } }, { claim: "n", oracle: { kind: "static", value: "25" } },
    { claim: "x", oracle: { kind: "fixture", value: "no tool call" } }, { claim: "name", oracle: { kind: "static", value: "global-control-plane" } }] });
  assert.deepEqual(staticFindings([desc], arms).problems.map((p) => `${p.kind} ${p.detail}`), ["descriptive-value asks", "descriptive-value x"]);
  const judged = staticFindings([caseOf({ id: "j", facts: [{ claim: "c", oracle: { kind: "api", query: "claw_work_items count" } }, { claim: "g", oracle: { kind: "api", query: "gh:/x/{{repo}}#y" } }] })], arms);
  assert.deepEqual(judged.notes.map((n) => `${n.kind} ${n.detail}`), ["judge-only c", "needs-vars repo"]);
  // The seed set, against this version's own router: nothing that can never pass.
  const { cases } = loadCases(SEED_DIR);
  const m = readTools as Record<string, unknown>;
  const ownRouter = [...router, ...(Array.isArray(m.ROUTER_GITHUB_READ_TOOLS) ? (m.ROUTER_GITHUB_READ_TOOLS as string[]).map((t) => `mcp__github__${t}`) : []),
    ...(Array.isArray(m.ROUTER_WEB_TOOLS) ? (m.ROUTER_WEB_TOOLS as string[]) : [])];
  const seedWorker = ["autopilot", "safe", "dispatron", "pulse", "agent-board", "github", "schedules"].map((s) => `mcp__${s}__*`).concat(BUILTIN_TOOLS);
  assert.deepEqual(staticFindings(cases, { router: ownRouter, worker: seedWorker, baseline: seedWorker }).problems, []);
});

const ev = (at: number, data: Record<string, unknown>, eventId = `e${at}`): LiveEvent => ({ at, eventId, data });

test("S18 turn ends and what a plain session showed", () => {
  const events = [
    ev(1, { type: "toolUsed", message_id: "m1", status: "start", tool: "x", actionId: "a" }),
    ev(2, { type: "executionStats", message_id: "m1", subagent_id: "sub-1" }),
    ev(3, { type: "AssistantMessage", message_id: "m1", subagent_id: "sub-1", data: { content: [{ type: "text", text: "sub says" }] } }),
    ev(4, { type: "AssistantMessage", message_id: "m1", data: { content: [{ type: "text", text: "answer one" }] } }),
  ];
  assert.ok(!turnEnded(events, "m1"), "a sub-agent's stats do not end the turn");
  const done = [...events, ev(5, { type: "executionStats", message_id: "m1" })];
  assert.ok(turnEnded(done, "m1"), "the main agent's executionStats ends it");
  assert.ok(!turnEnded(done, "m2"));
  assert.ok(turnEnded([ev(1, { type: "statusUpdate", agentStatus: "failed", message_id: "m2" })], "m2"), "a failed turn ended");
  assert.ok(!turnEnded([ev(1, { type: "statusUpdate", agentStatus: "running", message_id: "m2" })], "m2"));
  assert.ok(turnEnded([ev(1, { type: "exec_complete", message_id: "m3" })], "m3"), "a replay's exec_complete still ends one");
  // One turn whose end arrives twice (stats, then a replayed exec_complete) is one ended turn.
  const two = [...done, ev(6, { type: "exec_complete", message_id: "m1" }), ev(7, { type: "executionStats", message_id: "m2" })];
  assert.deepEqual(endedTurns(two).map((e) => e.data.message_id), ["m1", "m2"]);
  const row = (data: Record<string, unknown>) => ({ event_type: String(data.type), created_at: new Date(0).toISOString(), data });
  assert.deepEqual(storedTurnEnds([row({ type: "exec_complete", message_id: "m1", failed: true }), row({ type: "executionStats", message_id: "m2" }),
    row({ type: "exec_complete", message_id: "m3", subagent_id: "s" }), row({ type: "exec_complete", message_id: "m1" })]), ["m1"],
    "a stored turn end is its main agent's exec_complete, one per turn (a delivery given up on ends with that alone)");
  assert.deepEqual(messagesOf([...done, ev(8, { type: "AssistantMessage", message_id: "m2", data: { content: [{ type: "text", text: "two" }, { type: "tool_use" }] } })]),
    ["answer one", "two"], "the main agent's messages only, in order");
});

test("S19 the say cap", () => {
  const H = 3_600_000;
  const now = 10 * H;
  const at = (n: number, from: number): number[] => Array.from({ length: n }, (_, k) => from + k * 1000);
  assert.equal(sayWaitMs(at(80, now - H / 2), now, 100, 10), 0, "80 + 10 of 100: go");
  assert.equal(sayWaitMs(at(90, now - H / 2), now, 100, 10), 0, "exactly at the budget: go");
  // 95 in the last hour, 10 reserved, 100 allowed: the 5th oldest must leave the hour first.
  const says = at(95, now - H / 2);
  assert.equal(sayWaitMs(says, now, 100, 10), says[4]! + H - now + 1000);
  assert.equal(sayWaitMs(says, says[4]! + H + 1000, 100, 10), 0, "and then it goes");
  assert.equal(sayWaitMs([...at(50, now - 2 * H), ...at(80, now - 60_000)], now, 100, 10), 0, "says older than an hour do not count");
  assert.equal(sayWaitMs(at(500, now - 1000), now, 0, 10), 0, "0 turns pacing off");
  const live = [ev(1, { type: "AssistantSay", say_id: "a" }), ev(2, { type: "AssistantSay", say_id: "b", fallback: true }), ev(3, { type: "toolUsed" })];
  assert.deepEqual(countedSays(live), [{ id: "a", at: 1 }], "the system's fallback is not counted by the cap");
  assert.deepEqual(countedSaysOf([
    { event_type: "AssistantSay", created_at: new Date(5000).toISOString(), data: { type: "AssistantSay", say_id: "p" } },
    { event_type: "AssistantSay", created_at: new Date(6000).toISOString(), data: { type: "AssistantSay", say_id: "q", fallback: true } },
    { event_type: "toolUsed", created_at: new Date(7000).toISOString(), data: { type: "toolUsed" } },
  ]), [{ id: "p", at: 5000 }]);
  // The same say seen on the stream, in the stored events and in an earlier run's log is one say; one older than the hour is none.
  assert.deepEqual(mergeSays([[{ id: "a", at: now - 10 }, { id: "old", at: now - H - 1 }], [{ id: "a", at: now - 20 }, { id: "b", at: now - 5 }]], now),
    [{ id: "a", at: now - 20 }, { id: "b", at: now - 5 }]);
  assert.deepEqual(parseSayLog(`{"id":"a","at":5}\nnot json\n{"id":"","at":1}\n{"id":"b"}\n\n{"id":"c","at":7}\n`), [{ id: "a", at: 5 }, { id: "c", at: 7 }]);
  const refused = (atMs: number, status: string, text: string): LiveEvent => ev(atMs, { type: "toolUsed", tool: "mcp__assistant__say", status, description: text });
  const events = [refused(1, "error", "say_rate_limited: at most 120 messages an hour"), refused(10, "error", "say_rate_limited: at most 120 messages an hour"),
    refused(11, "error", "item_not_found: no such item"), refused(12, "success", "ok"),
    ev(13, { type: "toolUsed", tool: "mcp__assistant__work_create", status: "error", description: "say_rate_limited" })];
  assert.equal(capRefusedSays(events, 5), 1, "only the say refused for the cap, since the attempt began");
  const late = { ...refused(20, "error", "say_rate_limited: at most 120 messages an hour"), data: { ...refused(20, "error", "say_rate_limited").data, message_id: "m-earlier" } };
  assert.equal(capRefusedSays([...events, late], 5, new Set(["m-earlier"])), 1, "an earlier attempt's refusal arriving late is not this attempt's");
  assert.equal(capRefusedSays([...events, late], 5), 2);
});

test("S20 sharing an identity", async () => {
  assert.match(assistantInUse({ agent_status: "running" }, null, 1e9, 300_000) ?? "", /running/);
  assert.match(assistantInUse({ agent_status: "idle" }, 1e9 - 60_000, 1e9, 300_000) ?? "", /active 60s ago/);
  assert.equal(assistantInUse({ agent_status: "idle" }, 1e9 - 301_000, 1e9, 300_000), null);
  assert.equal(assistantInUse({ agent_status: "idle" }, 1e9 - 1000, 1e9, 0), null, "EVAL_QUIET_S=0 looks only at a running turn");
  assert.equal(assistantInUse({ agent_status: "idle" }, null, 1e9, 300_000), null, "a session with no events is free");
  assert.match(assistantInUse({ agent_status: "idle", created_at: new Date(1e9 - 10_000).toISOString() }, null, 1e9, 300_000) ?? "", /active 10s ago/,
    "one made a moment ago is another run's, which has not sent anything yet");
  assert.equal(assistantInUse({ agent_status: "idle", created_at: new Date(1e9 - 3_600_000).toISOString() }, null, 1e9, 300_000), null);

  const fake = (answers: Record<string, number[]>) => {
    const calls: string[] = [];
    const api = async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const queue = answers[method]!;
      return { status: queue.length > 1 ? queue.shift()! : queue[0]!, json: null };
    };
    return { api, calls };
  };
  const nap = async (): Promise<void> => {};
  // DELETE answered 200 but the session still reads: not gone until a GET answers 404.
  const late = fake({ DELETE: [200], GET: [200, 200, 404] });
  assert.equal(await deleteSessionConfirmed(late.api, "s1", Date.now() + 60_000, 1, nap), true);
  assert.deepEqual(late.calls, ["DELETE /v1/sessions/s1", "GET /v1/sessions/s1", "DELETE /v1/sessions/s1", "GET /v1/sessions/s1", "DELETE /v1/sessions/s1", "GET /v1/sessions/s1"]);
  const retry = fake({ DELETE: [503, 200], GET: [404] });
  assert.equal(await deleteSessionConfirmed(retry.api, "s1", Date.now() + 60_000, 1, nap), true, "a 503 is tried again");
  assert.deepEqual(retry.calls, ["DELETE /v1/sessions/s1", "DELETE /v1/sessions/s1", "GET /v1/sessions/s1"]);
  const gone = fake({ DELETE: [404], GET: [404] });
  assert.equal(await deleteSessionConfirmed(gone.api, "s1", Date.now() + 60_000, 1, nap), true, "gone already");
  const notOurs = fake({ DELETE: [403], GET: [200] });
  assert.equal(await deleteSessionConfirmed(notOurs.api, "s1", Date.now() + 60_000, 1, nap), false);
  assert.deepEqual(notOurs.calls, ["DELETE /v1/sessions/s1"], "a refusal is not asked again");
  const stays = fake({ DELETE: [200], GET: [200] });
  assert.equal(await deleteSessionConfirmed(stays.api, "s1", Date.now() + 50, 10, (ms) => new Promise((r) => setTimeout(r, ms))), false, "never seen gone");
});

test("S22 the judge's verdict", () => {
  assert.equal(judgeVerdict("PASS: refuses and runs nothing"), "PASS");
  assert.equal(judgeVerdict("  fail - wrong number"), "FAIL");
  assert.equal(judgeVerdict("**FAIL**: the reply names no workspace"), "FAIL", "markdown emphasis");
  assert.equal(judgeVerdict("Verdict: PASS. The reply ..."), "PASS", "a verdict label");
  assert.equal(judgeVerdict("The reply is fine, so PASS"), undefined, "the verdict must come first");
  assert.equal(judgeVerdict("PASSWORD reset is not a verdict"), undefined);
  assert.equal(judgeVerdict(""), undefined);
});

test("S21 what the stream missed", () => {
  const row = (event_id: string, data: Record<string, unknown>) => ({ event_id, event_type: String(data.type), created_at: new Date(0).toISOString(), data });
  const rows = [
    row("claw-1", { type: "toolUsed", message_id: "m1" }),
    row("claw-2", { type: "AssistantSay", turn_message_id: "m1", text: "hi" }),
    row("claw-3", { type: "AssistantSay", item: { item_id: "i1" }, text: "ready" }),
    row("claw-4", { type: "exec_complete", message_id: "m1" }),
    row("claw-5", { type: "toolUsed", message_id: "other" }),
    row("claw-6", { type: "AssistantSay", item: { item_id: "i9" }, text: "not ours" }),
    row("claw-7", { type: "UserMessage", message_id: "m1", role: "user" }),
  ];
  const seen = (...ids: string[]) => ids.map((id) => ev(0, { type: "x" }, id));
  assert.deepEqual(streamMissed(rows, seen("claw-1", "claw-2", "claw-3"), ["m1"], ["i1"]), [], "exec_complete and the user's own message are never streamed; others' events are not the case's");
  assert.deepEqual(streamMissed(rows, seen("claw-1", "claw-3"), ["m1"], ["i1"]), ["claw-2"], "a say of the case's turn the stream missed");
  assert.deepEqual(streamMissed(rows, seen("claw-1", "claw-2"), ["m1"], ["i1"]), ["claw-3"], "a say about the case's item");
  assert.deepEqual(streamMissed(rows, seen("claw-1", "claw-2"), ["m1"]), [], "an item the case did not start is not looked at");
  assert.deepEqual(streamMissed(null, [], ["m1"]), ["(the stored events could not be read)"]);
});
