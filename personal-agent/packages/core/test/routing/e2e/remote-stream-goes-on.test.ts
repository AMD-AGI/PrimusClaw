// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Whatever is said in a chat while its agent's turn streams there sits below the stream's bubble: a command answered at once
// (`/agent sessions`) as much as a queued message. The answer must then come below that, whole and in order, never begun in
// the bubble above it and continued below. The router in front of the real remote agents tells the turn at its one entry.
import assert from "node:assert/strict";
import { test } from "node:test";

import { turnText } from "../../../src/locales/turn.js";
import type { FakeCommand } from "../../../../../test-support/remote-fake.js";
import { type RemoteWorld, Script } from "../../../../../test-support/remote-world.js";
import type { Recorded } from "../../../../../test-support/surface.js";
import { message } from "../world.js";
import { attachedThroughRouter, routed } from "./remote-routed.js";

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

/** The chat top to bottom: a stream's message stays where the stream opened; every other message goes at the bottom. */
function chat(outbox: readonly Recorded[], from: number): string[] {
  const lines: string[] = [];
  let bubble = -1;
  outbox.slice(from).forEach((r) => {
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
  return lines;
}

const PARAS = ["First", "Second", "Third"].map(
  (n) => `${n} part of the overview. ${"The engine runs one round per candidate and keeps the best. ".repeat(38)}`,
);

test("a long answer comes below a slash command answered while it streamed, whole and in order", () =>
  routed(
    async (w) => {
      neverPastAMinute(w.rw);
      const script = new Script();
      const prompts: FakeCommand[] = [];
      script.onPrompt = (_srv, _sid, cmd) => {
        prompts.push(cmd);
        return Promise.resolve();
      };
      const sid = await attachedThroughRouter(w, script);
      const from = w.rw.surface.outbox.length;
      await w.r.router.handle(message("explain the repo"));
      await w.rw.until(() => prompts.length === 1);
      await w.rw.server.say(sid, "I will look first.");
      await w.rw.until(() =>
        w.rw.surface.outbox.some((r) => r.op === "stream.emit" && r.text.includes("I will look first.")),
      );
      // The person asks for their sessions while the agent still works: answered at once, below the stream.
      const before = w.rw.surface.outbox.length;
      await w.r.router.handle(message("/agent sessions"));
      const reply = w.rw.surface.outbox.slice(before).find((r) => r.op === "send");
      assert.ok(reply, "the command was answered");
      const said = JSON.stringify(reply.message.body);
      await w.rw.server.say(sid, PARAS.join("\n\n"));
      await w.rw.server.end(sid);
      await w.rw.idle();

      const read = chat(w.rw.surface.outbox, from);
      const shown = read.join("\n");
      const command = read.indexOf(said);
      const parts = ["First", "Second", "Third"].map((n) =>
        read.findIndex((l) => l.includes(`${n} part of the overview.`)),
      );
      const [first = -1] = parts;
      assert.ok(command >= 0 && parts.every((i) => i >= 0), shown);
      // Nothing of the answer is left above the command's reply, and its parts follow each other there ...
      assert.ok(first > command, `the answer's first part is above the command's reply:\n${shown}`);
      assert.deepEqual(parts, [first, first + 1, first + 2], shown);
      assert.ok(read[first + 1]?.includes("(cont. 2/3)") && read[first + 2]?.includes("(cont. 3/3)"), shown);
      // ... each said once, and the bubble above the reply only says where the answer is.
      for (const n of ["First", "Second", "Third"]) {
        assert.equal(read.filter((line) => line.includes(`${n} part of the overview.`)).length, 1, shown);
      }
      const bubble = read.findIndex((line) => line.includes(turnText.in("en").answerBelow));
      assert.ok(bubble >= 0 && bubble < command, shown);
    },
    { remote: { direct: true, streaming: true } },
  ));

test("a turn with nothing said below its stream still answers in the stream's bubble", () =>
  routed(
    async (w) => {
      neverPastAMinute(w.rw);
      const script = new Script();
      const sid = await attachedThroughRouter(w, script);
      script.onPrompt = async (srv) => {
        await srv.say(sid, "Short answer.");
        await srv.end(sid);
      };
      const from = w.rw.surface.outbox.length;
      await w.say("explain the repo");
      const read = chat(w.rw.surface.outbox, from);
      assert.ok(!read.some((line) => line.includes(turnText.in("en").answerBelow)), read.join("\n"));
      assert.equal(read.filter((line) => line.includes("Short answer.")).length, 1, read.join("\n"));
    },
    { remote: { direct: true, streaming: true } },
  ));
