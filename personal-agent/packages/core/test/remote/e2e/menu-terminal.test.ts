// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A conversation open in a terminal: watched read-only, or typed into (teams/tests/test_remote_menu.py).
import assert from "node:assert/strict";
import { test } from "node:test";

import { decode } from "../../../src/remote/events.js";
import { NO_ASK_MODES, noAskLine, queuedLine, queuedNote, rowUnreadableLine } from "../../../src/remote/lines.js";
import { RemoteLiveView } from "../../../src/remote-view/live-view.js";
import type { RemoteStep } from "../../../src/remote/events.js";
import type { FakeCommand, FakeRemote } from "../../../../../test-support/remote-fake.js";
import type { Recorded } from "../../../../../test-support/surface.js";
import {
  ALICE,
  type RemoteWorld,
  Script,
  WORLD_ERRORS,
  remoteWorld,
} from "../../../../../test-support/remote-world.js";
import { AAD } from "./helpers.js";
import {
  ATTACH_AGENT,
  type Json,
  Watching,
  agentsCard,
  attachCaps,
  insides,
  press,
  starts,
  textsIn,
  titles,
} from "./menu.js";

const WATCH_ONLY = "Watch only (the terminal keeps working)";
const CONNECT = "Connect (the terminal keeps working)";
const READ_ONLY = "It is in use in a terminal, so you can only watch;";
const nowOf = (w: RemoteWorld): number => w.test.clock.epochMs() / 1000;
const resumable = (caps: Record<string, Json>): Json[] => (caps["claude-attach"]?.["resumable"] ?? []) as Json[];

/** The caps of a connector that types into the terminal of the conversation it holds open (`r-live`). */
function typingCaps(w: RemoteWorld, change: Json = {}): Record<string, Json> {
  const caps = attachCaps(nowOf(w), { change: { terminal_input: true, ...change } });
  const live = resumable(caps)[1];
  if (live) live["input"] = "terminal";
  return caps;
}

const chunk = (kind: string, text: string, extra: Json = {}): Json => ({
  update: { sessionUpdate: kind, content: { type: "text", text } },
  ...extra,
});

/** Private maps of the worker's that a restart empties. */
const memory = (w: RemoteWorld) =>
  (w.remote as unknown as { chats: { readOnly: Map<string, string>; readOnlyKnown: Map<string, string> } }).chats;

/** A connector that types what is sent into the terminal that has the conversation open: a message waits, then runs there. */
class Typing extends Script {
  protected override async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
    const sid = cmd.session_id;
    if (cmd.type === "session.new") {
      await srv.emit(sid, "session_started", {
        acp_session_id: "acp-1",
        attached: true,
        live_terminal: true,
        input: "terminal",
        modes: [],
        currentMode: null,
      });
    } else if (cmd.type === "prompt") {
      await srv.emit(sid, "terminal_input_queued", { reason: "terminal_working", cmd_seq: 1, queued: 1 });
      await srv.emit(sid, "agent_message_chunk", chunk("agent_message_chunk", "Ran it in the terminal: 40 passed."));
      await srv.end(sid, "end_turn");
    }
  }
}

/** A connector that types into the terminal and says, at the start, which permission mode that terminal is in. */
class TypingIn extends Script {
  constructor(private readonly mode: string | null) {
    super();
  }

  protected override async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
    if (cmd.type !== "session.new") return;
    await srv.emit(cmd.session_id, "session_started", {
      acp_session_id: "acp-1",
      attached: true,
      live_terminal: true,
      input: "terminal",
      modes: [],
      currentMode: null,
      terminal_mode: this.mode,
    });
  }
}

for (const how of ["the Watch button", "a Take over tapped after a terminal opened it", "/agent attach with its ref"]) {
  test(`a conversation open in a terminal is watched read only its output arrives and nothing typed is sent: ${how}`, () =>
    remoteWorld(async (w) => {
      const caps = attachCaps(nowOf(w));
      const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps });
      w.server.onCommand = new Watching().hook;
      let done: Json | null = null;
      let want = "r-live";
      if (how === "the Watch button") {
        done = await press(w, await agentsCard(w), WATCH_ONLY);
      } else if (how.startsWith("a Take over")) {
        const card = await agentsCard(w);
        const first = resumable(caps)[0];
        if (first) first["state"] = "live";
        const agent = w.server.connector(cid).agents[0];
        if (agent) agent.capabilities = caps["claude-attach"] ?? {};
        done = await press(w, card, "Take over");
        want = "r-idle";
      } else {
        await w.say("/agent attach r-live");
      }
      await w.idle();
      const cwd = resumable(caps).find((e) => e["ref"] === want)?.["cwd"];
      assert.deepEqual(starts(w), [{ connector_id: cid, agent_id: "claude-attach", cwd, resume_ref: want }], how);
      const state = w.test.store.remoteState.attachedRemote(AAD);
      assert.ok(state);
      assert.equal(insides(w).state.phase(AAD), "watching");
      const status = w.statusEdits().at(-1)?.[1] ?? textsIn(done ?? w.statusCards().at(-1) ?? {}).join(" ");
      assert.ok(status.includes("(read-only)") && status.includes("you can only watch its output here"), status);
      // a message is answered here and never sent: the terminal is the only writer
      await w.say("please run the tests again");
      assert.ok(w.last().startsWith(`${READ_ONLY} your message was not sent`), w.last());
      assert.deepEqual(w.server.commandsOf("prompt"), []);
      // nor does a mode change or a stop: the terminal runs it
      await w.say("/agent mode plan");
      assert.ok(w.last().startsWith(READ_ONLY), w.last());
      await w.say("/stop");
      assert.equal(w.last(), "This is a read-only watch: the terminal is using it, so stop it there.");
      assert.deepEqual(w.server.commandsOf("set_mode"), []);
      assert.deepEqual(w.server.commandsOf("cancel"), []);
      // what the terminal's agent says arrives in the chat
      const sid = state.sessionId ?? "";
      await w.server.emit(
        sid,
        "agent_message_chunk",
        chunk("agent_message_chunk", "All 40 tests pass.", { read_only: true }),
      );
      await w.until(() => w.said().some((t) => t.includes("All 40 tests pass.")));
      // the terminal lets it go: the watch ends, and the chat says how to carry on
      await w.server.emit(sid, "session_closed", { reason: "terminal_closed" });
      await w.until(() => w.test.store.remoteState.attachedRemote(AAD) === null);
      await w.until(() => w.said().some((t) => t.includes("closed in the terminal, so the watch is over")));
    }));
}

test("attaching to a terminal that does not ask says once that messages run at once and one that asks says nothing", async () => {
  for (const [mode, warned] of [
    ["bypassPermissions", "bypass permissions"],
    ["auto", "auto"],
    ["default", null],
    ["plan", null],
    [null, null],
  ] as const) {
    await remoteWorld(async (w) => {
      w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: typingCaps(w) });
      w.server.onCommand = new TypingIn(mode).hook;
      await press(w, await agentsCard(w), CONNECT);
      await w.idle();
      const lines = w.said().filter((t) => t.includes("with no approval card"));
      assert.deepEqual(
        lines,
        warned === null
          ? []
          : [`⚠️ This terminal is in ${warned} mode: what you send from here runs at once, with no approval card.`],
        `${String(mode)}: ${w.said().join(" | ")}`,
      );
    });
  }
});

test("the no ask line is said in the chat s language for each mode that does not ask", () => {
  assert.deepEqual(Object.keys(NO_ASK_MODES).sort(), ["acceptEdits", "auto", "bypassPermissions", "dontAsk"]);
  assert.equal(
    noAskLine("bypassPermissions", "zh"),
    "⚠️ 这个终端是 bypass permissions 模式：手机发的指令会直接执行，不会再弹审批卡。",
  );
  for (const mode of ["default", "plan", null, "something-new"]) {
    assert.equal(noAskLine(mode, "zh"), null);
    assert.equal(noAskLine(mode, "en"), null);
  }
});

test("a conversation open in a terminal its connector types into takes messages and says why one waits", () =>
  remoteWorld(async (w) => {
    const cid = w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: typingCaps(w) });
    w.server.onCommand = new Typing().hook;
    const card = await agentsCard(w);
    assert.ok(!titles(card).includes(WATCH_ONLY) && titles(card).includes(CONNECT), titles(card).join(", "));
    await press(w, card, CONNECT);
    await w.idle();
    assert.deepEqual(starts(w), [
      { connector_id: cid, agent_id: "claude-attach", cwd: "/home/me/work/term", resume_ref: "r-live" },
    ]);
    assert.notEqual(insides(w).state.phase(AAD), "watching");
    await w.say("please run the tests again");
    await w.idle();
    assert.deepEqual(
      w.server.commandsOf("prompt").map((c) => c.body["text"]),
      ["please run the tests again"],
    );
    assert.ok(
      w.said().some((t) => t.includes("Ran it in the terminal: 40 passed.")),
      w.said().join(" | "),
    );
    // The wait is a line of the turn's live view, in the chat's language.
    const seen: string[] = [];
    const display = { progress: (step: RemoteStep) => seen.push(step.note ?? "") };
    const state = w.test.store.remoteState.attachedRemote(AAD);
    const step = decode(
      { name: "terminal_input_queued", data: { data: { reason: "terminal_working" } }, id: "q1" },
      WORLD_ERRORS,
    );
    const runner = (w.remote as unknown as { runner: { apply(r: unknown, s: RemoteStep, d: unknown): Promise<void> } })
      .runner;
    const request = { chatKey: AAD, to: w.conversationOf(), state };
    await runner.apply(request, step, display);
    assert.deepEqual(seen, ["⏳ Queued"]);
    w.setLang(AAD, "zh");
    await runner.apply(request, step, display);
    assert.equal(seen.at(-1), "⏳ 已排队");
  }));

/** What a connector says of a question on the terminal's screen, as it says it (connector session.ts `terminal_input_queued`). */
const RM_ASKS = 'Bash command: rm -rf "$(echo …/build)"';

/**
 * A connector that types into a terminal whose Claude Code has a registry row it cannot read (it says so at the start), and whose
 * screen shows a question of its own when the message comes: it says what the question asks, twice (a second question after the
 * first), and the message runs once the questions are answered there.
 */
class AtAQuestion extends Script {
  /** The turn's own reply, sent once the test lets the questions be answered. */
  readonly tasks: Promise<void>[] = [];

  constructor(private readonly answered: Promise<void>) {
    super();
  }

  protected override async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
    const sid = cmd.session_id;
    if (cmd.type === "session.new") {
      await srv.emit(sid, "session_started", {
        acp_session_id: "acp-1",
        agent_id: "claude-attach",
        kind: "claude",
        cwd: "/home/me/work/term",
        title: "autopilot",
        attached: true,
        live_terminal: true,
        input: "terminal",
        modes: [],
        currentMode: null,
        terminal_mode: "default",
        registry_row_unreadable: true,
      });
    } else if (cmd.type === "prompt") {
      for (const dialog of [RM_ASKS, "Create file: notes.md"]) {
        await srv.emit(sid, "terminal_input_queued", {
          reason: "terminal_dialog",
          cmd_id: cmd.cmd_id ?? null,
          cmd_seq: 1,
          queued: 1,
          dialog,
          registry_row_unreadable: true,
        });
      }
      this.tasks.push(
        this.answered.then(async () => {
          await srv.emit(sid, "agent_message_chunk", chunk("agent_message_chunk", "Done in the terminal."));
          await srv.end(sid, "end_turn");
        }),
      );
    }
  }
}

for (const lang of ["en", "zh"] as const) {
  test(`a message held by a question on the terminal says what it asks and a registry row it cannot read is said once: ${lang}`, () =>
    remoteWorld(
      async (w) => {
        let answer = (): void => undefined;
        const answered = new Promise<void>((resolve) => {
          answer = resolve;
        });
        const script = new AtAQuestion(answered);
        // (the live view's waits stay virtual; one of more than a minute, the stream's own closing, does not come within the test)
        const virtual = w.virtual.sleep.bind(w.virtual);
        w.virtual.sleep = (ms, signal) =>
          ms > 60_000
            ? new Promise<void>((_resolve, reject) => {
                signal?.addEventListener("abort", () => {
                  reject(signal.reason as Error);
                });
              })
            : virtual(ms, signal);
        w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: typingCaps(w) });
        w.server.onCommand = script.hook;
        w.setLang(AAD, lang);
        await press(w, await agentsCard(w), lang === "en" ? CONNECT : "连上（终端照常用）");
        await w.idle();
        const said = w.say("please run the tests again");
        const asks = queuedNote("terminal_dialog", RM_ASKS, lang);
        const short = queuedLine("terminal_dialog", lang);
        const ops = (): Recorded[] => w.surface.outbox;
        // What the person reads while it waits is what the question asks (the floating status: its short line), never the bare
        // "waiting for the terminal".
        try {
          await w.until(() => JSON.stringify(ops()).includes(JSON.stringify(asks).slice(1, -1)));
          await w.until(() => ops().some((r) => r.op === "stream.inform" && r.text.includes(short)));
        } finally {
          answer();
        }
        await said;
        await Promise.all(script.tasks);
        await w.until(() => JSON.stringify(ops()).includes("Done in the terminal."));
        assert.ok(
          !ops().some((r) => r.op === "stream.inform" && r.text.includes(queuedLine("terminal_state_unknown", lang))),
        );
        // Each question said once in the chat, in the order they came; the bare wait never.
        const questions = w
          .said()
          .filter((t) => t.includes(lang === "en" ? "waiting for your confirmation" : "终端在等你确认"));
        assert.deepEqual(questions, [asks, queuedNote("terminal_dialog", "Create file: notes.md", lang)]);
        const hint = rowUnreadableLine(lang);
        assert.ok(hint.includes("claude --resume"), hint);
        assert.equal(
          JSON.stringify(ops()).split("claude --resume").length - 1,
          1,
          `said once per attach: ${w.said().join(" | ")}`,
        );
        assert.equal(
          asks,
          lang === "en"
            ? '⏳ The terminal is waiting for your confirmation: Bash command: rm -rf "$(echo …/build)"'
            : '⏳ 终端在等你确认：Bash command: rm -rf "$(echo …/build)"',
        );
      },
      { direct: true, streaming: true },
    ));
}

test("a wait for a question on the terminal is the whole line in the live view and a short one in the floating status", () => {
  const view = new RemoteLiveView("🤖 Claude", "zh");
  const step = decode(
    {
      name: "terminal_input_queued",
      data: {
        data: { reason: "terminal_dialog", cmd_seq: 1, queued: 1, dialog: RM_ASKS, registry_row_unreadable: true },
      },
      id: "q1",
    },
    WORLD_ERRORS,
  );
  assert.deepEqual([step.queued, step.dialog, step.rowUnreadable], ["terminal_dialog", RM_ASKS, true]);
  view.apply({
    ...step,
    note: queuedNote("terminal_dialog", step.dialog, "zh"),
    waitLine: queuedLine("terminal_dialog", "zh"),
  });
  assert.deepEqual(view.statusLines(), ["⏳ 等你确认"]);
  assert.ok(view.render().includes('⏳ 终端在等你确认：Bash command: rm -rf "$(echo …/build)"'), view.render());
  // (no summary: the question all the same)
  assert.equal(queuedNote("terminal_dialog", null, "en"), "⏳ The terminal is waiting for your confirmation");
  assert.equal(queuedNote("terminal_working", null, "zh"), "⏳ 已排队");
});

test("what is typed at the shared terminal shows on the phone before its reply and leaving ends nothing there", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: typingCaps(w) });
    w.server.onCommand = new Typing().hook;
    await press(w, await agentsCard(w), CONNECT);
    await w.idle();
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    // (history replayed on attach, and what Claude Code writes as the user's turn itself, are not words typed now)
    await w.server.emit(sid, "user_message_chunk", chunk("user_message_chunk", "an old prompt", { replay: true }));
    await w.server.emit(sid, "user_message_chunk", chunk("user_message_chunk", "<command-name>/clear</command-name>"));
    // (from a connector that passes on the turns Claude Code takes on its own: a background task's notification, a message from
    // another session or a sub-agent, a compacted conversation's summary)
    for (const own of [
      "<task-notification>\n<task-id>a0b1c2d3e4f5a6b7c</task-id>\n<output-file>/tmp/claude-0/x/tasks/a0b1.output</output-file>\n</task-notification>",
      'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1.sock">\nplease rebase\n</cross-session-message>',
      '<agent-message from="a0123456789abcdef">\ndone\n</agent-message>',
      "This session is being continued from a previous conversation that ran out of context.",
    ]) {
      await w.server.emit(sid, "user_message_chunk", chunk("user_message_chunk", own));
    }
    await w.server.emit(sid, "user_message_chunk", chunk("user_message_chunk", "run the linter\nthen tell me"));
    await w.server.emit(sid, "agent_message_chunk", chunk("agent_message_chunk", "Lint is clean."));
    await w.until(() => w.said().some((t) => t.includes("Lint is clean.")));
    const said = w.said();
    const typed = said.flatMap((t, i) => (t.startsWith("🖥 <b>Typed in the terminal:</b>") ? [i] : []));
    assert.deepEqual(
      typed.map((i) => said[i]),
      ["🖥 <b>Typed in the terminal:</b><br><br>│ <i>run the linter</i><br>│ <i>then tell me</i>"],
      said.join(" | "),
    );
    const reply = said.findIndex((t) => t.includes("Lint is clean."));
    assert.ok((typed[0] ?? Infinity) < reply, "the prompt comes before its reply");
    assert.ok(!said.some((t) => t.includes("an old prompt") || t.includes("/clear")));
    assert.ok(
      !said.some((t) => /task-id|tasks\/a0b1|please rebase|agent-message|previous conversation/.test(t)),
      said.join(" | "),
    );
    // leaving the conversation sends the connector nothing: the terminal keeps it, untouched
    await w.say("/agent detach");
    await w.idle();
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.deepEqual(w.server.commandsOf("close"), []);
    assert.deepEqual(w.server.commandsOf("cancel"), []);
  }));

test("the reply to a prompt typed at a terminal the chat types into is told after the watch's few quiet seconds", () =>
  remoteWorld(
    async (w) => {
      w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: typingCaps(w) });
      w.server.onCommand = new Typing().hook;
      await press(w, await agentsCard(w), CONNECT);
      await w.idle();
      const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
      const says = (kind: string, text: string) => w.server.emit(sid, kind, chunk(kind, text));
      // Typed at the terminal: no turn of the phone's, so nothing but quiet ends it (2026-11-11 guide re-check).
      await says("user_message_chunk", "Reply with TERMINAL only");
      await says("agent_message_chunk", "TERMINAL");
      // (the session's own timings here are a minute of quiet: only the watch's, TEST_TIMINGS, get it out in time)
      await w.until(() => w.said().some((t) => t.includes("TERMINAL") && !t.includes("Typed in the terminal")), 5_000);
      // A worker that restarted reads back that the session types into a terminal: its reader is just as quick.
      w.remote.shutdown();
      const chats = w.remote as unknown as {
        chats: { terminalInput: Map<string, string>; readOnlyKnown: Map<string, string> };
      };
      chats.chats.terminalInput.clear(); // (a new worker process: nothing of this in memory)
      chats.chats.readOnlyKnown.clear();
      w.remote.resume();
      await says("user_message_chunk", "Reply with AGAIN only");
      await says("agent_message_chunk", "AGAIN");
      await w.until(() => w.said().some((t) => t.includes("AGAIN") && !t.includes("Typed in the terminal")), 5_000);
    },
    { timings: { quietMs: 60_000, toolQuietMs: 60_000, gapMs: 0, maxAgeMs: 120_000, reconnectMs: 50 } },
  ));

test("the reply to a prompt typed at the shared terminal says so in the chats language", () =>
  remoteWorld(async (w) => {
    w.setLang(AAD, "zh");
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: typingCaps(w) });
    w.server.onCommand = new Typing().hook;
    await press(w, await agentsCard(w), "连上（终端照常用）");
    await w.idle();
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    const says = (kind: string, text: string) => w.server.emit(sid, kind, chunk(kind, text));
    await says("user_message_chunk", "run the linter");
    await says("agent_message_chunk", "Lint is clean.");
    await w.until(() => w.said().some((t) => t.includes("Lint is clean.")));
    assert.ok(
      w
        .said()
        .find((t) => t.includes("Lint is clean."))
        ?.includes("回复终端里的输入："),
    );
    await says("agent_message_chunk", "Also: a new commit landed."); // (said after that reply: the agent's own again)
    await w.until(() => w.said().some((t) => t.includes("a new commit landed.")));
    assert.ok(
      w
        .said()
        .find((t) => t.includes("a new commit landed."))
        ?.includes("自己说的："),
    );
  }));

/**
 * A connector that typed the message into the terminal but did not see it in the transcript in time (`terminal_input_unconfirmed`),
 * as a connector before 0.1.22 ended a pasted message of several lines: the prompt as Claude Code recorded it, in a
 * `<pasted_content>` block, then the end of the turn; the session's answer comes after that end.
 */
class Unconfirmed extends Typing {
  protected override async handle(srv: FakeRemote, cmd: FakeCommand): Promise<void> {
    if (cmd.type !== "prompt") return super.handle(srv, cmd);
    const sid = cmd.session_id;
    const sent = cmd.body["text"];
    const text = (typeof sent === "string" ? sent : "").replaceAll("\r\n", "\n");
    await srv.emit(
      sid,
      "user_message_chunk",
      chunk("user_message_chunk", `\n\n<pasted_content id="9a55">\n${text}\n</pasted_content id="9a55">\n`),
    );
    await srv.emit(sid, "turn_end", { stopReason: "error", error: "terminal_input_unconfirmed" });
  }
}

for (const [lang, version] of [
  ["en", "0.1.21"],
  ["zh", "0.2.2"],
] as const) {
  test(`a message the terminal took without the connector seeing it in time is never said as not sent and its answer still comes: ${lang} ${version}`, () =>
    remoteWorld(
      async (w) => {
        w.setLang(AAD, lang);
        w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: typingCaps(w), version });
        w.server.onCommand = new Unconfirmed().hook;
        await press(w, await agentsCard(w), lang === "zh" ? "连上（终端照常用）" : CONNECT);
        await w.idle();
        const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
        await w.say("summarise the three issues\r\n\r\none line each");
        const lead = lang === "zh" ? "还没确认终端收到" : "Not confirmed by the terminal yet";
        await w.until(() => w.said().some((t) => t.includes(lead)));
        const note = w.said().find((t) => t.includes(lead)) ?? "";
        assert.ok(!/did not complete|not sent|may not have gone in|没有完成|没发出去|没有发进去/u.test(note), note);
        assert.ok(
          note.includes(lang === "zh" ? "之后的回复仍会发到这里" : "Whatever the session answers still shows here"),
          note,
        );
        // (an upgrade is offered only to a connector from before the fix)
        assert.equal(note.includes("npm install -g @primusclaw/connector@latest"), version === "0.1.21", note);
        // The prompt the terminal took is shown as it was typed, never as Claude Code's paste block.
        assert.ok(!w.said().some((t) => t.includes("pasted_content")), w.said().join(" | "));
        await w.server.emit(
          sid,
          "agent_message_chunk",
          chunk("agent_message_chunk", "The three issues, one line each."),
        );
        await w.until(() => w.said().some((t) => t.includes("The three issues, one line each.")), 5_000);
      },
      { timings: { quietMs: 60_000, toolQuietMs: 60_000, gapMs: 0, maxAgeMs: 120_000, reconnectMs: 50 } },
    ));
}

test("the sessions card says a conversation it types into takes messages in the persons language", () =>
  remoteWorld(async (w) => {
    w.setLang(AAD, "zh");
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: typingCaps(w, { takeover: true }) });
    await w.say("/agent sessions");
    const card = w.cards().at(-1) ?? {};
    assert.ok(titles(card).includes("连上（终端照常用）"), titles(card).join(", "));
    assert.ok(!titles(card).includes("接管…") && !titles(card).includes("只看（终端照常用）"));
    assert.ok(
      textsIn(card).includes(
        "终端里正在用：连上后，你在这里发的消息会作为输入打进那个终端，回复和终端里敲的内容都会出现在这里；终端照常用，随时可以断开",
      ),
      textsIn(card).join(" | "),
    );
  }));

test("a watch this worker did not know of is refused by claw and told as read only", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: attachCaps(nowOf(w)) });
    w.server.onCommand = new Watching().hook;
    await press(w, await agentsCard(w), WATCH_ONLY);
    await w.idle();
    memory(w).readOnly.clear(); // (as after a restart: the worker keeps this in memory)
    w.server.failOn("POST", "/commands", [409, "session_read_only"]);
    await w.say("hello");
    assert.ok(w.last().startsWith(READ_ONLY), w.last());
    assert.equal(insides(w).state.phase(AAD), "watching");
  }));

test("after a worker restart a watch is read back from the session before anything is sent", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: attachCaps(nowOf(w)) });
    w.server.onCommand = new Watching().hook;
    await press(w, await agentsCard(w), WATCH_ONLY);
    await w.idle();
    memory(w).readOnly.clear(); // (a new worker process: nothing of this in memory)
    memory(w).readOnlyKnown.clear();
    await w.say("stop it");
    await w.say("/agent mode plan");
    await w.say("run the tests");
    assert.ok(w.last().startsWith(READ_ONLY), w.last());
    assert.deepEqual(
      ["prompt", "set_mode", "cancel"].map((t) => w.server.commandsOf(t)),
      [[], [], []],
    );
  }));

test("a watch that ended while the chat could not be told is left at the next message", () =>
  remoteWorld(async (w) => {
    w.server.addConnector(ALICE, "dev-pod", ATTACH_AGENT, { caps: attachCaps(nowOf(w)) });
    w.server.onCommand = new Watching().hook;
    await press(w, await agentsCard(w), WATCH_ONLY);
    await w.idle();
    const sid = w.test.store.remoteState.attachedRemote(AAD)?.sessionId ?? "";
    w.reachable = false; // (muted hours: the end is not told)
    await w.server.emit(sid, "session_closed", { reason: "terminal_closed" });
    w.server.session(sid).status = "closed";
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.notEqual(w.test.store.remoteState.attachedRemote(AAD), null);
    await w.say("is it done?");
    assert.ok(w.last().startsWith("The conversation was closed in the terminal, so the watch is over"), w.last());
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
    assert.deepEqual(w.server.commandsOf("prompt"), []);
  }));
