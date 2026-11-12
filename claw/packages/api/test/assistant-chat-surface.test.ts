// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The chat app a message came through (`channel_context.channel`) as a router turn tells it apart: Teams has words and a rule of
 * its own; any other channel is said generically and gets the generic reply-style rule; a client that names none is the Teams worker.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CHAT_REPLY_RULE, chatSurface, DEFAULT_CHANNEL, turnChatSurface } from "../src/assistant/chat-surface.js";
import { readToolsOfPlugin, ROUTER_RULES } from "../src/assistant/read-tools.js";
import { renderRouterReadSection } from "../src/assistant/prompts.js";

test("CS1 Teams, and a message that names no channel or an odd one, keep Teams' rule and words", () => {
  for (const named of [undefined, "", "teams", 7, "Teams", "x".repeat(40), "a b", "__proto__"]) {
    const surface = chatSurface(named);
    assert.equal(surface.channel, DEFAULT_CHANNEL, String(named));
    assert.deepEqual(surface.replyRules, ["teams-reply-style"]);
    assert.equal(surface.where, "in Teams");
  }
  assert.deepEqual(ROUTER_RULES, ["teams-reply-style"]);
});

test("CS2 another chat app is said generically and gets the generic reply-style rule", () => {
  for (const channel of ["slack", "chatapp", "web-chat"]) {
    assert.deepEqual(chatSurface(channel), { channel, where: "in the chat", replyRules: [CHAT_REPLY_RULE] });
  }
  const rows = [
    { id: 17, type: "rule", name: "teams-reply-style", config: {} },
    { id: 22, type: "rule", name: CHAT_REPLY_RULE, config: {} },
  ];
  assert.deepEqual(readToolsOfPlugin(9, rows).pluginTools.map((t: any) => t.id), [17]);
  assert.deepEqual(readToolsOfPlugin(9, rows, chatSurface("slack").replyRules).pluginTools.map((t: any) => t.id), [22]);
});

test("CS3 the GitHub line tells a person without GitHub to bind it where they talk to Clawy", () => {
  const shown = { servers: [], github: [], githubBinding: true };
  assert.match(renderRouterReadSection(shown), /sending \/github bind to Clawy in Teams \(/);
  const other = renderRouterReadSection({ ...shown, where: "in the chat" });
  assert.match(other, /sending \/github bind to Clawy in the chat \(/);
  assert.doesNotMatch(other, /Teams/);
});

test("CS4 a turn's own message decides its channel; only a turn with no message of the person's follows their latest one", async () => {
  /** A session whose rows are `rows` (message id -> channel_context.channel, null for none), newest last. */
  const querier = (rows: Array<[string, string | null]>) => async (text: string, params?: unknown[]) => {
    if (text.includes("message_id = $2")) {
      const row = rows.find(([id]) => id === params?.[1]);
      return { rows: row ? [{ channel: row[1] }] : [] } as never;
    }
    assert.match(text, /ORDER BY received_at DESC LIMIT 1$/); // (one row, as the reply language reads it)
    const latest = rows.at(-1);
    return { rows: latest ? [{ channel: latest[1] }] : [] } as never;
  };
  const rows: Array<[string, string | null]> = [["m1", "chatapp"], ["m2", null], ["m3", "teams"], ["m4", "chatapp"]];
  assert.equal((await turnChatSurface(querier(rows), "s", "m2")).channel, "teams", "a message that names none is Teams'");
  assert.equal((await turnChatSurface(querier(rows), "s", "m3")).channel, "teams");
  assert.equal((await turnChatSurface(querier(rows), "s", "m4")).channel, "chatapp");
  assert.equal((await turnChatSurface(querier(rows), "s", "report")).channel, "chatapp", "no message: the latest one's");
  assert.equal((await turnChatSurface(querier([...rows, ["m5", null]]), "s", "report")).channel, "teams", "one naming none");
  assert.equal((await turnChatSurface(querier([]), "s", "report")).channel, "teams");
});
