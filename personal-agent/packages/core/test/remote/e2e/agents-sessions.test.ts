// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Remote agents from the chat: /stop, the sessions, attach, detach, mode and close, through the real Claw client.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CODEX_OPTIONS, type FakeCommand, type FakeRemote } from "../../../../../test-support/remote-fake.js";
import { ALICE, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, BOB, TWO_AGENTS, attached, oneTurn } from "./helpers.js";

// --- /stop --------------------------------------------------------------------------------------------------------------

test("stop cancels the agents turn and the turn ends as stopped", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.tool(sid, "t1", "Run the whole test suite");
    };
    await attached(w, script);
    await w.send("run everything");
    await w.until(() => w.progressTexts().some((t) => t.includes("⏳ Run the whole test suite")));
    await w.say("/stop");
    assert.equal(w.server.commandsOf("cancel").length, 1);
    assert.ok(w.said().includes("Stopping the agent.") && w.answer() === "Stopped.", w.said().join(" | "));
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false);
  }));

test("stop when nothing runs sends nothing", () =>
  remoteWorld(async (w) => {
    await attached(w);
    await w.say("/stop");
    assert.equal(w.last(), "Nothing is running.");
    assert.equal(w.server.commandsOf("cancel").length, 0);
  }));

test("stop for a machine that went offline queues the cancel and stops watching", () =>
  remoteWorld(async (w) => {
    const script = new Script({ cancelEnds: false });
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "busy");
    };
    const { cid, sid } = await attached(w, script);
    await w.send("long task");
    await w.until(() => w.progressTexts().some((t) => t.includes("busy")));
    w.server.connector(cid).online = false;
    await w.say("/stop");
    assert.equal(w.server.commandsOf("cancel").length, 1);
    assert.ok(w.last().includes("That machine is offline"), w.last());
    assert.equal(w.remote.busyChats().length, 0);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false); // /stop clears it
    w.server.connector(cid).online = true; // the machine is back, and the agent ends what it was doing
    await w.server.say(sid, "and it ended after all.");
    await w.server.end(sid, "cancelled");
    await w.until(() => w.said().some((t) => t.includes("it ended after all.") && t.includes("on its own"))); // the reader says how
  }));

test("a turn this worker lost track of that is still going is shown to its end before a new one starts", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    const { sid } = await attached(w, script);
    await w.server.say(sid, "work from before the restart ");
    w.test.store.remoteState.setRemoteTurn(AAD, sid, true); // the worker restarted: it had a turn open and no reader
    await w.send("anything new?");
    await w.until(() => w.progressTexts().some((t) => t.includes("work from before the restart")));
    assert.ok(w.said().some((t) => t.includes("I lost track of your previous task")));
    assert.equal(w.server.commandsOf("prompt").length, 0);
    await w.server.say(sid, "and its end.");
    await w.server.end(sid);
    await w.idle();
    assert.equal(w.answer(), "work from before the restart and its end.");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false);
    script.onPrompt = oneTurn;
    await w.say("now this");
    assert.deepEqual(
      w.server.commandsOf("prompt").map((c) => c.body["text"]),
      ["now this"],
    );
  }));

test("a turn that ended while nobody watched still delivers its answer", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = oneTurn;
    const { sid } = await attached(w, script);
    w.test.store.remoteState.setRemoteTurn(AAD, sid, true); // the worker lost its reader; the agent finished meanwhile
    await w.server.say(sid, "the answer nobody saw");
    const last = await w.server.end(sid);
    await w.say("what next?");
    assert.equal(w.answer(), "the answer nobody saw"); // delivered, not skipped
    assert.ok(w.said().some((t) => t.includes("I lost track of your previous task")));
    assert.equal(w.server.commandsOf("prompt").length, 0); // the message is asked for again, not run on top of it
    const state = w.test.store.remoteState.attachedRemote(AAD);
    assert.ok(state && !state.turnOpen && Number(state.cursor) === last);
    await w.say("what next?");
    assert.deepEqual(
      w.server.commandsOf("prompt").map((c) => c.body["text"]),
      ["what next?"],
    );
    assert.equal(w.answer(), "Done.");
  }));

test("a turn is closed in the store even when its answer could not be sent", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = oneTurn;
    await attached(w, script);
    w.refuse = (message) => JSON.stringify(message).includes("Done.");
    await w.say("go");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false);
    assert.equal(w.remote.busyChats().length, 0);
    w.refuse = null;
    await w.say("again");
    assert.equal(w.server.commandsOf("prompt").length, 2); // the next message is sent, not mistaken for a lost turn
  }));

test("a second stop stops waiting for an agent that does not end its turn", () =>
  remoteWorld(async (w) => {
    const script = new Script({ cancelEnds: false });
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "stuck");
    };
    await attached(w, script);
    await w.send("go");
    await w.until(() => w.progressTexts().some((t) => t.includes("stuck")));
    await w.send("/stop");
    assert.equal(w.last(), "Stopping the agent.");
    assert.ok(w.remote.busyChats().length > 0);
    await w.send("/stop");
    assert.ok(w.last().startsWith("I stopped watching the agent"), w.last());
    assert.equal(w.server.commandsOf("cancel").length, 1);
    await w.until(() => w.remote.busyChats().length === 0);
    await w.say("/agent detach"); // and the chat can leave it
    assert.equal(w.last(), "—— Back to the assistant ——");
  }));

// --- /agent sessions, attach, detach ------------------------------------------------------------------------------------

test("sessions are listed numbered and only mine", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    const bobs = w.server.addConnector(BOB, "bobs-box", TWO_AGENTS);
    const mine = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    const other = w.server.addSession(ALICE, cid, "claude", { cwd: "/home/me/b" });
    w.server.session(other).updated_at = "2026-10-29T07:00:00.000Z";
    w.server.addSession(BOB, bobs, "codex", { cwd: "/home/bob/secret" });
    await w.say("/agent sessions");
    assert.ok(!w.last().includes("/home/bob/secret"));
    assert.ok(
      w.last().includes("⬛ Codex 1. /home/me/a") && w.last().includes("\u{1f7e0} Claude Code 2. /home/me/b"),
      w.last(),
    );
    assert.deepEqual(w.test.store.remoteState.getRemote(AAD)?.listing, [mine, other]);
  }));

test("attach goes back to a session without replaying it and resumes the agent", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    await w.server.started(sid, { mode: "plan" });
    await w.server.say(sid, "OLD TURN TEXT");
    await w.server.end(sid);
    await w.server.say(sid, "OLD TOO");
    await w.server.end(sid);
    await w.say("/agent sessions");
    await w.say("/agent attach 1");
    const state = w.test.store.remoteState.attachedRemote(AAD);
    assert.ok(state);
    assert.equal(state.sessionId, sid);
    assert.equal(state.cursor, String(w.server.events.get(sid)?.at(-1)?.id));
    assert.deepEqual([state.mode, state.modes], ["plan", ["default", "plan", "acceptEdits"]]);
    assert.equal(w.server.commandsOf("resume")[0]?.session_id, sid);
    assert.equal(w.statusCards().length, 1); // entering from the assistant: one status card, and nothing else
    assert.ok(w.last().startsWith("🔌 Connected to dev-pod · ⬛ Codex /home/me/a · mode plan Status: idle"), w.last());
    assert.ok(!w.said().some((t) => t.includes("OLD")) && w.progressTexts().length === 0);
    const script = new Script();
    script.onPrompt = oneTurn;
    w.server.onCommand = script.hook;
    w.server.streamOpens.length = 0;
    await w.say("continue");
    assert.equal(w.server.streamOpens[0]?.after, Number(state.cursor)); // reading starts after what attach skipped
    assert.equal(w.answer(), "Done.");
  }));

test("attach by id prefix and the refusals", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    const bobs = w.server.addConnector(BOB, "bobs-box", TWO_AGENTS);
    const mine = w.server.addSession(ALICE, cid, "codex", { sid: "abcdef00-0000-4000-8000-000000000001" });
    const done = w.server.addSession(ALICE, cid, "codex", {
      status: "closed",
      sid: "beadee00-0000-4000-8000-000000000002",
    });
    const theirs = w.server.addSession(BOB, bobs, "codex", { sid: "cafe0000-0000-4000-8000-000000000003" });
    for (const [text, expected] of [
      ["/agent attach", "Use `/agent attach N`"],
      ["/agent attach 1", "I could not tell which session you mean"], // no listing yet
      ["/agent attach abcde", "I could not tell which session or agent you mean"], // five characters name no session, nor an agent
      ["/agent attach 99", "I could not tell which session you mean"],
      [`/agent attach ${theirs.slice(0, 12)}`, "I could not tell which session or agent you mean"], // not mine
      [`/agent attach ${done.slice(0, 12)}`, "That session has ended"],
    ] as const) {
      await w.say(text);
      assert.ok(w.last().includes(expected), `${text}: ${w.last()}`);
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    }
    w.server.onCommand = new Script().hook;
    await w.say(`/agent attach ${mine.slice(0, 6)}`); // six characters are enough
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.sessionId, mine);
  }));

test("an id whose first characters are all digits is still an id and a short number is still a number", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    const digits = w.server.addSession(ALICE, cid, "codex", { cwd: "/a", sid: "12345678-0000-4000-8000-000000000001" });
    const other = w.server.addSession(ALICE, cid, "codex", { cwd: "/b", sid: "87654321-0000-4000-8000-000000000002" });
    w.server.session(other).updated_at = "2026-10-29T09:00:00.000Z";
    w.server.onCommand = new Script().hook;
    await w.say("/agent sessions");
    assert.deepEqual(w.test.store.remoteState.getRemote(AAD)?.listing, [other, digits]);
    await w.say("/agent attach 12345678");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.sessionId, digits);
    await w.say("/agent detach");
    await w.say("/agent attach 1");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.sessionId, other);
  }));

test("attach to a session on an offline machine works but sends no resume", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { online: false });
    const sid = w.server.addSession(ALICE, cid, "codex");
    await w.say("/agent sessions");
    await w.say("/agent attach 1");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.sessionId, sid);
    assert.ok(w.last().includes("the machine is offline"), w.last());
    assert.equal(w.server.commandsOf("resume").length, 0);
  }));

test("attach while the agent is at work says so and relights its open permission card", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS);
    const sid = w.server.addSession(ALICE, cid, "codex");
    await w.server.say(sid, "I am editing");
    await w.server.ask(sid, "act-9", "Edit README.md", CODEX_OPTIONS, { input: { path: "README.md" } });
    await w.say("/agent sessions");
    await w.say("/agent attach 1");
    await w.until(() => w.permissionCards().length > 0);
    assert.ok(
      w.said().some((t) => t.includes("It is working right now") && t.includes("Status: working")),
      w.said().join(" | "),
    );
    const cards = w.permissionCards();
    assert.equal(cards.length, 1);
    const actions = (cards[0]?.["actions"] ?? []) as Record<string, Record<string, unknown>>[];
    assert.deepEqual(
      actions.map((b) => b["data"]?.["option_id"]),
      ["allow_once", "accept_execpolicy_amendment", "cancel"],
    );
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.turnOpen, false);
    assert.equal(w.remote.running(AAD), false);
    await w.server.end(sid);
    await w.idle();
  }));

test("detach new and attach wait for a running turn", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "busy");
    };
    const { sid } = await attached(w, script);
    await w.send("long");
    await w.until(() => w.progressTexts().some((t) => t.includes("busy")));
    for (const text of ["/agent new codex /other", "/agent attach 1", "/agent close"]) {
      await w.send(text); // (a turn is running: `say` would wait for it)
      assert.equal(w.last(), "A task is still running. Send /stop first.", text);
    }
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.sessionId, sid);
    const before = w.server.commands.length;
    await w.send("/agent detach");
    await w.idle();
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.deepEqual(w.server.commands.slice(before), []);
    assert.ok(w.last().includes("That turn goes on on the machine, uninterrupted"), w.last());
  }));

// --- /agent mode --------------------------------------------------------------------------------------------------------

test("mode shows what the agent offers and changes it with the agents own ids", () =>
  remoteWorld(async (w) => {
    await attached(w);
    await w.say("/agent mode");
    assert.equal(
      w.last(),
      "Mode: `default`. The agent offers `default`, `plan`, `acceptEdits`. Change it with `/agent mode ID`.",
    );
    await w.say("/agent mode plan");
    assert.deepEqual(w.server.commandsOf("set_mode")[0]?.body, { type: "set_mode", mode_id: "plan" });
    assert.equal(w.last(), "Mode is now `plan`.");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.mode, "plan");
  }));

test("a mode the agent does not offer is refused before anything is sent", async () => {
  for (const [text, expected] of [
    [
      "/agent mode bypassPermissions",
      "The agent does not offer `bypassPermissions`. It offers: `default`, `plan`, `acceptEdits`.",
    ],
    ["/agent mode bad/id", "That is not a mode id. Send `/agent mode`"],
    ["/agent mode " + "x".repeat(80), "That is not a mode id. Send `/agent mode`"],
  ] as const) {
    await remoteWorld(async (w) => {
      await attached(w);
      await w.say(text);
      assert.ok(w.last().startsWith(expected), w.last());
      assert.equal(w.server.commandsOf("set_mode").length, 0);
    });
  }
});

test("mode needs an attached session and an agent that has not confirmed is said so", async () => {
  await remoteWorld(async (w) => {
    await w.say("/agent mode plan");
    assert.ok(w.last().includes("not attached"), w.last());
  });
  await remoteWorld(
    async (w) => {
      class Silent extends Script {
        protected override async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
          if (cmd.type !== "set_mode") await super.handle(srv, cmd);
        }
      }
      await attached(w, new Silent());
      await w.say("/agent mode plan");
      assert.ok(w.last().includes("it has not confirmed yet"), w.last());
    },
    { watchSeconds: { start: 30, mode: 0.3 } },
  );
});

// --- /agent close and /agent off ----------------------------------------------------------------------------------------

test("close ends the attached session and the chat goes back to claw", () =>
  remoteWorld(async (w) => {
    const { sid } = await attached(w);
    await w.say("/agent close");
    assert.equal(w.server.commandsOf("close")[0]?.session_id, sid);
    assert.equal(w.server.session(sid).status, "closed");
    assert.equal(w.last(), "Closed the session. Your messages go to PrimusClaw again.");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

test("close by number closes that one and keeps the attachment", () =>
  remoteWorld(async (w) => {
    const { cid, sid } = await attached(w);
    const other = w.server.addSession(ALICE, cid, "claude", { cwd: "/elsewhere" });
    w.server.session(other).updated_at = "2026-10-29T01:00:00.000Z";
    w.server.session(sid).updated_at = "2026-10-29T09:00:00.000Z";
    await w.say("/agent sessions");
    await w.say("/agent close 2");
    assert.equal(w.server.session(other).status, "closed");
    assert.equal(w.server.session(sid).status, "active");
    assert.equal(w.last(), "Closed the session.");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.sessionId, sid);
  }));
