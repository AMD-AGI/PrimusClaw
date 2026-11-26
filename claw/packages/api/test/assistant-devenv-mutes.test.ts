// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Mutes and session counts as the router reads them (`assistant/devenv-tools.ts`), on a real Postgres with the production schema.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 *
 * 2026-11-26 03:21: the user muted one conversation and asked "我静音的只是clean这一个会话吧？". devenv_list carried no mute, so the router
 * said it could not tell; and it gave one machine's sessions as "共 8 个会话，列出 8 个，其中 1 个未列出的另算".
 *
 *   MU1 devenv_list gives every conversation the user muted (muted_conversations: machine, id, title now, label, since), and each
 *       session says muted (with since when); a conversation muted under an older title is named by its title now; one the machine
 *       no longer reports keeps the title it had; another user's mutes are never listed; ids are compared without case
 *   MU1b a muted conversation held by a session open through Claw is named by that session's title and label
 *   MU2 a machine with more sessions than its agents card shows says how many are listed: session_count = sessions_listed + sessions_not_shown
 *   MU3 the router is told to answer mutes and counts from these fields, never "cannot tell"
 *   MU4 `mutedConversations` (what `/approvals` says): each muted conversation with its machine, its name now, since when and its
 *       item; nothing of anyone else's
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
type Recorded = Record<string, any>;

describe("devenv_list mutes and counts", { skip }, () => {
  let w: World;
  let store: typeof import("../src/remote-agents/store.js");
  let inbound: typeof import("../src/assistant/inbound.js");
  let devenv: typeof import("../src/assistant/devenv-tools.js");
  let prompts: typeof import("../src/assistant/prompts.js");

  before(async () => {
    w = await startWorld({ CLAW_REMOTE_AGENTS_ENABLED: "true", CLAW_ASSISTANT_TOOLS: "on", CLAW_ASSISTANT_ATTENDED_TTL_SEC: "600" });
    store = await import("../src/remote-agents/store.js");
    inbound = await import("../src/assistant/inbound.js");
    devenv = await import("../src/assistant/devenv-tools.js");
    prompts = await import("../src/assistant/prompts.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_remote_terminal_mutes, claw_remote_events, claw_remote_commands, claw_remote_sessions, claw_remote_agents,
      claw_remote_connectors, claw_tasks, claw_assistants, claw_sessions, claw_assistant_messages, claw_remote_audit CASCADE`);
  });

  const now = () => Math.floor(Date.now() / 1000);
  async function machine(owner: string, name: string, resumable: Recorded[]): Promise<string> {
    const row = await store.registerConnector(owner, name, "0.3.4", null, 10);
    assert.ok(row);
    await store.recordHeartbeat(row.connector_id, owner, {
      version: "0.3.4", cmdCursor: null,
      agents: [{ agent_id: "claude-sessions", kind: "attach", name: "Claude Code (existing sessions)", capabilities: { resumable, watch_live: true, terminal_input: true } }],
    });
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [row.connector_id]);
    return String(row.connector_id);
  }
  const conv = (n: number, title: string, state: "live" | "idle", ago: number) =>
    ({ ref: `a0000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title, cwd: "/home/u", updated_at: now() - ago, state, typed: true });
  async function mute(owner: string, cid: string, ref: string, title: string, agoMin: number): Promise<void> {
    await w.q(
      "INSERT INTO claw_remote_terminal_mutes (owner_user_id, connector_id, ref, title, muted_at) VALUES ($1, $2, $3, $4, NOW() - make_interval(mins => $5::int))",
      [owner, cid, ref, title, agoMin],
    );
  }
  async function userTurn(u: { routerSid: string; userId: string }, content: string): Promise<Claims> {
    const turn = await w.routerTurn(u);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, $3, 'Alice A', $4, $5::jsonb, $6::jsonb, NOW())`,
      [u.routerSid, turn.mid, u.userId, content, JSON.stringify({ kind: "person" }),
        JSON.stringify(inbound.parseChannelContext({ channel: "teams", channel_message_id: `m-${turn.mid}` }))],
    );
    return turn;
  }

  test("MU1 devenv_list carries each muted conversation and each session's mute, from Claw's own record", async () => {
    const alice = await w.user("alice");
    const clean = conv(1, "clean", "live", 30);
    const hosting = conv(2, "hosting", "live", 60);
    const blog = conv(3, "blog", "idle", 90);
    const pod = await machine("alice", "yihan-dev-pod", [clean, hosting, blog]);
    // Muted from its item, whose title was not the conversation's (the 03:21 row says "yihan" for the conversation titled "clean").
    await mute("alice", pod, clean.ref, "yihan", 1);
    // One the machine no longer reports.
    await mute("alice", pod, "a0000000-0000-4000-8000-000000000099", "an old one", 600);
    const bobBox = await machine("bob", "bob-box", [conv(7, "bob's", "live", 10)]);
    await mute("bob", bobBox, conv(7, "x", "live", 0).ref, "bob's", 1);

    const out = await devenv.devenvList(await userTurn(alice, "我静音的只是clean这一个会话吧？"));
    const rows = out.machines[0]!.sessions;
    assert.deepEqual(rows.map((s) => [s.title, s.muted, typeof s.muted_since]),
      [["clean", true, "string"], ["hosting", false, "undefined"], ["blog", false, "undefined"]]);
    assert.deepEqual(out.muted_conversations.map((m) => [m.machine, m.id, m.title, m.label]), [
      ["yihan-dev-pod", clean.ref, "clean", rows[0]!.label],
      ["yihan-dev-pod", "a0000000-0000-4000-8000-000000000099", "an old one", null],
    ]);
    assert.equal(out.muted_conversations[0]!.muted_since, rows[0]!.muted_since);
    assert.ok(Date.parse(out.muted_conversations[0]!.muted_since) > Date.parse(out.muted_conversations[1]!.muted_since), "newest first");
    assert.ok(!JSON.stringify(out).includes("bob"), "another user's mutes are never listed");
    assert.match(out.note, /muted_conversations is every conversation the user muted/);
    assert.match(out.note, /Never say you cannot see or tell whether one is muted/);

    // Nothing muted: an empty list, every session false.
    await w.q("TRUNCATE claw_remote_terminal_mutes");
    const none = await devenv.devenvList(await userTurn(alice, "我静音了哪些会话？"));
    assert.deepEqual(none.muted_conversations, []);
    assert.ok(none.machines[0]!.sessions.every((s) => s.muted === false));

    // A mute stored with the id in another case is the same conversation (ids are compared without case).
    await mute("alice", pod, clean.ref.toUpperCase(), "yihan", 1);
    const upper = await devenv.devenvList(await userTurn(alice, "clean 静音了吗？"));
    assert.deepEqual(upper.machines[0]!.sessions.map((s) => [s.title, s.muted]), [["clean", true], ["hosting", false], ["blog", false]]);
    assert.deepEqual(upper.muted_conversations.map((m) => [m.title, m.label]), [["clean", upper.machines[0]!.sessions[0]!.label]]);
  });

  test("MU1b a muted conversation held by a session open through Claw is named by the title and label of that session", async () => {
    const alice = await w.user("alice");
    const clean = { ...conv(1, "clean", "idle", 30), state: "attached" };
    const pod = await machine("alice", "yihan-dev-pod", [clean, conv(2, "hosting", "live", 60)]);
    const made = await store.createSession({ owner: "alice", client: null, connectorId: pod, agentId: "claude-sessions", cwd: "/home/u", mode: null, maxActive: 10, commandsPerMinute: 1000 });
    assert.equal(made.status, "created");
    const sid = (made as { session: Recorded }).session.session_id as string;
    await w.q("DELETE FROM claw_remote_commands WHERE session_id = $1", [sid]);
    await store.ingestEvents({ connector_id: pod, owner_user_id: "alice" },
      [{ index: 0, session_id: sid, seq: 1, type: "session_started", ts: Date.now(), data: { acp_session_id: clean.ref } }]);
    await mute("alice", pod, clean.ref, "yihan", 1);
    const out = await devenv.devenvList(await userTurn(alice, "我静音的只是clean这一个会话吧？"));
    const chat = out.machines[0]!.sessions.find((s) => s.opened_in === "chat")!;
    assert.deepEqual([chat.id, chat.title, chat.muted], [sid, "clean", true]);
    assert.deepEqual(out.muted_conversations.map((m) => [m.id, m.title, m.label]), [[clean.ref, "clean", chat.label]]);
  });

  test("MU2 a machine whose card shows only some sessions says how many are listed, and the counts add up", async () => {
    const alice = await w.user("alice");
    // Seven open in a terminal: the card shows five of them (CARD_RESUMABLE_SHOWN), so two are not listed.
    const list = Array.from({ length: 7 }, (_, i) => conv(i + 1, `t${i + 1}`, "live", (i + 1) * 10));
    await machine("alice", "yihan-dev-pod", list);
    const out = await devenv.devenvList(await userTurn(alice, "我的开发机上有几个会话？"));
    const m = out.machines[0]!;
    assert.deepEqual([m.session_count, m.sessions_listed, m.sessions_not_shown, m.sessions.length], [7, 5, 2, 5]);
    assert.equal(m.session_count, m.sessions_listed! + m.sessions_not_shown!);
    assert.match(out.note, /sessions_listed is how many are listed, and session_count = sessions_listed \+ sessions_not_shown/);
    // The whole machine asked for by name: all listed, no counts needed.
    const one = await devenv.devenvList(await userTurn(alice, "yihan-dev-pod 上的会话都列出来"), { machine: "yihan-dev-pod" });
    assert.equal(one.machines[0]!.sessions.length, 7);
    assert.equal(one.machines[0]!.sessions_not_shown, undefined);
  });

  test("MU4 mutedConversations names each muted conversation as the router does, and lists only the user's own", async () => {
    await w.user("alice");
    const clean = conv(1, "clean", "live", 30);
    const pod = await machine("alice", "yihan-dev-pod", [clean, conv(2, "hosting", "live", 60)]);
    await mute("alice", pod, clean.ref, "yihan", 1);
    await mute("alice", pod, "a0000000-0000-4000-8000-000000000099", "an old one", 600);
    const bobBox = await machine("bob", "bob-box", [conv(7, "bob's", "live", 10)]);
    await mute("bob", bobBox, conv(7, "x", "live", 0).ref, "bob's", 1);

    const out = await devenv.mutedConversations("alice");
    assert.deepEqual(out.map((m) => [m.item, m.machine, m.title]), [
      [null, "yihan-dev-pod", "clean"], // (the title it has now, not the one it was muted under; no item of it is left to name it by)
      [null, "yihan-dev-pod", "an old one"], // (one the machine no longer reports keeps the title it had)
    ]);
    assert.deepEqual(Object.keys(out[0]!).sort(), ["item", "machine", "muted_since", "title"]);
    assert.ok(Date.parse(out[0]!.muted_since) > Date.parse(out[1]!.muted_since), "newest first");
    assert.deepEqual((await devenv.mutedConversations("bob")).map((m) => [m.machine, m.title]), [["bob-box", "bob's"]]);
    assert.deepEqual(await devenv.mutedConversations("carol"), []);
  });

  test("MU3 the router answers mutes and counts from devenv_list, never 'cannot tell'", () => {
    const section = prompts.renderRouterDevenvSection({ actions: true, send: true });
    assert.match(section, /Muted conversations \(静音/);
    assert.match(section, /muted_conversations is every conversation the user muted/);
    assert.match(section, /Never say you cannot see or tell mutes/);
    assert.match(section, /\/approvals mute #<item>/);
    assert.match(section, /session_count in all, sessions_listed listed, sessions_not_shown not listed/);
    assert.equal(prompts.ROUTER_DEVENV_PROMPT_VERSION, "router-devenv-v17");
  });
});
