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
 *   S23 files: a turn's files must name a fixture inside the cases directory; the files the assistant's messages hand the user are
 *       read with the item that delivered each; `delivers` and `min_chars` are graded, and skipped in baseline
 *   S24 oracle steps after a pick: a state said in words, an empty list as a word, a filtered count, a file's content and a regex;
 *       a value with `||` is named by any of its alternatives; a GraphQL oracle is a query only; an unknown step is not runnable
 *   S25 with no_ids, a number that names a pull request, an issue, a CI run, a topic or `owner/repo#n` is not a bare item number
 *   S26 a GitHub read that answered its failure in words is a failed call (Brain records it as a success), so a reply that it could
 *       not read is explained; another tool's text is not read that way
 *   S27 run variables from a JSON object: nested objects as `a.b`, null as no value
 *   S28 a label for the kind of answer, or settings written as code, is a description, not a value; a number, a name, a path or a time is a value
 *   S29 the stored calls of the run's own turns (the messages it knows by id): a person's turn in the same session is not one
 *   S30 a turn's reply is not its "on it" line: the wait after a turn's end goes on until another say of the turn, which the server
 *       says for a router that ended in plain text; the line is known by the id the server gives it
 *   S36 a case's setup.forget_memories: a list of 1 to 10 non-empty substrings; the entries it names are found by title or body,
 *       case-insensitively; the entries an attempt made are those listed after it that were not before it, and only those
 *   S37 expect_memory / expect_no_memory: lists of 1 to 10 non-empty substrings; graded on the entries the attempt made: each
 *       expect_memory substring held by one of them (title or body, case-insensitive), no expect_no_memory substring held by any;
 *       entries not read (a recording graded offline) leave the check unverified, never passed
 *   S39 route=clarify: the final reply asks, by a question mark, a request for what is missing (Chinese or English, as routers
 *       write it since say took choices) or a choice put to the person; request words inside a sign-off or a "no need" clause do
 *       not count, so an answer ending in "如果有任何问题，请告诉我" does not ask (any question mark still does, as before); an item
 *       or a card is no clarification however it asks
 *   S35 the signed-in token is sent only with the person's text message (its words, type and channel context, nothing else), a card's
 *       `deny` and the check of whose it is: an allow, an answer, a decision or a message with more in it, or any other route is refused; a turn's channel_context is sent beside its files, and a
 *       case may name only what a channel sends
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ToolCall } from "./e2e/agent-eval-lib.js";
import * as readTools from "../src/assistant/read-tools.js";
import { lookupAckSayId } from "../src/assistant/lookup-ack.js";
import { silentTurnNotice, turnLostNotice } from "../src/assistant/router-turn-end.js";
import {
  BUILTIN_TOOLS, CAPABILITY_DENIAL, SELF_INABILITY, fill, oracleMcpTarget, filledCase, judgeFacts, judgePrompt, missingVars, oracleMayRun, oracleQuery, placeholdersOf, reachable, staticFindings,
  type Arms,
  apiQuery, caseSays, cardsOf, cardsShownBy, clearsSkillDrafts, foreignDraftAnswers, skillDraftCards, skillDraftIds, filesFrom, forRecording, heldCallRan, heldRequest, holdAnswers, identityRefusal, itemsStartedBy, needsJudge, parseRecordings, planOf, verdictOf, cleanupOf, finalSay, grade, loadCases, names, parseCases, passed, pick, routeOf, saysOf, scrub, select,
  sseFrames, toolPattern, totals, turnCalls, turnsOf, type CaseResult, type EvalCase, type ItemSeen, type LiveEvent, type Observed,
  assistantInUse, capRefusedSays, countedSays, judgeVerdict, countedSaysOf, deleteSessionConfirmed, endedTurns, mergeSays, messagesOf, pacedPerHour, parseSayLog, sayWaitMs, storedTurnEnds, streamMissed, turnEnded, turnAckSayId, turnsAnswered,
  ownSays, SYSTEM_TURN_NOTICES, asksUser,
  bareItemNumber, clockAnswer, clockQuery, clockValue, clockValues, descriptiveValue, flatVars, githubReadOnlyQuery, oracleValues, withToolFailures, storedTurnCalls,
  cardsLeftError, freshSessionEvery, setupTriggerBody, waitingCards, memoryRows, memoriesMatching, newMemoryIds,
  TURN_CONTEXT_KEYS, problemsOf, tokenRequestRefusal, turnMessageBody,
} from "./e2e/sa-eval-lib.js";
import { tmpDir } from "../../utils/test/tmp-dirs.js";

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
  // A skill draft's card the server shows after the turn is the card, not the answer: the answer before it is final, and the card
  // still counts as a card (cat-skills-suggest-en-007 on claw-v0.5.0 was graded on the card's own text).
  const drafted = saysOf([
    say(1, "m2", "Topics: release cadence. Decisions: ship Thursday. Action items: changelog."),
    say(2, "m2", 'I drafted a personal skill "meeting-notes"; nothing is saved yet.', {
      skill_card: { kind: "draft", name: "meeting-notes" }, confirm_write: { confirmation_id: "c9", kind: "skill_save" } }),
  ]);
  assert.match(finalSay(drafted, ["m2"], [])?.text ?? "", /^Topics:/);
  assert.equal(cardsOf(drafted), "confirm");
  assert.equal(finalSay([drafted[1]!], ["m2"], [])?.skillCard, true, "only a card: the card");
  const mine = caseSays(says, ["m1"], ["i1"]);
  assert.deepEqual(mine.map((s) => s.at), [1, 3, 4]);
  assert.equal(cardsOf(mine), "accept");
  assert.equal(cardsOf(caseSays(says, ["m1"], [])), "none");
  // A write the item's worker holds for the person is put to them as a card on the message saying the item needs them.
  const held = saysOf([say(5, "pending-3", "#1 needs your approval to: post a comment", {
    item: { item_id: "i1", board_state: "needs_you" }, held_write: { item_id: "i1", session_id: "w1", tool_use_id: "toolu_1", action: "post a comment" },
  })]);
  assert.equal(cardsOf(caseSays(held, ["m1"], ["i1"])), "confirm");
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
  const dir = tmpDir("sa-eval-");
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

test("S9b the review-as-X set, the multi-turn scripts and the recent-issue cases", () => {
  const { cases } = loadCases(SEED_DIR);
  const of = (dir: string) => cases.filter((c) => c.dir === dir);
  const review = of("review-a8");
  assert.ok(review.length >= 20, `${review.length} review-a8 cases`);
  // Review as another person, a merge confirmation and stopping a review are each covered.
  assert.ok(review.some((c) => c.turns.some((t) => t.user.includes("{EVAL_OTHER_PERSON}")) && c.route === "review"));
  assert.ok(review.some((c) => c.tools_must?.some((p) => toolPattern(p).test("mcp__assistant__confirmation_answer"))));
  // Stopping a review: the person's open reviews come with every message, so no tool is required; what is left open is read.
  assert.ok(review.some((c) => /停|stop/i.test(c.turns.at(-1)!.user) && c.facts?.some((f) => /where:kind=review\b/.test(f.oracle?.query ?? ""))));
  // A merged pull request is answered with when it merged, read from GitHub, and starts no review.
  assert.ok(review.some((c) => c.facts?.some((f) => /pulls\/\d+#merged_at/.test(f.oracle?.query ?? ""))));
  const sim = of("sim");
  assert.ok(sim.length >= 15, `${sim.length} multi-turn scripts`);
  for (const c of sim) assert.ok(c.turns.length >= 3 && c.turns.length <= 6, `${c.id}: ${c.turns.length} turns`);
  const recent = cases.filter((x) => /-y8-/.test(x.id));
  assert.ok(recent.length >= 15, `${recent.length} recent-issue cases`);
  // Every new case has a fact a run decides (a value to find in the answer, or an oracle the runner reads), or is graded on every
  // item it started being closed; tools_must alone does not count.
  for (const c of [...review, ...sim, ...recent]) {
    const decidable = (c.facts ?? []).some((f) => (f.oracle?.kind !== "api" && f.oracle?.value !== undefined) || oracleQuery({ kind: "api", query: (f.oracle?.query ?? "").replace(/\{\{[\w.]+\}\}|\{[A-Z_]+\}/g, "x") }));
    assert.ok(decidable || c.items_closed, `${c.id}: no fact a run can decide`);
  }
});

test("S9c what the router is given with every message needs no tool; a bare number has no language; a merge time is read", () => {
  const byId = new Map(loadCases(SEED_DIR).cases.map((c) => [c.id, c]));
  const get = (id: string) => { const c = byId.get(id); assert.ok(c, `${id} is in the seed set`); return c!; };
  // The person's items, what waits for them and the reviews they asked for come with each message (the router prompt): an answer
  // from that list is right, and a case that requires a recall of it fails a correct reply.
  for (const id of ["cat-items-y8-014", "cat-review-a8-013", "cat-review-a8-014", "cat-review-a8-017", "cat-review-a8-018", "cat-review-a8-019",
    "sim-items-mt-004", "sim-items-mt-014"]) {
    assert.deepEqual(get(id).tools_must, [], `${id}: no tool required`);
  }
  // "Only the number": a reply of digits has no language to follow.
  for (const id of ["cat-safe-y8-015", "sim-general-mt-012"]) assert.equal(get(id).style?.reply_lang, undefined, `${id}: no reply language`);
  // When a pull request merged is read in the turn, with pr_state as well as GitHub's own read.
  for (const id of ["cat-review-a8-021", "sim-github-mt-002"]) {
    assert.ok(get(id).tools_must?.some((p) => toolPattern(p).test("mcp__assistant__pr_state")), `${id}: pr_state counts as the read`);
  }
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
  // The values the run read are given as the truth, newer than the judge may know (E249: "ROCm 10.x does not exist"), with what the
  // fact check means: every value of a fact is required, and a value's `a||b` alternatives are each enough (`names`). A fact with no
  // value is left out, and without values there is no such line.
  const rocm = caseOf({ facts: [{ claim: "the latest ROCm release", oracle: { kind: "api", query: "gh:/repos/ROCm/TheRock/releases/latest#tag_name" } },
    { claim: "where it was read", oracle: { kind: "api", query: "a description" } }, { claim: "nothing read", oracle: { kind: "api", query: "gh:/x#y" } },
    { claim: "whether anything was found", oracle: { kind: "api", query: "gh:/y#z|map:0=没有||没搜到||none" } },
    { claim: "the open pull requests", oracle: { kind: "api", query: "gh:/p#n" } }] });
  const truth = judgePrompt(rocm, [{ user: "ROCm 最新版本？" }], "10.1.0", [],
    [["10.1.0"], null, [], ["没有||没搜到||none"], ["#12", "#15", ...Array.from({ length: 12 }, (_, k) => `#${100 + k}`)]]);
  assert.match(truth, /source of truth[^\n]*newer than anything you know[^\n]*"all of"[^\n]*every one[^\n]*"one of"[^\n]*any one/);
  assert.match(truth, /\n- the latest ROCm release: "10\.1\.0"\n/);
  assert.match(truth, /\n- whether anything was found: one of "没有", "没搜到", "none"\n/, "alternatives, never the raw a||b string");
  assert.doesNotMatch(truth, /\|\|/);
  assert.match(truth, /\n- the open pull requests: all of: \("#12"\) and \("#15"\) and [^\n]*\("#107"\)\n/, "every value required, the first 10 as the check");
  assert.doesNotMatch(truth, /#108/);
  assert.doesNotMatch(truth, /- where it was read:|- nothing read:/);
  assert.doesNotMatch(judgePrompt(rocm, [{ user: "q" }], "a"), /source of truth/);
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
  assert.ok(!reachable("mcp__safe__apikey_list|mcp__safe__secret_list", router));
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
  assert.equal(pacedPerHour(100, undefined, 10), 100, "a server that does not say its cap: the configured pace");
  assert.equal(pacedPerHour(550, 120, 10), 100, "a raised pace against the people's cap: 20 under it");
  assert.equal(pacedPerHour(550, 600, 10), 550, "under the evaluation identity's cap: as configured");
  assert.equal(pacedPerHour(0, 120, 10), 0, "0 stays no pace");
  assert.equal(pacedPerHour(100, 15, 10), 11, "never at or under the reserve");
  assert.equal(pacedPerHour(100, "600", 10), 100, "only a whole number counts");
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
  // A judge that reasons first: its last line's first word.
  assert.equal(judgeVerdict("The reply names 3 nodes, as the rubric asks.\n\nPASS: names the count"), "PASS");
  assert.equal(judgeVerdict("It names no workspace.\n**Verdict: FAIL** - no workspace"), "FAIL");
  assert.equal(judgeVerdict("Looks like PASS at first.\nBut it is wrong, so FAIL"), undefined, "never a word inside a sentence");
  assert.equal(judgeVerdict("PASS: first line\nFAIL: a later line"), "PASS", "the first line wins");
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
  assert.deepEqual(streamMissed(rows, seen("claw-1", "claw-2", "claw-3"), ["m1"], ["i1"]), [], "exec_complete and the user's own message are never live on a stream; others' events are not the case's");
  assert.deepEqual(streamMissed(rows, seen("claw-1", "claw-3"), ["m1"], ["i1"]), ["claw-2"], "a say of the case's turn the stream missed");
  assert.deepEqual(streamMissed(rows, seen("claw-1", "claw-2"), ["m1"], ["i1"]), ["claw-3"], "a say about the case's item");
  assert.deepEqual(streamMissed(rows, seen("claw-1", "claw-2"), ["m1"]), [], "an item the case did not start is not looked at");
  assert.deepEqual(streamMissed(null, [], ["m1"]), ["(the stored events could not be read)"]);
  // What nothing graded reads is no gap (E249: 8 events at a turn's start, its progress, sandbox and plugin loading); a status that
  // says the turn failed ends it, and is one.
  const progress = [
    row("claw-8", { type: "statusUpdate", message_id: "m1", agentStatus: "running" }),
    row("claw-9", { type: "sandboxStatus", message_id: "m1", status: "ready" }),
    row("claw-10", { type: "toolUsed", message_id: "m1", tool: "load_mcp", status: "success", brief: "Loaded plugin MCP (safe)" }),
    row("claw-11", { type: "toolUsed", message_id: "m1", tool: "load_rule", status: "success" }),
    row("claw-12", { type: "toolUsed", message_id: "m1", tool: "load_hooks", status: "success" }),
    row("claw-13", { type: "statusUpdate", message_id: "m1", agentStatus: "failed" }),
    row("claw-14", { type: "toolUsed", message_id: "m1", tool: "mcp__assistant__load_notes", status: "success" }),
  ];
  assert.deepEqual(streamMissed([...rows, ...progress], seen("claw-1", "claw-2", "claw-3"), ["m1"], ["i1"]), ["claw-13", "claw-14"]);
});

test("S23 files in, files and long answers out", () => {
  assert.deepEqual(parseCases(JSON.stringify(caseOf({ turns: [{ user: "q", files: [{ fixture: "fixtures/a.pdf" }] }] }))).bad, []);
  for (const fixture of ["/etc/passwd", "../x.pdf", "a/../../x", ""]) {
    const bad = parseCases(JSON.stringify(caseOf({ turns: [{ user: "q", files: [{ fixture }] }] }))).bad;
    assert.equal(bad.length, 1, fixture);
  }
  assert.equal(parseCases(JSON.stringify(caseOf({ delivers: [{}] }))).bad.length, 1);

  const says = saysOf([
    say(1, "m1", "#3 delivered a file: chart.png", { files: [{ name: "chart.png", content_type: "image/png", item_id: "i1" }] }),
    say(2, "", "#4 delivered a file: other.csv", { files: [{ name: "other.csv", content_type: "text/csv", item_id: "i9" }] }),
    say(3, "m1", "no file"),
  ]);
  assert.deepEqual(says[0].files, [{ name: "chart.png", content_type: "image/png", item_id: "i1" }]);
  assert.deepEqual(says[2].files, []);
  assert.deepEqual(filesFrom(says, ["i1"]).map((f) => f.name), ["chart.png"], "only the case's own items' files");

  const c = caseOf({ delivers: [{ name: "\\.png$", type: "image/" }], style: { min_chars: 700 } });
  const delivered = filesFrom(says, ["i1"]);
  assert.deepEqual(failed(c, observed({ delivered, final: "x".repeat(700) })), []);
  assert.deepEqual(failed(c, observed({ delivered: [], final: "x".repeat(699) })), [">= 700 chars", "delivers \\.png$ image/"]);
  assert.deepEqual(failed(caseOf({ delivers: [{ type: "application/vnd.openxmlformats" }] }), observed({ delivered })), ["delivers * application/vnd.openxmlformats"]);
  const baseline = grade(c, observed({ mode: "baseline", route: undefined, cards: undefined, final: "x".repeat(700) }));
  assert.ok(baseline.find((x) => x.name.startsWith("delivers"))?.skipped, "baseline has no files to grade, and says so");
});

test("S24 oracle steps after a pick", () => {
  const q = (query: string) => oracleQuery({ kind: "api", query });
  const merged = q("gh:/repos/o/r/pulls/296#merged|map:true=merged||已合并;false=not merged||未合并");
  assert.deepEqual(merged, { via: "github", path: "/repos/o/r/pulls/296", at: "merged", steps: ["map:true=merged||已合并;false=not merged||未合并"] });
  assert.deepEqual(oracleValues({ merged: true }, merged!), ["merged||已合并"]);
  assert.deepEqual(oracleValues({ merged: false }, merged!), ["not merged||未合并"]);
  assert.ok(names("PR #296 已合并。", "merged||已合并"), "any alternative names it");
  assert.ok(!names("PR #296 还开着。", "merged||已合并"));
  // An empty list is a word, and a list that is not empty is left as it is.
  const open = q("gh:/repos/o/r/pulls?state=open#*.number|empty:none||没有");
  assert.deepEqual(oracleValues([], open!), ["none||没有"]);
  assert.deepEqual(oracleValues([{ number: 3 }, { number: 5 }], open!), ["3", "5"]);
  // A filtered count: one author's open pull requests out of the list.
  const mine = q("gh:/repos/o/r/pulls?state=open#*|where:user.login=octo|count");
  const pulls = [{ user: { login: "octo" } }, { user: { login: "someone" } }, { user: { login: "octo" } }];
  assert.deepEqual(oracleValues(pulls, mine!), ["2"]);
  assert.deepEqual(oracleValues(pulls, q("gh:/x#*|where:user.login!=octo|count")!), ["1"]);
  assert.deepEqual(oracleValues([], mine!), ["0"], "none of them is a count of 0");
  // A file's content (base64, as the contents API gives it) and a regex's first group.
  const file = q("gh:/repos/o/r/contents/claw/package.json#content|b64|match:\"version\":\\s*\"([^\"]+)\"");
  const content = Buffer.from('{\n  "name": "claw",\n  "version": "0.1.0"\n}\n').toString("base64").replace(/(.{20})/g, "$1\n");
  assert.deepEqual(oracleValues({ content }, file!), ["0.1.0"]);
  // A GraphQL count of unresolved review threads; a mutation is never an oracle.
  const threads = q("ghql:query{repository(owner:\"o\",name:\"r\"){pullRequest(number:291){reviewThreads(first:100){nodes{isResolved}}}}}#data.repository.pullRequest.reviewThreads.nodes.*|where:isResolved=false|count");
  assert.equal(threads?.via, "github-graphql");
  const answer = { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] } } } } };
  assert.deepEqual(oracleValues(answer, threads!), ["2"]);
  assert.equal(q("ghql:mutation{addComment(input:{}){clientMutationId}}#data"), null, "a mutation is not read");
  assert.equal(githubReadOnlyQuery("{ viewer { login } }"), true);
  assert.equal(githubReadOnlyQuery("query Q { a } mutation M { b }"), false);
  // A step this runner does not know: the oracle is not runnable (the judge grades it), never read wrong.
  assert.equal(q("gh:/x#a|sum"), null);
  assert.equal(q("/v1/work-items#data.length|count")?.via, "claw");
  assert.deepEqual(q("mcp:safe/node_list?limit=5#data.*|where:status=Ready|count"),
    { via: "mcp", server: "safe", tool: "node_list", args: { limit: 5 }, at: "data.*", steps: ["where:status=Ready", "count"] });
  // Picking within, sorting and keeping the first; a regex filter with an alternation.
  const keys = [{ name: "b", exp: "2027-03" }, { name: "a", exp: "2026-12" }, { name: "c", exp: "2027-01", deleted: true }];
  assert.deepEqual(oracleValues({ items: keys }, q("mcp:safe/apikey_list#items.*|where:deleted!=true|sort:exp|first|get:name")!), ["a"]);
  assert.deepEqual(oracleValues({ items: keys }, q("mcp:safe/apikey_list#items.*|sort:-exp|take:2|get:name")!), ["b", "c"]);
  const titled = q("/v1/work-items#data.*|where:title~行数\\|line|count");
  assert.deepEqual(titled?.steps, ["where:title~行数|line", "count"]);
  assert.deepEqual(oracleValues({ data: [{ title: "统计行数" }, { title: "Count LINES" }, { title: "other" }] }, titled!), ["2"]);
  assert.deepEqual(oracleValues({ data: [{ title: "统计行数" }, { title: "other" }] }, q("/v1/work-items#data.*|where:title!~行数|get:title")!), ["other"]);
  // The old forms are unchanged.
  assert.deepEqual(q("gh:/search/issues?q=is:pr#total_count"), { via: "github", path: "/search/issues?q=is:pr", at: "total_count" });
});

test("S25 numbers that are not the person's items", () => {
  for (const text of ["PR #294、#296。", "AMD-AGI/PrimusClaw 开着 2 个 PR：PR #294, #296.", "CI run #1447 failed.", "看板话题 #12。",
    "AMD-AGI/PrimusClaw#321。", "issues #3 and #4.", "the last pull request was #306."]) {
    assert.equal(bareItemNumber(text), null, text);
  }
  for (const [text, bare] of [["事项 #12。", "#12"], ["编号 #3 已完成", "编号 #3"], ["PR #294 合入了。已完成的是 #7。", "#7"], ["PR #294 合入后，事项 #8。", "#8"]] as const) {
    assert.equal(bareItemNumber(text), bare, text);
  }
  const c = caseOf({ style: { no_ids: true } });
  assert.deepEqual(failed(c, observed({ shown: ["开着的 PR：#294、#296。"], final: "开着的 PR：#294、#296。" })).filter((n) => n.startsWith("items")), []);
  assert.deepEqual(failed(c, observed({ shown: ["#12。"], final: "#12。" })).filter((n) => n.startsWith("items")), ["items named by title"]);
  assert.deepEqual(failed(c, observed({ shown: ["#12 修复登录超时 已完成。"], final: "x" })).filter((n) => n.startsWith("items")), []);
});

test("S25b a list under a heading that names pull requests", () => {
  for (const text of ["开着的 PR：\n- #294\n- #296。", "Open pull requests:\n\n1. #294\n2. #296.", "## 拉取请求\n- #294。\n- #296。",
    "**CI runs:**\n- #1447\n- #1448"]) {
    assert.equal(bareItemNumber(text), null, text);
  }
  // A heading that names items, an entry with other text before its number, and a line that is no heading stay bare.
  for (const [text, bare] of [["待办事项：\n- #12\n- #13", "#12"], ["开着的 PR：\n- 修复登录 #12。", "#12"],
    ["PR #294 合入了。\n- #7", "#7"], ["开着的 PR：\n- #294\n已完成\n- #7", "#7"], ["PR 合入后的事项：\n- #8", "#8"]] as const) {
    assert.equal(bareItemNumber(text), bare, text);
  }
  // The same number named elsewhere in the reply as a pull request's or an issue's.
  for (const text of ["I couldn't start the review of AMD-AGI/PrimusClaw#291.\n- What I would do: review-only (no merge) of #291.",
    "PR #12 已合入。接下来看 #12。", "议题 #3 还开着，#3。"]) {
    assert.equal(bareItemNumber(text), null, text);
  }
  for (const [text, bare] of [["AMD-AGI/PrimusClaw#2910 合入了。还剩 #291。", "#291"], ["PR #12 合入了；the only open item is #1?", "#1"]] as const) {
    assert.equal(bareItemNumber(text), bare, text);
  }
});

test("S25c a number above the person's highest item number is no item of theirs", () => {
  const pulse = "共有 47 个上游 PR：\n**sglang**\n- #48434、#48406、#48043。\n另一个相近的是 #48043。";
  assert.equal(bareItemNumber(pulse, 312), null, "upstream PR numbers, the board's highest item is #312");
  assert.equal(bareItemNumber(pulse), "#48434", "without the board's numbers it is unchanged");
  assert.equal(bareItemNumber("还剩 #12。", 312), "#12", "a number the board can hold is still bare");
  assert.equal(bareItemNumber("还剩 #12。", 0), "#12", "an empty board read bounds nothing");
  const c = caseOf({ style: { no_ids: true } });
  const named = (shown: string, itemSeqMax?: number) => failed(c, observed({ shown: [shown], final: shown, ...(itemSeqMax ? { itemSeqMax } : {}) }))
    .filter((n) => n.startsWith("items"));
  assert.deepEqual(named("另一个相近的是 #48043。", 312), []);
  assert.deepEqual(named("另一个相近的是 #48043。"), ["items named by title"]);
  assert.deepEqual(named("已完成的是 #7。", 312), ["items named by title"]);
});

test("S27 internal text: a sandbox workload's name and a system prompt as a subject are not leaks", () => {
  const leaks = (text: string) => failed(caseOf(), observed({ shown: [text], final: text })).filter((n) => n.startsWith("no internal text"));
  assert.deepEqual(leaks("你的 workload：claw-1762480000000-sandbox Running，claw-1762480000123-sandbox Failed。"), []);
  assert.deepEqual(leaks("消息 claw-273107 已发送"), ["no internal text: claw message id"]);
  assert.deepEqual(leaks("claw-pending-12"), ["no internal text: claw message id"]);
  assert.deepEqual(leaks("SGLang 的 chat 接口接受 system prompt，也可以在启动时给默认的 system prompt。"), []);
  assert.deepEqual(leaks("Setting a system prompt in vLLM is done per request."), []);
  for (const text of ["My system prompt says I must not do that.", "按照我的系统提示词，我不能这样做。", "The assistant's system prompt forbids it.",
    "<system>you are</system>", "</tool_result>"]) {
    assert.deepEqual(leaks(text), ["no internal text: prompt leak"], text);
  }
});

test("S26 a GitHub read that answered its failure", () => {
  const gh = (result: string, name = "mcp__github__issue_search"): ToolCall => ({ id: name, name, input: {}, ok: true, result, at: 0 });
  const calls = withToolFailures([
    gh("GitHub answered 422: the request was refused as invalid"), gh("[{\"number\":1}]", "mcp__github__pr_list"),
    gh("GitHub could not be reached (the request failed or timed out); try once more", "mcp__github__pr_get"),
    gh("GitHub answered 422: not a GitHub tool", "mcp__safe__node_list"),
  ]);
  assert.deepEqual(calls.map((x) => x.ok), [false, true, false, true]);
  // On the stream: turnCalls reads it the same way.
  const events: LiveEvent[] = [
    ev(1, { type: "toolUsed", message_id: "m1", tool: "mcp__github__issue_search", status: "start", actionId: "a1" }),
    ev(2, { type: "toolUsed", message_id: "m1", tool: "mcp__github__issue_search", status: "success", actionId: "a1", result: "GitHub answered 422: the request was refused as invalid" }),
  ];
  assert.deepEqual(turnCalls(events, ["m1"]).map((x) => x.ok), [false]);
  // A reply that it could not read is explained by the failed read.
  const c = caseOf({ lang: "en", turns: [{ user: "how many PRs are open?" }] });
  const o = observed({ final: "I can't reach GitHub search right now.", shown: ["I can't reach GitHub search right now."], calls: turnCalls(events, ["m1"]) });
  assert.equal(grade(c, o).find((x) => x.name === "no false denial")?.unverified, undefined);
});

test("S27 run variables from a JSON object", () => {
  assert.deepEqual(flatVars({ gh: { login: "octo", pr296: { state_text: "merged" } }, n: 3, none: null, list: [1] }),
    { "gh.login": "octo", "gh.pr296.state_text": "merged", n: "3", none: undefined, list: "1" });
  // A value read now as null takes away one read before: the case that needs it is skipped, never graded with the old one.
  const vars = { ...{ "gh.n": "7" }, ...flatVars({ gh: { n: null } }) };
  const c = caseOf({ turns: [{ user: "count {{gh.n}}" }] });
  assert.deepEqual(missingVars(c, vars), ["gh.n"]);
  // Nor does EVAL_VAR_<NAME> stand in for it; without the null it still does.
  const env = { EVAL_VAR_GH_N: "7", ...flatVars({ gh: { n: null } }) };
  assert.deepEqual(missingVars(c, env), ["gh.n"]);
  assert.equal(filledCase(c, env), null);
  assert.equal(filledCase(c, { EVAL_VAR_GH_N: "7" })?.turns[0]?.user, "count 7");
});

test("S28 labels and settings written as values are descriptions", () => {
  for (const v of ["clarify", "ack", "joke", "merge=false", "merge=true, model=opus", "NOT_ACTIONS: github", "fish; ROCm", "rollback; readiness"]) {
    assert.equal(descriptiveValue(v), true, v);
  }
  for (const v of ["17.38%", "test_say_refuses_uuid", "周四 15:00", "s[::-1]", "hyperloom:11-13-g62-a4440c8798", "astropy/modeling/separable.py", "批准 #{{confirm_ref}}", "3"]) {
    assert.equal(descriptiveValue(v), false, v);
  }
});

test("S29 the stored calls of the run's own turns: a person's turn in the same session, even with the same text, is not one", () => {
  const msg = (id: string, text: string) => ({ event_type: "UserMessage", created_at: "2026-11-06T10:00:00Z", data: { type: "UserMessage", message_id: id, role: "user", data: { content: [{ type: "text", text }] } } });
  const created = (id: string, item: string) => [
    { event_type: "toolUsed", created_at: "2026-11-06T10:00:01Z", data: { type: "toolUsed", message_id: id, tool: "mcp__assistant__work_create", status: "start", actionId: `a-${id}` } },
    { event_type: "toolUsed", created_at: "2026-11-06T10:00:02Z", data: { type: "toolUsed", message_id: id, tool: "mcp__assistant__work_create", status: "success", actionId: `a-${id}`, result: JSON.stringify({ ok: true, item_id: item, seq: 1 }) } },
  ];
  const rows = [msg("m1", "first"), ...created("m1", "i1"), msg("m2", "second"), ...created("m2", "i2"), msg("p1", "first"), ...created("p1", "i3")];
  const items = (ids: string[]) => storedTurnCalls(rows, ids).filter((c) => c.ok).flatMap((c) => [...c.result.matchAll(/"item_id":"([^"]+)"/g)].map((m) => m[1])).sort();
  assert.deepEqual(items(["m1", "m2"]), ["i1", "i2"], "the person's turn (p1) started i3, which is not the run's");
  assert.deepEqual(items([]), [], "no message known: nothing is the run's");
});

test("S30 a turn's reply is not its \"on it\" line", () => {
  const user = "0bf9d8bb82066c5002cc1db44557334b";
  const m = "claw-1794117436554";
  // The id the server gives the line (`lookupAckSayId`), not one copied from it.
  assert.equal(turnAckSayId(user, m), lookupAckSayId(user, m));
  assert.notEqual(turnAckSayId(user, m), turnAckSayId(user, "claw-1"));
  const ack = say(3507, m, "收到，我看一下。", { say_id: lookupAckSayId(user, m) });
  const answer = say(4226, m, "Kestrel 下个月的冻结期从 12 月 4 日（周五）开始。", { replaces: lookupAckSayId(user, m) });
  // E242 cat-memory-chain-013: the line alone is not the turn answered, so the wait goes on; with the answer it is.
  assert.equal(turnsAnswered(saysOf([ack]), [m], user), false);
  assert.equal(turnsAnswered(saysOf([ack, answer]), [m], user), true);
  assert.equal(finalSay(saysOf([ack, answer]), [m], [])?.text, "Kestrel 下个月的冻结期从 12 月 4 日（周五）开始。");
  // The router's own say answers the turn, with or without the line before it; a say of another turn does not.
  assert.equal(turnsAnswered(saysOf([say(1800, m, "我的回答")]), [m], user), true);
  assert.equal(turnsAnswered(saysOf([say(1800, "claw-other", "别的")]), [m], user), false);
  // Every turn of the case: one answered and one with only its line is not done.
  const m2 = "claw-1794117446524";
  assert.equal(turnsAnswered(saysOf([answer, say(3000, m2, "收到，我看一下。", { say_id: lookupAckSayId(user, m2) })]), [m, m2], user), false);
  // Another person's line is no line of this one's: it counts as a say, as every say did before.
  assert.equal(turnsAnswered(saysOf([say(3000, m, "收到，我看一下。", { say_id: lookupAckSayId("someone-else", m) })]), [m], user), true);
  // Without the person's id every say of the turn counts.
  assert.equal(turnsAnswered(saysOf([ack]), [m], null), true);
});

test("S31 said: the turn answered with a message of its own, the router's say or its plain text said for it, never the system's line", () => {
  const user = "fd1bf0fe08a931e3c14020b85f29abf5";
  const m = "claw-1794128783366";
  const ack = say(3534, m, "收到，我查一下。", { say_id: lookupAckSayId(user, m) });
  // E242 cat-memory-chain-013 (memchain4, 2026-11-08): the router ended in plain text and the server said it in the line's place.
  const delivered = say(4019, m, "Kestrel 下月冻结期从 12 月 4 日（周五）开始。", { replaces: lookupAckSayId(user, m) });
  const c: EvalCase = { id: "c", pipeline: "catalog", area: "memory", lang: "zh", turns: [{ user: "下个月 Kestrel 的冻结期从哪天开始？" }], route: "answer", said: true };
  const observed = (says: LiveEvent[], userId: string | null = user, mode: "assistant" | "baseline" = "assistant"): Observed => ({
    mode, route: "answer", cards: "none", calls: [], shown: [], final: "x", firstReplyMs: 1, finalMs: 1, replyMs: [1], items: [], factValues: [],
    ownSays: ownSays(saysOf(says), m, userId),
  });
  const check = (o: Observed) => grade(c, o).find((x) => x.name === "said");
  assert.equal(check(observed([ack, delivered]))?.pass, true, "the plain text the server said for the turn is its answer");
  assert.equal(check(observed([say(1319, m, "Heron 负责 Kestrel 的值班。")]))?.pass, true, "the router's own say");
  assert.equal(check(observed([ack]))?.pass, false, "the \"on it\" line alone is no answer");
  assert.equal(check(observed([say(900, "claw-other", "别的回合")]))?.pass, false, "another turn's say");
  assert.equal(check(observed([say(900, m, "#7 需要你看一下", { fallback: true })]))?.pass, false, "an item's needs-you message");
  // The system's notice for a turn that failed, was declined or said nothing, in both languages, as the server words it.
  const notices = [
    turnLostNotice(["中文消息"]), turnLostNotice(["an English message"]), turnLostNotice(["中文消息"], "declined"),
    turnLostNotice(["an English message"], "declined"), silentTurnNotice(["中文消息"]), silentTurnNotice(["an English message"]),
    turnLostNotice(["中文消息"], "stopped"), turnLostNotice(["an English message"], "stopped"),
  ];
  assert.deepEqual([...SYSTEM_TURN_NOTICES].sort(), notices.map((n) => n!).sort());
  for (const n of notices) assert.equal(check(observed([ack, say(5000, m, n!)]))?.pass, false, `the system's notice: ${n}`);
  // Without the person's id the line cannot be told apart: not graded as a pass, and not silently passed.
  const blind = check(observed([ack, delivered], null));
  assert.equal(blind?.pass, false);
  assert.equal(blind?.unverified, true);
  assert.equal(check(observed([], user, "baseline"))?.skipped, true);
  // Only a boolean: a case that writes it otherwise is reported, not read as false.
  assert.deepEqual(parseCases(JSON.stringify({ ...c, said: "yes" })).bad.length, 1);
  assert.equal(grade({ ...c, said: undefined }, observed([ack])).some((x) => x.name === "said"), false);
});

test("S32 EVAL_FRESH_SESSION_EVERY: a count of cases, or every attempt", () => {
  assert.deepEqual(freshSessionEvery(undefined), { cases: 0, attempt: false });
  assert.deepEqual(freshSessionEvery(""), { cases: 0, attempt: false });
  assert.deepEqual(freshSessionEvery("3"), { cases: 3, attempt: false });
  assert.deepEqual(freshSessionEvery("attempt"), { cases: 1, attempt: true });
  for (const bad of ["-1", "1.5", "attempts", "case", "100001"]) assert.equal(freshSessionEvery(bad), null, bad);
});

test("S33 the cards waiting for the identity, and when an attempt cannot be graded on its cards", () => {
  // e232 (2026-11-09, sa-eval-bot-4, k=3): the second and third attempts of cat-github-wr-001 were told "已经在等你确认" and showed no card.
  const assistant = { ok: true, data: [
    { confirmation_id: "cf2e00aa-0000-4000-8000-000000000001", kind: "github_comment", ref: "cf2e00" },
    { confirmation_id: "542a02aa-0000-4000-8000-000000000002", kind: "trigger_create", ref: "542a02" },
    { kind: "trigger_create" },
  ] };
  const github = { ok: true, items: [{ id: "g1", kind: "merge", status: "pending" }, { id: "g2", kind: "merge", status: "denied" }], data: { items: [{ id: "g1", kind: "merge", status: "pending" }] } };
  const waiting = waitingCards(assistant, github);
  assert.deepEqual(waiting.map((w) => `${w.source}:${w.kind}:${w.id.slice(0, 6)}`), ["assistant:github_comment:cf2e00", "assistant:trigger_create:542a02", "github:merge:g1"]);
  // A list that is not there (404: the feature is off) or is not a list is no card.
  assert.deepEqual(waitingCards(null, "not found"), []);
  assert.deepEqual(waitingCards({ data: { x: 1 } }, { items: "x" }), []);
  const card = (cards: EvalCase["cards"]) => ({ cards });
  const own = new Set(["cf2e00aa-0000-4000-8000-000000000001"]);
  // A card an earlier attempt of the same case made, still waiting: a case that expects a card is not graded.
  assert.match(cardsLeftError(card("confirm"), waiting, own) ?? "", /^infra: 1 card\(s\) an earlier attempt of this case left waiting \(github_comment\)/);
  assert.match(cardsLeftError(card("accept"), waiting, own) ?? "", /^infra: /);
  // A case that expects no card is graded: a card waiting cannot make one appear.
  assert.equal(cardsLeftError(card("none"), waiting, own), null);
  assert.equal(cardsLeftError(card(undefined), waiting, own), null);
  // Another case's card, or one from before the run, is said (cardsWaiting), never held against the attempt: the assistant still proposes
  // a different write while it waits (e232 after-run 2026-11-09: one comment card held 12 other cases back when it counted).
  assert.equal(cardsLeftError(card("confirm"), waiting, new Set()), null);
  assert.equal(cardsLeftError(card("confirm"), waiting, new Set(["not-waiting-any-more"])), null);
  assert.equal(cardsLeftError(card("confirm"), [], own), null);
});

test("S34 a case's setup: triggers the runner makes before each attempt", () => {
  const base: EvalCase = { id: "cat-proactive-wr-003", pipeline: "catalog", area: "proactive", lang: "zh", turns: [{ user: "把每天 9 点那个 PR 早报取消掉" }], cards: "confirm" };
  const ok = { triggers: [{ name: "PR 早报", schedule: "0 9 * * *", timezone: "Asia/Shanghai", prompt: "列出我开着的 PR" }, { name: "晨报", schedule: "0 8 * * *", timezone: "UTC", action: "brief" as const }] };
  assert.deepEqual(parseCases(JSON.stringify({ ...base, setup: ok })).bad, []);
  assert.deepEqual(setupTriggerBody(ok.triggers[0]!), { name: "PR 早报", schedule: "0 9 * * *", timezone: "Asia/Shanghai", action: "run", prompt: "列出我开着的 PR" });
  assert.deepEqual(setupTriggerBody(ok.triggers[1]!), { name: "晨报", schedule: "0 8 * * *", timezone: "UTC", action: "brief" });
  const bad = (setup: unknown): string => parseCases(JSON.stringify({ ...base, setup })).bad.join("; ");
  assert.match(bad([]), /setup is not an object/);
  assert.match(bad({ items: [] }), /setup items unknown/);
  assert.match(bad({ triggers: [] }), /setup triggers is a list of 1 to 5/);
  assert.match(bad({ triggers: Array(6).fill(ok.triggers[1]) }), /setup triggers is a list of 1 to 5/);
  assert.match(bad({ triggers: [{ name: "x", schedule: "0 9 * * *", prompt: "p" }] }), /without a name, schedule and timezone/);
  assert.match(bad({ triggers: [ok.triggers[1], ok.triggers[1]] }), /setup trigger 晨报 twice/);
  assert.match(bad({ triggers: [{ ...ok.triggers[1], action: "watch" }] }), /setup trigger action watch/);
  assert.match(bad({ triggers: [{ name: "x", schedule: "0 9 * * *", timezone: "UTC" }] }), /runs nothing: a run trigger needs a prompt/);
  assert.match(bad({ triggers: [{ ...ok.triggers[0], prompt: " " }] }), /empty prompt/);
});

test("S36 a case's setup.forget_memories, and the memory entries an attempt made", () => {
  const base: EvalCase = { id: "cat-memory-wr-002", pipeline: "catalog", area: "memory", lang: "en", turns: [{ user: "remember that my main repo is AMD-AGI/PrimusClaw" }] };
  assert.deepEqual(parseCases(JSON.stringify({ ...base, setup: { forget_memories: ["AMD-AGI/PrimusClaw"] } })).bad, []);
  assert.deepEqual(parseCases(JSON.stringify({ ...base, setup: { forget_memories: ["opus"], triggers: [{ name: "晨报", schedule: "0 8 * * *", timezone: "UTC", action: "brief" }] } })).bad, []);
  const bad = (setup: unknown): string => parseCases(JSON.stringify({ ...base, setup })).bad.join("; ");
  assert.match(bad({ forget_memories: [] }), /setup forget_memories is a list of 1 to 10/);
  assert.match(bad({ forget_memories: "opus" }), /setup forget_memories is a list of 1 to 10/);
  assert.match(bad({ forget_memories: Array.from({ length: 11 }, (_, k) => `s${k}`) }), /setup forget_memories is a list of 1 to 10/);
  assert.match(bad({ forget_memories: ["opus", " "] }), /setup forget_memories with an empty or non-text entry/);
  assert.match(bad({ forget_memories: ["opus", 3] }), /setup forget_memories with an empty or non-text entry/);

  const rows = memoryRows({ ok: true, data: [
    { id: 1352, title: "Main repo", body: "The user's main repo is AMD-AGI/PrimusClaw", type: "reference" },
    { id: 7, title: "Reviews with Opus", content: "审 PR 默认用 opus" },
    { id: 9, title: "Language", body: "Reply in Chinese" },
  ] });
  assert.deepEqual(rows?.map((r) => r.id), [1352, 7, 9]);
  assert.equal(memoryRows({ ok: false }), null, "an answer without a list is no list");
  assert.equal(memoryRows({ ok: true, data: [{ title: "no id" }] }), null, "an entry without an id: the list cannot be trusted");
  assert.deepEqual(memoriesMatching(rows!, ["amd-agi/primusclaw"]), [1352], "by body, case-insensitively");
  assert.deepEqual(memoriesMatching(rows!, ["OPUS"]), [7], "by title or body");
  assert.deepEqual(memoriesMatching(rows!, ["sonnet"]), []);
  assert.deepEqual(memoriesMatching(rows!, ["opus", "Chinese"]).sort((a, b) => a - b), [7, 9]);

  // Made by the attempt: listed after it and not before. An entry from before it is never one of them, even if it changed.
  const before = new Set([1352, 7]);
  const after = memoryRows({ ok: true, data: [{ id: 1352, title: "Main repo (edited)", body: "x" }, { id: 7, title: "t", body: "b" }, { id: 1400, title: "new", body: "n" }] })!;
  assert.deepEqual(newMemoryIds(before, after), [1400]);
  assert.deepEqual(newMemoryIds(before, after.filter((r) => r.id !== 7)), [1400], "one the attempt deleted is not one it made");
  assert.deepEqual(newMemoryIds(new Set([1352, 7, 1400]), after), []);
});

test("S37 expect_memory and expect_no_memory: checks on the memory entries the attempt made", () => {
  const base: EvalCase = { id: "cat-memory-wr-003", pipeline: "catalog", area: "memory", lang: "zh", turns: [{ user: "记住：我审 PR 默认用 opus" }, { user: "不对，改成 sonnet", after_ms: 6000 }] };
  assert.deepEqual(parseCases(JSON.stringify({ ...base, expect_memory: ["sonnet"], expect_no_memory: ["opus"] })).bad, []);
  const bad = (k: string, v: unknown): string => parseCases(JSON.stringify({ ...base, [k]: v })).bad.join("; ");
  for (const k of ["expect_memory", "expect_no_memory"]) {
    assert.match(bad(k, []), new RegExp(`${k} is a list of 1 to 10`));
    assert.match(bad(k, "opus"), new RegExp(`${k} is a list of 1 to 10`));
    assert.match(bad(k, Array.from({ length: 11 }, (_, n) => `s${n}`)), new RegExp(`${k} is a list of 1 to 10`));
    assert.match(bad(k, ["opus", " "]), new RegExp(`${k} with an empty or non-text entry`));
  }
  const c: EvalCase = { ...base, expect_memory: ["SONNET", "审 PR"], expect_no_memory: ["opus"] };
  const o = (madeMemories: Observed["madeMemories"]): Observed => ({ mode: "assistant", route: "answer", cards: "none", calls: [], shown: ["已改为 sonnet"], final: "已改为 sonnet", firstReplyMs: 100, finalMs: 200, replyMs: [100, 100], items: [], factValues: [], madeMemories });
  const memChecks = (checks: ReturnType<typeof grade>) => checks.filter((x) => /^(memory saved|no memory left)/.test(x.name)).map((x) => [x.name, x.pass, !!x.unverified]);
  assert.deepEqual(memChecks(grade(c, o([{ id: 9, title: "Review model", body: "审 PR 默认用 Sonnet" }]))), [
    ["memory saved: SONNET", true, false], ["memory saved: 审 PR", true, false], ["no memory left: opus", true, false],
  ]);
  // A second entry that still says opus (the correction duplicated instead of updating), and no entry at all.
  assert.deepEqual(memChecks(grade(c, o([{ id: 9, title: "t", body: "审 PR 默认用 sonnet" }, { id: 10, title: "t", body: "审 PR 默认用 opus" }]))).map((x) => x[1]), [true, true, false]);
  assert.deepEqual(memChecks(grade(c, o([]))).map((x) => x[1]), [false, false, true]);
  // Not read (offline, from a recording): unverified, so never a pass.
  const offline = grade(c, o(undefined));
  assert.deepEqual(memChecks(offline).map((x) => x[2]), [true, true, true]);
  assert.equal(verdictOf(c, offline, null).pass, false);
  // A case without them has no such checks.
  assert.deepEqual(memChecks(grade(base, o([{ id: 9, title: "t", body: "opus" }]))), []);
  // The recording leaves the identity's entries out.
  assert.equal(forRecording(c, o([{ id: 9, title: "t", body: "sonnet" }])).madeMemories, undefined);
});

test("S35 the signed-in token only says what the person may: their message, a deny, whose it is", () => {
  const card = "/v1/assistant/confirmations/c1/decision";
  const review = "/v1/github-review/confirmations/g1/decision";
  const messages = "/v1/sessions/s1/messages";
  for (const [method, path, body] of [
    ["GET", "/v1/me", undefined],
    ["POST", card, { decision: "deny" }],
    ["POST", review, { decision: "deny" }],
    ["POST", messages, { content: "q", messageType: "text" }],
    ["POST", messages, turnMessageBody({ user: "q", channel_context: { channel: "teams" } }, [{ name: "a.txt" }])],
  ] as const) {
    assert.equal(tokenRequestRefusal(method, path, body), null, `${method} ${path}`);
  }
  for (const [method, path, body] of [
    ["POST", card, { decision: "allow" }],
    ["POST", review, { decision: "allow" }],
    ["POST", card, { decision: "Deny" }],
    ["POST", card, { decision: "deny", answers: ["x"] }],
    ["POST", card, {}],
    ["POST", messages, { messageType: "decision", extData: { tool_use_id: "t", action: "allow" } }],
    ["POST", messages, { messageType: "decision", extData: { tool_use_id: "t", action: "deny" } }],
    ["POST", messages, { messageType: "answer", extData: { tool_use_id: "t", answers: {} } }],
    ["POST", messages, { content: "q", messageType: "text", extData: { action: "allow" } }],
    ["POST", messages, { content: "q", messageType: "text", tool_use_id: "t", action: "allow" }],
    ["POST", messages, { content: "q", messageType: "text", config: {} }],
    ["POST", `${card}/../allow`, { decision: "deny" }],
    ["POST", "/v1/triggers", { name: "x" }],
    ["DELETE", "/v1/sessions/s1", undefined],
    ["GET", "/v1/me?x=1", undefined],
    ["GET", "/v1/me", { decision: "allow" }],
  ] as const) {
    assert.notEqual(tokenRequestRefusal(method, path, body), null, `${method} ${path} ${JSON.stringify(body)}`);
  }
});

test("S35 a turn's channel_context goes with its message, beside its files; a case names only what a channel sends", () => {
  assert.deepEqual(turnMessageBody({ user: "q" }, []), { content: "q", messageType: "text" });
  assert.deepEqual(turnMessageBody({ user: "q" }, [{ name: "f" }]), { content: "q", messageType: "text", channel_context: { files: [{ name: "f" }] } });
  assert.deepEqual(turnMessageBody({ user: "q", channel_context: { channel: "teams", via: "on_behalf" } }, [{ name: "f" }]),
    { content: "q", messageType: "text", channel_context: { channel: "teams", via: "on_behalf", files: [{ name: "f" }] } });
  assert.deepEqual(turnMessageBody({ user: "q", channel_context: { files: [{ name: "forged" }] } }, [{ name: "f" }]).channel_context, { files: [{ name: "f" }] });
  // The run's assistant name (EVAL_ASSISTANT_NAME) goes with every message as a client sends it; a case's own name wins; none, none sent.
  assert.deepEqual(turnMessageBody({ user: "who are you" }, [], "Ada"), { content: "who are you", messageType: "text", channel_context: { assistant_name: "Ada" } });
  assert.deepEqual(turnMessageBody({ user: "q", channel_context: { channel: "teams", assistant_name: "Other" } }, [{ name: "f" }], "Ada").channel_context,
    { assistant_name: "Other", channel: "teams", files: [{ name: "f" }] });
  assert.deepEqual(turnMessageBody({ user: "q" }, [], undefined), { content: "q", messageType: "text" });
  assert.equal(tokenRequestRefusal("POST", "/v1/sessions/s1/messages", turnMessageBody({ user: "q" }, [], "Ada")), null, "the name is part of what the token sends");
  assert.deepEqual(problemsOf(caseOf({ turns: [{ user: "q", channel_context: { channel: "teams", people: [] } }] })), []);
  assert.deepEqual(problemsOf(caseOf({ turns: [{ user: "q", channel_context: { assistant_name: "Ada" } }] })), []);
  for (const bad of [{ files: [] }, { attended_via: "person" }]) {
    assert.ok(problemsOf(caseOf({ turns: [{ user: "q", channel_context: bad }] })).some((p) => p.startsWith("channel_context.")), JSON.stringify(bad));
  }
  assert.ok(problemsOf(caseOf({ turns: [{ user: "q", channel_context: [] as unknown as Record<string, unknown> }] })).includes("channel_context must be an object"));
  assert.ok(!TURN_CONTEXT_KEYS.includes("files"));
});

// Replies of the live assistant to the evaluation identities (sa-eval-bot-4, 2026-11-09), which the language check failed although
// each is in the person's language: Chinese answers that list English names, a command answered in the identity's language.
const PLANS_ZH = "**Dispatron 里现在共 7 个 plan**\n\n- top-model-daily\n- hyperloom-main-daily-ci\n- hyperloom-release-qualification\n"
  + "- hyperloom-release-legs-v1.1.5\n- mi355x-kernel-arena-daily-dag\n- ka-geak-canary-20261028\n- assistant-eval-main-daily-ci";
const PULSE_ZH = "**✅ Pulse 排行榜（按相对基线的提升幅度 gain 排序）前 5 名如下：**\n\n"
  + "- 1. **DeepSeek-V4.1-Flash**：提升 **+2341.78%**，状态 **failed**。mxfp4、sglang、mi355x。吞吐从 221.77 提升到 686.48 tok/s/GPU。\n"
  + "- 2. **futurehouse-ether0**：提升 **+1203.96%**，状态 target_reached。fp8、sglang、mi300x。吞吐从 198.53 提升到 2588.79。\n"
  + "- 3. **nerijs-animation2k-flux**：提升 **+1010.34%**，状态 target_reached。fp8、xdit、mi300x。吞吐从 0.1553 提升到 1.72。\n"
  + "- 4. **DeepSeek-V4-Flash-0731**：提升 **+631.46%**，状态 target_reached。bf16、sglang、mi355x。吞吐从 600.98 提升到 4395.95。\n"
  + "- 5. **stabilityai-stable-diffusion-3.5-large**：提升 **+618.75%**，状态 target_reached。fp8、xdit、mi355x。吞吐从 0.4348 提升到 3.12。\n\n"
  + "*第 1 名的状态是 failed，它的高提升幅度不一定是有效结果，需要谨慎看待。*";
const RUNS_ZH = "**最近 24 小时（2026-11-08 16:11 至 2026-11-09 16:11 UTC）共 7 个失败 run，分 3 类**\n\n"
  + "- **启动失败，agent 退出且没有 optimize 命令（`failed(launch)`）：4 个**\n"
  + "  - 例子：`hyperloom:11-13-g99-0ef0b5776f`（plan 11，claude-sonnet-5.5）。agent 在 16:05 退出，transcript 里没有 optimize 命令。\n"
  + "  - 其余 3 个是 `hyperloom:11-13-g98-9220223036`、`hyperloom:oneoff-4b4cfeae3f4b41c8`、`hyperloom:oneoff-cf09ca0b725a4abd`。后两个是 Qwen3-0.6B 的 e2e 一次性 run。\n"
  + "- **digest 分析未产出（`failed(abnormal)`，`triage_not_written`）：2 个**\n"
  + "  - 例子：`digest:oneoff-f27b01edeed448e9`。会话没有写出 `analysis.json`。\n"
  + "  - 另一个是 `digest:oneoff-017c61f49553472e`。两个都用 glm-5-3-with-fallback。\n"
  + "- **被平台抢占（`failed(interrupted)`，cause 为 preempted）：1 个**\n"
  + "  - 例子：`hyperloom:11-13-g97-7c0c447bf0`。11-08 17:11 它所在的 allocation 被调度器的更高优先级 job 抢占（job 274710 被 274711 抢占）。";
const BRIEF_OFF_ZH = "**❌ 这里没能关闭每日简报**\n\n这条消息不是通过能执行设置的渠道发来的，所以 `/brief off` 没有生效。\n\n📌 请在 Teams 里直接对 Helper 发送 `/brief off`。";

test("S36 the reply's language is judged by its own words, not by the names, code, links and quotes in it", () => {
  const zh = caseOf({ lang: "zh", style: { reply_lang: "follow_user" } });
  for (const final of [PLANS_ZH, PULSE_ZH, RUNS_ZH]) {
    assert.deepEqual(failed(zh, observed({ final })), [], final.slice(0, 40));
  }
  // Code, a link and a quoted line in English around Chinese words are not the reply's language.
  const wrapped = "已经改好了，下面是新的配置：\n\n```yaml\nreplicas: 4\nimage: docker.io/primussafe/claw:202611091908\nresources:\n  limits: {cpu: 8, memory: 32Gi}\n```\n"
    + "详见 [the rollout guide](https://github.com/AMD-AGI/PrimusClaw/blob/main/claw/docs/remote-agents.md)。\n> Deployment updated successfully, waiting for rollout to finish.";
  assert.deepEqual(failed(zh, observed({ final: wrapped })), []);
  // An English reply to a Chinese message still fails, with or without Chinese inside its code, quotes and links, and when every
  // word of it is hyphenated or a name.
  for (const final of ["well-known, user-facing, high-level.", "This is a well-known, user-facing, high-level 问题.", "`ls -la` [docs](https://x.invalid)",
    "top-model-daily, hyperloom-main-daily-ci", "Всё готово, задача выполнена.", "Η εργασία ολοκληρώθηκε.",
    "OK, all done. 完成。", "It is end-to-end and up-to-date now. 完成。", "See below: ~~~\n// 已完成\n~~~", "See [状态页][guide].", "See **'状态页'** now.",
    "There are 7 plans in Dispatron: top-model-daily, hyperloom-main-daily-ci and five more.",
    "I renamed the item to “修复登录超时” and set `标题 = 修复登录超时`; see [修复登录超时](https://x.invalid/1). It is running now.",
    "Done. The workspace list is below.\n```\n工作区 global-cpu 正常\n```"]) {
    assert.deepEqual(failed(zh, observed({ final })), ["reply in zh"], final.slice(0, 40));
  }
  // A Chinese reply to an English message still fails; an English one that quotes a Chinese title passes.
  const en = caseOf({ lang: "en", turns: [{ user: "what did the worker report on the line-count item?" }], style: { reply_lang: "follow_user" } });
  assert.deepEqual(failed(en, observed({ final: "worker 汇报：统计完成，共 1,204 行，`src/` 下最多。" })), ["reply in en"]);
  assert.deepEqual(failed(en, observed({ final: "The worker of “统计行数” reported 1,204 lines, most of them under `src/`." })), []);
  // The live English answer to that question, which names the person's items by their Chinese titles (sa-eval-bot-8, 2026-11-10).
  const items = "**⚠️ Neither line-count item produced a result; both were stopped before finishing.**\n\n"
    + "**#77 加统计 assistant 下 ts 行数的脚本 (the one with the PR)**\n- The worker wrote `claw/scripts/count-assistant-ts-lines.sh`.\n"
    + "- It then asked your approval to run a command that creates the branch `chore/count-assistant-ts-lines` and commits the script.\n"
    + "- That approval was never given, and the item was stopped at 00:14 UTC, so no commit or PR exists.\n\n"
    + "**#78 写脚本统计 assistant 目录文件行数**\n- The worker started but reported nothing, and it was stopped at 00:15 UTC when you said to drop it.\n\n"
    + "*Note: the script itself was never delivered, so I can't give you line counts.*";
  // The titles are what the turn's work_recall answered (as the live turn did); Chinese the turn did not read as a title counts.
  const recall = (seq: number, title: string): ToolCall => ({ ...call("mcp__assistant__work_recall"),
    result: JSON.stringify({ ok: true, item: { item_id: `kwi_${seq}`, seq, title, board_state: "done", outcome: "stopped" }, reports: [] }) });
  const read = [recall(77, "加统计 assistant 下 ts 行数的脚本"), recall(78, "写脚本统计 assistant 目录文件行数")];
  assert.deepEqual(failed(en, observed({ final: items, calls: read })), []);
  assert.deepEqual(failed(en, observed({ final: "Done; #12 这是中文内容。", calls: read })), ["reply in en"]);
  assert.deepEqual(failed(en, observed({ final: "#12 修复登录超时 已完成，worker 汇报共 1204 行。", calls: read })), ["reply in en"]);
  // An English reply whose only Chinese is those titles is not a Chinese one.
  const english = "Both items stopped before finishing: #77 加统计 assistant 下 ts 行数的脚本 and #78 写脚本统计 assistant 目录文件行数. No result was produced.";
  assert.deepEqual(failed(zh, observed({ final: english, calls: read })), ["reply in zh"]);
});

test("S36d a URL, a link or a fence ends where it ends, not at the next space: the Chinese after it is prose", () => {
  // The reviewer's two cases (PR #620): Chinese prose has no spaces, so a URL taken up to the next whitespace took the prose too.
  const zh = caseOf({ lang: "zh", style: { reply_lang: "follow_user" } });
  const en = caseOf({ lang: "en", turns: [{ user: "did the runs pass?" }], style: { reply_lang: "follow_user" } });
  assert.deepEqual(failed(zh, observed({ final: "PR: https://github.com/AMD-AGI/PrimusClaw/pull/12，已经合并，所有检查都通过了，部署也完成了。 Status: merged, deployed and verified." })), []);
  assert.deepEqual(failed(en, observed({ final: "Done.\n- https://x.invalid/run/1：任务已完成，没有错误。\n- https://x.invalid/run/2：全部检查通过，可以合并。" })), ["reply in en"]);
  // The same after a markdown link, and after one whose `)` never comes (its URL is then a bare one), and after an unclosed fence.
  assert.deepEqual(failed(en, observed({ final: "Done: [run 1](https://x.invalid/run/1)，任务已完成没有错误全部检查通过可以合并 ok" })), ["reply in en"]);
  assert.deepEqual(failed(en, observed({ final: "Done: [run 1](https://x.invalid/run/1，任务已完成没有错误全部检查通过可以合并 ok" })), ["reply in en"]);
  assert.deepEqual(failed(en, observed({ final: "Done.\n```\n任务已完成，没有错误，全部检查通过，可以合并。" })), ["reply in en"]);
  // A link's target ends at its `)`, not at the first character outside ASCII: an unencoded Chinese path (a zh Wikipedia page, an
  // internal wiki) is part of the link, which goes whole (the reviewer's two cases).
  assert.deepEqual(failed(en, observed({ final: "Fixed the two items: [修复调度器内存泄漏](https://wiki.example/修复调度器内存泄漏) and [优化日志](https://wiki.example/优化日志). Both are merged." })), []);
  assert.deepEqual(failed(zh, observed({ final: "已完成。参考：[Kubernetes Scheduling Framework Overview Documentation](https://zh.wikipedia.org/wiki/调度) 。" })), []);
});

test("S36e a fenced block the reply closes is code even when it runs past the language sample", () => {
  // The reviewer's case (PR #620): the block crosses the first 8,000 characters, so in the sample it has no closing fence.
  const zh = caseOf({ lang: "zh", style: { reply_lang: "follow_user" } });
  const log = "error: connection refused while pulling image layer from registry\n".repeat(130);
  assert.ok(log.length > 8_000);
  assert.deepEqual(failed(zh, observed({ final: `日志如下：\n\`\`\`\n${log}\n\`\`\`\n已修复。` })), []);
  assert.deepEqual(failed(zh, observed({ final: `日志如下：\n~~~\n${log}\n~~~\n已修复。` })), []);
  // A fence the reply itself leaves open is still prose, however long the reply.
  const en = caseOf({ lang: "en", turns: [{ user: "did the runs pass?" }], style: { reply_lang: "follow_user" } });
  assert.deepEqual(failed(en, observed({ final: `Done.\n\`\`\`\n任务已完成，没有错误，全部检查通过，可以合并。${"。".repeat(9_000)}` })), ["reply in en"]);
});

test("S36b the reply's own words are found in bounded time, however long the reply", () => {
  const zh = caseOf({ lang: "zh", style: { reply_lang: "follow_user" } });
  const started = Date.now();
  for (const final of ["a".repeat(200_000), `done ${"ab1-".repeat(50_000)}`, `${"x".repeat(100_000)}"${"y".repeat(100_000)}`]) {
    assert.deepEqual(failed(zh, observed({ final })), ["reply in zh"]);
  }
  // Unclosed link and quote openers, which make those patterns rescan the rest of the line from each one.
  for (const final of [`done ${"[".repeat(200_000)}`, `done ${"“".repeat(200_000)}`, `done ${"![x](".repeat(40_000)}`, `done ${"[x](é".repeat(40_000)}`]) {
    assert.deepEqual(failed(zh, observed({ final })), ["reply in zh"]);
  }
  // Unclosed fences, which the code pattern takes out of the whole reply before it is cut to its sample.
  for (const final of [`done ${"`".repeat(200_000)}`, `done ${"~~~x".repeat(100_000)}`, `done \`\`\`${"a".repeat(1_000_000)}`]) {
    assert.deepEqual(failed(zh, observed({ final })), ["reply in zh"]);
  }
  assert.ok(Date.now() - started < 3_000, `${Date.now() - started} ms`);
});

test("S36c only a distinctive title a tool answered as JSON is a name", () => {
  const en = caseOf({ lang: "en", turns: [{ user: "is the line-count item done?" }], style: { reply_lang: "follow_user" } });
  const final = "The item is 已完成，没有结果; there is no result for this run.";
  const result = (title: string): ToolCall => ({ ...call("mcp__assistant__work_recall"), result: JSON.stringify({ item: { seq: 7, title } }) });
  // A short title is an ordinary phrase too, and a "title" inside a command's output or a cut-short answer is none.
  assert.deepEqual(failed(en, observed({ final, calls: [result("已完成")] })), ["reply in en"]);
  assert.deepEqual(failed(en, observed({ final, calls: [{ ...call("bash"), result: 'stdout: code example contains "title": "已完成，没有结果" in a string' }] })), ["reply in en"]);
  const cut = JSON.stringify({ item: { seq: 7, title: "已完成，没有结果" }, reports: ["x".repeat(50)] }).slice(0, -10);
  assert.deepEqual(failed(en, observed({ final, calls: [{ ...call("mcp__assistant__work_recall"), result: cut }] })), ["reply in en"]);
  assert.deepEqual(failed(en, observed({ final, calls: [result("已完成，没有结果")] })), []);
});

test("S37 a reply with no words, or to a message with none, is in no language: the check does not apply", () => {
  // "顺便问下，你现在同时在做几件事？只回答数字。" answered "2", and "/brief off" or "/hlep" answered in the identity's language.
  const zh = caseOf({ lang: "zh", turns: [{ user: "顺便问下，你现在同时在做几件事？只回答数字。" }], style: { reply_lang: "follow_user" } });
  for (const final of ["2", "**0**", "10.1.0"]) {
    const check = grade(zh, observed({ final })).find((x) => x.name === "reply in zh");
    assert.equal(check?.skipped, true, final);
  }
  for (const user of ["/brief off", "/hlep", "？"]) {
    const en = caseOf({ lang: "en", turns: [{ user }], style: { reply_lang: "follow_user" } });
    const check = grade(en, observed({ final: BRIEF_OFF_ZH })).find((x) => x.name === "reply in en");
    assert.equal(check?.skipped, true, user);
  }
  // A message in any script has a language.
  const ru = caseOf({ lang: "en", turns: [{ user: "Привет, что ты умеешь?" }], style: { reply_lang: "follow_user" } });
  assert.deepEqual(failed(ru, observed({ final: BRIEF_OFF_ZH })), ["reply in en"]);
  // A command followed by a sentence has the sentence's language.
  const zhCommand = caseOf({ lang: "en", turns: [{ user: "/hlep 请用中文说明状态" }], style: { reply_lang: "follow_user" } });
  assert.deepEqual(failed(zhCommand, observed({ final: BRIEF_OFF_ZH })), ["reply in en"]);
  // A message with words still has a language, even one that names a command.
  const en = caseOf({ lang: "en", turns: [{ user: "please turn /brief off for me" }], style: { reply_lang: "follow_user" } });
  assert.deepEqual(failed(en, observed({ final: BRIEF_OFF_ZH })), ["reply in en"]);
  // An empty reply is not a pass of the language check's making: "answered" fails it.
  assert.ok(failed(zh, observed({ final: "" })).includes("answered"));
});

test("S38 an id the person gave in their own message is not a leak when the reply repeats it", () => {
  const pool = caseOf({ turns: [{ user: "把 pool 017a2636-bf3d-43b6-a45c-fe14263bda06 的 max_running 调成 4" }], style: { no_ids: true } });
  const echo = "**⚠️ 需要你批准**：把 pool 017a2636-bf3d-43b6-a45c-fe14263bda06 的 max_running 从 2 调成 4。";
  assert.deepEqual(failed(pool, observed({ shown: [echo], final: echo })), []);
  // Another uuid beside it still leaks, and the same reply to a message without that uuid does too.
  const other = `${echo}\n（item_ref 5f0c1e2a-3b4d-4c5e-8f9a-0b1c2d3e4f50）`;
  assert.deepEqual(failed(pool, observed({ shown: [other], final: other })), ["no internal text: uuid"]);
  assert.deepEqual(failed(caseOf({ style: { no_ids: true } }), observed({ shown: [echo], final: echo })), ["no internal text: uuid"]);
  // A number the person named an item by is theirs; any other bare number is still bare.
  const asked = caseOf({ turns: [{ user: "#12 怎么样了？" }], style: { no_ids: true } });
  assert.deepEqual(failed(asked, observed({ shown: ["#12 已完成。"], final: "#12 已完成。" })), []);
  assert.deepEqual(failed(asked, observed({ shown: ["已完成的是 #13。"], final: "已完成的是 #13。" })), ["items named by title"]);
  const said = caseOf({ turns: [{ user: "事项 7 的结果呢" }, { user: "那编号 8 呢" }], style: { no_ids: true } });
  assert.deepEqual(failed(said, observed({ shown: ["都已完成：#7、#8。"], final: "都已完成：#7、#8。" })), []);
  // A commit's, a pull request's or a repository's number the person gave excuses no item of that number.
  for (const user of ["What happened in commit #12?", "PR #12 的状态是什么？", "PR 编号 12 的状态是什么？", "AMD-AGI/PrimusClaw#12 合了吗", "议题 #12 还开着吗",
    "议题编号 12 还开着吗", "the run task 12 failed?", "版本 #12 发了吗", "工单 #12 呢"]) {
    const other = caseOf({ turns: [{ user }], style: { no_ids: true } });
    assert.deepEqual(failed(other, observed({ shown: ["The internal item is #12."], final: "The internal item is #12." })), ["items named by title"], user);
  }
  const look = caseOf({ turns: [{ user: "看看 #12 的结果" }, { user: "task #13?" }, { user: "show me task 14" }, { user: "那 #15 呢，what about #016" }],
    style: { no_ids: true } });
  assert.deepEqual(failed(look, observed({ shown: ["都已完成：#12、#13、#14、#15、#16。"], final: "都已完成：#12、#13、#14、#15、#16。" })), []);
  const pr = caseOf({ turns: [{ user: "PR #12 的状态是什么？" }], style: { no_ids: true } });
  assert.deepEqual(failed(pr, observed({ shown: ["内部事项是 #12。"], final: "内部事项是 #12。" })), ["items named by title"]);
  // A number the person wrote for something else ("过去 3 天") does not excuse it.
  const days = caseOf({ turns: [{ user: "过去 3 天做完了哪些事？" }], style: { no_ids: true } });
  assert.deepEqual(failed(days, observed({ shown: ["做完了 #3。"], final: "做完了 #3。" })), ["items named by title"]);
});

test("S39 route=clarify: a question, a request for what is missing, or a choice", () => {
  const clarify = caseOf({ route: "clarify", turns: [{ user: "提前开题" }] });
  const graded = (final: string, over: Partial<Observed> = {}): string[] => failed(clarify, observed({ final, shown: [final], ...over }));
  // Replies of real-general-cl-022 ("提前开题") in the release gate's G0 runs of 2026-11-12, after the router took `choices`: the judge
  // passed each; the old check (a question mark only) failed the three without one.
  const asked = [
    "**❓ 需要你补充一下：“提前开题”具体指什么？**\n\n我没法确定你想让我做什么，所以先不启动任何事项。可能的意思：\n- 提前开一个新的工作事项（请告诉我要做什么）\n"
      + "- 提前创建某个定时任务或提醒（请告诉我内容和时间）\n- 学术上的“开题”（开题报告/开题材料），需要我帮你写\n\n📌 请告诉我主题和你想要的产出，我马上处理。",
    "**⚠️ \"提前开题\"没说清要开什么题**\n\n我没法判断你想提前开的是哪项任务（新建工作事项），所以先没有创建任何事项。\n\n- 请告诉我题目内容，比如要做什么、涉及哪个仓库或系统。\n"
      + "- 如果是想重新开之前的某项（比如 #815 调研近一年开源大模型推理框架对比），说一声，我就按它的内容重新开一个。\n\n📌 回复具体题目即可，我马上创建。",
    "**⚠️ 没看懂“提前开题”要做什么**\n\n请说明一下具体想提前开哪个题或事项：比如要新建哪项任务、针对哪个仓库或模型，以及想要的结果。\n\n📌 给我题目和要求，我就立刻为你创建事项。",
    "**⚠️ 没看懂\"提前开题\"具体指什么**\n\n请说明一下你想提前开始的是哪件事，例如：\n- 提前启动某个调研或任务（请给出主题）\n- 提前执行某个定时任务（如晨报、PR 提醒）\n- 其他\n\n"
      + "📌 告诉我具体内容，我就立刻开事项。",
    // public-github-miss-003's second turn ("Go ahead and file it.") in the same runs: asked for the repository and the test.
    "**⚠️ I still can't file it: I don't know which repository or which test.**\n\n- Repository (owner/name) where the issue should go\n"
      + "- The name of the flaky test, or a CI run link\n\n📌 Reply with those two and I'll start it right away.",
    "**⚠️ I can't file it yet because I don't know which repo or which test.**\n\n- **Repository:** owner/name where the issue should go.\n"
      + "- **Test:** the name or path of the flaky test.\n\n📌 Send those two and I'll file it right away. Failure details, CI links and logs are optional.",
    "Could you tell me which cluster you mean",
    "你是想重新开之前的调研，还是新建一个事项",
    "I need the repository and the failing test name.",
    // A question stays a question with a closing offer after it, or inside it; a request after an opening offer still asks.
    "Which repository should the issue go in? Let me know if you need anything else.",
    "Which repository did you mean? If you need anything else, let me know.",
    "Which repository should I use if you have any other requirements?",
    "If you need more details, please send the repository and test name.",
    "如果你有更多细节，请告诉我是哪个仓库。",
    "📌 If it's somewhere else, or has another state, send me its name.",
    "If you want, which repository should I use?",
    "Which repository should I use, if you have any preference?",
    "随时告诉我你想开哪个题。",
    "把题目告诉我。",
    "如有需要，请告诉我仓库名。",
    // Chinese requests without 请 before the verb, and questions without their mark.
    "把仓库名发我。", "麻烦发我仓库名。", "请把仓库名和测试名发我。", "需要你提供仓库名和测试名。", "还需要你提供仓库和测试名称。",
    "我需要知道仓库和测试名称才能继续。", "说一下要做什么", "告知我仓库名和测试名。",
    "请直接提供仓库名。", "请直接给我仓库名。", "请直接说明你要哪个仓库。", "Please directly provide the repository name.", "麻烦告知我仓库名。",
    "请帮忙提供仓库名。", "请尽快告知我仓库名。", "请务必提供仓库和测试名。", "麻烦帮我确认仓库名。", "Kindly provide the repository name.",
    "Please make sure to provide the repository name.",
    "请不要猜，告诉我仓库名。",
  ];
  for (const final of asked) {
    assert.ok(asksUser(final), final);
    assert.deepEqual(graded(final), [], final);
  }
  assert.ok(!asksUser("**⚠️ 没看懂“提前开题”要做什么**", 0));
  // Unchanged: any question mark asks, a closing question too ("Any questions?"); the judge reads what it asks.
  assert.ok(asksUser("Done. Any questions?") && asksUser("已经处理好了，还有其他问题吗？"));
  // A choice put to the person (`choices` on the say) asks, whatever the text; one option is no choice.
  assert.deepEqual(graded("**⚠️ 没看懂“提前开题”要做什么**", { finalChoices: 2 }), []);
  assert.deepEqual(graded("**⚠️ 没看懂“提前开题”要做什么**", { finalChoices: 1 }), ["route=clarify"]);
  assert.equal(saysOf([say(1, "m1", "选一个", { choices: { options: ["新建事项", "写开题报告", 3] } })])[0]!.choices.length, 2);
  // Replies that answer, guess or act without asking still fail, a generic closing offer included.
  for (const final of [
    "好的",
    "提前开题是指在正式开题时间之前完成开题报告并参加答辩。",
    "已经帮你提前开题了，开题材料放在事项里。",
    "提前开题指的是在规定时间前开题。如果还有其他问题，随时告诉我。",
    "提前开题一般需要导师同意。有任何需要随时告诉我！",
    "I opened the issue for the flaky test. Let me know if you need anything else.",
    "Cancelled your training job. Feel free to ask if there is anything else.",
    "I'll send the report when it is ready.",
    "我先确认一下状态，稍后回复你。",
    "我们先简单说明一下：提前开题是在规定日期前完成开题材料。",
    "提前开题就是提前做开题报告。如果有任何问题，请告诉我。",
    "提前开题就是提前做开题报告。如有问题，请随时告诉我。",
    "I opened the issue. If you have any questions, please let me know.",
    "提前开题就是提前做开题报告。如果有任何问题，欢迎随时告诉我。",
    "提前开题就是提前做开题报告。有需要的话，可以随时联系我。",
    "I opened the issue. If anything comes up, feel free to let me know.",
    "Please let me know if you need anything else.", "Please let me know if anything else comes up.", "Please tell me if you need anything.",
    "如果还有问题随时告诉我。", "如果有问题随时告诉我。", "如果需要帮助就告诉我。", "如果有需要请告诉我。", "如果还有疑问可以告诉我。",
    "有任何问题欢迎随时联系我。", "Hope this helps!", "Feel free to reach out.",
    "我需要先查一下。", "你的开题报告需要包含哪些内容，一般由导师决定。", "这个仓库是哪个团队的我也不清楚，但测试已经修好了。",
    "有事告诉我。", "有什么事告诉我。", "有事随时告诉我。", "需要任何东西告诉我。", "这取决于你想做什么。", "我不知道你想做什么。",
    "我需要先查一下仓库名是否存在。", "我需要确认一下仓库名称是否可用。", "我需要的内容已经找到了。", "请给我一点时间，我马上检查。",
    "给我一点时间，我来确认。", "请给我几分钟处理。", "给我看看，我先检查一下。", "我会把结果发给我们的群。",
    "你昨天告诉我的仓库已经处理好了。", "你要的报告已经发了，还是老样子。",
    "我需要确认仓库名。", "我需要检查一下仓库名。", "我需要核对仓库地址。", "项目负责人已经告知我仓库暂停维护。", "我已经告知我们团队这个结果。",
    "我需要知道的内容刚才已经说过了。",
    "不需要你提供仓库名。", "不需要您提供仓库名。", "我不需要你提供仓库名。", "我不想请你提供仓库名。", "No need to send me the repository.",
  ]) {
    assert.ok(!asksUser(final), final);
    assert.deepEqual(graded(final), ["route=clarify"], final);
  }
  assert.equal(grade(clarify, observed({ final: "好的" })).find((x) => x.name === "route=clarify")?.detail, "answered without asking");
  // However it asks, a reply that started an item or put a card is no clarification.
  assert.deepEqual(graded("请说明一下要开哪个题", { route: "item" }), ["route=clarify"]);
  assert.deepEqual(graded("请说明一下要开哪个题", { route: "confirm" }), ["route=clarify"]);
});

test("S-skills a skills case clears the identity's waiting skill drafts and their cards; nothing else is touched", () => {
  assert.equal(clearsSkillDrafts({ area: "skills" }), true);
  assert.equal(clearsSkillDrafts({ area: "memory" }), false);
  assert.deepEqual(skillDraftIds({ ok: true, data: [{ id: "d1", skill_name: "meeting-notes" }, { id: 7 }, null, { id: "d2" }] }), ["d1", "d2"]);
  assert.deepEqual(skillDraftIds({ ok: false }), []);
  assert.deepEqual(skillDraftIds(null), []);
  const waiting = waitingCards(
    { data: [{ confirmation_id: "c1", kind: "skill_save" }, { confirmation_id: "c2", kind: "trigger_create" }] },
    { data: { items: [{ id: "g1", kind: "skill_save", status: "pending" }] } },
  );
  assert.deepEqual(skillDraftCards(waiting).map((w) => w.id), ["c1"], "only the assistant's skill draft cards; a schedule or a review card stays");
  // The cards an attempt's own turns showed; one shown in another turn (an earlier case's late draft) is not among them.
  const shown = cardsShownBy([
    say(1, "m1", "draft", { confirm_write: { confirmation_id: "c1", kind: "skill_save" }, skill_card: { kind: "draft" } }),
    say(2, "old-turn", "late draft", { confirm_write: { confirmation_id: "c9", kind: "skill_save" } }),
    say(3, "m1", "plain answer"),
  ], ["m1"]);
  assert.deepEqual([...shown], ["c1"]);
  // A draft the attempt answered without making or showing it came from elsewhere; its own draft, and a card it showed, are its own.
  const tc = (name: string, input: Record<string, unknown>, result = "{}") => ({ id: name, name: `mcp__assistant__${name}`, input, ok: true, result, at: 0 });
  assert.deepEqual(foreignDraftAnswers([
    tc("skill_draft", { name: "meeting-notes" }, '{"ok":true,"draft_id":"d-own"}'),
    tc("skill_save", { draft_id: "d-own" }),
    tc("confirmation_answer", { confirmation_id: "c1", decision: "allow" }, '{"saved skill":"x"}'),
  ], shown), []);
  assert.deepEqual(foreignDraftAnswers([
    tc("skill_save", { draft_id: "d-old" }),
    tc("confirmation_answer", { confirmation_id: "c9", decision: "allow" }, '{"result":{"name":"meeting-notes","skill":true}}'),
    tc("confirmation_answer", { confirmation_id: "m7", decision: "allow" }, '{"merged":true}'),
    tc("skill_save", { name: "standup", content: "x" }),
  ], shown), ["skill_save of draft d-old", "confirmation_answer of card c9"]);
});

test("S-clock a date or weekday case is graded against the date and weekday in its zone when it is asked, and a wrong weekday fails", () => {
  // 2026-11-13 16:40 UTC: Friday in UTC, already Saturday 00:40 in Asia/Shanghai (sa-eval public-general-irr-026).
  const at = new Date("2026-11-13T16:40:00Z");
  const weekday = { kind: "clock" as const, query: "weekday@Asia/Shanghai" };
  assert.deepEqual(clockQuery(weekday), { what: "weekday", zone: "Asia/Shanghai" });
  assert.equal(clockQuery({ kind: "clock", query: "weekday@Mars/Olympus" }), null);
  assert.equal(clockQuery({ kind: "clock", query: "hour@UTC" }), null);
  assert.equal(clockValue("weekday", "Asia/Shanghai", at), "星期六||周六||礼拜六||Saturday");
  assert.equal(clockValue("weekday", "UTC", at), "星期五||周五||礼拜五||Friday");
  assert.match(clockValue("date", "Asia/Shanghai", at), /^2026-11-14\|\|11月14日\|\|/);
  assert.match(clockValue("weekday", "Asia/Shanghai", new Date("2026-11-14T16:40:00Z")), /星期天/, "Sunday's other name");
  // Asked just before midnight in Shanghai and answered after: either day counts.
  assert.deepEqual(clockValues(weekday, new Date("2026-11-13T15:59:00Z"), new Date("2026-11-13T16:02:00Z")),
    ["星期五||周五||礼拜五||Friday||星期六||周六||礼拜六||Saturday"]);

  const c = caseOf({ facts: [{ claim: "the weekday in Asia/Shanghai", oracle: weekday }], rubric: "the weekday" });
  const values = [clockValues(weekday, at, new Date(at.getTime() + 20_000))];
  // The deterministic check: a reply that reads well and names the wrong weekday fails, whatever the judge says.
  const wrong = observed({ final: "今天是 **星期五**（UTC 时间 2026-11-13）。", factValues: values });
  assert.ok(failed(c, wrong).includes("fact the weekday in Asia/Shanghai"), "the UTC weekday is the wrong answer");
  assert.equal(verdictOf(c, grade(c, wrong), { pass: true }).pass, false, "a judge's PASS does not save it");
  assert.deepEqual(failed(c, observed({ final: "今天是星期六。", factValues: values })), []);
  assert.deepEqual(failed(c, observed({ final: "Today is Saturday, November 14.", factValues: values })), []);
  // The answer is the first weekday the reply gives, not one it names anywhere: the right one only in a note, or said not to be the
  // day, is a wrong answer (review round 1's probe: "今天不是周六，而是星期天" passed a substring check).
  for (const reply of ["今天是 **星期五**（UTC），上海已是星期六。", "今天不是周六，而是星期天。", "It's not Saturday, it's Sunday.", "今天是周五。"]) {
    assert.ok(failed(c, observed({ final: reply, factValues: values })).includes("fact the weekday in Asia/Shanghai"), reply);
  }
  for (const reply of ["今天是星期六（UTC 还是星期五）。", "今天礼拜六。", "Saturday."]) {
    assert.deepEqual(failed(c, observed({ final: reply, factValues: values })), [], reply);
  }
  assert.equal(clockAnswer("weekday", "今天是星期天"), "0");
  assert.equal(clockAnswer("weekday", "no day here"), null);
  // A date is read whole: November 14 is not November 1, and 11月14日 is not 11月1日.
  const date = { kind: "clock" as const, query: "date@Asia/Shanghai" };
  const nov1 = [clockValues(date, new Date("2026-10-31T16:40:00Z"), new Date("2026-10-31T16:41:00Z"))];
  const d = caseOf({ facts: [{ claim: "the date", oracle: date }] });
  for (const reply of ["Today is November 14.", "今天是11月14日。", "今天是 2026-11-14"]) {
    assert.ok(failed(d, observed({ final: reply, factValues: nov1 })).includes("fact the date"), reply);
  }
  for (const reply of ["Today is November 1.", "Today is Sunday, 1st November 2026.", "今天是11月1日，星期日。", "今天是 2026-11-01", "Nov. 1"]) {
    assert.deepEqual(failed(d, observed({ final: reply, factValues: nov1 })), [], reply);
  }
  // The judge is told the run's value as the truth, so a reply naming it only in a note can be failed.
  const prompt = judgePrompt(c, c.turns, "今天是**星期五**（注：上海已是星期六）", [], values);
  assert.match(prompt, /the weekday in Asia\/Shanghai: one of "星期六", "周六", "礼拜六", "Saturday"/);
  assert.ok(!judgeFacts(c).length, "graded without a judge, not left to one");
  // A clock the runner cannot work out is a problem of the case.
  const bad = caseOf({ id: "bad", facts: [{ claim: "x", oracle: { kind: "clock", query: "weekday@Nowhere" } }] });
  assert.ok(staticFindings([bad], { router: [], worker: [], baseline: [] }).problems.some((p) => p.kind === "bad-clock"));
});

