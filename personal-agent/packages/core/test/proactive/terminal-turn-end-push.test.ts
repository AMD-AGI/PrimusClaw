// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Claw's push for a turn that ended in a terminal while nobody was at it (`terminal_turn_end`, claw/packages/api/src/assistant/
 * remote-items.ts): what reaches the chat, as words (nothing to answer), whatever session the chat is attached to.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, at, shown, world } from "../../../../test-support/assistant/proactive-world.js";
import type { JsonObject } from "../../src/json.js";

/** Claw's push as U1 and U2 of claw/packages/api/test/remote-terminal-turn-ends.test.ts store it. */
function endSay(kind: "done" | "error", eventId: string, text: string): JsonObject {
  return {
    type: "assistant.say",
    event_id: eventId,
    text,
    fallback: true,
    item: { item_id: "wi-7", seq: 7, title: "dev-pod Claude Code：修 CI", board_state: "done" },
    remote: { kind, session_id: "th-1", machine: "dev-pod", agent: "claude-sessions", tool: "claude" },
  };
}

it("a terminal's turn that ended while nobody was there is said in its own words, with the mute command, in a chat attached elsewhere too", async () => {
  // Claw's push for a `terminal_turn_end` (claw/packages/api/test/remote-terminal-turn-ends.test.ts U1, U2): kind done or error,
  // on the conversation's terminal-hook session, filed under its item, with no ask.
  const w = world({ now: at(12) });
  w.proactive.showsAttached = true;
  // The chat follows another session: the connector never posts an end for a conversation a chat follows.
  w.store.remoteState.attachRemote(ALICE, {
    sessionId: "rs-another",
    connectorId: "c1",
    agentId: "claude",
    agentLabel: "Claude Code",
    host: "dev-pod",
    cwd: "/home/me/a",
  });
  const push = (event: JsonObject) => w.proactive.handle(ALICE, w.reference, event);
  const done =
    "#7 dev-pod 上终端里的 Claude Code（修 CI，work/claw）做完了，之后终端那边一直没人操作。\n它最后说：\n全部测试通过。\n（不想再收到这个会话的推送：/approvals mute #7）";
  assert.equal(await push(endSay("done", "say-end", done)), "delivered");
  const failed =
    "#7 Claude Code in a terminal on dev-pod (fix CI, work/claw) stopped with an error (rate_limit); nobody has typed in that terminal since.\n(To stop hearing from this conversation: /approvals mute #7)";
  assert.equal(await push(endSay("error", "say-end-err", failed)), "delivered");
  const said = shown(w.surface.outbox).join("\n");
  assert.ok(said.includes("全部测试通过。"), said);
  assert.ok(said.includes("/approvals mute #7"), said);
  assert.ok(said.includes("stopped with an error (rate_limit)"), said);
  // Words, not a card: nothing to answer, so nothing is stored as a request waiting here.
  assert.equal(w.store.remotePermissions.getRemotePermission("th-1", "say-end"), null);
});
