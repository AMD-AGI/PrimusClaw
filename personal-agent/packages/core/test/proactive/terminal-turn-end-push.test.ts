// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Claw's push for a turn that ended in a terminal while nobody was at it (`terminal_turn_end`, claw/packages/api/src/assistant/
 * remote-items.ts): its own card when Claw describes the end (`remote.end`), Claw's words otherwise (an older Claw), whatever session
 * the chat is attached to. Nothing to answer either way.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, at, shown, world } from "../../../../test-support/assistant/proactive-world.js";
import type { JsonObject } from "../../src/json.js";
import type { TerminalEndView } from "../../src/remote-view/terminal-end-view.js";

/** Claw's push as U1 and U2 of claw/packages/api/test/remote-terminal-turn-ends.test.ts store it. */
function endSay(kind: "done" | "error", eventId: string, text: string, end?: JsonObject): JsonObject {
  return {
    type: "assistant.say",
    event_id: eventId,
    text,
    fallback: true,
    item: { item_id: "wi-7", seq: 7, title: "dev-pod Claude Code：修 CI", board_state: "done" },
    remote: {
      kind,
      session_id: "th-1",
      machine: "dev-pod",
      agent: "claude-sessions",
      tool: "claude",
      ...(end ? { end } : {}),
    },
  };
}

const DONE =
  "【修 CI】做完了 · dev-pod · work/claw · 终端空闲 · #7\n全部测试通过。（全文见终端）\n接入：/agent attach 3f2a9c1e　静音：/approvals mute #7";
const FAILED =
  "[fix CI] stopped with an error (rate_limit) · dev-pod · work/claw · terminal idle · #7\nMute: /approvals mute #7";

function attachedElsewhere(w: ReturnType<typeof world>): void {
  // The chat follows another session: the connector never posts an end for a conversation a chat follows.
  w.store.remoteState.attachRemote(ALICE, {
    sessionId: "rs-another",
    connectorId: "c1",
    agentId: "claude",
    agentLabel: "Claude Code",
    host: "dev-pod",
    cwd: "/home/me/a",
  });
}

it("a terminal's turn that ended while nobody was there is its own card: which conversation, what it did, the rest on a tap, attach and mute", async () => {
  const w = world({ now: at(12) });
  w.proactive.showsAttached = true;
  attachedElsewhere(w);
  const push = (event: JsonObject) => w.proactive.handle(ALICE, w.reference, event);
  const end = {
    item_seq: 7,
    name: "修 CI",
    folder: "work/claw",
    summary: "全部测试通过。",
    full: "全部测试通过。\n\n改动：\n- 修了 [链接](https://evil.example) 的测试",
    more: true,
    attach: "/agent attach 3f2a9c1e",
  };
  assert.equal(await push(endSay("done", "say-end", DONE, end)), "delivered");
  const sent = w.surface.outbox.filter((r) => r.op === "send" || r.op === "post");
  assert.equal(sent.length, 1, shown(w.surface.outbox).join("\n"));
  const body = sent[0]?.message.body;
  assert.ok(body?.type === "view" && body.view.name === "terminalEnd");
  assert.equal(body.fallbackText, DONE);
  const model = body.view.model;
  assert.equal(model.title, "修 CI 做完了");
  assert.equal(model.where, "Claude Code · dev-pod · work/claw · 终端空闲 · #7");
  assert.equal(model.summary, "全部测试通过。");
  assert.match(model.full, /^全部测试通过。/);
  assert.doesNotMatch(model.full, /\]\(https:\/\/evil/, "no link is built from the agent's words");
  assert.deepEqual(model.buttons, [
    { title: "接入会话", command: "/agent attach 3f2a9c1e" },
    { title: "静音此会话", command: "/approvals mute #7" },
  ]);
  // Words, not a request: nothing is stored as waiting here.
  assert.equal(w.store.remotePermissions.getRemotePermission("th-1", "say-end"), null);
});

it("an end Claw describes with a command it may not put, or an item number that is none, never makes a card that runs something else", async () => {
  const w = world({ now: at(12) });
  const push = (event: JsonObject) => w.proactive.handle(ALICE, w.reference, event);
  const end = {
    item_seq: 7,
    name: "fix CI",
    folder: "work/claw",
    error: "rate_limit",
    summary: "",
    full: "",
    more: false,
  };
  assert.equal(
    await push(endSay("error", "say-err", FAILED, { ...end, attach: "/agent off robin-dev; /approvals off" })),
    "delivered",
  );
  const card = w.surface.outbox.find((r) => r.op === "send")?.message.body;
  assert.ok(card?.type === "view");
  const model = card.view.model as TerminalEndView;
  assert.equal(model.title, "fix CI stopped with an error (rate\\_limit)"); // (escaped for the card's markdown)
  assert.deepEqual(model.buttons, [{ title: "Mute this conversation", command: "/approvals mute #7" }]);
  // An item number that is none: no card, Claw's words.
  assert.equal(
    await push(endSay("error", "say-err-2", FAILED, { ...end, item_seq: "7; /approvals off" })),
    "delivered",
  );
  assert.ok(shown(w.surface.outbox).some((line) => line.includes("stopped with an error (rate_limit)")));
});

it("an end an older Claw sends without its description is said in Claw's words, in a chat attached elsewhere too", async () => {
  const w = world({ now: at(12) });
  w.proactive.showsAttached = true;
  attachedElsewhere(w);
  const push = (event: JsonObject) => w.proactive.handle(ALICE, w.reference, event);
  assert.equal(await push(endSay("done", "say-end", DONE)), "delivered");
  assert.equal(await push(endSay("error", "say-end-err", FAILED)), "delivered");
  const said = shown(w.surface.outbox).join("\n");
  assert.ok(said.includes("全部测试通过。"), said);
  assert.ok(said.includes("/approvals mute #7"), said);
  assert.ok(said.includes("stopped with an error (rate_limit)"), said);
  assert.equal(w.store.remotePermissions.getRemotePermission("th-1", "say-end"), null);
});
