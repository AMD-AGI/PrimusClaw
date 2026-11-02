// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An assistant deployment on a real Postgres: the production schema (`initDb` with the assistant on), real
 * users, sessions, run rows and queues, and nothing faked but what leaves the process (the drain that would
 * start a turn, the session event, the delivery kick).
 *
 * `turn()` opens a live turn the way the dispatcher leaves one: a run row that is running, a session gate
 * naming the turn, and the bearer a turn of that role would have been given.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { startAdmissionCluster, type AdmissionCluster } from "./admission-cluster.js";

export const TOKEN_KEY = "assistant-test-token-key-0123456789abcdef";

export interface Claims {
  sid: string; role: "router" | "worker"; item_id?: string; gen?: number; mid: string; task_id: string; exp: number;
}

export type World = Awaited<ReturnType<typeof startWorld>>;

export async function startWorld(env: Record<string, string> = {}) {
  const h: AdmissionCluster = await startAdmissionCluster({
    CLAW_ASSISTANT_ENABLED: "true",
    CLAW_ASSISTANT_TOKEN_KEY: TOKEN_KEY,
    CLAW_NOTIFICATIONS_ENABLED: "true",
    CLAW_DEPLOY_MODE: "safe",
    ...env,
  });
  const q = async (text: string, params: unknown[] = []) =>
    (await h.app.db.db.query(text, params)).rows as Array<Record<string, any>>;

  const mod = {
    tools: await import("../../src/assistant/tools.js"),
    reports: await import("../../src/assistant/reports.js"),
    messages: await import("../../src/assistant/messages.js"),
    turnEnd: await import("../../src/assistant/turn-end.js"),
    role: await import("../../src/assistant/role-profile.js"),
    silent: await import("../../src/assistant/silent-sweep.js"),
    runStarted: await import("../../src/assistant/run-started.js"),
    assistant: await import("../../src/assistant/assistant.js"),
    workItems: await import("../../src/assistant/work-items.js"),
    submit: await import("../../src/sessions/submit-message.js"),
    outbound: await import("../../src/assistant/outbound.js"),
    outbox: await import("../../src/notifications/outbox.js"),
    token: await import("../../src/assistant/token.js"),
    sweeper: await import("../../src/tasks/sweeper.js"),
    consumer: await import("../../src/events/consumer.js"),
    crypto: await import("../../src/crypto/user-env.js"),
  };
  mod.crypto.initUserEnvCrypto();

  /** The queue drains this world was asked to start, instead of starting turns. */
  const drains: Array<{ sessionId: string; userId: string }> = [];
  const realDrain = mod.submit.submitMessagePorts.drainOldestPendingMessage;
  mod.submit.submitMessagePorts.drainOldestPendingMessage = async (sessionId: string, userId: string) => {
    drains.push({ sessionId, userId });
  };

  /** What `recordAssistantSay` announced: the web client's event, and the delivery kick. */
  const events: Array<Record<string, any>> = [];
  let kicks = 0;
  const sayDeps = {
    publishSessionEvent: async (_sid: string, e: Record<string, unknown>) => { events.push(e); },
    kick: async () => { kicks += 1; },
  };

  async function user(userId: string): Promise<{ userId: string; routerSid: string }> {
    const { sessionId } = await mod.assistant.getOrCreateAssistant(userId);
    // What the user's own message stamps; the assistant has none until it has had one.
    await q(
      `UPDATE claw_sessions SET config = config || $2::jsonb WHERE session_id = $1`,
      [sessionId, JSON.stringify({ platform_key: `pk-${userId}`, llm_api_key: `vk-${userId}`, _server_managed_credentials: true })],
    );
    return { userId, routerSid: sessionId };
  }

  let runNo = 0;
  /** A run row that is running, and the session held by it. */
  async function openRun(sessionId: string, opts: { taskId?: string; messageId?: string; status?: string } = {}) {
    runNo += 1;
    const taskId = opts.taskId ?? `ktsk_test_${runNo}_${randomUUID().slice(0, 8)}`;
    const messageId = opts.messageId ?? `claw-test-${runNo}`;
    await q(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, input, metadata, depends_on, created_at, queued_at)
       VALUES ($1, $2, 'chat', $3, 'chat', 'brain', '{}'::jsonb, $4::jsonb, '{}', NOW(), NOW())`,
      [taskId, sessionId, opts.status ?? "running", JSON.stringify({ message_id: messageId })],
    );
    await q("UPDATE claw_sessions SET agent_status = 'running', agent_gate_message_id = $2 WHERE session_id = $1", [sessionId, messageId]);
    return { taskId, messageId };
  }

  async function closeRun(taskId: string, status: "completed" | "failed" | "cancelled" = "completed", failureReason?: string, agoSeconds = 3600) {
    await q(
      `UPDATE claw_tasks SET status = $2, failure_reason = $3, completed_at = NOW() - make_interval(secs => $4::int) WHERE task_id = $1`,
      [taskId, status, failureReason ?? null, agoSeconds],
    );
    const row = (await q("SELECT session_id FROM claw_tasks WHERE task_id = $1", [taskId]))[0];
    await q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [row.session_id]);
  }

  const claimsFor = (c: Omit<Claims, "exp"> & { exp?: number }): Claims => ({ ...c, exp: c.exp ?? Math.floor(Date.now() / 1000) + 600 });

  /** A live router turn of this user, with the claims its bearer would carry. */
  async function routerTurn(u: { routerSid: string }): Promise<Claims> {
    const run = await openRun(u.routerSid);
    return claimsFor({ sid: u.routerSid, role: "router", mid: run.messageId, task_id: run.taskId });
  }

  /** A live worker turn of the item, started the way the dispatcher starts one (`startWorkerRun`). */
  async function workerTurn(itemId: string): Promise<Claims> {
    const item = (await q("SELECT worker_session_id FROM claw_work_items WHERE item_id = $1", [itemId]))[0];
    const run = await openRun(item.worker_session_id);
    const started = await mod.runStarted.startWorkerRun(item.worker_session_id, run.taskId);
    assert.ok(started, "the session is not a worker session");
    return claimsFor({
      sid: item.worker_session_id, role: "worker", item_id: itemId, gen: started.generation, mid: run.messageId, task_id: run.taskId,
    });
  }

  /** An item the router created, by the tool that creates them. */
  async function createItem(u: { routerSid: string; userId: string }, title: string, brief = `do ${title}`): Promise<{ itemId: string; seq: number; workerSid: string }> {
    const turn = await routerTurn(u);
    const created = await mod.tools.workCreate(turn, { title, brief });
    await closeRun(turn.task_id);
    const row = (await q("SELECT worker_session_id FROM claw_work_items WHERE item_id = $1", [created.item_id]))[0];
    drains.length = 0;
    return { itemId: created.item_id, seq: created.seq, workerSid: row.worker_session_id };
  }

  const item = async (itemId: string) => (await q("SELECT * FROM claw_work_items WHERE item_id = $1", [itemId]))[0];
  const events_ = async (itemId: string) => (await q("SELECT * FROM claw_work_item_events WHERE item_id = $1 ORDER BY id", [itemId]));
  const pending = async (sessionId: string) => (await q("SELECT * FROM claw_pending_messages WHERE session_id = $1 ORDER BY id", [sessionId]));

  async function subscribe(userId: string, types = ["assistant.say", "work_item.needs_you"]): Promise<string> {
    const id = mod.outbox.newSubscriptionId();
    await q(
      `INSERT INTO claw_notification_subscriptions (subscription_id, owner_user_id, url, secret_enc, event_types, enabled)
       VALUES ($1, $2, 'https://hooks.example.com/claw', $3, $4::text[], true)`,
      [id, userId, mod.crypto.encryptUserEnvValue(`secret-${userId}`), types],
    );
    return id;
  }

  return {
    h, q, mod, drains, events, sayDeps, kicks: () => kicks, user, openRun, closeRun, routerTurn, workerTurn, createItem,
    item, itemEvents: events_, pending, subscribe,
    async stop() {
      mod.submit.submitMessagePorts.drainOldestPendingMessage = realDrain;
      await h.stop();
    },
  };
}
