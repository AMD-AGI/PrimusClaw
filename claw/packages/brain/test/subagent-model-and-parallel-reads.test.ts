// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A `task` call may pick its sub-agent's model from the ones the deployment
 * offers, and reads emitted together go to the sandbox together.
 *
 * The models are configured before anything is imported: they are read once,
 * at module load, like every other setting.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";

process.env.SUB_AGENT_MODELS = "light-model, other-model";
process.env.SUB_AGENT_EXPLORE_MODEL = "light-model";
process.env.SUB_AGENT_MAX_TURNS = "4";

const { agentLoop } = await import("../src/agent/agent-loop.js");
const { pickSubagentModel } = await import("../src/agent/sub-agent.js");
const { ToolRouter } = await import("../src/tools/router.js");
const { AnthropicProvider } = await import("../src/llm/anthropic-provider.js");
const { OpenAiProvider } = await import("../src/llm/openai-provider.js");
type LlmSession = import("../src/llm/provider.js").LlmSession;
type LlmTurnResult = import("../src/llm/provider.js").LlmTurnResult;
type LlmSessionOptions = import("../src/llm/provider.js").LlmSessionOptions;
type HandsClient = import("../src/clients/hands.js").HandsClient;
type LoopOptions = import("../src/agent/agent-loop.js").LoopOptions;
type SubagentType = import("../src/agent/sub-agent.js").SubagentType;

const usage = { input_tokens: 1, output_tokens: 1, cache_create: 0, cache_read: 0 };
type Turn = { content: unknown[]; stopReason: string };
const toolUse = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: "tool_use", id, name, input });
const say = (text: string): Turn => ({ content: [{ type: "text", text }], stopReason: "end_turn" });

function scripted(turns: Turn[]): LlmSession & { sent: Message[][] } {
  const sent: Message[][] = [];
  return {
    sent,
    async streamTurn(messages) {
      sent.push(JSON.parse(JSON.stringify(messages)));
      const next = turns.shift();
      if (!next) throw new Error("the loop asked for more turns than the script has");
      return { ...next, usage, firstByteMs: 1, promptTokens: 1 } as unknown as LlmTurnResult;
    },
    async complete() { return "summary"; },
  };
}

/** Sub-agents open their session through the provider: record the model each was opened with. */
const opened: string[] = [];
/** Models the gateway refuses for this key, with the status it answers. */
const refused = new Map<string, number>();
const originalAnthropic = AnthropicProvider.prototype.createSession;
const originalOpenAi = OpenAiProvider.prototype.createSession;
before(() => {
  const create = (opts: LlmSessionOptions) => {
    opened.push(opts.model);
    const status = refused.get(opts.model);
    if (status === undefined) return scripted([say("sub done")]);
    return {
      async streamTurn() { throw Object.assign(new Error(`${status} key may not call ${opts.model}`), { status }); },
      async complete() { return "summary"; },
    };
  };
  AnthropicProvider.prototype.createSession = create as never;
  OpenAiProvider.prototype.createSession = create as never;
});
after(() => {
  AnthropicProvider.prototype.createSession = originalAnthropic;
  OpenAiProvider.prototype.createSession = originalOpenAi;
});

function resultOf(session: { sent: Message[][] }, id: string): string {
  const block = session.sent[1]
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b: unknown) => (b as { tool_use_id?: string }).tool_use_id === id) as { content?: unknown } | undefined;
  return String(block?.content);
}

const PICK_ROWS: Array<{ name: string; requested: unknown; type: SubagentType; want: { model: string; fallback?: string } | RegExp }> = [
  { name: "nothing named, a reading profile: the reading default, the run's own behind it", requested: undefined, type: "explore", want: { model: "light-model", fallback: "run-model" } },
  { name: "nothing named, readonly: the reading default", requested: "", type: "readonly", want: { model: "light-model", fallback: "run-model" } },
  { name: "nothing named, a working profile: the run's own", requested: undefined, type: "generalPurpose", want: { model: "run-model" } },
  { name: "nothing named, shell: the run's own", requested: undefined, type: "shell", want: { model: "run-model" } },
  { name: "an offered model, which has no fallback", requested: "other-model", type: "generalPurpose", want: { model: "other-model" } },
  { name: "the run's own model, named", requested: "run-model", type: "explore", want: { model: "run-model" } },
  { name: "inherit keeps a reading profile on the run's own", requested: "inherit", type: "explore", want: { model: "run-model" } },
  { name: "a model not offered is refused", requested: "costly-model", type: "explore", want: /not offered.*run-model, light-model, other-model, inherit/ },
  { name: "a non-string is refused", requested: 7, type: "explore", want: /not offered/ },
];

for (const row of PICK_ROWS) {
  test(`pickSubagentModel: ${row.name}`, () => {
    const got = pickSubagentModel(row.requested, row.type, "run-model");
    if (row.want instanceof RegExp) assert.match((got as { error: string }).error, row.want);
    else assert.deepEqual(got, row.want);
  });
}

test("the task schema offers exactly the configured models", () => {
  const task = new ToolRouter(null, new Map()).allToolSchemas().find((t) => t.name === "task")!;
  const model = (task.input_schema as { properties: Record<string, { enum?: string[] }> }).properties.model;
  assert.deepEqual(model?.enum, ["light-model", "other-model", "inherit"]);
});

function parentOptions(session: LlmSession, router: unknown): LoopOptions {
  return {
    model: "run-model", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 4, depth: 0,
    router: router as never, sessionId: "s-269", userId: "u", llmSession: session,
    hands: {} as HandsClient,
    onEvent: async () => {},
  };
}

const taskSchema = { name: "task", description: "task", input_schema: { type: "object", properties: {} } } as unknown as ToolSchema;
const readSchema = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } }) as unknown as ToolSchema;

test("a task runs its sub-agent on the model it names, and an explore task on the reading default", async () => {
  opened.length = 0;
  const parent = scripted([
    { content: [
      toolUse("t1", "task", { description: "a", prompt: "p", subagent_type: "generalPurpose", model: "other-model" }),
      toolUse("t2", "task", { description: "b", prompt: "p", subagent_type: "explore" }),
      toolUse("t3", "task", { description: "c", prompt: "p", subagent_type: "explore", model: "costly-model" }),
    ], stopReason: "tool_use" },
    say("all done"),
  ]);
  const router = new ToolRouter({} as HandsClient, new Map());
  await agentLoop([{ role: "user", content: "go" } as Message], [taskSchema, readSchema("read")], parentOptions(parent, router));
  assert.deepEqual(opened.sort(), ["light-model", "other-model"]);   // the refused one opened nothing
  assert.equal(resultOf(parent, "t1"), "sub done");
  assert.match(resultOf(parent, "t3"), /^Error: model "costly-model" is not offered/);
});

test("reads emitted together run together; a write waits for them and runs alone", async () => {
  const log: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const router = {
    setHands: () => {},
    route: async (name: string, input: Record<string, unknown>) => {
      log.push(`start ${name} ${input.path}`);
      if (name !== "write") {
        // Both reads must have started before either is let finish: run one after another, this never resolves.
        if (log.filter((l) => l.startsWith("start read") || l.startsWith("start grep")).length === 2) release();
        await gate;
      }
      log.push(`end ${name} ${input.path}`);
      return `${name} ok`;
    },
  };
  const parent = scripted([
    { content: [
      toolUse("r1", "read", { path: "a" }),
      toolUse("r2", "grep", { path: "b" }),
      toolUse("w1", "write", { path: "c" }),
    ], stopReason: "tool_use" },
    say("done"),
  ]);
  const timeout = setTimeout(() => release(), 2_000);
  try {
    await agentLoop([{ role: "user", content: "go" } as Message],
      ["read", "grep", "write"].map(readSchema), parentOptions(parent, router));
  } finally {
    clearTimeout(timeout);
  }
  assert.deepEqual(log.slice(0, 2).sort(), ["start grep b", "start read a"], `reads did not start together: ${log.join(" | ")}`);
  assert.deepEqual(log.slice(-2), ["start write c", "end write c"], `the write did not run alone after the reads: ${log.join(" | ")}`);
  assert.equal(resultOf(parent, "r1"), "read ok");
  assert.equal(resultOf(parent, "w1"), "write ok");
});

const FALLBACK_ROWS: Array<{ name: string; input: Record<string, unknown>; status: number; refuse: string; opened: string[]; result: RegExp }> = [
  { name: "a default the key cannot reach falls back to the run's model", input: { subagent_type: "explore" }, status: 403, refuse: "light-model", opened: ["light-model", "run-model"], result: /^sub done$/ },
  { name: "so does a default the gateway does not know", input: { subagent_type: "readonly" }, status: 404, refuse: "light-model", opened: ["light-model", "run-model"], result: /^sub done$/ },
  // The call chose this model: falling back would hide that its choice did not happen.
  { name: "a model the call named does not", input: { subagent_type: "explore", model: "other-model" }, status: 403, refuse: "other-model", opened: ["other-model"], result: /Sub-agent failed: 403/ },
  // Not a refusal of the model: running again elsewhere would hide a real failure.
  { name: "a failure that is not a refusal does not", input: { subagent_type: "explore" }, status: 500, refuse: "light-model", opened: ["light-model"], result: /Sub-agent failed: 500/ },
];

for (const row of FALLBACK_ROWS) {
  test(`sub-agent default model: ${row.name}`, async () => {
    opened.length = 0;
    refused.clear();
    refused.set(row.refuse, row.status);
    try {
      const parent = scripted([
        { content: [toolUse("t1", "task", { description: "a", prompt: "p", ...row.input })], stopReason: "tool_use" },
        say("all done"),
      ]);
      const router = new ToolRouter({} as HandsClient, new Map());
      await agentLoop([{ role: "user", content: "go" } as Message], [taskSchema, readSchema("read")], parentOptions(parent, router));
      assert.deepEqual(opened, row.opened);
      assert.match(resultOf(parent, "t1"), row.result);
    } finally {
      refused.clear();
    }
  });
}
