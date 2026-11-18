// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Where the router sends a message, a group's message and a click once remote agents are on (test_remote_agents.py): the router
// in front of the real remote agents, the real Claw client and the fake remote-agents server.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { FakeRemote } from "../../../../../test-support/remote-fake.js";
import { Script } from "../../../../../test-support/remote-world.js";
import { clickOf, message, said } from "../world.js";
import { attachedThroughRouter, routed } from "./remote-routed.js";

async function oneTurn(srv: FakeRemote, sid: string): Promise<void> {
  await srv.say(sid, "Done.");
  await srv.end(sid);
}

const prompts = (srv: FakeRemote): unknown[] => srv.commandsOf("prompt").map((c) => c.body);

test("test_a_message_that_quotes_goes_to_the_attached_agent_with_the_quote", () =>
  routed(async (w) => {
    const script = new Script();
    await attachedThroughRouter(w, script);
    script.onPrompt = oneTurn;
    w.rw.server.calls.length = 0;
    const quote = {
      messageId: "m-1",
      author: "Bob",
      text: "docs are stale",
      fromBot: false,
      sentAt: "",
      deleted: false,
      source: "entity" as const,
    };
    await w.say("add a line to the README", { quotes: [quote] });
    assert.deepEqual(
      w.rw.server.commandsOf("prompt").map((c) => c.body["text"]),
      ["Quoted message from Bob:\n> docs are stale\n\nadd a line to the README"],
    );
  }));

test("test_a_plain_message_goes_to_claw_until_the_chat_is_attached_and_to_the_agent_after", () =>
  routed(async (w) => {
    await w.say("hello"); // (not attached: Claw's turn)
    assert.deepEqual(w.r.turns.calls, [["create", "ak-alice", "hello"]]);
    assert.deepEqual(prompts(w.rw.server), []);
    const script = new Script();
    await attachedThroughRouter(w, script);
    script.onPrompt = oneTurn;
    w.rw.server.calls.length = 0;
    await w.say("add a line to the README");
    assert.deepEqual(prompts(w.rw.server), [{ type: "prompt", text: "add a line to the README" }]);
    assert.ok(
      w.rw.server.calls.every(([, path]) => path.startsWith("/v1/remote-agents")),
      JSON.stringify(w.rw.server.calls),
    );
    assert.equal(w.r.turns.calls.length, 1); // (nothing more went to Claw)
  }));

test("test_detach_sends_messages_to_claw_again_and_leaves_the_session_where_it_is", () =>
  routed(async (w) => {
    const sid = await attachedThroughRouter(w);
    await w.say("/agent detach");
    assert.equal(w.rw.last(), "—— Back to the assistant ——");
    assert.ok(w.rw.statusEdits().at(-1)?.[1].includes("Back to the assistant"), JSON.stringify(w.rw.statusEdits()));
    assert.equal(w.attachedSession(), null);
    assert.equal(w.rw.server.sessions.get(sid)?.status, "active");
    w.rw.server.calls.length = 0;
    await w.say("hello");
    assert.deepEqual(w.r.turns.calls, [["create", "ak-alice", "hello"]]);
    assert.deepEqual(prompts(w.rw.server), []);
    await w.say("/agent detach");
    assert.equal(w.rw.last(), "You are not attached to a remote session.");
  }));

test("test_new_while_attached_says_how_to_get_back_to_claw", () =>
  routed(async (w) => {
    await attachedThroughRouter(w);
    await w.say("/new");
    assert.ok(w.rw.last().includes("`/agent detach`"), w.rw.last());
    assert.notEqual(w.attachedSession(), null);
  }));

test("test_a_group_chat_gets_no_agent_commands_and_calls_nothing", () =>
  routed(async (w) => {
    await attachedThroughRouter(w);
    w.rw.server.calls.length = 0;
    // (`/agent attach` and `/agent detach` bind a group to one of the sender's sessions: group-binding.test.ts)
    for (const text of ["/agent new codex /repo", "/agents", "/agent sessions", "/agent off"]) {
      await w.say(text, { group: true });
      const last = said(w.r).at(-1) ?? "";
      assert.ok(last.includes("works only in a 1:1 chat") && last.startsWith(`\`${text.split(" ")[0] ?? ""}\``), text);
    }
    assert.deepEqual(w.rw.server.calls, []);
  }));

test("test_a_group_message_never_goes_to_the_remote_agent_the_1on1_chat_is_attached_to", () =>
  routed(async (w) => {
    await attachedThroughRouter(w);
    w.rw.server.calls.length = 0;
    await w.say("hello from the group", { group: true });
    assert.deepEqual(prompts(w.rw.server), []);
    assert.ok(w.rw.server.calls.every(([, path]) => !path.includes("/remote-agents")));
  }));

test("test_a_remote_button_clicked_in_a_group_is_not_active_there", () =>
  routed(async (w) => {
    // A live permission request, its card on screen: its own Allow button is what is pressed in the group.
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.ask(sid, "act-1", "Edit", [{ optionId: "allow_once", name: "Allow once", kind: "allow_once" }]);
    };
    const sid = await attachedThroughRouter(w, script);
    await w.r.router.handle(message("add a line to the README")); // (the turn now waits for the answer)
    await w.rw.until(() => w.rw.permissionCards().length > 0);
    const actions = (w.rw.permissionCards()[0]?.["actions"] ?? []) as Record<string, unknown>[];
    const allow = actions.find((a) => (a["data"] as Record<string, unknown>)["option_id"] === "allow_once") ?? {};
    const data = allow["data"] as Record<string, unknown>;
    assert.equal(data["session_id"], sid);
    await w.r.router.handle(clickOf(String(data["primusclaw"]), data, { group: true, card: "card-9" }));
    assert.equal(w.rw.last(), "That button is not active any more.");
    assert.deepEqual(w.rw.server.commandsOf("decision"), []);
    // (the same button in the 1:1 chat is live: the group's press was refused for being in a group)
    await w.r.router.handle(clickOf(String(data["primusclaw"]), data, { card: "card-9" }));
    await w.rw.until(() => w.rw.server.commandsOf("decision").length === 1);
  }));

test("test_unlinking_stops_everything_that_reads_with_the_key", () =>
  routed(async (w) => {
    const script = new Script();
    script.onPrompt = async (srv, sid) => {
      await srv.say(sid, "busy");
    };
    await attachedThroughRouter(w, script);
    await w.r.router.handle(message("long"));
    await w.rw.until(() => w.rw.progressTexts().some((t) => t.includes("busy")));
    assert.ok(w.rw.remote.busyChats().length > 0);
    await w.r.router.handle(message("/unlink"));
    await w.rw.until(() => w.rw.remote.busyChats().length === 0);
    assert.deepEqual(w.r.revoked, ["ak-alice"]);
    assert.equal(w.attachedSession(), null);
    assert.equal(w.rw.test.store.remoteState.getRemote("aad-a"), null);
    assert.equal(w.r.store.links.getKey("aad-a"), null);
  }));
