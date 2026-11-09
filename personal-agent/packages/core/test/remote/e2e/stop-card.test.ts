// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The remote half of a phone's Stop card (teams/tests/test_stop_button.py, the attached agent's turns): the press cancels only
// the turn the card was sent for, and only while it is the one running. The card itself is the router's.
import assert from "node:assert/strict";
import { test } from "node:test";

import { KEY_OF, type RemoteWorld, Script, USER_A, remoteWorld } from "../../../../../test-support/remote-world.js";
import { AAD, attached } from "./helpers.js";

/** A chat attached to an agent that runs the whole test suite, and the turn this worker watches for it. */
async function running(w: RemoteWorld) {
  const script = new Script();
  script.onPrompt = async (srv, sid) => {
    await srv.tool(sid, "t1", "Run the whole test suite");
  };
  const { sid } = await attached(w, script);
  await w.send("run everything");
  await w.until(() => w.progressTexts().some((t) => t.includes("⏳ Run the whole test suite")));
  const turn = w.remote.currentTurn(AAD);
  assert.ok(turn);
  return { sid, turn };
}

const press = (w: RemoteWorld, only: Parameters<RemoteWorld["remote"]["stop"]>[3]) =>
  w.remote.stop(USER_A, KEY_OF[AAD] ?? "", w.conversationOf(), only);

test("a phones message to an attached agent gets the card and its press cancels that turn", () =>
  remoteWorld(async (w) => {
    const { turn } = await running(w);
    assert.equal(await press(w, turn), true);
    await w.idle();
    assert.equal(w.server.commandsOf("cancel").length, 1);
    assert.equal(w.answer(), "Stopped.");
    assert.equal(w.remote.currentTurn(AAD), undefined);
    assert.equal(await press(w, turn), false); // (pressed again: the turn is over)
    assert.equal(w.server.commandsOf("cancel").length, 1);
  }));

test("a press after the agents turn ended on its own cancels nothing", () =>
  remoteWorld(async (w) => {
    const { sid, turn } = await running(w);
    await w.server.say(sid, "All green.");
    await w.server.end(sid);
    await w.idle();
    const before = w.said().length;
    assert.equal(await press(w, turn), false);
    assert.deepEqual(w.server.commandsOf("cancel"), []);
    assert.equal(w.said().length, before); // (nothing said: the caller says the turn is over)
  }));

test("the agents next turn is never cancelled by the card of the one before", () =>
  remoteWorld(async (w) => {
    const { turn } = await running(w);
    const turns = (w.remote as unknown as { chats: { turns: Map<string, typeof turn> } }).chats.turns;
    const standIn = { ...turn };
    turns.set(AAD, standIn);
    assert.equal(await press(w, turn), false);
    turns.set(AAD, turn);
    assert.deepEqual(w.server.commandsOf("cancel"), []);
    await w.say("/stop");
    assert.equal(w.server.commandsOf("cancel").length, 1);
  }));

test("a press for a chat that left its session stops nothing", () =>
  remoteWorld(async (w) => {
    const { turn } = await running(w);
    w.test.store.remoteState.detachRemote(AAD);
    assert.equal(await press(w, turn), false);
    assert.deepEqual(w.server.commandsOf("cancel"), []);
  }));

test("only the chat whose session card is its window is windowed", () =>
  remoteWorld(async (w) => {
    assert.equal(w.remote.windowed(AAD), false); // (not attached)
    await attached(w);
    const window = w.test.store.remoteState.attachedRemote(AAD)?.window;
    assert.equal(w.remote.windowed(AAD), window === "card");
    w.test.store.remoteState.setRemoteWindow(AAD, "card");
    assert.equal(w.remote.windowed(AAD), true);
    w.test.store.remoteState.setRemoteWindow(AAD, "chat");
    assert.equal(w.remote.windowed(AAD), false);
  }));
