// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The agent evaluation's reading and scoring, offline (`test/e2e/agent-eval-lib.ts`, `agent-eval-tasks.ts`).
 *
 *   E1  a session's stored events become its tool calls, approvals, MCP servers, final answer and turn numbers
 *   E2  a turn that never ended is a failure
 *   E3  a test run counts only when it is the last one and its output says the tests passed
 *   E4  the network counts only when a call that goes out succeeded
 *   E5  an edit counts as read-first only after a read of that file; a change counts as checked only when a shell call follows it
 *   E6  the summary leaves skipped tasks out, and adds up Brain's own numbers per category and in total
 *   E7  the set is 40 tasks in six categories, and no grader passes a session that did nothing
 *   E8  graders pass on what a correct session leaves
 *   E9  text graders ignore line-end style: a CSV written with CRLF (Python's csv module) matches the LF answer
 */
import assert from "node:assert/strict";
import test from "node:test";
import AdmZip from "adm-zip";

import {
  behaviour, lastTestRunPassed, reachedNetwork, sameText, summarize, traceOf, type EventRow, type Outcome, type ToolCall, type Trace,
} from "./e2e/agent-eval-lib.js";
import { CATEGORIES, TASKS, type EvalContext } from "./e2e/agent-eval-tasks.js";

const at = (s: number): string => new Date(Date.UTC(2026, 10, 3, 9, 0, s)).toISOString();
const row = (s: number, data: Record<string, unknown>): EventRow => ({ event_type: String(data.type), created_at: at(s), data: { message_id: "m1", ...data } });

/** A turn as the replay returns it: plugin servers loaded, a sandbox opened, two shell calls, an approval, and its end. */
const ROWS: EventRow[] = [
  row(0, { type: "UserMessage", data: { content: [{ type: "text", text: "go" }] } }),
  row(0, { type: "toolUsed", tool: "load_mcp", brief: "Loaded plugin MCP (alpha)", status: "success", actionId: "plugin_mcp_3" }),
  row(0, { type: "toolUsed", tool: "load_rule", brief: "Loaded plugin rule: rule.md", status: "success", actionId: "plugin_rule_4" }),
  row(1, { type: "toolUsed", tool: "bash", status: "start", actionId: "t1", argumentsDetail: { bash: { command: "echo hi" } } }),
  row(2, { type: "sandboxStatus", status: "creating" }),
  row(9, { type: "sandboxStatus", status: "ready" }),
  row(10, { type: "toolUsed", tool: "bash", status: "success", actionId: "t1", description: "hi\n" }),
  row(11, { type: "toolUsed", tool: "mcp__alpha__thing_delete", status: "start", actionId: "t2", argumentsDetail: { mcp__alpha__thing_delete: { id: 1 } } }),
  row(11, { type: "permissionRequest", tool_use_id: "t2" }),
  row(12, { type: "toolUsed", tool: "mcp__alpha__thing_delete", status: "error", actionId: "t2", result: "denied" }),
  row(13, { type: "AssistantMessage", data: { content: [{ type: "text", text: "draft" }] } }),
  row(14, { type: "executionStats", turns: 3, elapsed_ms: 13000, tool_stats: { by_tool: { bash: 1, mcp__alpha__thing_delete: 1 }, error_calls: 1, total_calls: 2 }, token_usage: { input_tokens: 5, output_tokens: 70, cache_read: 900, cache_create: 100 } }),
  row(15, { type: "exec_complete", failed: false, final_text: "It printed hi." }),
];

test("E1 a session's stored events become what the graders read", () => {
  const t = traceOf(ROWS);
  assert.deepEqual(t.calls.map((c) => [c.name, c.ok, c.result]), [["bash", true, "hi\n"], ["mcp__alpha__thing_delete", false, "denied"]]);
  assert.deepEqual(t.calls[0]!.input, { command: "echo hi" });
  assert.deepEqual(t.approvals, ["t2"]);
  assert.deepEqual(t.mcpServers, ["alpha"]);
  assert.equal(t.final, "It printed hi.");
  assert.equal(t.failed, false);
  assert.equal(t.wallMs, 15_000);
  assert.equal(t.sandboxWaitMs, 7_000);
  assert.deepEqual(t.stats, {
    elapsedMs: 13000, turns: 3, totalCalls: 2, errorCalls: 1, byTool: { bash: 1, mcp__alpha__thing_delete: 1 },
    inputTokens: 5, outputTokens: 70, cacheRead: 900, cacheCreate: 100,
  });
  assert.equal(traceOf(ROWS, "other").calls.length, 0, "another turn's events are not this turn's");
});

test("E2 a turn that never ended is a failure", () => {
  assert.equal(traceOf(ROWS.filter((r) => r.data.type !== "exec_complete")).failed, true);
  assert.equal(traceOf([...ROWS.slice(0, -1), row(15, { type: "exec_complete", failed: true })]).failed, true);
});

const call = (name: string, input: Record<string, unknown>, ok: boolean | null = true, result = ""): ToolCall => ({ id: name, name, input, ok, result, at: 0 });
const bash = (command: string, result: string, ok = true): ToolCall => call("bash", { command }, ok, result);
const PASSED = "test_a ... ok\n\n----------------------------------------------------------------------\nRan 3 tests in 0.001s\n\nOK\n";
const FAILED = "FAIL: test_a\n----------------------------------------------------------------------\nRan 3 tests in 0.001s\n\nFAILED (failures=1)\n";

test("E3 a test run counts only when it is the last and says the tests passed", () => {
  const unittest = "cd /workspace/c1 && python3 -m unittest -v";
  assert.equal(lastTestRunPassed({ calls: [bash(unittest, PASSED)] }, "test_fizz.py"), true);
  assert.equal(lastTestRunPassed({ calls: [bash(unittest, PASSED), bash(unittest, FAILED)] }, "test_fizz.py"), false, "broken after it passed");
  assert.equal(lastTestRunPassed({ calls: [bash(unittest, FAILED), bash(unittest, PASSED)] }, "test_fizz.py"), true);
  assert.equal(lastTestRunPassed({ calls: [bash("python3 test_fizz.py", PASSED)] }, "test_fizz.py"), true);
  assert.equal(lastTestRunPassed({ calls: [bash("pytest -q", "3 passed in 0.01s")] }, "test_fizz.py"), true);
  assert.equal(lastTestRunPassed({ calls: [bash("pytest -q", "1 failed, 2 passed in 0.01s")] }, "test_fizz.py"), false);
  assert.equal(lastTestRunPassed({ calls: [bash("echo 'Ran 3 tests OK'", "Ran 3 tests OK")] }, "test_fizz.py"), false, "not a test run");
  assert.equal(lastTestRunPassed({ calls: [bash(unittest, "Ran 0 tests in 0.000s\n\nOK\n")] }, "test_fizz.py"), false, "nothing ran");
  assert.equal(lastTestRunPassed({ calls: [] }, "test_fizz.py"), false);
});

test("E4 the network counts only when a call that goes out succeeded", () => {
  assert.equal(reachedNetwork({ calls: [bash("curl -s https://example.org", "<html>")] }), true);
  assert.equal(reachedNetwork({ calls: [bash("gh api repos/a/b", "{}")] }), true);
  assert.equal(reachedNetwork({ calls: [call("web_fetch", { url: "https://example.org" })] }), true);
  assert.equal(reachedNetwork({ calls: [call("web_fetch", { url: "https://example.org" }, false)] }), false);
  assert.equal(reachedNetwork({ calls: [bash("curl -s https://example.org", "", false)] }), false);
  assert.equal(reachedNetwork({ calls: [bash("echo curling", "curling")] }), false);
});

test("E5 read-first edits and checked changes", () => {
  const read = (path: string) => call("read", { path });
  const edit = (path: string) => call("edit", { path, old_string: "a", new_string: "b" });
  assert.deepEqual(behaviour({ calls: [read("/workspace/a.py"), edit("a.py"), edit("b.py"), bash("python3 -m unittest", PASSED)] }),
    { edits: 2, editsAfterRead: 1, changed: true, checkedAfterChange: true });
  assert.deepEqual(behaviour({ calls: [bash("ls", ""), call("write", { path: "x" })] }),
    { edits: 0, editsAfterRead: 0, changed: true, checkedAfterChange: false });
  assert.deepEqual(behaviour({ calls: [call("multi_edit", { edits: [{ path: "a.py" }] }), bash("ls", "")] }),
    { edits: 1, editsAfterRead: 0, changed: true, checkedAfterChange: true });
});

test("E6 the summary leaves skipped tasks out and adds up per category and in total", () => {
  const t = traceOf(ROWS);
  const outcomes: Outcome[] = [
    { id: "a", category: "code", pass: true, why: [], trace: t },
    { id: "b", category: "code", pass: false, why: ["x"], trace: { ...t, failed: true } },
    { id: "c", category: "docs", pass: false, why: [], error: "create answered 500" },
    { id: "d", category: "mcp", pass: false, why: [], skipped: "no EVAL_PLUGIN_ID" },
  ];
  const sum = summarize(outcomes);
  assert.deepEqual(Object.keys(sum).sort(), ["all", "code", "docs"]);
  assert.equal(sum.code!.tasks, 2);
  assert.equal(sum.code!.passed, 1);
  assert.equal(sum.code!.broken, 1);
  assert.equal(sum.code!.toolCalls, 4);
  assert.equal(sum.code!.toolErrors, 2);
  assert.equal(sum.code!.approvals, 2);
  assert.equal(sum.code!.turnP50Ms, 13000);
  assert.equal(sum.code!.inputTokens, 2 * 1005);
  assert.deepEqual(sum.code!.byTool, { bash: 2, mcp__alpha__thing_delete: 2 });
  assert.deepEqual([sum.all!.tasks, sum.all!.passed, sum.all!.broken], [3, 1, 2]);
  assert.equal(sum.docs!.turnP50Ms, null);
});

const CTX: EvalContext = { userName: "Doe, Jane", workspaces: [{ id: "ws-a", name: "alpha" }, { id: "ws-b", name: "beta" }] };
const nothing: Trace = { final: "", failed: false, calls: [], approvals: [], mcpServers: [], stats: null, wallMs: null, sandboxWaitMs: null, files: {} };

test("E7 forty tasks in six categories, and no grader passes a session that did nothing", () => {
  assert.equal(TASKS.length, 40);
  assert.equal(new Set(TASKS.map((t) => t.id)).size, 40);
  assert.deepEqual([...new Set(TASKS.map((t) => t.category))].sort(), [...CATEGORIES].sort());
  for (const c of CATEGORIES) assert.ok(TASKS.filter((t) => t.category === c).length >= 6, c);
  for (const t of TASKS) {
    const v = t.grade(nothing, CTX);
    assert.equal(v.pass, false, `${t.id} passed an empty session`);
    assert.ok(v.why.length > 0, `${t.id} says why`);
  }
});

const task = (id: string) => TASKS.find((t) => t.id === id)!;
const zip = (entries: Record<string, string>): Buffer => {
  const z = new AdmZip();
  for (const [name, body] of Object.entries(entries)) z.addFile(name, Buffer.from(body));
  return z.toBuffer();
};

test("E8 graders pass on what a correct session leaves", () => {
  const c1 = task("c1");
  const testFile = /test_fizz\.py:\n```\n([\s\S]*?)```/.exec(c1.prompt)![1]!;
  const good: Trace = { ...nothing, calls: [bash("cd /workspace/c1 && python3 -m unittest -v", PASSED)], files: { "c1/test_fizz.py": Buffer.from(testFile) } };
  assert.deepEqual(c1.grade(good, CTX), { pass: true, why: [] });
  assert.deepEqual(c1.grade({ ...good, files: { "c1/test_fizz.py": Buffer.from(testFile.replace("FizzBuzz", "Fizz")) } }, CTX).why, ["tests unchanged"]);

  const r1 = task("r1");
  const fetched = [call("web_fetch", { url: "https://www.rfc-editor.org/rfc/rfc9110" })];
  assert.equal(r1.grade({ ...nothing, calls: fetched, final: "It is 418 (Unused), see https://www.rfc-editor.org/rfc/rfc9110#section-15.5.19" }, CTX).pass, true);
  assert.deepEqual(r1.grade({ ...nothing, final: "418 (Unused) https://www.rfc-editor.org/rfc/rfc9110" }, CTX).why, ["looked it up"]);

  const d3 = task("d3");
  const xlsx = zip({
    "xl/workbook.xml": `<workbook><sheets><sheet name="Q1" sheetId="1"/></sheets></workbook>`,
    "xl/sharedStrings.xml": "<sst><si><t>Month</t></si><si><t>Revenue</t></si><si><t>Mar</t></si></sst>",
    "xl/worksheets/sheet1.xml": "<sheetData><row r=\"4\"><c r=\"B4\"><v>300</v></c></row></sheetData>",
  });
  assert.equal(d3.grade({ ...nothing, files: { "d3/sales.xlsx": xlsx } }, CTX).pass, true);

  const d4 = task("d4");
  const memo = zip({ "word/document.xml": `<w:body><w:p><w:r><w:t>Quarterly Memo</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Revenue grew 12% </w:t></w:r><w:r><w:t>this quarter.</w:t></w:r></w:p></w:body>` });
  assert.equal(d4.grade({ ...nothing, files: { "d4/memo.docx": memo } }, CTX).pass, true, "a paragraph split across runs");

  const d6 = task("d6");
  const deck = zip({ "ppt/slides/slide1.xml": "<a:t>Plan</a:t>", "ppt/slides/slide2.xml": "<a:t>Risks</a:t>" });
  assert.equal(d6.grade({ ...nothing, files: { "d6/deck.pptx": deck } }, CTX).pass, true);

  const p3 = task("p3");
  const listed = [call("mcp__alpha__workspace_list", {})];
  assert.equal(p3.grade({ ...nothing, calls: listed, final: "Two: ws-a and beta." }, CTX).pass, true);
  assert.deepEqual(p3.grade({ ...nothing, calls: listed, final: "Two: ws-a and beta.", approvals: ["t9"] }, CTX).why, ["asked for no write"]);

  const p1 = task("p1");
  assert.equal(p1.grade({ ...nothing, mcpServers: ["alpha"], final: "Connected: Alpha, for jobs." }, CTX).pass, true);

  const l2 = task("l2");
  assert.equal(l2.grade({ ...nothing, files: { "l2/times.txt": Buffer.from("1000\n1136\n") } }, CTX).pass, true);
  assert.equal(l2.grade({ ...nothing, files: { "l2/times.txt": Buffer.from("1000\n1100\n") } }, CTX).pass, false);
});

test("E9 text graders ignore line-end style", () => {
  assert.equal(sameText("a,b\r\n1,2\r\n", "a,b\n1,2\n"), true, "CRLF");
  assert.equal(sameText("a,b\r1,2", "a,b\n1,2\n"), true, "bare CR");
  assert.equal(sameText("a,b  \r\n1,2\t\r\n", "a,b\n1,2"), true, "line-end spaces before a CRLF");
  assert.equal(sameText("a,b\r\n1,3\r\n", "a,b\n1,2\n"), false, "different content is still different");
  assert.equal(sameText("a,b1,2", "a,b\n1,2"), false, "a missing line break is still different");
  assert.equal(sameText(null, ""), false);

  const d2 = task("d2");
  const crlf = Buffer.from("id,name,score\r\n2,bo,93\r\n3,chen,85\r\n1,ana,71\r\n");
  assert.equal(d2.grade({ ...nothing, files: { "d2/scores.csv": crlf } }, CTX).pass, true, "csv.writer's CRLF output");
});
