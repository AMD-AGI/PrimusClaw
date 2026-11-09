// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Follow-ups of the remote agent push, each with the scenario that found it (teams/tests/test_remote_followups.py). Whether a person
// may be woken (quiet hours, /pause, the reply window) is the assistant's; here the chat is reachable or not as a test says.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import { CredentialUnavailable } from "../../../src/remote/follow/follower.js";
import type { FollowTimings } from "../../../src/remote/follow/timings.js";
import { ANSWER_CHARS_MAX } from "../../../src/remote-view/limits.js";
import { CODEX_OPTIONS, type FakeRemote } from "../../../../../test-support/remote-fake.js";
import {
  ALICE,
  type RemoteWorld,
  Script,
  TEST_TIMINGS,
  remoteWorld,
} from "../../../../../test-support/remote-world.js";
import { AAD, TWO_AGENTS } from "./helpers.js";

const answer = (text: string) => async (srv: FakeRemote, sid: string) => {
  await srv.say(sid, text);
  await srv.end(sid);
};

async function attachedClaude(w: RemoteWorld, script = new Script()): Promise<{ sid: string; script: Script }> {
  w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
  w.server.onCommand = script.hook;
  await w.say("/agent new claude /home/me/repo");
  const state = w.test.store.remoteState.attachedRemote(AAD);
  assert.ok(state, w.said().join("\n"));
  return { sid: state.sessionId ?? "", script };
}

/**
 * A session on the user's machine that has had a turn, then went on by itself with no `turn_end` (a background task that
 * finishes, a scheduled job, a `Monitor`); and the chat's list of sessions.
 */
async function sessionWithATail(w: RemoteWorld, script = new Script()): Promise<string> {
  const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
  const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
  w.server.onCommand = script.hook;
  await w.server.started(sid, { mode: "plan" });
  await w.server.say(sid, "turn text");
  await w.server.end(sid);
  await w.server.say(sid, "autonomous output after the turn, no turn_end");
  await w.server.tool(sid, "t1", "Monitor: tests", "pending");
  await w.say("/agent sessions");
  return sid;
}

const onItsOwn = (w: RemoteWorld): string[] => w.said().filter((t) => t.includes("on its own"));
const prompts = (w: RemoteWorld): unknown[] => w.server.commandsOf("prompt").map((c) => c.body["text"]);
const settle = (ms = 900): Promise<void> => sleep(ms);
const turnOpen = (w: RemoteWorld): boolean | undefined => w.test.store.remoteState.attachedRemote(AAD)?.turnOpen;

interface Follow {
  ensure(chatKey: string): void;
  drop(chatKey: string): void;
}
const follow = (w: RemoteWorld): Follow => (w.remote as unknown as { follow: Follow }).follow;
const follower = (w: RemoteWorld): { alive: boolean } | undefined =>
  (w.remote as unknown as { chats: { followers: Map<string, { alive: boolean }> } }).chats.followers.get(AAD);

function refollow(w: RemoteWorld, timings: Partial<FollowTimings>): void {
  w.settings.timings = { ...TEST_TIMINGS, ...timings };
  follow(w).drop(AAD);
  follow(w).ensure(AAD);
}

function followOff(w: RemoteWorld): void {
  w.settings.follow = false;
  follow(w).drop(AAD);
}

// --- 1. attaching to a session that is going on by itself ----------------------------------------------------------------------

test("attaching to a session that goes on by itself opens no turn and messages reach the agent", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    const sid = await sessionWithATail(w, script);
    await w.say("/agent attach 1");
    const state = w.test.store.remoteState.attachedRemote(AAD);
    assert.equal(state?.sessionId, sid);
    assert.equal(state.turnOpen, false);
    assert.equal(w.remote.running(AAD), false);
    assert.ok(!w.said().some((t) => t.includes("in the middle of a task")));
    // told, on the status card
    assert.ok(
      w
        .said()
        .slice(-3)
        .some((t) => t.includes("It is working right now") && t.includes("Status: working")),
      w.said().slice(-3).join(" | "),
    );
    script.onPrompt = answer("Yes, I am here.");
    await w.say("are you there?");
    assert.deepEqual(prompts(w), ["are you there?"]);
    assert.equal(w.answer(), "Yes, I am here.", w.said().slice(-3).join(" | "));
    // what the coding agent wrote carries Teams' AI label
    const sent = w.surface.outbox.filter(
      (r) => "message" in r && JSON.stringify(r.message).includes("Yes, I am here."),
    );
    assert.ok(
      sent.length > 0 && sent.every((r) => "message" in r && r.message.aiGenerated === true),
      JSON.stringify(sent),
    );
    assert.ok(!w.said().some((t) => t.includes("lost track") || t.includes("still working")));
    await w.say("and again");
    assert.deepEqual(prompts(w), ["are you there?", "and again"]);
  }));

test("after such an attach the agents own output reaches the chat from the follower", () =>
  remoteWorld(async (w) => {
    const sid = await sessionWithATail(w);
    await w.say("/agent attach 1");
    assert.equal(follower(w)?.alive, true);
    await w.server.say(sid, "The monitor fired: build is green.");
    await settle();
    const told = onItsOwn(w);
    assert.equal(told.length, 1, told.join(" | ")); // (once, and not the output from before the attach)
    assert.ok(told[0]?.includes("The monitor fired: build is green."));
    assert.ok(!w.said().some((t) => t.includes("autonomous output after the turn")));
  }));

test("stop right after such an attach cancels what the agent is doing and clears the turn", () =>
  remoteWorld(
    async (w) => {
      await sessionWithATail(w);
      await w.say("/agent attach 1");
      await w.say("/stop");
      assert.ok(w.last().includes("Stopping the agent."), w.last());
      assert.equal(w.server.commandsOf("cancel").length, 1);
      assert.equal(turnOpen(w), false);
    },
    { timings: { ...TEST_TIMINGS, quietMs: 5000, toolQuietMs: 5000, maxAgeMs: 60_000 } },
  ));

test("an unanswered permission in such a tail still gets its card", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    w.server.onCommand = new Script().hook;
    await w.server.say(sid, "turn text");
    await w.server.end(sid);
    await w.server.ask(sid, "act-9", "Edit README.md", CODEX_OPTIONS, { input: { path: "README.md" } });
    await w.say("/agent sessions");
    await w.say("/agent attach 1");
    assert.equal(w.permissionCards().length, 1);
    assert.equal(turnOpen(w), false);
  }));

test("a prompt this worker sent and has not seen end is still an open turn when the chat attaches again", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    w.remote.shutdown();
    await w.server.say(sid, "working on it");
    w.test.store.remoteState.setRemoteTurn(AAD, sid, true); // (the worker's own prompt: it sent it, and has not seen its end)
    await w.say("/agent sessions");
    await w.send("/agent attach 1");
    await w.until(() => w.remote.running(AAD)); // (shown as it goes on: the status card says it is working)
    assert.ok(w.statusEdits().at(-1)?.[1].includes("Status: working"));
    assert.ok(
      w.said().some((t) => t.startsWith("—— Now: dev-pod · ")),
      w.said().join(" | "),
    ); // (the line that says where the chat is now; the turn's live view under it)
    await w.server.say(sid, " Done.");
    await w.server.end(sid);
    await w.idle();
    assert.ok(w.answer().includes("Done."));
    assert.equal(turnOpen(w), false);
  }));

// --- 1. /stop clears the turn whatever else happens ----------------------------------------------------------------------------

test("a second stop clears the open turn and the next message reaches the agent", () =>
  remoteWorld(async (w) => {
    const script = new Script({ cancelEnds: false });
    script.onPrompt = async (srv, session) => {
      await srv.say(session, "busy");
    };
    await attachedClaude(w, script);
    await w.send("long task");
    await w.until(() => w.progressTexts().some((t) => t.includes("busy")));
    await w.send("/stop"); // (the agent does not end its turn: the turn is still being watched)
    await w.until(() => w.server.commandsOf("cancel").length === 1);
    await w.say("/stop");
    assert.ok(w.last().includes("I stopped watching the agent"), w.last());
    assert.equal(turnOpen(w), false);
    assert.equal(w.remote.running(AAD), false);
    script.onPrompt = answer("Fine now.");
    await w.say("hello");
    assert.equal(prompts(w).at(-1), "hello");
    assert.equal(w.answer(), "Fine now.");
    assert.ok(!w.said().some((t) => t.includes("lost track")));
  }));

test("stop for a turn the worker lost track of clears it", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w, new Script({ cancelEnds: false }));
    w.remote.shutdown();
    w.settings.follow = false;
    w.test.store.remoteState.setRemoteTurn(AAD, sid, true); // the worker restarted: it had a turn open and no reader
    await w.say("/stop");
    assert.equal(w.server.commandsOf("cancel").length, 1);
    assert.equal(turnOpen(w), false);
  }));

test("stop that cannot reach claw still clears the turn", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    w.remote.shutdown();
    w.settings.follow = false;
    w.test.store.remoteState.setRemoteTurn(AAD, sid, true);
    w.server.failOn("POST", "/commands", 500);
    await w.say("/stop");
    assert.ok(w.last().includes("could not take that"), w.last());
    assert.equal(turnOpen(w), false);
  }));

// --- 3. a session that is gone when the user writes ---------------------------------------------------------------------------

for (const status of [404, 403]) {
  for (const following of [true, false]) {
    test(`a session that is gone when the user writes detaches the chat and says so: ${String(status)}, followed ${String(following)}`, () =>
      remoteWorld(async (w) => {
        const { sid } = await attachedClaude(w);
        w.server.failOn("GET", "/events", status);
        if (following) {
          // the session is deleted while the chat is idle: its stream ends, and the reader finds it gone and stops
          w.server.dropStreamAfter = 1;
          await w.server.say(sid, "bye");
          await w.until(() => follower(w)?.alive !== true);
        } else {
          followOff(w);
        }
        await w.say("hello?");
        assert.ok(w.last().includes("no longer available") && w.last().includes("/agent new"), w.last());
        assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
        assert.deepEqual(prompts(w), []);
        assert.notEqual(follower(w)?.alive, true);
        // not the same sentence again: the chat is detached, its messages go to PrimusClaw
        const before = w.said().length;
        await w.say("hello again");
        assert.ok(
          !w
            .said()
            .slice(before)
            .some((t) => t.includes("no longer available") || t.includes("send your message again")),
        );
      }));
  }
}

test("a session that cannot be read for a moment is still asked again", () =>
  remoteWorld(async (w) => {
    await attachedClaude(w);
    followOff(w);
    w.server.failOn("GET", "/events", 500);
    await w.say("hello?");
    assert.ok(w.last().includes("send your message again"), w.last());
    assert.notEqual(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

// --- 6. the reader's own small defects -----------------------------------------------------------------------------------------

/** The identity exchange, down for a moment: unavailable `fails` times, then the key (`bound: false`: no credential at all). */
function exchange(fails: number, bound = true): { calls: number; read: () => Promise<string | null> } {
  const state = {
    calls: 0,
    read: () => {
      state.calls += 1;
      if (!bound) return Promise.resolve(null);
      if (state.calls <= fails) return Promise.reject(new CredentialUnavailable("SaFE is down"));
      return Promise.resolve("ak-alice");
    },
  };
  return state;
}

test("a credential that is unavailable for a moment does not end the reader", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    w.remote.shutdown();
    const down = exchange(3);
    w.credential = down.read;
    follow(w).ensure(AAD);
    await w.server.say(sid, "Said while SaFE was down.");
    await w.until(() => onItsOwn(w).length > 0, 10_000);
    assert.ok(onItsOwn(w)[0]?.includes("Said while SaFE was down."));
    assert.ok(down.calls >= 4, String(down.calls));
  }));

test("a user with no credential at all is not read for", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    w.remote.shutdown();
    const none = exchange(0, false); // not bound either: nobody to read for
    w.credential = none.read;
    follow(w).ensure(AAD);
    await w.server.say(sid, "Nobody may hear this.");
    await settle();
    assert.deepEqual(onItsOwn(w), []);
    assert.equal(none.calls, 1);
    assert.equal(follower(w)?.alive, false);
  }));

test("a stop that timed out does not leave the text it was sending to be merged into the next turn", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    refollow(w, { quietMs: 30_000, toolQuietMs: 30_000, maxAgeMs: 60_000, stopWaitMs: 300 });
    script.onPrompt = answer("NEW answer.");
    await w.server.say(sid, "OLD text that was waiting. ");
    await sleep(300);
    w.hang = (message) => JSON.stringify(message).includes("OLD text that was waiting."); // the send that never comes back
    await w.say("go on");
    assert.equal(w.answer(), "NEW answer.", w.said().join(" | ")); // (not "OLD text that was waiting. NEW answer.")
    assert.deepEqual(prompts(w), ["go on"]);
    // the old text is not lost: it is held for the assistant's release (tested with it)
    assert.ok(
      w.held.some((h) => h.text.includes("OLD text that was waiting.")),
      JSON.stringify(w.held),
    );
  }));

const paragraphs = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `PART${String(i)} ` + "x".repeat(Math.floor((ANSWER_CHARS_MAX * 2) / 3)));
const partCounts = (w: RemoteWorld): number[] =>
  [0, 1, 2].map((i) => w.said().filter((t) => t.includes(`PART${String(i)} `)).length);

test("a message that fails in the middle is resent from the part that was not sent", () =>
  remoteWorld(
    async (w) => {
      const { sid } = await attachedClaude(w);
      let broken = true; // three messages: each of the paragraphs is two thirds of what one message holds
      w.refuse = (message) => {
        if (broken && JSON.stringify(message).includes("PART1")) {
          broken = false;
          return true; // the queue dropped one message
        }
        return false;
      };
      await w.server.say(sid, paragraphs(3).join("\n\n"));
      await w.until(() => w.said().some((t) => t.includes("PART2")), 10_000);
      await settle();
      assert.deepEqual(partCounts(w), [1, 1, 1]); // no part twice
    },
    { timings: { ...TEST_TIMINGS, retryMs: 200 } },
  ));

test("what a failed message leaves unsent is held without the parts that went out", () =>
  remoteWorld(async (w) => {
    const { sid, script } = await attachedClaude(w);
    w.refuse = (message) => JSON.stringify(message).includes("PART1"); // the queue is down
    script.onPrompt = answer("Answer to the prompt.");
    await w.server.say(sid, paragraphs(3).join("\n\n"));
    await w.until(() => w.said().filter((t) => t.includes("PART0 ")).length === 1, 10_000);
    await sleep(300); // (the second part failed; the next try is far away)
    await w.say("go on"); // the user writes: what waits must go out now, cannot, and is held
    assert.equal(w.answer(), "Answer to the prompt.");
    const held = w.held.map((h) => h.text).join("\n");
    assert.ok(!held.includes("PART0 ") && held.includes("PART1 ") && held.includes("PART2 "), held.slice(0, 200));
  }));

// --- 7. /stop reaches a step that was already running when the chat attached --------------------------------------------------

/** A session whose agent has begun a long step and sent nothing since. */
async function sessionInAStep(
  w: RemoteWorld,
  options: { stepEnds?: boolean; turnEnds?: boolean } = {},
): Promise<string> {
  const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
  const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
  w.server.onCommand = new Script().hook;
  await w.server.started(sid, { mode: "plan" });
  await w.server.say(sid, "running the build");
  await w.server.tool(sid, "t1", "Bash: make all", "pending");
  if (options.stepEnds === true) await w.server.tool(sid, "t1", "Bash: make all", "completed");
  if (options.turnEnds === true) await w.server.end(sid);
  await w.say("/agent sessions");
  return sid;
}

const NOTHING = "Nothing is running.";

test("stop after the quiet period still cancels a step that was running when the chat attached", () =>
  remoteWorld(async (w) => {
    await sessionInAStep(w);
    await w.say("/agent attach 1");
    await settle(800); // (longer than `quietMs`; the step sends no event meanwhile)
    await w.say("/stop");
    assert.ok(w.last().includes("Stopping the agent."), w.said().slice(-3).join(" | "));
    assert.equal(w.server.commandsOf("cancel").length, 1);
    assert.equal(turnOpen(w), false);
  }));

test("stop after the quiet period still cancels when a permission request is waiting for an answer", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    w.server.onCommand = new Script().hook;
    await w.server.say(sid, "I need to edit a file");
    await w.server.ask(sid, "act-9", "Edit README.md", CODEX_OPTIONS, { input: { path: "README.md" } });
    await w.say("/agent sessions");
    await w.say("/agent attach 1");
    assert.equal(w.permissionCards().length, 1);
    await settle(800);
    await w.say("/stop");
    assert.ok(w.last().includes("Stopping the agent."), w.said().slice(-3).join(" | "));
    assert.equal(w.server.commandsOf("cancel").length, 1);
  }));

test("a step that ends after the chat attached is no longer running for stop", () =>
  remoteWorld(async (w) => {
    const sid = await sessionInAStep(w);
    await w.say("/agent attach 1");
    await w.server.tool(sid, "t1", "Bash: make all", "completed"); // (the seeded step is ended by its own id, like any other)
    await settle(800);
    await w.say("/stop");
    assert.equal(w.last(), NOTHING);
    assert.deepEqual(w.server.commandsOf("cancel"), []);
  }));

test("a step that had ended before the chat attached is not running", () =>
  remoteWorld(async (w) => {
    await sessionInAStep(w, { stepEnds: true });
    await w.say("/agent attach 1");
    await settle(800);
    await w.say("/stop");
    assert.equal(w.last(), NOTHING);
    assert.deepEqual(w.server.commandsOf("cancel"), []);
  }));

test("a step left open in a turn that has ended is not running", () =>
  remoteWorld(async (w) => {
    await sessionInAStep(w, { turnEnds: true });
    await w.say("/agent attach 1");
    await w.say("/stop");
    assert.equal(w.last(), NOTHING);
    assert.deepEqual(w.server.commandsOf("cancel"), []);
  }));

// --- a session that ended while the user could not be told ---------------------------------------------------------------------

test("a session that ended during a pause is left by the first message that is refused", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedClaude(w);
    w.reachable = false; // (paused: the person may not be told)
    w.server.session(sid).status = "closed";
    await w.server.emit(sid, "session_closed", { reason: "the connector was stopped" });
    await settle();
    assert.notEqual(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.ok(!w.said().some((t) => t.includes("The session ended"))); // (not told: a pause)
    w.reachable = true;
    await w.say("hello?");
    assert.ok(w.last().includes("That session has ended") && w.last().includes("PrimusClaw again"), w.last());
    assert.deepEqual(prompts(w), []);
    // not attached to a session that takes no prompt: the next message is not refused too
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));
