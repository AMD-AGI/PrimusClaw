// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Controlling the chat's agent sessions in plain words while the chat is attached to one (teams/tests/test_remote_nl_control.py).
// The sentences that go to the assistant instead are the router's (its own tests); here the chat has no assistant.
import assert from "node:assert/strict";
import { test } from "node:test";

import { naturalCommand } from "../../../src/capabilities/natural.js";
import { sessionControl } from "../../../src/capabilities/sessions-words.js";
import { ALICE, type RemoteWorld, Script, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD } from "./helpers.js";

const AGENTS = [
  ["claude", "claude-code", "Claude Code"],
  ["codex", "codex", "Codex"],
] as const;
const CAPS = { claude: { roots: ["/home/me/work"] }, codex: { roots: ["/home/me/work"] } };

/** A machine with a claude and a codex session, both started. */
async function machineWithSessions(w: RemoteWorld, script: Script): Promise<{ claude: string; codex: string }> {
  const cid = w.server.addConnector(ALICE, "robin-dev-pod", AGENTS, { caps: CAPS });
  const claude = w.server.addSession(ALICE, cid, "claude", { cwd: "/home/me/work" });
  const codex = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/other" });
  for (const sid of [claude, codex]) await w.server.started(sid);
  w.server.onCommand = script.hook;
  return { claude, codex };
}

/** An agent that answers each prompt "Done." and ends its turn. */
function answering(): Script {
  const script = new Script();
  script.onPrompt = async (srv, sid) => {
    await srv.say(sid, "Done.");
    await srv.end(sid);
  };
  return script;
}

for (const said of [
  "好了，回到助理吧",
  "先回助理",
  "回到助理吧",
  "那就回到助理吧，谢谢",
  "我们回到助理",
  "ok, back to the assistant please",
  "Okay back to the assistant",
  "back to the assistant now",
  "回到助理。",
]) {
  test(`back to the assistant said as people say it detaches: ${said}`, () => {
    assert.equal(naturalCommand(said), "/agent detach");
    assert.equal(naturalCommand(said, false, new Set(["agent detach"])), said); // not attached: the words stay words
  });
}

for (const said of ["回到助理然后跑测试", "回到助理的那个问题上", "back to the assistant tests"]) {
  test(`a detach inside a longer sentence is not one: ${said}`, () => {
    assert.equal(naturalCommand(said), said);
  });
}

for (const said of ["停掉它", "把它停了", "别跑了", "stop it", "Stop the agent."]) {
  test(`stop it stops the attached agent and is the assistants otherwise: ${said}`, () => {
    assert.equal(naturalCommand(said), "/stop");
    assert.equal(naturalCommand(said, false, new Set(["stop it"])), said);
    assert.equal(naturalCommand("停", false, new Set(["stop it"])), "/stop"); // the plain "停" keeps stopping whatever runs
  });
}

for (const [said, control] of [
  ["切到昨天那个会话", true],
  ["切换到 PrimusClaw 那个会话", true],
  ["回到上一个会话", true],
  ["新开一个会话在 ~/repo 里看看", true],
  ["新开一个会话", true],
  ["开个新会话，在 ~/work 下跑 make", true],
  ["switch to yesterday's session", true],
  ["go back to the codex session", true],
  ["open a new session in ~/repo and have a look", true],
  ["Start a fresh session", true],
  ["切到 main 分支", false],
  ["fix the session timeout bug", false],
  ["会话超时的问题你看下", false],
  ["让 robin-dev-pod 上的 codex 跑一下测试", false],
  ["open the session.py file", false],
  ["open a new claude session in ~/repo", true],
  ["Create a new session manager class for token refresh", false],
  ["新建一个会话管理器类", false],
  ["新开一个会话窗口的组件", false],
  ["start a new session token on login", false],
  ["Create a new user session for token refresh", false],
  ["Open a new database session", false],
  ["open a new codex session with the tests", true],
  ["start a fresh claude code session in ~/x", true],
] as const) {
  test(`a sentence about the sessions is told apart from one for the agent: ${said}`, () => {
    assert.equal(sessionControl(said), control);
  });
}

test("attached without the assistant every sentence still goes to the agent", () =>
  remoteWorld(async (w) => {
    await machineWithSessions(w, answering());
    await w.say("切到 robin-dev-pod 的 claude");
    await w.say("切到昨天那个会话");
    assert.deepEqual(
      w.server.commandsOf("prompt").map((c) => c.body["text"]),
      ["切到昨天那个会话"],
    );
  }));

test("attached back to the assistant in other words detaches", () =>
  remoteWorld(async (w) => {
    await machineWithSessions(w, new Script());
    await w.say("切到 robin-dev-pod 的 claude");
    await w.say("好了，回到助理吧");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.deepEqual(w.server.commandsOf("prompt"), []);
  }));

test("attached stop it cancels the agents turn instead of sending it the words", () =>
  remoteWorld(async (w) => {
    const { claude } = await machineWithSessions(w, new Script());
    await w.say("切到 robin-dev-pod 的 claude");
    await w.say("停掉它");
    assert.deepEqual(w.server.commandsOf("prompt"), [], "the words were not sent to the agent");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.sessionId, claude);
  }));

// --- the attach command of a conversation on the machine ----------------------------------------------------------------------

const CONV = "c0ffee12-3456-4789-abcd-ef0123456703";

function conversations(state = "idle"): Record<string, Record<string, unknown>> {
  return {
    claude: {
      roots: ["/home/me/work"],
      resumable: [
        {
          ref: CONV,
          title: "fix the flaky scheduler test",
          cwd: "/home/me/work/hyperloom",
          updated_at: 1_762_442_400,
          state,
        },
        {
          ref: "5eed5eed-1111-4222-8333-944455556605",
          title: "review",
          cwd: "/home/me/work/x",
          updated_at: 1_762_500_000,
          state: "idle",
        },
      ],
    },
    codex: { roots: ["/home/me/work"] },
  };
}

const startsOf = (w: RemoteWorld) =>
  w.server.commandsOf("session.new").map((c) => ({
    agent_id: c.body["agent_id"],
    cwd: c.body["cwd"],
    resume_ref: c.body["resume_ref"],
  }));

test("the attach command of a conversation on the machine takes it over", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(
      ALICE,
      "robin-dev-pod",
      [
        ["claude", "attach", "Claude Code"],
        ["codex", "codex", "Codex"],
      ],
      { caps: conversations() },
    );
    w.server.onCommand = answering().hook;
    await w.say(`/agent attach ${CONV}`);
    assert.deepEqual(startsOf(w), [{ agent_id: "claude", cwd: "/home/me/work/hyperloom", resume_ref: CONV }]);
    assert.notEqual(w.test.store.remoteState.attachedRemote(AAD), null);
    // The first characters of the ref name it too, as they do a session.
    await w.say("/agent detach");
    await w.say("/agent attach 5eed5eed");
    assert.equal(startsOf(w).at(-1)?.resume_ref, "5eed5eed-1111-4222-8333-944455556605");
  }));

for (const [state, online, said] of [
  ["live", true, "still open in a terminal"],
  ["unknown", true, "cannot tell whether that conversation is open in a terminal"],
  ["idle", false, "is offline"],
] as const) {
  test(`a conversation that cannot be taken over now says why and starts nothing: ${state}`, () =>
    remoteWorld(async (w) => {
      w.server.addConnector(ALICE, "robin-dev-pod", [["claude", "attach", "Claude Code"]], {
        online,
        caps: conversations(state),
      });
      await w.say(`/agent attach ${CONV}`);
      assert.deepEqual(w.server.commandsOf("session.new"), []);
      assert.ok(w.last().toLowerCase().includes(said) || w.last().includes(said), w.last());
    }));
}
