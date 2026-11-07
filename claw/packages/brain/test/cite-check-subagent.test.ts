// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run's citation check (`ExecuteRequest.cite_check`, `tools/cite-check.ts`) has no way around it.
 *
 *   CS1 a sub-agent's deliver_text of a cited report is checked as its parent's would be; without the forwarded check it is not
 *   CS2 deliver_file of a cited report in the sandbox is refused, and the model told to deliver it with deliver_text, whatever its
 *       extension and however long (the whole file is searched); a file with only one of the two, a file that cannot be read, and
 *       any file in a run without the check are not refused for it
 *   CS3 the check's budget ends a wait for a page that never answers: the statement is unverified and the check returns
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";

const { runSubagent } = await import("../src/agent/sub-agent.js");
const { parseCiteCheck, CITED_FILE_REFUSAL } = await import("../src/tools/cite-check.js");
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
 * A router over a sandbox whose one file is `file` (or none, when null): its `grep` searches the file line by line, as Hands' does,
 * and lists the path when a line matches.
 */
function routerOver(file: string | null) {
  const searches: Array<Record<string, unknown>> = [];
  const hands = {
    callToolFull: async (name: string, input: Record<string, unknown>) => {
      if (name !== "grep") throw new Error(`unexpected ${name}`);
      searches.push(input);
      if (file === null) return { text: `Error: ENOENT: no such file or directory, stat '${String(input.path)}'`, isError: false };
      if (file === "BIG") return { text: "[note] 1 file(s) over 8 MB not searched.", isError: false };
      const re = new RegExp(String(input.pattern), input.case_sensitive ? "" : "i");
      return { text: file.split("\n").some((l) => re.test(l)) ? String(input.path) : "(no matches)", isError: false };
    },
  } as unknown as HandsClient;
  return { router: new ToolRouter(hands), searches };
}

test("CS2 deliver_file of a cited report is refused; other files are not refused for it", async () => {
  const check = parseCiteCheck({ tools: ["mcp__assistant__deliver_text"] }, ports);
  const report = routerOver(REPORT);
  report.router.citeCheck = check;
  const outcome = { isError: false };
  assert.equal(await report.router.route("deliver_file", { path: "/workspace/report.md" }, undefined, outcome), CITED_FILE_REFUSAL);
  assert.equal(outcome.isError, true);
  assert.equal(report.searches.length, 2, "the whole file is searched for a list of sources and for a citation");

  // Past any read limit, and under another extension: still the same report.
  const long = routerOver(["vLLM supports MI300X [1].", ...Array.from({ length: 5000 }, (_, i) => `filler ${i}`), `[1]: vLLM on ROCm — ${A}`].join("\n"));
  long.router.citeCheck = check;
  assert.equal(await long.router.route("deliver_file", { path: "/workspace/report.html" }, undefined, { isError: false }), CITED_FILE_REFUSAL);

  for (const [file, path] of [
    ["Plain notes.\nNo citations.", "/workspace/notes.md"],
    [`Links only.\n[1]: a page — ${A}`, "/workspace/links.md"],
    ["Cites [1] but lists nothing.", "/workspace/half.md"],
    [null, "/workspace/missing.md"],
    ["BIG", "/workspace/data.csv"],
  ] as const) {
    const r = routerOver(file);
    r.router.citeCheck = check;
    const text = await r.router.route("deliver_file", { path }, undefined, { isError: false }).catch((e: Error) => e.message);
    assert.notEqual(text, CITED_FILE_REFUSAL, path);
  }
  const unchecked = routerOver(REPORT);
  const text = await unchecked.router.route("deliver_file", { path: "/workspace/report.md" }, undefined, { isError: false }).catch((e: Error) => e.message);
  assert.notEqual(text, CITED_FILE_REFUSAL);
  assert.equal(unchecked.searches.length, 0, "without the check the file is not searched");
});

test("CS3 a page that never answers does not hold the check past its budget", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { checkReport, CITE_CHECK_BUDGET_MS } = await import("../src/tools/cite-check.js");
  const pending = checkReport(REPORT, { fetchPage: () => new Promise(() => {}), judge: async ({ claims }) => claims.map(() => true) });
  await Promise.resolve();
  t.mock.timers.tick(CITE_CHECK_BUDGET_MS + 1);
  const r = await pending;
  assert.equal(r.supported, 0);
  assert.equal(r.unreadable, 1);
});
