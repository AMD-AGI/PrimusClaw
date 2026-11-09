// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What a chat attached to a remote agent shows of it BETWEEN turns (teams/tests/test_remote_follow.py): output that comes with no
// prompt open is delivered by itself (one new message), once; an answer never carries what came before its own prompt. Quiet hours
// and /pause (the assistant's) are ported with it.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import type { FollowTimings } from "../../../src/remote/follow/timings.js";
import type { FakeRemote } from "../../../../../test-support/remote-fake.js";
import {
  ALICE,
  type RemoteWorld,
  Script,
  TEST_TIMINGS,
  remoteWorld,
} from "../../../../../test-support/remote-world.js";
import { AAD, TWO_AGENTS } from "./helpers.js";

/** The chat attached to a claude session on dev-pod; the script the test then changes. */
async function attachedClaude(w: RemoteWorld, script = new Script()): Promise<{ sid: string; script: Script }> {
  w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
  w.server.onCommand = script.hook;
  await w.say("/agent new claude /home/me/repo");
  const state = w.test.store.remoteState.attachedRemote(AAD);
  assert.ok(state, w.said().join("\n"));
  return { sid: state.sessionId ?? "", script };
}

/** The messages of what the agent said with no prompt open (they are headed with who said it). */
const onItsOwn = (w: RemoteWorld): string[] => w.said().filter((t) => t.includes("on its own"));
const prompts = (w: RemoteWorld): unknown[] => w.server.commandsOf("prompt").map((c) => c.body["text"]);
/** Longer than the pause that ends a burst (`quietMs` of the test world), and than the reading of a few events. */
const settle = (ms = 900): Promise<void> => sleep(ms);
const streams = (w: RemoteWorld, sid: string) => w.server.streamOpens.filter((s) => s.session_id === sid);

interface Follow {
  ensure(chatKey: string): void;
  drop(chatKey: string): void;
}
const follow = (w: RemoteWorld): Follow => (w.remote as unknown as { follow: Follow }).follow;

/** The worker with the push switched off, and whatever is following the chat dropped. */
function followOff(w: RemoteWorld): void {
  w.settings.follow = false;
  follow(w).drop(AAD);
}

/** The chat's reader again, with these timings. */
function refollow(w: RemoteWorld, timings: Partial<FollowTimings>): void {
  w.settings.timings = { ...TEST_TIMINGS, ...timings };
  follow(w).drop(AAD);
  follow(w).ensure(AAD);
}

const answer = (text: string) => async (srv: FakeRemote, sid: string) => {
  await srv.say(sid, text);
  await srv.end(sid);
};

// --- the defect: output with no prompt open --------------------------------------------------------------------------------

test("what the agent writes after its turn reaches the chat without a message from the user", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    script.onPrompt = answer("First answer.");
    await w.say("do the thing");
    assert.ok(w.answer().includes("First answer."));
    const before = w.said().length;
    // the agent goes on by itself (a background task finished): chunks and tool calls, and no turn end
    await w.server.say(sid, "The background job ");
    await w.server.tool(sid, "t1", "Run tests", "pending");
    await w.server.tool(sid, "t1", "Run tests", "completed");
    await w.server.say(sid, "finished: 42 tests passed.");
    await settle();
    const told = onItsOwn(w);
    assert.equal(told.length, 1, w.said().slice(before).join(" | "));
    assert.ok(told[0]?.includes("finished: 42 tests passed."));
    assert.ok(!told[0]?.includes("⬛") && told[0]?.includes("🟠 Claude Code on dev-pod"), told[0] ?? ""); // who said it
    assert.equal(w.said().length, before + 1); // nothing else was sent: no live view, no action row, no second copy
    assert.deepEqual(prompts(w), ["do the thing"]);
  }));

test("it is a new message and the chat is not asked anything", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.server.say(sid, "Heads up: the deploy finished.");
    await settle();
    const sent = w.operations().filter((o) => o.text.includes("on its own"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.op, "send"); // (an edit is not redrawn by Teams on a phone, and does not buzz)
    assert.deepEqual(prompts(w), []);
  }));

test("a burst with steps between is one message with the last text and a second burst is a second message", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    for (let n = 0; n < 5; n += 1) {
      await w.server.say(sid, `narration ${String(n)}. `);
      await w.server.tool(sid, `t${String(n)}`, `step ${String(n)}`, "pending");
      await w.server.tool(sid, `t${String(n)}`, `step ${String(n)}`, "completed");
    }
    await w.server.say(sid, "All five steps done.");
    await settle();
    let told = onItsOwn(w);
    assert.equal(told.length, 1, told.join(" | "));
    assert.ok(told[0]?.includes("All five steps done.") && !told[0].includes("narration"), told[0] ?? "");
    await w.server.say(sid, "Later: one more thing finished.");
    await settle();
    told = onItsOwn(w);
    assert.equal(told.length, 2, told.join(" | "));
    assert.ok(told[1]?.includes("one more thing finished") && !told[1].includes("All five steps done."), told[1] ?? "");
    await settle();
    assert.equal(onItsOwn(w).length, 2); // nothing is said twice
  }));

test("steps and thoughts with no text say nothing", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    const before = w.said().length;
    await w.server.think(sid, "hmm");
    await w.server.tool(sid, "t1", "Read a file", "pending");
    await w.server.tool(sid, "t1", "Read a file", "completed");
    await settle();
    assert.equal(w.said().length, before);
  }));

test("a step that is still running holds the text back until it ends", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.server.say(sid, "Started the long build.");
    await w.server.tool(sid, "b1", "make all", "pending");
    await sleep(600); // longer than `quietMs` (250), shorter than `toolQuietMs` (1000): the agent is not done
    assert.deepEqual(onItsOwn(w), []);
    await w.server.tool(sid, "b1", "make all", "completed");
    await w.server.say(sid, "Build finished.");
    await settle();
    assert.equal(onItsOwn(w).length, 1);
    assert.ok(onItsOwn(w)[0]?.includes("Build finished."));
  }));

test("a step that never ends does not hold the text for ever", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.server.say(sid, "Waiting on a build that hangs.");
    await w.server.tool(sid, "b1", "make all", "pending");
    await sleep(1800); // past `toolQuietMs`
    assert.equal(onItsOwn(w).length, 1);
  }));

test("a connector that ends the turn is shown at once and the open turn is closed", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    w.test.store.remoteState.setRemoteTurn(AAD, sid, true); // (this worker believed a turn was open)
    await w.server.say(sid, "It finished.");
    await w.server.end(sid);
    await w.until(() => onItsOwn(w).length > 0);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false);
  }));

// --- the answer to a prompt is that prompt's ---------------------------------------------------------------------------------

test("an answer never carries what the agent wrote before the prompt", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    script.onPrompt = answer("Here is the help you asked for.");
    // a backlog the worker has not delivered (the follower is off here: the fallback must hold too)
    for (let n = 0; n < 3; n += 1) await w.server.say(sid, `old context ${String(n)}. `);
    followOff(w);
    await w.say("what now?");
    assert.equal(w.answer(), "Here is the help you asked for.", w.said().join(" | "));
    assert.ok(!w.progressTexts().some((t) => t.includes("old context")), w.progressTexts().join(" | "));
  }));

test("the backlog the follower has not delivered yet goes out first and apart from the answer", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    refollow(w, { quietMs: 30_000, toolQuietMs: 30_000, maxAgeMs: 60_000 }); // (a pause not over yet)
    script.onPrompt = answer("Answer to the prompt.");
    await w.server.say(sid, "The nightly job finished.");
    await sleep(300); // read, not yet said
    assert.deepEqual(onItsOwn(w), []);
    await w.say("anything new?");
    const told = onItsOwn(w);
    assert.equal(told.length, 1, told.join(" | "));
    assert.ok(told[0]?.includes("The nightly job finished."));
    assert.equal(w.answer(), "Answer to the prompt.");
    assert.ok(w.said().indexOf(told[0] ?? "") < w.said().indexOf("Answer to the prompt."), "the earlier output first");
  }));

test("after a turn the agent is followed again from where the turn ended and nothing is said twice", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    script.onPrompt = answer("Answer one.");
    await w.say("first");
    await w.server.say(sid, "Between turns: result A.");
    await settle();
    script.onPrompt = answer("Answer two.");
    await w.say("second");
    await w.server.say(sid, "Between turns: result B.");
    await settle();
    const told = onItsOwn(w);
    assert.deepEqual(
      told.map((t) => [t.includes("result A"), t.includes("result B")]),
      [
        [true, false],
        [false, true],
      ],
      told.join(" | "),
    );
    assert.equal(w.said().filter((t) => t.includes("Answer one.")).length, 1);
    assert.equal(w.said().filter((t) => t.includes("Answer two.")).length, 1);
  }));

test("a stream that drops is picked up after the last event and nothing is said twice", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    w.server.dropStreamAfter = 2;
    await w.server.say(sid, "part one, ");
    await w.server.say(sid, "part two, ");
    await w.server.say(sid, "part three.");
    await settle(1400);
    const told = onItsOwn(w);
    assert.equal(told.length, 1, w.said().join(" | "));
    assert.ok(told[0]?.includes("part one, part two, part three."), told[0] ?? "");
    const opens = streams(w, sid);
    assert.ok(opens.length >= 2 && (opens.at(-1)?.after ?? 0) > 0, JSON.stringify(opens));
  }));
