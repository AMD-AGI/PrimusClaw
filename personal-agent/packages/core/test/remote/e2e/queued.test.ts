// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A message sent to an attached session while the agent still works on the previous one: it is sent at once and waits on the
// machine behind that turn (the connector queues it, as Claude Code queues what is typed while it works), the person is told so,
// and its own turn is read and answered right after the one in front. `/stop` stops the running turn and gives up what waits.
// The connector here is the test's: each prompt is only recorded, and the test says what the machine does and when.
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteAgentText } from "../../../src/locales/remote-agents.js";
import { QUEUED_PROMPTS_MAX } from "../../../src/remote/chats.js";
import type { FakeCommand, FakeRemote } from "../../../../../test-support/remote-fake.js";
import { type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, attached, en, oneTurn } from "./helpers.js";

const zh = remoteAgentText.in("zh");

/** Claw's number of a command, as the fake answers it (its place among every command the server took, from 1). */
function seqOf(w: RemoteWorld, cmd: FakeCommand | undefined): number {
  assert.ok(cmd);
  return w.server.commands.indexOf(cmd) + 1;
}

/** The turn of `cmd` ends on the machine, naming its prompt as the connector does. */
function endOf(w: RemoteWorld, sid: string, cmd: FakeCommand | undefined, reason = "end_turn"): Promise<number> {
  return w.server.emit(sid, "turn_end", { stopReason: reason, cmd_id: cmd?.cmd_id ?? null, cmd_seq: seqOf(w, cmd) });
}

/** A session whose prompts the test runs by hand: `prompts` gets each one as Claw hands it to the machine. */
async function manual(w: RemoteWorld): Promise<{ sid: string; prompts: FakeCommand[]; script: Script }> {
  const script = new Script();
  const prompts: FakeCommand[] = [];
  script.onPrompt = (_srv: FakeRemote, _sid: string, cmd: FakeCommand) => {
    prompts.push(cmd);
    return Promise.resolve();
  };
  const { sid } = await attached(w, script);
  return { sid, prompts, script };
}

/** The first message's turn is under way: its words are on the live view. */
async function firstRunning(w: RemoteWorld, sid: string, prompts: FakeCommand[]): Promise<void> {
  await w.send("write the report");
  await w.until(() => prompts.length === 1);
  await w.server.say(sid, "Reading the sources...");
  await w.server.tool(sid, "call-1", "Read sources.md");
  await w.until(() => w.progressTexts().some((t) => t.includes("Reading the sources")));
}

test("a message while the agent is working is queued behind its turn and answered after it", () =>
  remoteWorld(async (w) => {
    const { sid, prompts } = await manual(w);
    await firstRunning(w, sid, prompts);
    await w.send("also, what time is it there?");
    await w.until(() => prompts.length === 2);
    // sent at once, in order, and the person is told it waits (not that it was refused)
    assert.deepEqual(
      w.server.commandsOf("prompt").map((c) => c.body["text"]),
      ["write the report", "also, what time is it there?"],
    );
    await w.until(() => w.last() === en.queuedBehind({ n: 1 }));
    assert.ok(w.remote.busyChats().length > 0);
    // the machine ends the first turn, then runs the queued message
    await w.server.say(sid, "The report is written.");
    await endOf(w, sid, prompts[0]);
    await w.until(() => w.said().includes("The report is written."));
    assert.ok(w.remote.busyChats().length > 0, "the queued message's turn is read next");
    await w.server.say(sid, "It is 9:00.");
    await endOf(w, sid, prompts[1]);
    await w.idle();
    const said = w.said();
    assert.equal(w.answer(), "It is 9:00.");
    assert.ok(said.indexOf("The report is written.") < said.indexOf("It is 9:00."), said.join("\n"));
    const state = w.test.store.remoteState.attachedRemote(AAD);
    assert.ok(state && !state.turnOpen);
  }));

test("a correction sent during the turn reaches the agent as the next message, in order", () =>
  remoteWorld(async (w) => {
    const { sid, prompts } = await manual(w);
    await firstRunning(w, sid, prompts);
    await w.send("算了，改成只写摘要");
    await w.until(() => prompts.length === 2);
    await w.until(() => [en.queuedBehind({ n: 1 }), zh.queuedBehind({ n: 1 })].includes(w.last()));
    await endOf(w, sid, prompts[0], "cancelled");
    await w.server.say(sid, "好的，只写了摘要。");
    await endOf(w, sid, prompts[1]);
    await w.idle();
    assert.equal(w.answer(), "好的，只写了摘要。");
  }));

test("several messages queue in order and each is answered in turn", () =>
  remoteWorld(async (w) => {
    const { sid, prompts } = await manual(w);
    await firstRunning(w, sid, prompts);
    await w.send("second");
    await w.until(() => w.last() === en.queuedBehind({ n: 1 }));
    await w.send("third");
    await w.until(() => w.last() === en.queuedBehind({ n: 2 }));
    assert.equal(prompts.length, 3);
    for (const [i, answer] of ["one", "two", "three"].entries()) {
      await w.server.say(sid, `Answer ${answer}.`);
      await endOf(w, sid, prompts[i]);
      await w.until(() => w.said().includes(`Answer ${answer}.`));
    }
    await w.idle();
    const said = w.said().filter((t) => t.startsWith("Answer "));
    assert.deepEqual(said, ["Answer one.", "Answer two.", "Answer three."]);
  }));

test("past what the machine queues a message is not sent, and the person is told why", () =>
  remoteWorld(async (w) => {
    const { sid, prompts } = await manual(w);
    await firstRunning(w, sid, prompts);
    for (let i = 1; i <= QUEUED_PROMPTS_MAX; i += 1) {
      await w.send(`queued ${String(i)}`);
      await w.until(() => w.last() === en.queuedBehind({ n: i }));
    }
    await w.send("one too many");
    await w.until(() => w.last() === en.queueFull({ n: QUEUED_PROMPTS_MAX }));
    assert.equal(w.server.commandsOf("prompt").length, 1 + QUEUED_PROMPTS_MAX);
    await w.send("/stop");
    await w.idle();
  }));

test("/stop during a turn stops it, drops what was queued behind it, and the next message runs as usual", () =>
  remoteWorld(async (w) => {
    const { sid, prompts, script } = await manual(w);
    await firstRunning(w, sid, prompts);
    await w.send("second");
    await w.until(() => w.last() === en.queuedBehind({ n: 1 }));
    await w.send("/stop"); // (the fake connector ends the running turn as cancelled, naming no prompt, as an older one does)
    await w.idle();
    assert.deepEqual(w.server.commandsOf("cancel").length, 1);
    assert.ok(w.said().includes(en.stopping + en.queueDropped({ n: 1 })), w.said().join("\n"));
    // nothing waits on the dropped message: the chat is free, and the next message starts its own turn
    script.onPrompt = oneTurn;
    await w.say("try again");
    assert.equal(w.answer(), "Done.");
    assert.deepEqual(
      w.server.commandsOf("prompt").map((c) => c.body["text"]),
      ["write the report", "second", "try again"],
    );
  }));

test("a queued message the machine refuses before it runs is given up, and the person is told", () =>
  remoteWorld(async (w) => {
    const { sid, prompts } = await manual(w);
    await firstRunning(w, sid, prompts);
    await w.send("second");
    await w.until(() => prompts.length === 2);
    await w.server.emit(sid, "command_rejected", {
      type: "prompt",
      reason: "too_many_queued_prompts",
      cmd_id: prompts[1]?.cmd_id ?? null,
      cmd_seq: seqOf(w, prompts[1]),
    });
    await w.until(() => w.said().some((t) => t.startsWith(en.queuedRefused({ reason: "" }))));
    await w.server.say(sid, "The report is written.");
    await endOf(w, sid, prompts[0]);
    await w.idle(); // (no turn is read for the refused message: nothing would ever end it)
    assert.equal(w.answer(), "The report is written.");
  }));

test("the queued message's turn is not ended by the end of the turn in front of it", () =>
  remoteWorld(async (w) => {
    const { sid, prompts } = await manual(w);
    await firstRunning(w, sid, prompts);
    await w.send("second");
    await w.until(() => w.last() === en.queuedBehind({ n: 1 }));
    // the first prompt is refused on the machine by name, and its turn_end follows the refusal (a terminal's refusal says both)
    await w.server.emit(sid, "command_rejected", {
      type: "prompt",
      reason: "terminal_busy",
      cmd_id: prompts[0]?.cmd_id ?? null,
      cmd_seq: seqOf(w, prompts[0]),
    });
    await w.until(() => w.last() !== en.queuedBehind({ n: 1 })); // (the first turn's end is said: the refusal)
    await endOf(w, sid, prompts[0], "error");
    await w.server.say(sid, "Second answer.");
    await endOf(w, sid, prompts[1]);
    await w.idle();
    assert.equal(w.answer(), "Second answer.");
  }));
