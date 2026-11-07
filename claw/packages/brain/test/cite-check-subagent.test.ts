// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run's citation check (`ExecuteRequest.cite_check`, `tools/cite-check.ts`) has no way around it.
 *
 *   CS1 a sub-agent's deliver_text of a cited report is checked as its parent's would be; without the forwarded check it is not
 *   CS2 deliver_file of a cited report in the sandbox is refused, and the model told to deliver it with deliver_text; a text file
 *       that is not one, a file that cannot be read, and any file in a run without the check are not refused for it
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

/** A router over a sandbox whose `read` answers with `file` (numbered as Hands numbers lines), or fails when it is null. */
function routerOver(file: string | null) {
  const reads: unknown[] = [];
  const hands = {
    callToolFull: async (name: string, input: Record<string, unknown>) => {
      if (name !== "read") throw new Error(`unexpected ${name}`);
      reads.push(input);
      if (file === null) return { text: "Error: no such file", isError: true };
      return { text: file.split("\n").map((l, i) => `${String(i + 1).padStart(6)}|${l}`).join("\n"), isError: false };
    },
  } as unknown as HandsClient;
  return { router: new ToolRouter(hands), reads };
}

test("CS2 deliver_file of a cited report is refused; other files are not refused for it", async () => {
  const check = parseCiteCheck({ tools: ["mcp__assistant__deliver_text"] }, ports);
  const report = routerOver(REPORT);
  report.router.citeCheck = check;
  const outcome = { isError: false };
  assert.equal(await report.router.route("deliver_file", { path: "/workspace/report.md" }, undefined, outcome), CITED_FILE_REFUSAL);
  assert.equal(outcome.isError, true);
  assert.equal(report.reads.length, 1);

  for (const [file, path] of [["Plain notes.\nNo citations.", "/workspace/notes.md"], [null, "/workspace/missing.md"], [REPORT, "/workspace/chart.png"]] as const) {
    const r = routerOver(file);
    r.router.citeCheck = check;
    const text = await r.router.route("deliver_file", { path }, undefined, { isError: false }).catch((e: Error) => e.message);
    assert.notEqual(text, CITED_FILE_REFUSAL, path);
  }
  const unchecked = routerOver(REPORT);
  const text = await unchecked.router.route("deliver_file", { path: "/workspace/report.md" }, undefined, { isError: false }).catch((e: Error) => e.message);
  assert.notEqual(text, CITED_FILE_REFUSAL);
  assert.equal(unchecked.reads.length, 0, "without the check the file is not read");
});
