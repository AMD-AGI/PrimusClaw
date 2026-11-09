// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The status card as the action row, Mode, and a machine's name where an agent's is wanted (teams/tests/test_remote_menu.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import { TYPED_PATHS_KEPT } from "../../../src/remote/chats.js";
import { remoteAgentText } from "../../../src/locales/remote-agents.js";
import { remoteText } from "../../../src/locales/remote.js";
import { OPTION_BUTTONS_MAX } from "../../../src/remote-view/limits.js";
import { assertValidCard } from "../../../../../test-support/adaptive-card.js";
import { ALICE, Script, USER_B, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, BOB, TWO_AGENTS, promptScript } from "./helpers.js";
import {
  ASKING_BY_DEFAULT,
  CAPS,
  FLAGS,
  type Json,
  MODES,
  STATUS_TITLES,
  UNATTENDED_BY_DEFAULT,
  agentsCard,
  attachedWith,
  buttonsIn,
  dataOf,
  inputsIn,
  press,
  pressData,
  shown,
  starts,
  textsIn,
  titles,
} from "./menu.js";

const UNATTENDED_NOTE = remoteText.in("en").unattendedNote;
const cardsSentSince = (w: Parameters<typeof shown>[0], before: number) =>
  w
    .operations()
    .slice(before)
    .filter((o) => (o.op === "send" || o.op === "post") && o.card);

/** An agent that answers "Done." to every prompt. */
function answering(script: Script): Script {
  script.onPrompt = async (srv, sid) => {
    await srv.say(sid, "Done.");
    await srv.end(sid);
  };
  return script;
}

test("every turn ends with the answer and nothing under it and the status card is only edited", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedWith(w, { script: promptScript(40), caps: CAPS });
    const before = w.operations().length;
    await w.say("first");
    await w.say("second");
    const rows = w.statusCards(); // the one sent when the chat attached
    assert.equal(rows.length, 1);
    const row = rows[0] ?? {};
    assertValidCard(row);
    assert.ok(buttonsIn(row).every((b) => dataOf(b)["primusclaw"] === "remote" && dataOf(b)["session_id"] === sid));
    assert.deepEqual(cardsSentSince(w, before), []); // 80 chunks, two answers, and not one card
    const statusCard = w.test.store.remoteState.getRemote(AAD)?.statusCard;
    const status = w
      .operations()
      .slice(before)
      .filter((o) => o.op === "update" && o.id === statusCard && o.card);
    const words = status.map((o) => textsIn(o.card ?? {}).join(" "));
    assert.deepEqual(
      words.map((t) => [t.includes("Status: working"), t.includes("Status: idle")]),
      [
        [true, false],
        [false, true],
        [true, false],
        [false, true],
      ],
      words.join("\n"),
    );
    assert.ok(words.every((t) => t.includes("⬛ Codex") && t.includes("/home/me/repo") && t.includes("mode default")));
    assert.deepEqual(titles(status.at(-1)?.card ?? {}), STATUS_TITLES);
  }));

test("no row after a session that closed and none for a chat that left it", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "bye");
      await srv.emit(sid, "session_closed", { reason: "the agent exited" });
    };
    await attachedWith(w, { script });
    const before = w.operations().length;
    await w.say("go");
    assert.deepEqual(cardsSentSince(w, before), []);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.ok(w.statusEdits().at(-1)?.[1].includes("The session has ended"));
  }));

const BADGES: readonly (readonly [
  string,
  Record<string, Json>,
  { unattended?: boolean; mode: string } | null,
  boolean,
])[] = [
  ["the connector says nothing at all", CAPS, null, false],
  ["the session says it asks", ASKING_BY_DEFAULT, { unattended: false, mode: "default" }, false],
  [
    "the session says it asks, though its agent starts unattended",
    UNATTENDED_BY_DEFAULT,
    { unattended: false, mode: "default" },
    false,
  ],
  ["the session says it does not", ASKING_BY_DEFAULT, { unattended: true, mode: "bypassPermissions" }, true],
  ["the session does not say, its agent starts unattended", UNATTENDED_BY_DEFAULT, { mode: "bypassPermissions" }, true],
  ["the session does not say, its agent starts asking", ASKING_BY_DEFAULT, { mode: "default" }, false],
];

for (const [label, caps, says, badge] of BADGES) {
  test(`the row says when the session runs without asking for approval: ${label}`, () =>
    remoteWorld(async (w) => {
      w.server.addConnector(ALICE, "dev-pod", [["claude", "claude", "Claude Code"]], { caps });
      w.server.onCommand = answering(new Script({ modes: MODES, flags: FLAGS, ...(says ?? {}) })).hook;
      await w.say("/agent new claude /home/me/work");
      await w.say("go");
      assert.equal(w.statusCards().length, 1, label); // sent once when the chat attached; the turn edited it in place
      assert.equal(w.statusEdits().at(-1)?.[1].includes(UNATTENDED_NOTE), badge, label);
    }));
}

test("the latest event decides and attach and resume read the same keys", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const sid = w.server.addSession(ALICE, cid, "codex", { cwd: "/home/me/a" });
    w.server.onCommand = new Script().hook;
    await w.server.started(sid, { mode: "bypassPermissions", modes: MODES, unattended: true, flags: FLAGS });
    let row = await press(w, await agentsCard(w), "Attach"); // (the tapped card is the status card now)
    let state = w.test.store.remoteState.attachedRemote(AAD);
    assert.equal(state?.unattended, true);
    assert.deepEqual(state.modeFlags, FLAGS);
    assert.ok(textsIn(row).join(" ").includes(UNATTENDED_NOTE));
    await w.say("/agent detach");
    // the agent was resumed from the terminal's side later and says it asks again: `session_resumed` carries the same keys
    await w.server.emit(sid, "session_resumed", {
      acp_session_id: "acp-1",
      currentMode: "default",
      unattended: false,
      modes: MODES.map((m) => ({ id: m, name: m, unattended: FLAGS[m] })),
    });
    await w.server.emit(sid, "mode_update", { currentMode: "bypassPermissions", unattended: true });
    await w.server.emit(sid, "mode_update", { currentMode: "plan", unattended: false });
    row = await press(w, await agentsCard(w), "Attach");
    state = w.test.store.remoteState.attachedRemote(AAD);
    assert.deepEqual([state?.mode, state?.unattended], ["plan", false]);
    assert.ok(!textsIn(row).join(" ").includes(UNATTENDED_NOTE));
  }));

test("the action row has no mode button until the agent has said its modes", () =>
  remoteWorld(
    async (w) => {
      const { sid } = await attachedWith(w, { script: new Script({ started: false }), caps: CAPS });
      assert.deepEqual(w.test.store.remoteState.attachedRemote(AAD)?.modes, []);
      let done = await pressData(w, { op: "row", session_id: sid });
      assert.deepEqual(titles(done), STATUS_TITLES.slice(0, 3));
      done = await pressData(w, { op: "mode", session_id: sid }); // a Mode button that is not there, pressed anyway
      assert.ok(textsIn(done).join(" ").includes("I do not know the agent's modes yet"), textsIn(done).join(" | "));
      assert.deepEqual(titles(done), STATUS_TITLES.slice(0, 3));
    },
    { watchSeconds: { start: 0.3, mode: 0.3 } }, // (the agent never reports in: the watch for it is short)
  ));

test("mode lists only the modes the connector reports as allowed and set mode asks the agent", () =>
  remoteWorld(async (w) => {
    const { sid } = await attachedWith(w, { caps: CAPS }); // the agent's session offers default, plan and acceptEdits
    // ... but the connector reports these two as allowed
    w.test.store.remoteState.setRemoteModes(AAD, sid, { mode: "default", modes: ["default", "plan"] });
    const row = await pressData(w, { op: "row", session_id: sid });
    const picker = await press(w, row, "Mode");
    const mode = inputsIn(picker)["mode"] ?? {};
    assert.deepEqual(
      ((mode["choices"] ?? []) as Json[]).map((c) => c["value"]),
      ["default", "plan"],
    );
    assert.ok(!JSON.stringify(picker).includes("bypassPermissions"));
    assert.deepEqual(titles(picker), ["Set mode", "Back"]);
    assert.equal(mode["value"], "default");
    const done = await press(w, picker, "Set mode", { typed: { mode: "plan" } });
    assert.deepEqual(
      w.server.commandsOf("set_mode").map((c) => c.body["mode_id"]),
      ["plan"],
    );
    assert.ok(textsIn(done)[0]?.includes("Asking the agent to switch to plan."), textsIn(done).join(" | "));
    assert.deepEqual(titles(done), STATUS_TITLES);
    await w.idle();
    // the watch said when the agent had (the click's own line and the watch's race each other to the chat)
    const messages = w
      .operations()
      .filter((o) => o.op === "send" && !o.card)
      .map((o) => o.text);
    assert.deepEqual(
      messages.slice(-2).sort(),
      ["Asking the agent to switch to plan. I will say when it has.", "Mode is now `plan`."],
      w.said().join(" | "),
    );
  }));

test("the mode picker marks the modes the session says do not ask and the badge follows the switch", () =>
  remoteWorld(async (w) => {
    const flags = { default: false, plan: false, acceptEdits: true };
    const { sid } = await attachedWith(w, { script: answering(new Script({ flags, unattended: false })), caps: CAPS });
    assert.deepEqual(w.test.store.remoteState.attachedRemote(AAD)?.modeFlags, flags);
    const row = await pressData(w, { op: "row", session_id: sid });
    let picker = await press(w, row, "Mode");
    assert.deepEqual(
      ((inputsIn(picker)["mode"]?.["choices"] ?? []) as Json[]).map((c) => c["title"]),
      ["default", "plan", "acceptEdits (unattended)"],
    );
    const back = await press(w, picker, "Back");
    assert.deepEqual(titles(back), STATUS_TITLES);
    assert.deepEqual(w.server.commandsOf("set_mode"), []);
    assert.ok(!textsIn(back).join(" ").includes(UNATTENDED_NOTE));
    picker = await press(w, back, "Mode");
    await press(w, picker, "Set mode", { typed: { mode: "acceptEdits" } });
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.unattended, true); // the agent's `mode_update` said so
    await w.say("go");
    // and the status card, edited when the next turn ended, says it too
    assert.ok(w.statusEdits().at(-1)?.[1].includes(UNATTENDED_NOTE));
  }));

for (const [label, mode] of [
  ["a mode the agent never offered", "bypassPermissions"],
  ["not a mode id at all", "plan; rm -rf /"],
  ["nothing", ""],
] as const) {
  test(`set mode refuses what the agent does not offer and sends nothing: ${label}`, () =>
    remoteWorld(async (w) => {
      const { sid } = await attachedWith(w);
      const done = await pressData(w, { op: "set_mode", session_id: sid, mode });
      assert.deepEqual(w.server.commandsOf("set_mode"), [], label);
      assert.deepEqual(titles(done), STATUS_TITLES, label);
      const text = textsIn(done).join(" ");
      assert.ok(text.includes("does not offer") || text.includes("not a mode id"), `${label}: ${text}`);
    }));
}

// --- /agents new, and a machine's name where an agent's is wanted ------------------------------------------------------------

for (const command of [
  "/agent new codex /home/me/repo",
  "/agents new codex /home/me/repo",
  "/AGENTS NEW codex /home/me/repo",
]) {
  test(`agents new is agent new: ${command}`, () =>
    remoteWorld(async (w) => {
      const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
      w.server.onCommand = new Script().hook;
      await w.say(command);
      assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "codex", cwd: "/home/me/repo" }]);
      assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.cwd, "/home/me/repo");
      const cards = w.statusCards();
      assert.equal(cards.length, 1);
      assert.ok(textsIn(cards[0] ?? {}).includes("🔌 Connected to dev-pod · ⬛ Codex"));
    }));
}

for (const command of [
  "/agent new robin-dev-pod /home/robin",
  "/agents new robin-dev-pod /home/robin",
  "/agents new Robin-Dev-Pod /home/robin",
  "/agent new robin-dev-pod/claude-devpod /home/robin",
]) {
  test(`the name of a machine with one online agent starts that agent at once: ${command}`, () =>
    remoteWorld(async (w) => {
      const cid = w.server.addConnector(ALICE, "robin-dev-pod", [["claude-devpod", "claude", "Claude Code"]], {
        caps: { "claude-devpod": { roots: ["/home/robin"] } },
      });
      w.server.onCommand = new Script().hook;
      await w.say(command);
      assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "claude-devpod", cwd: "/home/robin" }]);
      const cards = w.statusCards();
      assert.equal(cards.length, 1);
      assert.equal(textsIn(cards[0] ?? {})[0], "🔌 Connected to robin-dev-pod · 🟠 Claude Code");
    }));
}

for (const command of ["/agent new robin-dev-pod /home/robin", "/agents new robin-dev-pod /home/robin"]) {
  test(`the name of a machine with several agents offers them as buttons with the folder already typed: ${command}`, () =>
    remoteWorld(async (w) => {
      const cid = w.server.addConnector(ALICE, "robin-dev-pod", TWO_AGENTS, { caps: CAPS });
      w.server.onCommand = new Script().hook;
      await w.say(command);
      assert.deepEqual(starts(w), []); // nothing yet: which agent is a tap
      const card = w.cards().at(-1) ?? {};
      assertValidCard(card);
      assert.equal(textsIn(card)[0], "🖥️ Which agent on robin-dev-pod?");
      assert.ok(textsIn(card)[1]?.includes("/home/robin"));
      assert.deepEqual(titles(card), ["⬛ Codex", "🟠 Claude Code"]);
      // the buttons name a token, not the folder
      assert.ok(!JSON.stringify(buttonsIn(card).map((b) => b["data"])).includes("/home/robin"));
      await press(w, card, "🟠 Claude Code");
      assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "claude", cwd: "/home/robin" }]); // the folder as typed
      assert.deepEqual(titles(shown(w)), STATUS_TITLES);
      assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.agentId, "claude");
    }));
}

for (const [label, online, agents, expected] of [
  ["the machine is offline", false, TWO_AGENTS, "robin-dev-pod is offline"],
  ["the machine has no agent yet", true, [], "robin-dev-pod has not reported an agent yet"],
] as const) {
  test(`a machine that cannot take work says why: ${label}`, () =>
    remoteWorld(async (w) => {
      w.server.addConnector(ALICE, "robin-dev-pod", agents, { online });
      await w.say("/agents new robin-dev-pod /home/robin");
      assert.ok(w.last().includes(expected), `${label}: ${w.last()}`);
      assert.deepEqual(starts(w), [], label);
    }));
}

test("a name that is neither an agent nor a machine is still not found and an agent id beats a machine name", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "codex", [
      ["codex", "codex", "Codex"],
      ["claude", "claude", "Claude Code"],
    ]);
    w.server.onCommand = new Script().hook;
    await w.say("/agent new gemini /repo");
    assert.ok(w.last().includes("I could not find an agent called `gemini`"), w.last());
    assert.deepEqual(starts(w), []);
    await w.say("/agent new codex /repo"); // a machine called codex that has an agent called codex: the agent
    assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "codex", cwd: "/repo" }]);
  }));

test("the machine choice card names four agents and counts the rest", () =>
  remoteWorld(async (w) => {
    const many = Array.from({ length: 6 }, (_, n) => [`a${String(n)}`, "codex", `Agent ${String(n)}`] as const);
    w.server.addConnector(ALICE, "dev-pod", many);
    await w.say("/agent new dev-pod /repo");
    const card = w.cards().at(-1) ?? {};
    assertValidCard(card);
    assert.equal(titles(card).length, OPTION_BUTTONS_MAX);
    assert.ok(textsIn(card).join(" ").includes("2 more not shown"));
  }));

test("a machine choice button cannot choose the folder and one for a machine that is not yours starts nothing", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const bobs = w.server.addConnector(BOB, "bobs-box", TWO_AGENTS);
    w.server.onCommand = new Script().hook;
    await w.say("/agent new dev-pod /home/me/work");
    const tokens = [...new Set(buttonsIn(w.cards().at(-1) ?? {}).map((b) => dataOf(b)["typed"]))];
    assert.equal(tokens.length, 1);
    const token = tokens[0];
    const base = { op: "new", connector_id: cid, agent_id: "codex", slot: 0 };
    for (const [label, data, expected] of [
      ["a path of its own, no token", { path: "/etc" }, "not one of the agent's folders"],
      ["a token nobody stored", { typed: "forged" }, "That card has expired"],
      ["no token and no slot", { slot: null }, "That button is no longer valid"],
    ] as const) {
      const done = await pressData(w, { ...base, ...data });
      assert.deepEqual(starts(w), [], label);
      assert.ok(textsIn(done).join(" ").includes(expected), `${label}: ${textsIn(done).join(" | ")}`);
    }
    await pressData(w, { ...base, path: "/etc", typed: token });
    // the folder that was typed, not the one forged
    assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "codex", cwd: "/home/me/work" }]);
    w.server.sessions.clear();
    w.server.commands.length = 0;
    w.test.store.remoteState.detachRemote(AAD);
    const done = await pressData(w, { op: "new", connector_id: bobs, agent_id: "codex", slot: 0, typed: token });
    assert.deepEqual(starts(w), []);
    assert.ok(textsIn(done)[1]?.includes("not available any more"));
  }));

test("a token is one users and runs out and only the last few are kept", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    w.server.addConnector(BOB, "bobs-box", TWO_AGENTS, { caps: CAPS });
    w.server.onCommand = new Script().hook;
    await w.say("/agent new dev-pod /home/me/work");
    const token = dataOf(buttonsIn(w.cards().at(-1) ?? {})[0])["typed"];
    const data = { op: "new", connector_id: cid, agent_id: "codex", slot: 0, typed: token };
    await pressData(w, data, { user: USER_B });
    assert.deepEqual(starts(w), []); // Bob holds the token and not Alice's machine: nothing starts
    await w.test.clock.advance(3601 * 1000);
    const done = await pressData(w, data);
    assert.deepEqual(starts(w), []);
    assert.ok(textsIn(done).join(" ").includes("That card has expired"));
    for (let n = 0; n < TYPED_PATHS_KEPT + 5; n += 1) await w.say(`/agent new dev-pod /home/me/work${String(n)}`);
    const typed = (w.remote as unknown as { chats: { typed: Map<string, Map<string, unknown>> } }).chats.typed;
    assert.equal(typed.get(AAD)?.size, TYPED_PATHS_KEPT);
  }));

test("the machine choice offers the approval choice and the badge of each agent", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(
      ALICE,
      "dev-pod",
      [
        ["claude", "claude", "Claude Code"],
        ["codex", "codex", "Codex"],
      ],
      { caps: { ...ASKING_BY_DEFAULT, codex: UNATTENDED_BY_DEFAULT["claude"] ?? {} } },
    );
    // (the one that is chosen starts so)
    w.server.onCommand = new Script({ mode: "bypassPermissions", modes: MODES, unattended: true, flags: FLAGS }).hook;
    await w.say("/agent new dev-pod /home/me/work");
    const card = w.cards().at(-1) ?? {};
    assertValidCard(card);
    const inputs = inputsIn(card);
    assert.deepEqual(Object.keys(inputs), ["appr0", "appr1"]);
    assert.deepEqual(
      Object.values(inputs).map((i) => i["value"]),
      ["ask", "unattended"],
    );
    assert.equal(textsIn(card).join(" ").split(UNATTENDED_NOTE).length - 1, 1);
    // the second agent starts unattended: asking is the other kind
    await press(w, card, "⬛ Codex", { typed: { appr1: "ask" } });
    assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "codex", cwd: "/home/me/work" }]);
    assert.deepEqual(
      w.server.commandsOf("set_mode").map((c) => c.body["mode_id"]),
      ["default"],
    );
  }));

// --- the flag ---------------------------------------------------------------------------------------------------------------------

test("with remote agents off the new ways in say so and call nothing", () =>
  remoteWorld(
    async (w) => {
      for (const text of [
        "/agents new codex /repo",
        "/agents frobnicate",
        "/agent",
        "/agent new robin-dev-pod /repo",
      ]) {
        await w.say(text);
        assert.equal(w.last(), remoteAgentText.in("en").notEnabled, text);
      }
      assert.deepEqual(w.server.calls, []);
    },
    { enabled: false },
  ));
