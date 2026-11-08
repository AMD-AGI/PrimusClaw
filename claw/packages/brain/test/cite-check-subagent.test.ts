// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run's citation check (`ExecuteRequest.cite_check`, `tools/cite-check.ts`) has no way around it.
 *
 *   CS1 a sub-agent's deliver_text of a cited report is checked as its parent's would be; without the forwarded check it is not
 *   CS2 deliver_file of a cited report in the sandbox, whatever its extension and however long (the whole file is searched), is
 *       read whole and delivered through the run's checked deliver_text, so the text stored is the checked one; a file with only one
 *       of the two, a file that cannot be searched, and any file in a run without the check are left to deliver_file
 *   CS4 a cited report that is too large, cannot be read back, or has no checked deliver_text to go through is refused, nothing
 *       delivered
 *   CS3 the check's budget ends a wait for a page that never answers: the check returns, and the statement is not checked
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";

const { runSubagent } = await import("../src/agent/sub-agent.js");
const { parseCiteCheck, CITED_FILE_REFUSAL, CITED_FILE_TOO_LARGE, CITED_FILE_UNREADABLE } = await import("../src/tools/cite-check.js");
const { ToolRouter } = await import("../src/tools/router.js");
const { AnthropicProvider } = await import("../src/llm/anthropic-provider.js");
const { OpenAiProvider } = await import("../src/llm/openai-provider.js");
type HandsClient = import("../src/clients/hands.js").HandsClient;
type LlmSession = import("../src/llm/provider.js").LlmSession;
type LlmTurnResult = import("../src/llm/provider.js").LlmTurnResult;
type LlmContentBlock = import("../src/llm/provider.js").LlmContentBlock;

const A = "https://rocm.docs.amd.com/en/latest/vllm.html";
const REPORT = ["vLLM supports MI300X [1].", "vLLM is the fastest engine [1].", "", `[1]: vLLM on ROCm — ${A}`].join("\n");
const ports = {
  fetchPage: async () => ({ ok: true as const, text: "vLLM supports MI300X." }),
  judge: async ({ claims }: { claims: string[] }) => claims.map((c) => c.includes("MI300X")),
};

const schema = (name: string): ToolSchema =>
  ({ name, description: name, input_schema: { type: "object", properties: {} } }) as unknown as ToolSchema;

const originalAnthropic = AnthropicProvider.prototype.createSession;
const originalOpenAi = OpenAiProvider.prototype.createSession;
let turns: Array<{ content: LlmContentBlock[]; stopReason: string }> = [];
before(() => {
  const create = (): LlmSession => {
    let i = 0;
    return {
      async streamTurn(_messages: Message[], _tools: ToolSchema[]) {
        const turn = turns[i++];
        if (!turn) throw new Error("scripted session exhausted");
        return { content: turn.content, stopReason: turn.stopReason, usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1 } as LlmTurnResult;
      },
      async complete() { return "summary"; },
    } as LlmSession;
  };
  AnthropicProvider.prototype.createSession = create as never;
  OpenAiProvider.prototype.createSession = create as never;
});
after(() => {
  AnthropicProvider.prototype.createSession = originalAnthropic;
  OpenAiProvider.prototype.createSession = originalOpenAi;
});

async function subDelivers(citeCheck: ReturnType<typeof parseCiteCheck>): Promise<string> {
  turns = [
    { content: [{ type: "tool_use", id: "t0", name: "mcp__assistant__deliver_text", input: { name: "r.md", text: REPORT } }], stopReason: "tool_use" },
    { content: [{ type: "text", text: "done" }], stopReason: "end_turn" },
  ];
  const sent: string[] = [];
  const assistant = { callTool: async (_name: string, args: Record<string, unknown>) => { sent.push(String(args.text)); return "{\"ok\":true}"; } };
  await runSubagent({
    description: "d", prompt: "p", subagentType: "general",
    parentSchemas: [schema("mcp__assistant__deliver_text")],
    hands: {} as HandsClient, platformMcpClients: new Map([["assistant", assistant]]),
    onEvent: async () => {}, model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 4, sessionId: "sub", depth: 1,
    citeCheck,
  });
  assert.equal(sent.length, 1);
  return sent[0];
}

test("CS1 a sub-agent's delivery is checked with the forwarded check, and only with it", async () => {
  const checked = await subDelivers(parseCiteCheck({ tools: ["mcp__assistant__deliver_text"] }, ports));
  assert.match(checked, /vLLM is the fastest engine \(unverified\)\./);
  assert.match(checked, /^Citation check /m);
  const unchecked = await subDelivers(null);
  assert.equal(unchecked, REPORT);
});

/**
 * A router over a sandbox whose one file is `file` (or none, when null): its `grep` searches the file line by line, as Hands' does, and
 * answers with the path and the count of matching lines; its `read` with line_numbers false answers the file's raw text. The run's
 * assistant server records what deliver_text was sent. `unreadable`: the read fails.
 */
function routerOver(file: string | null, opts: { unreadable?: boolean } = {}) {
  const searches: Array<Record<string, unknown>> = [];
  const reads: Array<Record<string, unknown>> = [];
  const delivered: Array<Record<string, unknown>> = [];
  const hands = {
    callToolFull: async (name: string, input: Record<string, unknown>) => {
      if (name === "read") {
        reads.push(input);
        if (opts.unreadable || file === null) return { text: `Error reading ${String(input.path)}: ENOENT`, isError: true };
        return { text: input.line_numbers === false ? file : "1|numbered", isError: false };
      }
      if (name !== "grep") throw new Error(`unexpected ${name}`);
      searches.push(input);
      if (file === null) return { text: `Error: ENOENT: no such file or directory, stat '${String(input.path)}'`, isError: false };
      if (file === "BIG") return { text: "[note] 1 file(s) over 8 MB not searched.", isError: false };
      const re = new RegExp(String(input.pattern), input.case_sensitive ? "" : "i");
      const n = file.split("\n").filter((l) => re.test(l)).length;
      // As Hands answers a count: the path relative to the workspace, a colon and the number of matching lines.
      return { text: n ? `${String(input.path).replace(/^\/workspace\//, "")}:${n}` : "(no matches)", isError: false };
    },
  } as unknown as HandsClient;
  const assistant = {
    callTool: async (tool: string, input: Record<string, unknown>) => {
      if (tool !== "deliver_text") throw new Error(`unexpected ${tool}`);
      delivered.push(input);
      return "{\"ok\":true}";
    },
  };
  return { router: new ToolRouter(hands, new Map([["assistant", assistant as never]])), searches, reads, delivered };
}

const check = () => parseCiteCheck({ tools: ["mcp__assistant__deliver_text"] }, ports);
const deliverFile = async (r: ReturnType<typeof routerOver>, path: string, extra: Record<string, unknown> = {}) => {
  const outcome = { isError: false };
  const text = await r.router.route("deliver_file", { path, ...extra }, undefined, outcome).catch((e: Error) => `threw: ${e.message}`);
  return { text, isError: outcome.isError };
};

test("CS2 deliver_file of a cited report is delivered as checked text; other files are left to deliver_file", async () => {
  const report = routerOver(REPORT);
  report.router.citeCheck = check();
  const out = await deliverFile(report, "/workspace/report.md", { caption: "the comparison" });
  assert.equal(out.isError, false);
  assert.equal(report.searches.length, 2, "the whole file is searched for a list of sources and for a citation");
  assert.deepEqual(report.reads, [{ path: "/workspace/report.md", line_numbers: false }], "read whole, raw");
  assert.equal(report.delivered.length, 1);
  assert.equal(report.delivered[0].name, "report.md");
  assert.equal(report.delivered[0].caption, "the comparison");
  assert.notEqual(report.delivered[0].text, REPORT, "the file's own text never reaches the API");
  assert.match(String(report.delivered[0].text), /vLLM is the fastest engine \(unverified\)\./);
  assert.match(String(report.delivered[0].text), /^Citation check /m);
  assert.match(out.text, /^This file is a report with numbered citations: it was delivered as text \(report\.md\), checked against its sources\./);
  assert.match(out.text, /Citation check before delivery: 1 of 2 cited statements are supported/);

  // A name that looks like a note, a citation at the start of its line, a report past any read limit under another extension.
  for (const [file, path, name] of [
    [REPORT, "/workspace/[1].md", "[1].md"],
    [REPORT, "/workspace/[note] 1 file.md", "[note] 1 file.md"],
    [`[1] vLLM supports MI300X.\n\n[1]: vLLM on ROCm — ${A}`, "/workspace/r.md", "r.md"],
    [["vLLM supports MI300X [1].", ...Array.from({ length: 5000 }, (_, i) => `filler ${i}`), `[1]: vLLM on ROCm — ${A}`].join("\n"), "/workspace/report.html", "report.md"],
  ] as const) {
    const r = routerOver(file);
    r.router.citeCheck = check();
    const o = await deliverFile(r, path);
    assert.equal(o.isError, false, path);
    assert.deepEqual(r.delivered.map((d) => d.name), [name], path);
    assert.match(String(r.delivered[0].text), /^Citation check /m, path);
  }

  // Not a cited report, or not searchable: deliver_file answers for it as before, nothing goes through deliver_text.
  for (const [file, path] of [
    ["Plain notes.\nNo citations.", "/workspace/notes.md"],
    [`Links only.\n[1]: a page — ${A}`, "/workspace/links.md"],
    ["Cites [1] but lists nothing.", "/workspace/half.md"],
    [null, "/workspace/missing.md"],
    ["BIG", "/workspace/data.csv"],
  ] as const) {
    const r = routerOver(file);
    r.router.citeCheck = check();
    const o = await deliverFile(r, path);
    assert.deepEqual([r.delivered.length, r.reads.length], [0, 0], path);
    assert.doesNotMatch(o.text, /numbered citations/, path);
  }
  const unchecked = routerOver(REPORT);
  await deliverFile(unchecked, "/workspace/report.md");
  assert.deepEqual([unchecked.searches.length, unchecked.delivered.length], [0, 0], "without the check the file is neither searched nor read");
});

test("CS4 a cited report too large, unreadable, or with no checked deliver_text is refused, nothing delivered", async () => {
  const huge = routerOver("BIG");
  huge.router.citeCheck = check();
  assert.deepEqual(await deliverFile(huge, "/workspace/huge.md"), { text: CITED_FILE_TOO_LARGE, isError: true });
  assert.equal(huge.reads.length, 0, "a file too large to search is not read");

  const big = routerOver(`${"x".repeat(300 * 1024)} [1].\n\n[1]: vLLM on ROCm — ${A}`);
  big.router.citeCheck = check();
  assert.deepEqual(await deliverFile(big, "/workspace/big.md"), { text: CITED_FILE_TOO_LARGE, isError: true });
  assert.equal(big.delivered.length, 0);

  const gone = routerOver(REPORT, { unreadable: true });
  gone.router.citeCheck = check();
  assert.deepEqual(await deliverFile(gone, "/workspace/report.md"), { text: CITED_FILE_UNREADABLE, isError: true });
  assert.equal(gone.delivered.length, 0);

  const other = routerOver(REPORT);
  other.router.citeCheck = parseCiteCheck({ tools: ["mcp__assistant__other"] }, ports);
  assert.deepEqual(await deliverFile(other, "/workspace/report.md"), { text: CITED_FILE_REFUSAL, isError: true });
  assert.deepEqual([other.reads.length, other.delivered.length], [0, 0]);
});

test("CS3 a page that never answers does not hold the check past its budget", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { checkReport, CITE_CHECK_BUDGET_MS } = await import("../src/tools/cite-check.js");
  const pending = checkReport(REPORT, { fetchPage: () => new Promise(() => {}), judge: async ({ claims }) => claims.map(() => true) });
  await Promise.resolve();
  t.mock.timers.tick(CITE_CHECK_BUDGET_MS + 1);
  const r = await pending;
  assert.equal(r.supported, 0);
  assert.equal(r.unreadable, 0, "a page the budget ran out on is not known to be unreadable");
  assert.equal(r.unchecked, 2);
  assert.equal(r.unverified, 0);
});
