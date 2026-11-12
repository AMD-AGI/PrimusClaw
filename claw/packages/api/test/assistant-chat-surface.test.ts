// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The chat app a message came through (`channel_context.channel`) as a router turn tells it apart: Teams has words and a rule of
 * its own; any other channel is said generically and gets the generic reply-style rule; a client that names none is the Teams worker.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CHAT_REPLY_RULE, chatSurface, DEFAULT_CHANNEL } from "../src/assistant/chat-surface.js";
import { chosenReplyLanguage, turnChannelTold } from "../src/assistant/inbound.js";
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

test("CS4 a turn's own message decides its channel, read beside its reply language; only a turn without one follows the latest", async () => {
  /** A session whose rows are `rows` (message id -> channel_context.channel, null for none), newest last; the statements run. */
  const run: string[] = [];
  const querier = (rows: Array<[string, string | null]>) => async (text: string, params?: unknown[]) => {
    run.push(text);
    assert.match(text, /^SELECT channel_context->>'reply_language' AS chosen, channel_context->>'channel' AS channel FROM /);
    if (text.endsWith("AND message_id = $2")) {
      const row = rows.find(([id]) => id === params?.[1]);
      return { rows: row ? [{ chosen: "en", channel: row[1] }] : [] } as never;
    }
    assert.match(text, /ORDER BY received_at DESC LIMIT 1$/); // (one row, as the reply language always read it)
    const latest = rows.at(-1);
    return { rows: latest ? [{ chosen: null, channel: latest[1] }] : [] } as never;
  };
  const channel = async (rows: Array<[string, string | null]>, messageId: string | null) =>
    chatSurface((await turnChannelTold(querier(rows), "s", messageId)).channel).channel;
  const rows: Array<[string, string | null]> = [["m1", "chatapp"], ["m2", null], ["m3", "teams"], ["m4", "chatapp"]];
  run.length = 0;
  assert.equal(await channel(rows, "m2"), "teams", "a message that names none is Teams'");
  assert.equal(run.length, 1, "a message's own row: one statement, by its key");
  assert.equal(await channel(rows, "m3"), "teams");
  assert.equal(await channel(rows, "m4"), "chatapp");
  assert.equal(await channel(rows, null), "chatapp", "a worker's report: the latest message's");
  assert.equal(await channel(rows, "gone"), "chatapp", "no row of its own: the latest message's");
  assert.equal(await channel([...rows, ["m5", null]], null), "teams", "a latest that names none");
  assert.equal(await channel([], null), "teams");
  // The reply language is what it was: read from the same row.
  assert.equal((await turnChannelTold(querier(rows), "s", "m4")).chosen, "en");
  assert.equal(await chosenReplyLanguage(querier(rows), "s", "m4"), "en");
});
