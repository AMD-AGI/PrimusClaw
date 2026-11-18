// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Taking over and joining conversations, the confirmation of a takeover, and the row's refusals in Chinese
// (teams/tests/test_remote_menu.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import { IDLE_SHOWN } from "../../../src/remote/limits.js";
import type { FakeCommand, FakeRemote } from "../../../../../test-support/remote-fake.js";
import { ALICE, type RemoteWorld, Script, USER_A, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, BOB, TWO_AGENTS, attached, idleTurn, turnsOf } from "./helpers.js";
import {
  ATTACH_AGENT,
  CAPS,
  type Json,
  Refusing,
  agentsCard,
  attachCaps,
  buttonsIn,
  dataOf,
  openTakeover,
  press,
  pressData,
  starts,
  tap,
  textsIn,
  titles,
} from "./menu.js";

const WATCH_ONLY = "Watch only (the terminal keeps working)";
const CONNECT = "Connect (the terminal keeps working)";
const DISCONNECT = "Disconnect (the terminal keeps it)";
const nowOf = (w: RemoteWorld): number => w.test.clock.epochMs() / 1000;
const resumable = (caps: Record<string, Json>): Json[] => (caps["claude-attach"]?.["resumable"] ?? []) as Json[];

function typingCaps(w: RemoteWorld, change: Json = {}): Record<string, Json> {
  const caps = attachCaps(nowOf(w), { change: { terminal_input: true, ...change } });
  const live = resumable(caps)[1];
  if (live) live["input"] = "terminal";
  return caps;
}

/** A connector whose new session runs under the conversation id `r-live`, saying `started` as it starts. */
class StartsAs extends Script {
  constructor(private readonly started: Json) {
    super();
  }

  protected override async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
    if (cmd.type === "session.new") await srv.emit(cmd.session_id, "session_started", this.started);
    else await super.handle(srv, cmd);
  }
}

/** It types into the terminal holding the conversation `r-live` and says so: its session runs that conversation. */
const joinedTerminal = () =>
  new StartsAs({
    acp_session_id: "r-live",
    attached: true,
    live_terminal: true,
    input: "terminal",
    modes: [],
    currentMode: null,
  });
/** Its new session runs its agent under the conversation id its attach agent also reports as open (`r-live`). */
const ownConversation = () =>
  new StartsAs({ acp_session_id: "r-live", modes: [{ id: "default" }], currentMode: "default" });

test("a take over of someone elses machine or an offline one starts nothing", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: attachCaps(nowOf(w)) });
    const bobs = w.server.addConnector(BOB, "bobs-box", ATTACH_AGENT, { caps: attachCaps(nowOf(w)) });
    const card = await agentsCard(w);
    let done = await pressData(w, { op: "new", connector_id: bobs, agent_id: "claude-attach", resume: "r-idle" });
    assert.deepEqual(starts(w), []);
    assert.ok(textsIn(done)[1]?.includes("not available any more"));
    w.server.connector(cid).online = false;
    done = await press(w, card, "Take over");
    assert.deepEqual(starts(w), []);
    assert.ok(textsIn(done).join(" ").includes("dev-pod is offline"));
  }));

test("a connector that refuses the takeover says why and the chat stays with claw", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: attachCaps(nowOf(w)) });
    w.server.onCommand = new Refusing("session_live").hook;
    await press(w, await agentsCard(w), "Take over");
    assert.equal(
      w.last(),
      "The session could not start: That conversation is still open in a terminal on that machine. Quit it " +
        "there first, then take it over. Your messages go to PrimusClaw again.",
    );
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

test("an agent with nothing to take over and one that reports junk show nothing to tap", () =>
  remoteWorld(async (w) => {
    const junk = {
      "claude-attach": {
        resumable: [3, null, { ref: 7 }, { ref: "", cwd: "/a" }, { ref: "r", cwd: "" }, { ref: "ok\n", cwd: "/a" }],
      },
    };
    w.server.addConnector(ALICE, "empty", ATTACH_AGENT, { caps: { "claude-attach": { resumable: [] } } });
    w.server.addConnector(ALICE, "junky", ATTACH_AGENT, { caps: junk });
    w.server.addConnector(ALICE, "plain", TWO_AGENTS.slice(0, 1), { caps: CAPS });
    const card = await agentsCard(w);
    assert.ok(!titles(card).includes("Take over"));
    assert.equal(textsIn(card).join(" ").split("No conversation to take over yet.").length - 1, 2);
  }));

test("a terminal conversation this chat is connected to says so and offers disconnect which leaves the terminal alone", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: typingCaps(w) });
    w.server.onCommand = joinedTerminal().hook;
    await press(w, await agentsCard(w), CONNECT);
    await w.idle();
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    const card = await agentsCard(w);
    const text = textsIn(card).join(" | ");
    // under the machine: the conversation says this chat is on it, with Disconnect instead of Connect
    assert.ok(text.includes("📱 Connected from this chat (your session 1)"), text);
    assert.ok(!titles(card).includes(CONNECT));
    // (the session said it runs the terminal's conversation itself: joined, so listed there as connected)
    assert.deepEqual([...w.test.store.remoteSessionNames.remoteSessionAcps(AAD)], [[sid, "r-live"]]);
    const disconnect = buttonsIn(card).filter((b) => b["title"] === DISCONNECT);
    assert.deepEqual(
      disconnect.map((b) => [dataOf(b)["op"], dataOf(b)["session_id"]]),
      [
        ["close", sid],
        ["close", sid],
      ],
    ); // (above, and below)
    // below, the session is named after the conversation it joined
    assert.ok(
      textsIn(card).some((t) =>
        t.startsWith("1. 🤖 Claude Code (existing sessions) · **Open in a terminal** · term · dev-pod"),
      ),
      text,
    );
    await press(w, card, DISCONNECT);
    await w.idle();
    assert.ok(w.server.commandsOf("close").length > 0);
    assert.equal(w.server.session(sid).status, "closed");
    assert.deepEqual(w.server.commandsOf("cancel"), []); // (nothing stopped in the terminal: the session is only left)
  }));

test("a new session is named on the card by the first thing sent to it", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", TWO_AGENTS, { caps: CAPS });
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.end(sid, "end_turn");
    };
    w.server.onCommand = script.hook;
    await w.say("/agent new claude /home/me/work/repo");
    await w.idle();
    await w.say("please make the flaky parser test deterministic and tell me what was wrong");
    await w.idle();
    const card = await agentsCard(w);
    const line = textsIn(card).find((t) => t.startsWith("1. ")) ?? "";
    assert.ok(line.startsWith("1. 🟠 Claude Code · **please make the flaky parser…** · repo · dev-pod ("), line);
    // (a session this chat made is closed; only a joined terminal's is a Disconnect)
    assert.deepEqual(
      buttonsIn(card)
        .filter((b) => dataOf(b)["op"] === "close")
        .map((b) => b["title"]),
      ["Close"],
    );
  }));

test("the conversation of a session this chat started is not offered again as one to join", () =>
  remoteWorld(async (w) => {
    const caps = { ...typingCaps(w), claude: CAPS["claude"] ?? {} };
    w.server.addConnector(ALICE, "dev-pod", [...ATTACH_AGENT, ...TWO_AGENTS.slice(1)], { caps });
    const before = await agentsCard(w);
    assert.deepEqual(
      buttonsIn(before)
        .filter((b) => b["title"] === CONNECT)
        .map((b) => dataOf(b)["resume"]),
      ["r-live"],
    );
    w.server.onCommand = ownConversation().hook;
    await w.say("/agent new claude /home/me/work/repo");
    await w.idle();
    const card = await agentsCard(w);
    // it is this chat's own session ("Your sessions"), not a terminal's conversation to connect to
    assert.ok(!titles(card).includes(CONNECT));
    assert.ok(!textsIn(card).join(" | ").includes("Open in a terminal"));
    assert.ok(
      textsIn(card)
        .find((t) => t.startsWith("1. "))
        ?.startsWith("1. 🟠 Claude Code · **New session**"),
    );
  }));

test("older conversations than the card lists are counted", () =>
  remoteWorld(async (w) => {
    const many = Array.from({ length: 9 }, (_, n) => ({
      ref: `r${String(n)}`,
      title: `Conversation ${String(n)}`,
      cwd: "/home/me/work",
      updated_at: 1_761_000_000 - n,
      state: "idle",
    }));
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: { "claude-attach": { resumable: many } } });
    const card = await agentsCard(w);
    // with no terminal's conversation among them, the earlier ones are a short labelled group and the rest is counted
    assert.equal(titles(card).filter((t) => t === "Take over").length, IDLE_SHOWN);
    assert.ok(textsIn(card).join(" ").includes("7 older conversations not shown."));
  }));

// --- taking over a conversation a terminal has open (the person confirms; the connector ends the terminal first) ------------------

test("a conversation open in a terminal is taken over only after the person confirms what that does", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, {
      caps: attachCaps(nowOf(w), { change: { takeover: true } }),
    });
    w.server.onCommand = new Script().hook;
    const card = await agentsCard(w);
    assert.ok(
      !titles(card).includes("Take over…"),
      "a conversation open in a terminal is shared from the list, never taken",
    );
    assert.deepEqual(
      buttonsIn(card)
        .filter((b) => b["title"] === WATCH_ONLY)
        .map((b) => dataOf(b)["resume"]),
      ["r-live"],
    );
    assert.ok(!textsIn(card).join(" | ").includes("Still open in a terminal - exit it first."));
    const confirm = await openTakeover(w, cid);
    assert.deepEqual(starts(w), [], "nothing starts on the first tap: it only says what taking it over does");
    const words = textsIn(confirm).join(" ");
    assert.ok(words.includes("Open in a terminal") && words.includes("ends that terminal's process"), words);
    assert.ok(words.includes("claude --resume r-live"), words);
    assert.deepEqual(titles(confirm), ["Take over", "Cancel"]);
    const done = await press(w, confirm, "Take over");
    assert.deepEqual(starts(w), [
      { connector_id: cid, agent_id: "claude-attach", cwd: "/home/me/work/term", resume_ref: "r-live", takeover: true },
    ]);
    assert.equal(textsIn(done)[0], "🔌 In your existing conversation “Open in a terminal”");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.conversation, "Open in a terminal");
  }));

test("cancel on the confirmation starts nothing and shows the list again", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, {
      caps: attachCaps(nowOf(w), { change: { takeover: true } }),
    });
    const confirm = await openTakeover(w, cid);
    const back = await press(w, confirm, "Cancel");
    assert.deepEqual(starts(w), []);
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.ok(!titles(back).includes("Take over…") && titles(back).includes(WATCH_ONLY));
  }));

const TAPS: readonly (readonly [string, boolean, Json, string])[] = [
  [
    "a connector that cannot end a terminal, with the confirmation forged",
    false,
    { op: "new", resume: "r-live", takeover: "1" },
    "confirmation has expired",
  ],
  [
    "a connector that can, with a confirmation this worker never showed",
    true,
    { op: "new", resume: "r-live", takeover: "1" },
    "confirmation has expired",
  ],
  [
    "a connector that cannot end a terminal, asked for the confirmation",
    false,
    { op: "takeover", resume: "r-live" },
    "cannot take over a conversation that is open in a terminal",
  ],
  [
    "a conversation that is idle by now needs no confirmation",
    true,
    { op: "takeover", resume: "r-idle" },
    "no longer open in a terminal",
  ],
  [
    "a conversation that is not on the list",
    true,
    { op: "takeover", resume: "forged" },
    "not on the agent's list any more",
  ],
];

for (const [label, takeover, data, expected] of TAPS) {
  test(`a takeover tap is checked against what the connector says now: ${label}`, () =>
    remoteWorld(async (w) => {
      const caps = attachCaps(nowOf(w), takeover ? { change: { takeover: true } } : {});
      const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps });
      const done = await pressData(w, { connector_id: cid, agent_id: "claude-attach", ...data });
      assert.deepEqual(starts(w), [], label);
      assert.equal(w.test.store.remoteState.attachedRemote(AAD), null, label);
      assert.ok(
        textsIn(done).slice(0, 2).join(" ").includes(expected),
        `${label}: ${textsIn(done).slice(0, 2).join(" | ")}`,
      );
    }));
}

test("a confirmation starts one takeover of the conversation it was shown for", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, {
      caps: attachCaps(nowOf(w), { change: { takeover: true } }),
    });
    w.server.onCommand = new Script().hook;
    const confirm = await openTakeover(w, cid);
    const data = tap(confirm, "Take over");
    assert.ok(!["", "1"].includes(String(data["takeover"])), "the card carries a ticket of its own");
    // the ticket, moved onto another conversation of the list, starts nothing
    await w.click({ ...data, resume: "r-idle" }, USER_A);
    await w.idle();
    assert.deepEqual(
      starts(w).map((s) => s["takeover"]),
      [undefined],
    ); // (r-idle is idle: a plain takeover, no terminal is ended)
    // the confirmation itself, once
    await w.click(data, USER_A);
    await w.idle();
    assert.deepEqual(
      starts(w).map((s) => [s["resume_ref"], s["takeover"]]),
      [
        ["r-idle", undefined],
        ["r-live", true],
      ],
    );
    await w.say("/agent detach");
    await w.click(data, USER_A);
    await w.idle();
    assert.equal(starts(w).length, 2, "a confirmation is answered once");
  }));

test("a connector that could not end the terminal says so and the chat stays with claw", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, {
      caps: attachCaps(nowOf(w), { change: { takeover: true } }),
    });
    w.server.onCommand = new Refusing("terminal_did_not_exit").hook;
    const confirm = await openTakeover(w, cid);
    await press(w, confirm, "Take over");
    assert.ok(
      w
        .last()
        .startsWith(
          "The session could not start: The terminal did not let the conversation go when asked, so it was " +
            "not taken over; it is still there.",
        ),
      w.last(),
    );
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }));

test("the sessions card shares a conversation open in a terminal and never offers to take it", () =>
  remoteWorld(async (w) => {
    w.setLang(AAD, "zh");
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, {
      caps: attachCaps(nowOf(w), { change: { takeover: true } }),
    });
    await w.say("/agent sessions");
    const card = w.cards().at(-1) ?? {};
    assert.ok(!titles(card).includes("接管…") && titles(card).includes("只看（终端照常用）"), titles(card).join(", "));
    assert.ok(
      textsIn(card).includes("终端里正在用：这台机器的连接器还不能往终端里输入（需要 0.1.9 或更新），现在只能看"),
      textsIn(card).join(" | "),
    );
    // (the takeover is left to the status card of a watch, behind a confirmation that says what it does, in their language)
    const confirm = await openTakeover(w, cid);
    assert.equal(textsIn(confirm)[0], "🔌 接管终端里的会话？");
    assert.deepEqual(titles(confirm), ["确认接管", "取消"]);
    assert.ok(textsIn(confirm).join(" ").includes("结束终端里的这个会话进程"));
  }));

test("row buttons refused in a chinese chat say so in chinese", () =>
  remoteWorld(async (w) => {
    w.setLang(AAD, "zh");
    const { sid } = await attached(w);
    turnsOf(w).set(AAD, idleTurn());
    // (Back to the assistant is never refused: see "detach and the other row buttons wait for a running task")
    for (const op of ["close", "set_mode"]) {
      const done = await pressData(w, { op, session_id: sid, mode: "plan" }, { settle: false });
      const said = textsIn(done).join(" ");
      assert.ok(said.includes("还有任务在运行。先发 /stop。") && !said.includes("Send /stop first"), `${op}: ${said}`);
    }
    turnsOf(w).delete(AAD);
    let done = await pressData(w, { op: "detach", session_id: "some-earlier-session" });
    assert.ok(textsIn(done)[1]?.includes("这张卡片属于另一个会话"), textsIn(done).join(" | "));
    await w.say("/agent detach");
    done = await pressData(w, { op: "detach", session_id: sid });
    assert.ok(textsIn(done)[1]?.includes("你还没有接入远程会话。"), textsIn(done).join(" | "));
  }));
