// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A chat that streams keeps a stream's message where the stream opened: under the person's message it answers. When the person
// writes again while the agent works (or the chat is told something meanwhile), everything after that sits below the stream's
// bubble. An answer begun in the bubble and continued below is then read from its middle: its "(cont. 2/2)" lands under the
// queued message's notice and its first part is out of sight above both. The answer must come below what was said since, whole
// and in order.
import assert from "node:assert/strict";
import { test } from "node:test";

import { turnText } from "../../../src/locales/turn.js";
import type { FakeCommand, FakeRemote } from "../../../../../test-support/remote-fake.js";
import type { Recorded } from "../../../../../test-support/surface.js";
import { type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { attached, en } from "./helpers.js";

const ACP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function seqOf(w: RemoteWorld, cmd: FakeCommand | undefined): number {
  assert.ok(cmd);
  return w.server.commands.indexOf(cmd) + 1;
}

function endOf(w: RemoteWorld, sid: string, cmd: FakeCommand | undefined): Promise<number> {
  return w.server.emit(sid, "turn_end", {
    stopReason: "end_turn",
    cmd_id: cmd?.cmd_id ?? null,
    cmd_seq: seqOf(w, cmd),
  });
}

function words(srv: FakeRemote, sid: string, text: string): Promise<number> {
  return srv.emit(sid, "agent_message_chunk", {
    sessionId: ACP,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
  });
}

function step(srv: FakeRemote, sid: string, id: string, command: string): Promise<number> {
  return srv.emit(sid, "tool_call", {
    sessionId: ACP,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: id,
      title: `Bash: ${command}`,
      kind: "other",
      status: "in_progress",
      rawInput: { command },
      _meta: { claudeCode: { toolName: "Bash" } },
    },
  });
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

/** The stream's close at the chat's limit (minutes away) does not come within a test. */
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

/**
 * The chat as the person reads it, top to bottom: a stream's message stays where the stream opened and ends as its final; every
 * other message goes at the bottom when it is sent. `person`: where the person's own messages came, by the outbox's length then.
 */
function chat(outbox: readonly Recorded[], person: ReadonlyMap<number, string>): string[] {
  const lines: string[] = [];
  let bubble = -1;
  outbox.forEach((r, i) => {
    const said = person.get(i);
    if (said !== undefined) lines.push(`person: ${said}`);
    if (r.op === "stream.open") {
      bubble = lines.length;
      lines.push("(stream)");
    } else if (r.op === "stream.finish" && bubble >= 0) {
      lines[bubble] = JSON.stringify(r.message.body);
      bubble = -1;
    } else if (r.op === "send") {
      lines.push(JSON.stringify(r.message.body));
    }
  });
  const said = person.get(outbox.length);
  if (said !== undefined) lines.push(`person: ${said}`);
  return lines;
}

// (more than a stream's bubble holds: as on 2026-11-24, the bubble would end with the first part and the rest follow as messages)
const PARAS = ["First", "Second", "Third"].map(
  (n) => `${n} part of the overview. ${"The engine runs one round per candidate and keeps the best. ".repeat(38)}`,
);

test("a long answer whose turn the person wrote into comes below the queued message's notice, whole and in order", () =>
  remoteWorld(
    async (w) => {
      neverPastAMinute(w);
      const { sid, prompts } = await manual(w);
      const person = new Map<number, string>();
      person.set(w.surface.outbox.length, "explain the repo");
      await w.send("explain the repo");
      await w.until(() => prompts.length === 1);
      await step(w.server, sid, "toolu_1", "ls");
      await w.until(() => w.surface.outbox.some((r) => r.op === "stream.inform" && r.text.includes("ls")));
      // The person writes again while the agent still works: queued behind its turn, and told so.
      person.set(w.surface.outbox.length, "how did you install git?");
      await w.send("how did you install git?");
      await w.until(() => w.said().includes(en.queuedBehind({ n: 1 })));
      // The agent then writes a long answer (two messages' worth) and ends its turn.
      await words(w.server, sid, PARAS.join("\n\n"));
      await endOf(w, sid, prompts[0]);
      await w.until(() => w.said().some((t) => t.includes("Third part of the overview.")));
      await words(w.server, sid, "Installed with apt.");
      await endOf(w, sid, prompts[1]);
      await w.idle();

      const read = chat(w.surface.outbox, person);
      const at = (needle: string): number => read.findIndex((line) => line.includes(needle));
      const notice = at(en.queuedBehind({ n: 1 }));
      const parts = ["First", "Second", "Third"].map((n) => at(`${n} part of the overview.`));
      const [first = -1, second = -1, third = -1] = parts;
      const shown = read.join("\n");
      assert.ok(notice >= 0 && parts.every((i) => i >= 0), shown);
      // Nothing of the answer is left above the notice, out of the reader's sight ...
      assert.ok(first > notice, `the answer's first part is above what was said since:\n${shown}`);
      // ... its parts are new messages next to each other, the first with the agent's head, the others its continuation ...
      assert.deepEqual([second, third], [first + 1, first + 2], shown);
      assert.ok(read[first]?.includes("Claude Code"), shown);
      assert.ok(read[second]?.includes("(cont. 2/3)") && read[third]?.includes("(cont. 3/3)"), shown);
      // ... and the first turn's bubble (above the person's second message) only says where the answer is.
      const bubble = at(turnText.in("en").answerBelow);
      assert.ok(bubble >= 0 && bubble < at("person: how did you install git?"), shown);
      assert.ok(!(read[bubble] ?? "").includes("overview"), shown);
      // Each part is said once, and the second message's answer follows after the first's.
      for (const n of ["First", "Second", "Third"]) {
        assert.equal(read.filter((line) => line.includes(`${n} part of the overview.`)).length, 1, shown);
      }
      assert.ok(at("Installed with apt.") > third, shown);
    },
    { direct: true, streaming: true },
  ));
