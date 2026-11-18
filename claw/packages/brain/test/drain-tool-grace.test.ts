// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A drain (SIGTERM) lets a tool call already in flight finish, so a run moved
// to another replica neither repeats it nor tells the model it was stopped.
//
// On 2026-11-07 a brain rollout cut a legacy chat turn's foreground `bash`
// (`sleep 90`) twice: Hands killed the command with its cancelled request, the
// resumed run was told the call was interrupted, the model wrote "上一次执行被中断
// ... 所以我重新执行一次" into the chat and ran the command again, three times in
// all. These drive the real agent loop through that drain and a resume from what
// the drained attempt persisted. Reverse proof: dispatching with the run's own
// signal (agent-loop.ts, `callSignal`) makes D1 fail -- the call is cut, the
// resumed model is shown INTERRUPTED_TOOL_RESULT.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import type { ToolRouter } from "../src/tools/router.js";
import type { CheckpointState } from "../src/agent/index.js";
import { agentLoop, INTERRUPTED_TOOL_RESULT, type LoopOptions } from "../src/agent/agent-loop.js";
import { cutDrainedCalls, shieldFromDrain } from "../src/agent/drain-shield.js";
import { SIGTERM_ABORT_REASON, LEASE_LOST_ABORT_REASON } from "../src/tasks/abort-registry.js";

function session(turns: Array<Partial<LlmTurnResult>>): { session: LlmSession; prompts: Message[][] } {
  const prompts: Message[][] = [];
  let i = 0;
  return {
    prompts,
    session: {
      async streamTurn(messages: Message[]) {
        prompts.push(structuredClone(messages));
        const turn = turns[i++];
        if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
        return {
          content: turn.content ?? [],
          stopReason: turn.stopReason ?? "end_turn",
          usage: { input_tokens: 10, output_tokens: 5, cache_create: 0, cache_read: 0 },
          firstByteMs: 1,
        };
      },
      async complete() { return "summary"; },
    } as unknown as LlmSession,
  };
}

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): LlmContentBlock =>
  ({ type: "tool_use", id, name, input }) as LlmContentBlock;
const text = (t: string): LlmContentBlock => ({ type: "text", text: t }) as LlmContentBlock;

const TOOLS = [
  { name: "bash", description: "run a command", input_schema: { type: "object", properties: {} } },
] as unknown as ToolSchema[];

function opts(over: Partial<LoopOptions> & Record<string, unknown>): LoopOptions {
  return {
    model: "test-model", apiUrl: "http://localhost:0", apiKey: "test-key", maxTurns: 10,
    onEvent: async () => {}, sessionId: "sess-drain", userId: "user-1", ...over,
  } as unknown as LoopOptions;
}

function store() {
  let latest: CheckpointState | undefined;
  return {
    get latest() { return latest; },
    onCheckpoint: async (s: CheckpointState) => { latest = structuredClone(s); },
    onTurnJournal: async (s: CheckpointState) => { latest = structuredClone(s); },
  };
}

/**
 * A command that takes `ms` and, like Hands, is killed when the request it
 * answers is cancelled. `runs` counts how often it was started; `onStart` is
 * where the test begins the drain.
 */
function sandbox(ms: number, onStart: () => void) {
  const runs: string[] = [];
  const router = {
    route: (name: string, input: Record<string, unknown>, signal?: AbortSignal) => {
      runs.push(String(input.command));
      onStart();
      return new Promise<string>((resolve, reject) => {
        const done = setTimeout(() => resolve("slept"), ms);
        const kill = () => { clearTimeout(done); reject(new Error("This operation was aborted")); };
        if (signal?.aborted) kill();
        else signal?.addEventListener("abort", kill, { once: true });
      });
    },
    setHands: () => {},
  } as unknown as ToolRouter;
  return { runs, router };
}

const SLEEP = { command: "sleep 90 && echo slept" };

async function drainedThenResumed(graceMs: number, commandMs: number, reason: unknown = SIGTERM_ABORT_REASON,
  takenOverAfterMs?: number) {
  const kv = store();
  const ac = new AbortController();
  const box = sandbox(commandMs, () => {
    if (ac.signal.aborted) return;
    ac.abort(reason);
    // (another replica takes the run over while the drain waits: what the runner says on a lost lock, `noteLeaseLost`)
    if (takenOverAfterMs !== undefined) setTimeout(() => cutDrainedCalls(ac.signal, LEASE_LOST_ABORT_REASON), takenOverAfterMs);
  });
  const first = session([{ content: [text("我先执行命令。"), toolUse("b1", "bash", SLEEP)], stopReason: "tool_use" }]);
  await agentLoop([{ role: "user", content: "run it" }], TOOLS, opts({
    signal: ac.signal, drainToolGraceMs: graceMs, llmSession: first.session, router: box.router,
    onCheckpoint: kv.onCheckpoint, onTurnJournal: kv.onTurnJournal,
  }));
  assert.ok(kv.latest, "the drained attempt persisted something to resume from");
  // The resumed run, on another replica: a model that would run the command
  // again if shown anything but its result.
  const second = session([{ content: [text("命令已完成。")], stopReason: "end_turn" }]);
  const resumed = await agentLoop([{ role: "user", content: "run it" }], TOOLS, opts({
    resumeFrom: kv.latest, llmSession: second.session, router: box.router,
    onCheckpoint: kv.onCheckpoint, onTurnJournal: kv.onTurnJournal,
  }));
  const shown = second.prompts[0].at(-1)!.content as Array<{ tool_use_id: string; content: unknown }>;
  return { runs: box.runs, shown, resumed, asked: second.prompts.length };
}

test("D1: a call in flight when the drain begins finishes, and the resumed run continues from its result", async () => {
  const r = await drainedThenResumed(5_000, 50);
  assert.deepEqual(r.runs, [SLEEP.command], "the command ran once, across both attempts");
  assert.equal(r.shown[0].tool_use_id, "b1");
  assert.match(JSON.stringify(r.shown[0].content), /slept/, "the resumed model is shown the command's own result");
  assert.doesNotMatch(JSON.stringify(r.shown[0].content), new RegExp(INTERRUPTED_TOOL_RESULT.slice(0, 30)),
    "and is never told the call was interrupted");
  assert.equal(r.asked, 1, "the resumed run asks the model only for the turn after the drained one");
  assert.equal(r.resumed.finalText, "我先执行命令。\n命令已完成。");
});

test("D2: a call still running when the grace is up is cut as before, and is not made again", async () => {
  const r = await drainedThenResumed(30, 2_000);
  assert.deepEqual(r.runs, [SLEEP.command]);
  assert.match(JSON.stringify(r.shown[0].content), new RegExp(INTERRUPTED_TOOL_RESULT.slice(0, 30)));
});

test("D3: a stop that is not a drain cuts the call at once, whatever the grace", async () => {
  const started = Date.now();
  const r = await drainedThenResumed(5_000, 2_000, LEASE_LOST_ABORT_REASON);
  assert.ok(Date.now() - started < 1_500, "the call was not waited for");
  assert.match(JSON.stringify(r.shown[0].content), new RegExp(INTERRUPTED_TOOL_RESULT.slice(0, 30)));
});

test("D5: a run taken over by another replica while the drain waits has its call cut at once", async () => {
  const started = Date.now();
  const r = await drainedThenResumed(5_000, 2_000, SIGTERM_ABORT_REASON, 20);
  assert.ok(Date.now() - started < 1_500, "the call did not go on writing after the takeover");
  assert.deepEqual(r.runs, [SLEEP.command]);
  assert.match(JSON.stringify(r.shown[0].content), new RegExp(INTERRUPTED_TOOL_RESULT.slice(0, 30)),
    "a call cut by the takeover is told as interrupted, never as a result");
});

test("D6: a drain that begins before the call leaves does not start it; the resumed run makes it once, as usual", async () => {
  const kv = store();
  const ac = new AbortController();
  const box = sandbox(20, () => {});
  const first = session([{ content: [text("我先执行命令。"), toolUse("b1", "bash", SLEEP)], stopReason: "tool_use" }]);
  await agentLoop([{ role: "user", content: "run it" }], TOOLS, opts({
    signal: ac.signal, drainToolGraceMs: 5_000, llmSession: first.session, router: box.router,
    onCheckpoint: kv.onCheckpoint,
    // (the drain lands while the call's start is being journalled: after it was announced, before it was sent)
    onTurnJournal: async (st: CheckpointState) => {
      await kv.onTurnJournal(st);
      if (st.pending_turn?.started?.includes("b1") && !ac.signal.aborted) ac.abort(SIGTERM_ABORT_REASON);
    },
  }));
  assert.deepEqual(box.runs, [], "nothing was started once the drain had begun");
  const second = session([{ content: [text("命令已完成。")], stopReason: "end_turn" }]);
  await agentLoop([{ role: "user", content: "run it" }], TOOLS, opts({
    resumeFrom: kv.latest, llmSession: second.session, router: box.router,
    onCheckpoint: kv.onCheckpoint, onTurnJournal: kv.onTurnJournal,
  }));
  assert.deepEqual(box.runs, [SLEEP.command], "the resumed run made it, once");
  const shown = second.prompts[0].at(-1)!.content as Array<{ tool_use_id: string; content: unknown }>;
  assert.match(JSON.stringify(shown[0].content), /slept/);
});

test("D4: the shield follows the run's signal: other reasons at once, a drain after the grace, nothing once disposed", async () => {
  const user = new AbortController();
  const a = shieldFromDrain(user.signal, 10_000);
  user.abort();
  assert.equal(a.signal?.aborted, true);
  assert.equal(a.cut(), true);
  a.dispose();

  const drain = new AbortController();
  const b = shieldFromDrain(drain.signal, 20);
  drain.abort(SIGTERM_ABORT_REASON);
  assert.equal(b.signal?.aborted, false, "a drain does not reach the call at once");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(b.signal?.aborted, true, "it does once the grace is up");
  assert.equal(b.signal?.reason, SIGTERM_ABORT_REASON);
  b.dispose();

  const late = new AbortController();
  const c = shieldFromDrain(late.signal, 20);
  late.abort(SIGTERM_ABORT_REASON);
  c.dispose();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.signal?.aborted, false, "a call that returned is not cut afterwards");
  assert.equal(c.cut(), false);

  const off = new AbortController();
  const d = shieldFromDrain(off.signal, 0);
  assert.equal(d.signal, off.signal, "grace 0 is the run's own signal");
  assert.equal(shieldFromDrain(undefined, 1_000).signal, undefined);

  // A takeover the runner learned of before this call was shielded still cuts it, as it is made.
  const early = new AbortController();
  early.abort(SIGTERM_ABORT_REASON);
  cutDrainedCalls(early.signal, LEASE_LOST_ABORT_REASON);
  const e = shieldFromDrain(early.signal, 10_000);
  assert.equal(e.signal?.aborted, true);
  assert.equal(e.signal?.reason, LEASE_LOST_ABORT_REASON);
  e.dispose();
});
