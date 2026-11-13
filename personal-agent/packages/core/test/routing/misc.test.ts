// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Single tests of other Python modules that test the router (plugins, log hygiene, the plain route's attached state). */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonObject, Logger, LogFields } from "@primusclaw/personal-agent";

import type { AssistantRouteRequest } from "../../src/routing/features.js";
import { ALICE, BOB } from "./fixtures.js";
import { clickOf, link, message, said, world } from "./world.js";

test("test_a_session_made_with_another_plugin_is_kept_and_records_the_new_plugin", async () => {
  const w = world({ config: { pluginId: "2" } });
  link(w, ALICE.id, "ak-alice");
  w.store.sessions.setSession(ALICE.id, { sessionId: "old-session", pluginId: "5" });
  await w.router.handle(message("multibranch progress?"));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [["send", "ak-alice", "old-session", "multibranch progress?"]]);
  assert.ok(!said(w).some((t) => t.includes("new session")));
  assert.equal(w.store.sessions.getSession(ALICE.id), "old-session");
  assert.equal(w.store.sessions.getSessionPlugin(ALICE.id), "2");
});

test("a session made without the plugin is replaced, and the person is told why", async () => {
  const w = world({ config: { pluginId: "2" } });
  link(w, ALICE.id, "ak-alice");
  w.store.sessions.setSession(ALICE.id, { sessionId: "plain", pluginId: "" });
  await w.router.handle(message("hi"));
  await w.router.settled();
  assert.deepEqual(w.turns.calls, [["create", "ak-alice", "hi"]]);
  assert.equal(said(w)[0], "Starting a new session so I can use the Primus platform tools.");
});

function recording(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger: Logger = {
    debug: (m: string, f?: LogFields) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
    info: (m: string, f?: LogFields) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
    warn: (m: string, f?: LogFields) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
    error: (m: string, f?: LogFields) => lines.push(`${m} ${JSON.stringify(f ?? {})}`),
    child: () => logger,
  };
  return { logger, lines };
}

const MESSAGE_MARK = "MSG-7f3a";
const SAFE_KEY = "ak-EXAMPLEsafekeyvalue000000000000000000000000";
const PASTED_KEY = "sk-EXAMPLE-pastedkey000000000000";

test("test_an_ordinary_message_and_its_answer_are_not_logged (the router's lines)", async () => {
  const w = world();
  const { logger, lines } = recording();
  Object.assign(w.deps, { logger });
  link(w, ALICE.id, SAFE_KEY);
  w.turns.answers = ["ANSWER-91c2 here is the plan"];
  await w.router.handle(message(`${MESSAGE_MARK} what is the plan`));
  await w.router.settled();
  assert.ok(said(w).some((t) => t.includes("ANSWER-91c2")));
  assert.ok(lines.length > 0);
  for (const mark of [MESSAGE_MARK, "ANSWER-91c2", SAFE_KEY]) assert.ok(!lines.join("\n").includes(mark), mark);
});

test("test_a_message_that_holds_credentials_is_not_logged (the router's lines)", async () => {
  const w = world();
  const { logger, lines } = recording();
  Object.assign(w.deps, { logger });
  link(w, ALICE.id, SAFE_KEY);
  w.turns.fail = true;
  await w.router.handle(message(`${MESSAGE_MARK} my key is ${PASTED_KEY}`));
  await w.router.settled();
  await w.router.handle(clickOf("mystery", { secret: PASTED_KEY }));
  for (const mark of [MESSAGE_MARK, PASTED_KEY, SAFE_KEY]) assert.ok(!lines.join("\n").includes(mark), mark);
});

test("test_someone_the_assistant_does_not_understand_also_tells_it_which_session (#455)", async () => {
  const routed: AssistantRouteRequest[] = [];
  const attached = { session_id: "rs-7", phase: "attached" } as JsonObject;
  const w = world({
    assistant: { on: () => true, route: (r) => (routed.push(r), Promise.resolve(true)) },
    remote: { enabled: true, chatContext: () => Promise.resolve(attached) },
  });
  link(w, ALICE.id, "ak");
  await w.router.handle(message("这个聊天现在连着哪个会话？"));
  assert.deepEqual(routed[0]?.attached, attached);
});

test("test_by_the_plain_route_a_chat_attached_to_nothing_says_so_and_a_worker_without_remote_agents_says_nothing (#455)", async () => {
  const routed: AssistantRouteRequest[] = [];
  const on = world({
    assistant: { on: () => true, route: (r) => (routed.push(r), Promise.resolve(true)) },
    remote: { enabled: true, chatContext: () => Promise.resolve(null) },
  });
  link(on, ALICE.id, "ak");
  await on.router.handle(message("这个聊天现在连着哪个会话？"));
  assert.ok(routed[0] !== undefined && "attached" in routed[0] && routed[0].attached === null);
  const off = world({ assistant: { on: () => true, route: (r) => (routed.push(r), Promise.resolve(true)) } });
  link(off, ALICE.id, "ak");
  await off.router.handle(message("还连着吗"));
  assert.ok(routed[1] !== undefined && !("attached" in routed[1]));
});

test("test_link_codes_and_the_keys_they_carry_are_not_logged (the router's lines and security events)", async () => {
  const w = world();
  const { logger, lines } = recording();
  const events: string[] = [];
  Object.assign(w.deps, {
    logger,
    securityEvent: (name: string, fields: object) => events.push(`${name} ${JSON.stringify(fields)}`),
  });
  const code = w.store.links.stashPending(SAFE_KEY);
  await w.router.handle(message("/link WRONG222", { id: "w1" }));
  await w.router.handle(message(`/link ${code.toLowerCase()}`, { id: "ok" }));
  await w.router.handle(message(`/link ${code}`, { user: BOB, id: "replay" })); // (single use: refused)
  assert.equal(w.store.links.getKey(ALICE.id), SAFE_KEY);
  assert.equal(w.store.links.getKey(BOB.id), null);
  const logged = [...lines, ...events].join("\n");
  for (const mark of [SAFE_KEY, code, code.toLowerCase(), "WRONG222"]) assert.ok(!logged.includes(mark), mark);
});
