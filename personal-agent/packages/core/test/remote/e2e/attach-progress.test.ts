// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A turn of a session on the machine shows its progress while it runs: the agent's words as they come, and one line counting its
// steps by tool, in a progress message edited every few seconds (or the stream, where the chat has one). A message that waits for
// the terminal's running turn is said so at once, once. The events are the ones the connector sends for a conversation open in a
// terminal (connector/src/attach.ts `transcriptUpdates`, connector/src/session.ts `tellWorking`).
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteAgentText } from "../../../src/locales/remote-agents.js";
import { REMOTE_EDIT_SECONDS } from "../../../src/remote/turns/chat-turn.js";
import type { FakeCommand, FakeRemote } from "../../../../../test-support/remote-fake.js";
import type { Recorded } from "../../../../../test-support/surface.js";
import { type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, attached } from "./helpers.js";

const zh = remoteAgentText.in("zh");

/** Claw's number of a command, as the fake answers it. */
function seqOf(w: RemoteWorld, cmd: FakeCommand | undefined): number {
  assert.ok(cmd);
  return w.server.commands.indexOf(cmd) + 1;
}

async function manual(w: RemoteWorld): Promise<{ sid: string; prompts: FakeCommand[] }> {
  const script = new Script();
  const prompts: FakeCommand[] = [];
  script.onPrompt = (_srv: FakeRemote, _sid: string, cmd: FakeCommand) => {
    prompts.push(cmd);
    return Promise.resolve();
  };
  const { sid } = await attached(w, script, "/home/me/repo", "claude");
  return { sid, prompts };
}

// --- the connector's events, exactly as it sends them for a terminal's transcript ---------------------------------------------

const ACP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function words(srv: FakeRemote, sid: string, text: string): Promise<number> {
  return srv.emit(sid, "agent_message_chunk", {
    sessionId: ACP,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

function step(srv: FakeRemote, sid: string, id: string, name: string, input: Record<string, string>): Promise<number> {
  const what = input["command"] ?? input["file_path"] ?? "";
  return srv.emit(sid, "tool_call", {
    sessionId: ACP,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: what ? `${name}: ${what}` : name,
      kind: "other",
      status: "in_progress",
      rawInput: input,
      _meta: { claudeCode: { toolName: name } },
    },
  });
}

function stepDone(srv: FakeRemote, sid: string, id: string): Promise<number> {
  return srv.emit(sid, "tool_call_update", {
    sessionId: ACP,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: id,
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "ok" } }],
    },
  });
}

/** Five steps (Bash three times, Read twice) with the agent's words between, as one tool-heavy turn writes them. */
async function busyTurn(srv: FakeRemote, sid: string): Promise<void> {
  await words(srv, sid, "先看一下测试是怎么跑的。");
  await step(srv, sid, "toolu_1", "Read", { file_path: "/home/me/repo/package.json" });
  await stepDone(srv, sid, "toolu_1");
  await step(srv, sid, "toolu_2", "Bash", { command: "npm test" });
  await stepDone(srv, sid, "toolu_2");
  await words(srv, sid, "有两个失败，我去看看。");
  await step(srv, sid, "toolu_3", "Read", { file_path: "/home/me/repo/src/a.ts" });
  await stepDone(srv, sid, "toolu_3");
  await step(srv, sid, "toolu_4", "Bash", { command: "npm test -- a" });
  await stepDone(srv, sid, "toolu_4");
  await step(srv, sid, "toolu_5", "Bash", { command: "git diff" });
}

function endOf(w: RemoteWorld, sid: string, cmd: FakeCommand | undefined): Promise<number> {
  return w.server.emit(sid, "turn_end", {
    stopReason: "end_turn",
    cmd_id: cmd?.cmd_id ?? null,
    cmd_seq: seqOf(w, cmd),
  });
}

/** Each operation on a message, with the live view's clock when it left. */
function timed(w: RemoteWorld): { op: Recorded; at: number }[] {
  const seen: { op: Recorded; at: number }[] = [];
  const record = w.surface.record.bind(w.surface);
  w.surface.record = (entry: Recorded) => {
    seen.push({ op: entry, at: w.virtual.now });
    record(entry);
  };
  return seen;
}

/** What an operation says: a message's whole body (its text and any card), or a stream's text. */
const textOf = (r: Recorded): string =>
  r.op === "post" || r.op === "update" || r.op === "send"
    ? JSON.stringify(r.message)
    : r.op === "stream.inform" || r.op === "stream.emit"
      ? r.text
      : "";

const STEPS = "正在：Bash ×3, Read ×2";

/** The live view's waits stay virtual, but the stream's own closing before the chat's limit (minutes) does not come within a test. */
function neverPastAMinute(w: RemoteWorld): void {
  const virtual = w.virtual.sleep.bind(w.virtual);
  w.virtual.sleep = (ms, signal) =>
    ms > 60_000
      ? new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(signal.reason as Error);
          });
        })
      : virtual(ms, signal);
}

test("a tool-heavy turn on the machine shows the agent's words and its steps by tool while it runs, in one progress message edited every few seconds", () =>
  remoteWorld(async (w) => {
    w.setLang(AAD, "zh");
    const { sid, prompts } = await manual(w);
    const ops = timed(w);
    await w.send("跑一下测试，修掉失败的");
    await w.until(() => prompts.length === 1);
    await busyTurn(w.server, sid);
    // Before the turn ends: the progress message already says what the agent wrote and how many steps of each tool it ran.
    // (the progress message: the one posted with the live view's header; the status card is another message)
    const mine = () => {
      const post = ops.find(({ op }) => op.op === "post" && textOf(op).includes("正在处理（"));
      const id = post?.op.op === "post" ? post.op.id : "";
      return ops.filter(({ op }) => (op.op === "post" || op.op === "update") && op.id === id);
    };
    const progress = () => mine().map(({ op }) => textOf(op));
    await w.until(() => progress().some((t) => t.includes(STEPS) && t.includes("有两个失败，我去看看。")));
    const shown = progress().find((t) => t.includes(STEPS)) ?? "";
    assert.ok(shown.includes("先看一下测试是怎么跑的。"), shown);
    assert.ok(shown.includes("⏳ Bash: git diff"), shown);
    assert.ok(!w.said().some((t) => t.includes("全部修好了")), "the answer is not out yet");
    // One message, edited in place, never more often than every REMOTE_EDIT_SECONDS.
    const posts = ops.filter(({ op }) => op.op === "post" && textOf(op).includes("正在处理（"));
    assert.equal(posts.length, 1, JSON.stringify(posts.map(({ op }) => textOf(op))));
    const edits = mine()
      .filter(({ op }) => op.op === "update")
      .map(({ at }) => at);
    assert.ok(edits.length >= 1);
    const times = [posts[0]?.at ?? 0, ...edits];
    for (let i = 1; i < times.length; i += 1) {
      assert.ok((times[i] ?? 0) - (times[i - 1] ?? 0) >= REMOTE_EDIT_SECONDS * 1000 - 1, JSON.stringify(times));
    }
    await words(w.server, sid, "全部修好了，测试通过。");
    await endOf(w, sid, prompts[0]);
    await w.idle();
    assert.equal(w.answer(), "全部修好了，测试通过。");
  }));

test("with a stream, the floating status counts the steps by tool until the agent writes, and its words fill the bubble before the turn ends", () =>
  remoteWorld(
    async (w) => {
      neverPastAMinute(w);
      w.setLang(AAD, "zh");
      const { sid, prompts } = await manual(w);
      await w.send("跑一下测试，修掉失败的");
      await w.until(() => prompts.length === 1);
      const ops = (kind: Recorded["op"]) => w.surface.outbox.filter((r) => r.op === kind).map(textOf);
      // (the floating status is what Teams shows until the bubble has words; once it has, the words are what grows)
      await step(w.server, sid, "toolu_1", "Read", { file_path: "/home/me/repo/package.json" });
      await stepDone(w.server, sid, "toolu_1");
      await step(w.server, sid, "toolu_2", "Bash", { command: "npm test" });
      await stepDone(w.server, sid, "toolu_2");
      await step(w.server, sid, "toolu_3", "Bash", { command: "npm test -- a" });
      await w.until(() =>
        ops("stream.inform").some((t) => t.includes("正在：Bash ×2, Read ×1") && t.includes("⏳ Bash: npm test -- a")),
      );
      await stepDone(w.server, sid, "toolu_3");
      await words(w.server, sid, "有两个失败，我去看看。");
      await w.until(() => ops("stream.emit").some((t) => t.includes("有两个失败，我去看看。")));
      assert.equal(w.surface.outbox.filter((r) => r.op === "stream.finish").length, 0, "the turn has not ended");
      await words(w.server, sid, "全部修好了，测试通过。");
      await endOf(w, sid, prompts[0]);
      await w.idle();
      const finals = w.surface.outbox.filter((r) => r.op === "stream.finish");
      assert.ok(
        finals.length === 1 && JSON.stringify(finals[0]).includes("全部修好了，测试通过。"),
        JSON.stringify(finals),
      );
    },
    { direct: true, streaming: true },
  ));

test("a message the busy terminal queues is said so in the chat at once, once, with how to take it back", () =>
  remoteWorld(async (w) => {
    w.setLang(AAD, "zh");
    const { sid, prompts } = await manual(w);
    await w.send("顺便看下 lint");
    await w.until(() => prompts.length === 1);
    const cmd = prompts[0];
    // (the connector: once when the busy terminal draws the paste late, and Claude Code's queue taking it says nothing new; a
    // connector that says it again, or once more after a step of the running turn, is not repeated to the person)
    const queued = (held: boolean) =>
      w.server.emit(sid, "terminal_input_queued", {
        reason: "terminal_working",
        cmd_id: cmd?.cmd_id ?? null,
        cmd_seq: seqOf(w, cmd),
        queued: 1,
        ...(held ? { held: "terminal" } : {}),
      });
    await queued(true);
    const notice = zh.terminalBusy + zh.terminalBusyHeld;
    assert.equal(
      notice,
      "会话正忙，已排队，当前回合结束后发送。要撤回：在那台机器的终端里按 ↑，排队的消息会回到输入框。",
    );
    await w.until(() => w.said().includes(notice));
    await queued(true);
    await step(w.server, sid, "toolu_9", "Bash", { command: "npm run lint" });
    await queued(true);
    await words(w.server, sid, "lint 没问题。");
    await endOf(w, sid, cmd);
    await w.idle();
    assert.equal(w.said().filter((t) => t.startsWith(zh.terminalBusy)).length, 1, w.said().join("\n"));
    assert.equal(w.answer(), "lint 没问题。");

    // The next message, still waiting on the connector (no `held`): /stop takes it back.
    await w.send("再跑一次");
    await w.until(() => prompts.length === 2);
    const next = prompts[1];
    await w.server.emit(sid, "terminal_input_queued", {
      reason: "terminal_working",
      cmd_id: next?.cmd_id ?? null,
      cmd_seq: seqOf(w, next),
      queued: 1,
    });
    await w.until(() => w.said().includes(zh.terminalBusy + zh.terminalBusyWaiting));
    await words(w.server, sid, "好了。");
    await endOf(w, sid, next);
    await w.idle();
    assert.equal(w.said().filter((t) => t.startsWith(zh.terminalBusy)).length, 2);
  }));

test("a wait that is not the terminal's running turn, or another message's, says nothing more than the floating line", () =>
  remoteWorld(async (w) => {
    const { sid, prompts } = await manual(w);
    await w.send("write the report");
    await w.until(() => prompts.length === 1);
    const cmd = prompts[0];
    // someone's half-typed text in the terminal's box: the live view says why, no chat message
    await w.server.emit(sid, "terminal_input_queued", {
      reason: "terminal_typing",
      cmd_id: cmd?.cmd_id ?? null,
      cmd_seq: seqOf(w, cmd),
      queued: 1,
    });
    // the terminal queues a message that is not this turn's (another prompt's number)
    await w.server.emit(sid, "terminal_input_queued", {
      reason: "terminal_working",
      cmd_id: "c-someone-else",
      cmd_seq: seqOf(w, cmd) + 7,
      queued: 2,
      held: "terminal",
    });
    await words(w.server, sid, "Done.");
    await endOf(w, sid, cmd);
    await w.idle();
    const busy = remoteAgentText.in("en").terminalBusy;
    assert.ok(!w.said().some((t) => t.startsWith(busy)), w.said().join("\n"));
    assert.equal(w.answer(), "Done.");
  }));
