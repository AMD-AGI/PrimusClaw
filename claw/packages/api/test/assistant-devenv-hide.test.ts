// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `devenv_hide` (`assistant/devenv-tools.ts`): "除了 autopilot重构 和 blog 都隐藏" on the assistant, on a real Postgres with the production
 * schema. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   H1 keep: a card lists every other conversation as to be hidden and the one a process has open as not hidden; nothing is hidden
 *      until the person presses it; then the listing (and devenv_list) no longer has them; undo shows them again, by card
 *   H2 targets by name; disconnect closes the chat's own sessions on that machine (a close queued for each), after the card
 *   H3 a name that matches nothing, several machines with none named, and a turn with no message of the user's are refused
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const REFS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444"];
const ATTACH = {
  agent_id: "claude-sessions", kind: "attach", name: "Claude Code (existing sessions)",
  capabilities: { resumable: [
    { ref: REFS[0], title: "autopilot重构", cwd: "/w", updated_at: 4, state: "idle" },
    { ref: REFS[1], title: "blog", cwd: "/w", updated_at: 3, state: "live", input: "terminal" },
    { ref: REFS[2], title: "数字1到400逐行列出", cwd: "/w", updated_at: 2, state: "idle" },
    { ref: REFS[3], title: "pwd 与 ls -la 目录查看", cwd: "/w", updated_at: 1, state: "unknown" },
  ] },
};

describe("devenv_hide", { skip }, () => {
  let w: World;
  let store: typeof import("../src/remote-agents/store.js");
  let tools: typeof import("../src/assistant/devenv-tools.js");
  let schedules: typeof import("../src/assistant/schedules.js");
  let inbound: typeof import("../src/assistant/inbound.js");

  before(async () => {
    w = await startWorld({ CLAW_REMOTE_AGENTS_ENABLED: "true", CLAW_ASSISTANT_TOOLS: "on", CLAW_ASSISTANT_ATTENDED_TTL_SEC: "600",
      CLAW_TRIGGERS_ENABLED: "true", CLAW_TRIGGER_TOOLS_ENABLED: "true", CLAW_TRIGGER_TOOLS_TOKEN_KEY: "trigger-tools-test-key-0123456789abcdef" });
    store = await import("../src/remote-agents/store.js");
    tools = await import("../src/assistant/devenv-tools.js");
    schedules = await import("../src/assistant/schedules.js");
    inbound = await import("../src/assistant/inbound.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_remote_events, claw_remote_commands, claw_remote_sessions, claw_remote_agents, claw_remote_connector_transitions, claw_remote_connectors,
      claw_remote_hidden, claw_remote_audit, claw_work_items, claw_work_item_events, claw_tasks, claw_assistants, claw_sessions, claw_assistant_messages,
      claw_assistant_says, claw_assistant_confirmations, claw_notification_outbox, claw_notification_subscriptions CASCADE`);
  });

  async function machine(owner: string, name: string): Promise<string> {
    const row = await store.registerConnector(owner, name, "0.1.14", null, 10);
    assert.ok(row);
    await store.recordHeartbeat(row.connector_id, owner, { version: "0.1.14", cmdCursor: null, agents: [ATTACH] as never });
    await w.q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [row.connector_id]);
    return String(row.connector_id);
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
  const listedRefs = async (owner: string) =>
    ((await store.listConnectors(owner, 120_000))[0]!.agents[0].capabilities.resumable as Array<{ ref: string }>).map((r) => r.ref);
  const press = (confirmationId: unknown) => schedules.decideConfirmation({ userId: "alice", confirmationId: String(confirmationId), decision: "allow", via: "button" });
  /** The text of the newest card the user was shown. */
  const cardText = async () => String((await w.q("SELECT text FROM claw_assistant_says WHERE user_id = 'alice' ORDER BY created_at DESC LIMIT 1"))[0]?.text ?? "");

  test("H1 keep: the card says what is hidden and what is not; done only when pressed; undo shows them again", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    await machine("alice", "autopilot-devpod");
    const card = await tools.devenvHide(await userTurn(alice, "除了 autopilot重构 和 blog 都隐藏"), { keep: ["autopilot重构", "blog"] });
    assert.equal(card.done, false, JSON.stringify(card));
    assert.deepEqual([card.hide, card.show, card.disconnect, card.not_hidden_live], [2, 0, 0, []]);
    const text = await cardText();
    assert.match(text, /在 autopilot-devpod 上隐藏这些对话（不删除[^]*- 数字1到400逐行列出\n- pwd 与 ls -la 目录查看/);
    assert.doesNotMatch(text, /- autopilot重构|- blog/);
    assert.deepEqual(await listedRefs("alice"), REFS, "nothing hidden before the press");
    const done = await press(card.confirmation_id);
    assert.equal(done.status, "done", JSON.stringify(done));
    assert.deepEqual(await listedRefs("alice"), [REFS[0], REFS[1]]);
    // asking to hide the live one says it cannot be: a process has it open
    await assert.rejects(tools.devenvHide(await userTurn(alice, "把 blog 也隐藏"), { targets: ["blog"] }), (e: any) => e.code === "nothing_to_do" && /blog: a process has it open/.test(e.message));
    // undo, by card
    const back = await tools.devenvHide(await userTurn(alice, "显示隐藏的会话"), { undo: true });
    assert.deepEqual([back.hide, back.show], [0, 2]);
    assert.equal((await press(back.confirmation_id)).status, "done");
    assert.deepEqual(await listedRefs("alice"), REFS);
  });

  test("H2 targets by name, and disconnect closes the chat's own sessions there, after the card", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    const cid = await machine("alice", "autopilot-devpod");
    const made = await store.createSession({ owner: "alice", client: null, connectorId: cid, agentId: "claude-sessions", cwd: "/w", mode: null,
      resumeRef: REFS[1], maxActive: 5, commandsPerMinute: 60 });
    assert.equal(made.status, "created", JSON.stringify(made));
    const sid = String((made as { session: Record<string, unknown> }).session.session_id);
    const card = await tools.devenvHide(await userTurn(alice, "隐藏 数字1到400 那个，并断开手机连着的会话"), { targets: ["数字1到400"], disconnect: true });
    assert.deepEqual([card.hide, card.disconnect], [1, 1]);
    assert.equal((await press(card.confirmation_id)).status, "done");
    assert.deepEqual(await listedRefs("alice"), [REFS[0], REFS[1], REFS[3]]);
    const closes = await w.q("SELECT type FROM claw_remote_commands WHERE session_id = $1 AND type = 'close'", [sid]);
    assert.equal(closes.length, 1, "a close was queued for the chat's session");
  });

  test("H3 refused: a name that matches nothing, several machines with none named, a report's turn", async () => {
    const alice = await w.user("alice");
    await w.subscribe(alice.userId);
    await machine("alice", "autopilot-devpod");
    await assert.rejects(tools.devenvHide(await userTurn(alice, "隐藏 xyz"), { targets: ["没有这个名字"] }), (e: any) => e.code === "unknown_conversation");
    await machine("alice", "yihan-dev-pod");
    await assert.rejects(tools.devenvHide(await userTurn(alice, "隐藏 blog"), { targets: ["blog"] }), (e: any) => e.code === "which_machine");
    const report = await w.routerTurn(alice);
    await assert.rejects(tools.devenvHide(report, { machine: "autopilot-devpod", targets: ["blog"] }), (e: any) => e.code === "not_from_user");
  });
});
