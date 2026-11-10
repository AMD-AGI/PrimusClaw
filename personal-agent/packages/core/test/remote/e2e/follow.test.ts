// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What a chat attached to a remote agent shows of it BETWEEN turns (teams/tests/test_remote_follow.py): output that comes with no
// prompt open is delivered by itself (one new message), once; an answer never carries what came before its own prompt. Quiet hours
// and /pause (the assistant's) are ported with it.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import type { FollowTimings } from "../../../src/remote/follow/timings.js";
import { RemoteTurnState } from "../../../src/remote/turn-state.js";
import { CODEX_OPTIONS, type FakeRemote } from "../../../../../test-support/remote-fake.js";
import {
  ALICE,
  type RemoteWorld,
  Script,
  USER_A,
  USER_B,
  TEST_TIMINGS,
  WORLD_ERRORS,
  remoteWorld,
} from "../../../../../test-support/remote-world.js";
import { AAD, BOB, TWO_AGENTS } from "./helpers.js";

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

test("a session that ends while the chat is idle is told and the chat goes back to primusclaw", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.server.emit(sid, "session_closed", { reason: "the connector was stopped" });
    await w.until(() => w.said().some((t) => t.includes("The session ended")));
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

// --- leaving, and who is followed -------------------------------------------------------------------------------------------

const followers = (w: RemoteWorld): Map<string, unknown> =>
  (w.remote as unknown as { chats: { followers: Map<string, unknown> } }).chats.followers;

test("after a detach nothing the agent writes reaches the chat", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.say("/agent detach");
    const before = w.said().length;
    await w.server.say(sid, "Still working on my own.");
    await settle();
    assert.equal(w.said().length, before);
    assert.equal(followers(w).size, 0);
  }));

test("after an unlink nothing is read any more", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    w.remote.forgetPerson(AAD); // (what /unlink asks of the remote agents, the router's half aside)
    const opens = streams(w, sid).length;
    await w.server.say(sid, "Still here.");
    await settle();
    assert.deepEqual(onItsOwn(w), []);
    assert.equal(followers(w).size, 0);
    assert.equal(streams(w, sid).length, opens);
  }));

test("each attached chat is followed on one stream and only for its own session", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    const bob = USER_B.id;
    const bobCid = w.server.addConnector(BOB, "bobs-box", TWO_AGENTS);
    const bobSid = w.server.addSession(BOB, bobCid, "codex");
    w.conversationOf(USER_B); // (Bob's chat reference: where his news goes)
    w.test.store.remoteState.attachRemote(bob, {
      sessionId: bobSid,
      connectorId: bobCid,
      agentId: "codex",
      agentLabel: "⬛ Codex",
      host: "bobs-box",
      cwd: "/x",
    });
    follow(w).ensure(bob);
    await w.server.say(sid, "Alice's news.");
    await w.server.say(bobSid, "Bob's news.");
    await settle();
    const to = (user: { id: string }) =>
      w
        .operations()
        .filter((o) => o.conversation === `conv-${user.id}` && o.text.includes("on its own"))
        .map((o) => o.text);
    assert.equal(to(USER_A).length, 1);
    assert.ok(to(USER_A)[0]?.includes("Alice's news."));
    assert.equal(to(USER_B).length, 1);
    assert.ok(to(USER_B)[0]?.includes("Bob's news."));
    // (the first of Alice's is the one that waited for the agent to start)
    assert.equal(streams(w, sid).filter((s) => s.after > 0).length, 1);
    assert.equal(streams(w, bobSid).length, 1);
  }));

test("with the push switched off nothing is read between turns", () =>
  remoteWorld(async (w) => {
    w.settings.follow = false;
    const { sid } = await attachedClaude(w);
    await w.server.say(sid, "On its own.");
    await settle();
    assert.deepEqual(onItsOwn(w), []);
    assert.equal(followers(w).size, 0);
  }));

test("stop while the agent works on its own tells it to cancel and with nothing going on says so", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.say("/stop");
    assert.equal(w.last(), "Nothing is running.");
    assert.deepEqual(w.server.commandsOf("cancel"), []);
    await w.server.say(sid, "Busy with a thing I started myself");
    await w.server.tool(sid, "t1", "make", "pending");
    await sleep(200);
    const before = w.said().length;
    await w.say("/stop");
    assert.ok(w.said().slice(before).includes("Stopping the agent."), w.said().slice(before).join(" | "));
    assert.equal(w.server.commandsOf("cancel").length, 1);
    // (the agent ends its turn as cancelled: what it had said is delivered at once)
    await w.until(() => onItsOwn(w).length > 0);
  }));

// --- a worker that restarts -------------------------------------------------------------------------------------------------

test("a worker that starts follows the chats that are attached and says what it missed once", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.server.say(sid, "Said before the restart.");
    await settle();
    assert.equal(onItsOwn(w).length, 1);
    w.remote.shutdown(); // the worker goes down...
    await w.server.say(sid, "Said while the worker was down.");
    w.remote.resume(); // ...and comes back
    await settle();
    const told = onItsOwn(w);
    assert.equal(told.length, 2, told.join(" | "));
    assert.ok(told[1]?.includes("while the worker was down") && !told[1].includes("before the restart"), told[1] ?? "");
  }));

// --- more of the same: restarts, errors, holding, the unlink race --------------------------------------------------------------

test("text that was read but not yet said when the worker stops is said once by the next one", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    refollow(w, { quietMs: 30_000, toolQuietMs: 30_000, maxAgeMs: 60_000 });
    const marker = await w.server.say(sid, "Said by nobody yet.");
    await sleep(400); // read, and waiting for the pause
    assert.deepEqual(onItsOwn(w), []);
    w.remote.shutdown(); // the worker stops with the text unsaid
    await sleep(100);
    // the read position did not pass it
    assert.ok(Number(w.test.store.remoteState.attachedRemote(AAD)?.cursor || 0) < marker);
    w.settings.timings = TEST_TIMINGS;
    w.remote.resume();
    await settle();
    assert.equal(onItsOwn(w).length, 1);
    assert.ok(onItsOwn(w)[0]?.includes("Said by nobody yet."));
    w.remote.shutdown();
    w.remote.resume();
    await settle();
    assert.equal(onItsOwn(w).length, 1); // and not again
  }));

test("an unlink while a turn is open leaves nothing reading", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    script.onPrompt = async (srv, session) => {
      await srv.say(session, "Working, and not done."); // no turn end: the turn stays open
    };
    let opens = streams(w, sid).length;
    await w.send("a long task");
    await w.until(() => streams(w, sid).length > opens); // (the turn is reading)
    opens = streams(w, sid).length;
    w.remote.forgetPerson(AAD); // (what /unlink asks of the remote agents)
    await settle();
    assert.equal(followers(w).size, 0);
    assert.deepEqual(w.remote.busyChats(), []);
    assert.equal(streams(w, sid).length, opens);
  }));

test("a stream that is refused is not read again and one that fails is read again later", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    const reads = () => w.server.calls.filter(([, path]) => path.endsWith("/events")).length;
    follow(w).drop(AAD);
    w.server.failOn("GET", "/events", 401); // the key no longer works
    follow(w).ensure(AAD);
    await settle();
    const refused = reads();
    await settle();
    assert.equal(reads(), refused); // no retry loop
    assert.equal((followers(w).get(AAD) as { alive: boolean } | undefined)?.alive, false);
    assert.deepEqual(onItsOwn(w), []);
    follow(w).drop(AAD);
    w.server.failOn("GET", "/events", 500); // Claw is down for a moment
    follow(w).ensure(AAD);
    await sleep(300);
    w.server.fail.delete("GET /events");
    await w.server.say(sid, "Back after the outage.");
    await settle(1600);
    assert.equal(onItsOwn(w).length, 1, w.said().join(" | "));
    assert.ok(onItsOwn(w)[0]?.includes("Back after the outage."));
  }));

test("the answer so far is taken once and the ids already seen stay seen", () => {
  const state = new RemoteTurnState(WORLD_ERRORS);
  const chunk = (n: number, text: string) => ({
    id: String(n),
    name: "agent_message_chunk",
    data: { data: { update: { content: { text } } } },
  });
  state.feed(chunk(1, "one "));
  state.feed(chunk(2, "two"));
  assert.equal(state.answer, "one two");
  assert.equal(state.takeAnswer(), "one two");
  assert.equal(state.answer, "");
  assert.equal(state.takeAnswer(), "");
  state.feed(chunk(2, "two")); // the same event again: not folded twice
  assert.equal(state.answer, "");
  state.feed(chunk(3, "three"));
  assert.equal(state.takeAnswer(), "three");
});

test("the text waits for a step no longer than max age and messages come at most once per gap", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    refollow(w, { quietMs: 200, toolQuietMs: 60_000, gapMs: 1500, maxAgeMs: 800 });
    await w.server.say(sid, "First text, a step still open.");
    await w.server.tool(sid, "b1", "make all", "pending");
    const start = performance.now();
    await w.until(() => onItsOwn(w).length > 0, 5000);
    const waited = performance.now() - start;
    assert.ok(waited > 500 && waited < 2000, String(waited)); // maxAge (800 ms), not toolQuiet (a minute)
    const firstAt = performance.now();
    await w.server.tool(sid, "b1", "make all", "completed");
    await w.server.say(sid, "Second text, soon after the first.");
    await sleep(600);
    assert.equal(onItsOwn(w).length, 1); // the gap (1.5 s) has not passed
    await w.until(() => onItsOwn(w).length === 2, 5000);
    assert.ok(performance.now() - firstAt >= 1400);
  }));

test("an event for a chat that has left the session says nothing", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    const follower = followers(w).get(AAD) as { alive: boolean } | undefined;
    assert.ok(follower);
    w.test.store.remoteState.detachRemote(AAD); // (the state changed without the follower being told)
    await w.server.say(sid, "Nobody is listening.");
    await settle();
    assert.deepEqual(onItsOwn(w), []);
    assert.deepEqual(w.held, []);
    assert.equal(follower.alive, false); // it saw that the chat had left the session, and went
  }));

test("a message that is refused leaves the chat followed", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    const machine = w.server.connector([...w.server.connectors.keys()][0] ?? "");
    machine.online = false;
    await w.say("anyone there?");
    assert.ok(w.last().includes("offline"), w.last()); // nothing was sent, so no turn reads the session
    await w.server.say(sid, "It came back by itself and finished.");
    await settle();
    assert.equal(onItsOwn(w).length, 1);
    machine.online = true;
    w.server.failOn("POST", "/commands", 500);
    await w.say("and now?");
    w.server.fail.delete("POST /commands");
    await w.server.say(sid, "Second thing it finished.");
    await settle();
    assert.equal(onItsOwn(w).length, 2);
    assert.deepEqual(prompts(w), []);
  }));

test("a turn end with no new text does not say the last text again", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.server.say(sid, "Said once.");
    await settle();
    assert.equal(onItsOwn(w).length, 1);
    await w.server.tool(sid, "t1", "Run tests", "pending");
    await w.server.tool(sid, "t1", "Run tests", "completed");
    await w.server.end(sid); // a connector that does end its turns: only steps since the text
    await settle();
    assert.equal(onItsOwn(w).length, 1);
  }));

// --- found by the review: a step's late update, a send that fails, an end that cannot be read ----------------------------------

test("an update of a step that says no status does not reopen it after it ended", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.server.say(sid, "The tests ran.");
    await w.server.tool(sid, "t1", "Run tests", "pending");
    await w.server.tool(sid, "t1", "Run tests", "completed");
    await w.server.acp(sid, "tool_call_update", { toolCallId: "t1", title: "Run tests" }); // more output of it: no status
    await sleep(700); // past `quietMs` (250), well short of `toolQuietMs` (1000): nothing is open
    assert.equal(onItsOwn(w).length, 1);
  }));

test("text that cannot be sent when the user writes is held and not part of the answer", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    refollow(w, { quietMs: 30_000, toolQuietMs: 30_000, maxAgeMs: 60_000 });
    script.onPrompt = answer("Answer to the prompt.");
    const said = await w.server.say(sid, "Read, not yet said.");
    await sleep(300);
    w.refuse = (message) => JSON.stringify(message).includes("Read, not yet said."); // (the queue is down for it)
    await w.say("go on");
    assert.equal(w.answer(), "Answer to the prompt.", w.said().join(" | ")); // the unsent text is not carried by this answer
    assert.deepEqual(onItsOwn(w), []);
    // held for the assistant's release (its quiet-hours sweep, tested with it)
    assert.equal(w.held.length, 1);
    assert.ok(w.held[0]?.text.includes("Read, not yet said."));
    assert.equal(w.held[0]?.chatKey, AAD);
    assert.equal(w.held[0].eventId, String(said)); // (the event it came with: the assistant holds one burst once)
  }));

test("a message is not sent when the end of the session cannot be read and goes when it can", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    followOff(w);
    script.onPrompt = answer("Clean answer.");
    for (let n = 0; n < 2; n += 1) await w.server.say(sid, `older output ${String(n)}. `);
    w.server.failOn("GET", "/events", 500);
    await w.say("hello?");
    assert.ok(w.last().includes("nothing was sent"), w.last());
    assert.deepEqual(prompts(w), []);
    w.server.fail.delete("GET /events");
    await w.say("hello again");
    assert.deepEqual(prompts(w), ["hello again"]);
    assert.equal(w.answer(), "Clean answer.", w.said().join(" | "));
  }));

test("a worker that restarts in the middle of a turn delivers the rest of it and closes the turn", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    w.remote.shutdown();
    w.test.store.remoteState.setRemoteTurn(AAD, sid, true); // (a prompt had been sent and the worker died before the answer)
    await w.server.say(sid, "Half of the answer, ");
    await w.server.say(sid, "and the rest.");
    await w.server.end(sid);
    w.remote.resume(); // the worker is back
    await w.until(() => onItsOwn(w).length > 0);
    assert.ok(onItsOwn(w)[0]?.includes("Half of the answer, and the rest."), onItsOwn(w)[0] ?? "");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false);
    script.onPrompt = answer("Fresh answer.");
    await w.say("next"); // the turn is over: this is a new prompt, not "I lost track of your previous task"
    assert.deepEqual(prompts(w), ["next"]);
    assert.ok(!w.said().some((t) => t.includes("lost track")));
    assert.ok(w.answer().includes("Fresh answer."));
  }));

test("a permission request with no prompt open gets its card and in quiet hours none", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    await w.server.ask(sid, "act-1", "Run: rm -rf build", CODEX_OPTIONS, { kind: "execute" });
    await w.until(() => w.permissionCards().length > 0);
    assert.equal(w.permissionCards().length, 1);
    w.reachable = false; // (quiet hours, long after the person last wrote: the assistant's rule says nobody may be woken)
    await w.server.ask(sid, "act-2", "Run: make", CODEX_OPTIONS, { kind: "execute" });
    await settle();
    assert.equal(w.permissionCards().length, 1); // an approval is never pushed to wake someone
  }));
