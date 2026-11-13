// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The session card is the window (teams/tests/test_session_window.py): a chat attached in `card` mode keeps its chat box for the
// assistant, and talks to the session on the card (its text box and Send, a reply that quotes it, its approval buttons, Stop and
// Back to the assistant). Which way a message goes is the router's; the test world sends it on as the router does.
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";

import { CODEX_OPTIONS } from "../../../../../test-support/remote-fake.js";
import { Script, USER_A, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD } from "./helpers.js";
import {
  answering,
  approvalButtons,
  cardWords,
  lastWindow,
  prompts,
  sendFromCard,
  statusCardId,
  windowCards,
  windowed,
} from "./window-helpers.js";

const CARD = { windowDefault: "card" } as const;

// --- where what is typed goes --------------------------------------------------------------------------------------------------

test("the chat box goes to the assistant and the card to the session", () =>
  remoteWorld(async (w) => {
    const sid = await windowed(w, answering());
    await w.say("今天有什么要我处理的？");
    assert.deepEqual(w.toAssistant, ["今天有什么要我处理的？"], "the chat box is PrimusClaw Assistant's");
    assert.deepEqual(prompts(w), []);
    await sendFromCard(w, sid, "run the tests");
    await w.idle();
    assert.deepEqual(prompts(w), ["run the tests"]);
    assert.deepEqual(w.toAssistant, ["今天有什么要我处理的？"]);
    // the card says where each goes
    assert.ok(
      cardWords(lastWindow(w)).includes("What you type in the chat box goes to PrimusClaw Assistant"),
      cardWords(lastWindow(w)),
    );
  }, CARD));

test("a reply quoting the session card goes to the session", () =>
  remoteWorld(async (w) => {
    await windowed(w, answering());
    await w.say("看一下 README", USER_A, [statusCardId(w)]);
    assert.deepEqual(prompts(w), ["看一下 README"], "only the words go, not the quoted card");
    assert.deepEqual(w.toAssistant, []);
    // a quote of another message is PrimusClaw Assistant's
    await w.say("这是什么意思", USER_A, ["some-other-message"]);
    assert.deepEqual(w.toAssistant, ["这是什么意思"]);
    assert.deepEqual(prompts(w), ["看一下 README"]);
  }, CARD));

test("mode chat sends the chat box to the session and mode card takes it back", () =>
  remoteWorld(async (w) => {
    await windowed(w, answering());
    await w.say("/agent mode chat");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.window, "chat");
    assert.equal(w.test.store.prefs.getPrefs(AAD).remoteWindow, "chat");
    await w.say("hello session");
    assert.deepEqual(prompts(w), ["hello session"]);
    assert.deepEqual(w.toAssistant, []);
    await w.say("/agent mode card");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.window, "card");
    await w.say("hello there");
    assert.deepEqual(prompts(w), ["hello session"]);
    assert.deepEqual(w.toAssistant, ["hello there"]);
    // the setting is the person's: the next attach takes it, whatever the worker's default
    w.settings.windowDefault = "chat";
    await w.say("/agent detach");
    await w.say("/agent new codex /home/me/repo");
    assert.equal(w.test.store.remoteState.attachedRemote(AAD)?.window, "card");
  }, CARD));

test("a worker whose default is chat keeps the old routing", () =>
  remoteWorld(
    async (w) => {
      await windowed(w, answering());
      await w.say("hello");
      assert.deepEqual(prompts(w), ["hello"]);
      assert.deepEqual(w.toAssistant, []);
      assert.deepEqual(windowCards(w), []); // (the old status card, not the window)
    },
    { windowDefault: "chat" },
  ));

// --- the card is the window --------------------------------------------------------------------------------------------------

test("the reply streams into the card and nothing else is posted", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.tool(sid, "t1", "Run pytest", "in_progress");
      await srv.say(sid, "Ran 12 tests.\n");
      await srv.tool(sid, "t1", "Run pytest", "completed");
      await srv.say(sid, "All green: CARD-REPLY-7.");
      await srv.end(sid);
    };
    const sid = await windowed(w, script);
    const before = w.operations().length;
    await sendFromCard(w, sid, "run the tests");
    await w.idle();
    await sleep(100);
    const later = w.operations().slice(before);
    assert.ok(
      !later.some((o) => o.op === "send" && !o.card && o.text.includes("CARD-REPLY-7")),
      "the answer is on the card, not a message",
    );
    assert.ok(!w.surface.outbox.some((r) => r.op.startsWith("stream.")));
    const words = cardWords(lastWindow(w));
    assert.ok(
      words.includes("CARD-REPLY-7") &&
        words.includes("You sent from the card: run the tests") &&
        words.includes("Status: idle"),
      words,
    );
    // one new card for the turn, at its end, and it says the turn is over (a phone may not redraw an edit after it)
    const posted = windowCards(w, before).filter((c) => c.op !== "update");
    assert.equal(posted.length, 1, posted.map((c) => cardWords(c.card).slice(0, 80)).join(" | "));
    assert.ok(cardWords(posted[0]?.card).includes("Status: idle"));
  }, CARD));

test("a turn that grew the output posts the card again at the bottom", () =>
  remoteWorld(async (w) => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${String(i)}: ` + "x".repeat(40)).join("\n");
    const sid = await windowed(w, answering(long));
    const first = statusCardId(w);
    await sendFromCard(w, sid, "print a lot");
    await w.idle();
    await sleep(100);
    const now = statusCardId(w);
    assert.notEqual(now, first, "a new card at the bottom");
    assert.ok(
      w.operations().some((o) => o.op === "delete" && o.id === first),
      "and the old one removed",
    );
    // (a reply that quotes it still reaches the session)
    assert.ok(w.test.store.remoteState.getRemote(AAD)?.windowCards.includes(first));
    const last = lastWindow(w);
    const tail = ((last["body"] ?? []) as Record<string, unknown>[]).filter((b) => b["id"] === "window_tail");
    assert.ok(cardWords(last).includes("line 29") && !cardWords(tail).includes("line 0:"));
    // the whole of it, on request
    const before = w.operations().length;
    await w.click({ primusclaw: "remote", op: "full", session_id: sid }, USER_A, now);
    const full = w
      .operations()
      .slice(before)
      .filter((o) => o.op === "send")
      .map((o) => o.text)
      .join(" ");
    assert.ok(full.includes("line 0:") && full.includes("line 29"), full.slice(0, 200));
  }, CARD));

test("an approval waits on the card and is answered there", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.ask(sid, "act-1", "Edit README.md", CODEX_OPTIONS, { input: { path: "README.md" } });
    };
    script.onDecision = async (srv, sid) => {
      await srv.say(sid, "Edited: APPROVED-OK");
      await srv.end(sid);
    };
    const sid = await windowed(w, script);
    await sendFromCard(w, sid, "edit the readme");
    await w.until(() => windowCards(w).some((c) => cardWords(c.card).includes("Needs your approval: Edit README.md")));
    // no card of its own
    assert.ok(w.permissionCards().every((c) => JSON.stringify(c).includes("window_tail")));
    const card =
      [...windowCards(w)].reverse().find((c) => cardWords(c.card).includes("Needs your approval"))?.card ?? {};
    assert.ok(cardWords(card).includes("Status: waiting for you"));
    const button = approvalButtons(card).find(
      (a) => (a["data"] as Record<string, unknown>)["option_id"] === "allow_once",
    );
    const data = (button?.["data"] ?? {}) as Record<string, unknown>;
    assert.equal(data["in_window"], true);
    await w.click(data, USER_A, statusCardId(w));
    await w.idle();
    await sleep(100);
    const decisions = w.server.commandsOf("decision");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.body["option_id"], "allow_once");
    const words = cardWords(lastWindow(w));
    assert.ok(words.includes("APPROVED-OK") && !words.includes("Needs your approval"), words);
  }, CARD));

test("a terminal's question is never drawn in the window: it shows a tool and buttons, not the request", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "REDRAWN-OK");
    };
    const sid = await windowed(w, script);
    // (stored as a terminal's question shown whole: its options keep Allow)
    w.test.store.remotePermissions.saveRemotePermission({
      userId: AAD,
      sessionId: sid,
      actionId: "act-term",
      tool: "Run: TERMINAL-TOOL",
      options: CODEX_OPTIONS,
      expiresAt: Date.now() / 1000 + 600,
      ask: {
        action_id: "act-term",
        origin: "terminal",
        kind: "execute",
        input: { command: "ls" },
        clawy_shown_whole: true,
      },
    });
    await sendFromCard(w, sid, "go");
    await w.until(() => cardWords(lastWindow(w)).includes("REDRAWN-OK"));
    const card = lastWindow(w);
    assert.ok(!cardWords(card).includes("TERMINAL-TOOL"), cardWords(card));
    assert.deepEqual(approvalButtons(card), []);
  }, CARD));

test("stop and back to the assistant from the card", () =>
  remoteWorld(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "working on it");
    };
    const sid = await windowed(w, script);
    await sendFromCard(w, sid, "go");
    await w.until(() => w.remote.running(AAD));
    await w.click({ primusclaw: "remote", op: "stop", session_id: sid }, USER_A, statusCardId(w));
    await w.idle();
    assert.ok(w.server.commandsOf("cancel").length > 0);
    await w.click({ primusclaw: "remote", op: "detach", session_id: sid }, USER_A, statusCardId(w));
    assert.equal(w.test.store.remoteState.attachedRemote(AAD), null);
  }, CARD));

test("send with an empty box sends nothing", () =>
  remoteWorld(async (w) => {
    const sid = await windowed(w);
    await sendFromCard(w, sid, "   ");
    await w.idle();
    assert.deepEqual(prompts(w), []);
    assert.ok(cardWords(lastWindow(w)).includes("Write in the box first"));
  }, CARD));

for (const ends of [false, true]) {
  test(`what the agent says between turns goes into the card: ${ends ? "a turn end" : "a pause"}`, () =>
    remoteWorld(async (w) => {
      // the reader lets go of the text before the card is refreshed, and an agent that ended its turn is not "at work"
      const sid = await windowed(w);
      w.earlyTimers = true; // (the reader's pause ends on a virtual clock, a hair before its deadline: no real time, no load)
      await w.server.say(sid, "a background job finished: BG-DONE-3");
      if (ends) await w.server.end(sid);
      await w.until(() => {
        const words = cardWords(windowCards(w).at(-1)?.card);
        return words.includes("BG-DONE-3") && words.includes("Status: idle");
      }, 10_000);
      await sleep(500);
      assert.ok(cardWords(lastWindow(w)).includes("Status: idle"), cardWords(lastWindow(w)));
      assert.ok(!w.operations().some((o) => o.op === "send" && o.text.includes("BG-DONE-3")));
    }, CARD));
}

// --- a cancelled edit (found by the port: a turn's end cancelled an edit already waiting for the chat, which then posted the card
// a second time) ---------------------------------------------------------------------------------------------------------------

interface Board {
  refreshWindow(chatKey: string, to: unknown, how?: { byPerson?: boolean }): Promise<boolean>;
  scheduleWindow(chatKey: string, to: unknown): void;
  cancelWindowEdit(chatKey: string): void;
  settled(): Promise<void>;
}

test("an edit of the card cancelled while it waits for the chat does nothing", () =>
  remoteWorld(async (w) => {
    await windowed(w);
    const board = (w.remote as unknown as { board: Board }).board;
    const to = w.conversationOf();
    let release = (): void => undefined;
    w.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mark = w.operations().length;
    const first = board.refreshWindow(AAD, to, { byPerson: true }); // (holds the chat while its edit is in flight)
    board.scheduleWindow(AAD, to);
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); // (its pause is over: it waits for the chat)
    board.cancelWindowEdit(AAD);
    w.gate = null;
    release();
    await first;
    await board.settled();
    assert.deepEqual(
      w
        .operations()
        .slice(mark)
        .map((o) => o.op),
      ["update"],
    ); // the first refresh's edit, and nothing from the cancelled one
  }, CARD));

// --- found by review (#636 r1): the box's words are cut and emptied as Python's str.strip()[:INPUT_MAX] -----------------------

test("the box's words are cut by characters and a box of whitespace only is empty, as python reads them", () =>
  remoteWorld(async (w) => {
    const sid = await windowed(w, answering());
    const long = "a".repeat(3999) + "😀"; // 4000 characters, 4001 UTF-16 units
    await sendFromCard(w, sid, long);
    await w.idle();
    assert.deepEqual(prompts(w), [long]); // (the emoji whole: no half of a surrogate pair)
    await sendFromCard(w, sid, "\u0085  ");
    await w.idle();
    assert.equal(prompts(w).length, 1); // nothing sent: Python's strip() takes these as white space
    assert.ok(cardWords(lastWindow(w)).includes("Write in the box first"));
  }, CARD));
