// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A quarantine notice against a real JetStream server: told once, even when a
 * publish reached the stream and its acknowledgement did not.
 *
 * Each event of the notice (tasks/pending-quarantine.ts) goes out under a
 * stable id, and a retry publishes the one whose acknowledgement was lost under
 * that id again. Only the server's duplicate window makes the second publish a
 * no-op, so this is measured against nats-server itself, not a stand-in: the
 * event stream is first created the way a deployed cluster has it, with the
 * server's default two-minute window, the API's own start-up reconciles it, and
 * the retry comes after those two minutes, at the cadence the sweeper retries.
 *
 * The drain is the real one, on a real Postgres: the poison is a turn larger
 * than the server's `max_payload`, refused by the real client, and every
 * publish goes to the real streams. The one thing replaced is the outcome of a
 * single event publish: it is sent for real, then reported as a timeout.
 *
 * Coverage:
 *   J1 start-up widens a deployed event stream's duplicate window past the
 *      notice retry horizon
 *   J2 a notice event stored without an acknowledgement and retried after the
 *      server's default window is stored once
 *   J3 with the streams unavailable for longer than every bound -- the drain's
 *      count and window, the notice's attempts and its horizon -- a good queued
 *      message is not quarantined and is sent once they are back, and the
 *      poison's notice is given, once, then too
 *
 * Skipped without DATABASE_URL and CLAW_CHAOS_NATS_SERVER, and a skip is not a
 * pass: the rolling-restart CI job sets both and checks the pass count.
 */
process.env.PENDING_DRAIN_MAX_FAILURES = "2";
process.env.PENDING_DRAIN_FAILURE_WINDOW_SEC = "0";
process.env.NATS_REPLICAS = "1";

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "nats";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { freePort, Proc, sleep, until } from "./chaos-harness.js";

const NATS_SERVER = process.env.CLAW_CHAOS_NATS_SERVER;
const skip = postgresSkipReason()
  || (NATS_SERVER ? false : "CLAW_CHAOS_NATS_SERVER is not set, so there is no JetStream server to measure");
const SESSION = "s-jetstream-poison";
const USER = "u-jetstream-poison";
const RUNNING_TURN = "m-running";
/** NATS's default `duplicate_window`, what a stream created without one has. */
const SERVER_DEFAULT_WINDOW_NS = 2 * 60 * 1e9;

describe("a quarantine notice against JetStream", { skip }, () => {
  let dir: string;
  let server: Proc;
  let probe: NatsConnection;
  let h: AdmissionCluster;
  let nats: typeof import("../src/infra/nats.js");
  let dispatch: typeof import("../src/tasks/pending-dispatch.js");
  let quarantine: typeof import("../src/tasks/pending-quarantine.js");

  const rows = async (text: string, params: unknown[] = []) =>
    (await h.app.db.db.query(text, params)).rows as Array<Record<string, any>>;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "claw-quarantine-js-"));
    const port = await freePort();
    server = new Proc("nats", NATS_SERVER!, ["-js", "-a", "127.0.0.1", "-p", String(port), "-sd", join(dir, "js")], {
      cwd: dir, env: process.env, log: join(dir, "nats.log"),
    });
    process.env.NATS_URL = `nats://127.0.0.1:${port}`;
    probe = await until("nats-server", async () => {
      try { return await connect({ servers: process.env.NATS_URL }); } catch { return null; }
    }, 20_000);

    // The event stream as a deployed cluster has it: created by an API that
    // passed no duplicate window, so the server's default applies.
    const jsm = await probe.jetstreamManager();
    await jsm.streams.add({ name: "PRIMUS_CLAW_EVENTS", subjects: ["events.>"], max_age: 24 * 3600 * 1e9, num_replicas: 1 });
    assert.equal((await jsm.streams.info("PRIMUS_CLAW_EVENTS")).config.duplicate_window, SERVER_DEFAULT_WINDOW_NS,
      "the deployed shape, or J1 proves nothing");

    h = await startAdmissionCluster({ RUN_DOORBELL_DISPATCH: "false" });
    nats = await import("../src/infra/nats.js");
    dispatch = await import("../src/tasks/pending-dispatch.js");
    quarantine = await import("../src/tasks/pending-quarantine.js");
    await nats.initNats();
    (await import("../src/events/consumer.js")).tombstoneReader.has = async () => false;
    await rows(`INSERT INTO resources (name, type, image, resource) VALUES ('default', 'default', 'img:1', '{"cpu":"1"}'::jsonb)`);
  });

  after(async () => {
    await probe?.close().catch(() => {});
    await nats?.nc?.close().catch(() => {});
    await h?.stop();
    await server?.stop("SIGTERM", 10_000);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("J1 start-up widens the deployed event stream's duplicate window past the notice retry horizon", async () => {
    const jsm = await probe.jetstreamManager();
    const window = (await jsm.streams.info(nats.EVENT_STREAM)).config.duplicate_window;
    assert.equal(window, nats.EVENT_STREAM_DUPLICATE_WINDOW_MS * 1e6);
    assert.ok(window >= 2 * quarantine.QUARANTINE_NOTICE_RETRY_HORIZON_SEC * 1e9,
      "every retry starts inside the horizon, and the window covers it twice over");
  });

  test("J2 a notice event stored without an acknowledgement, retried after the default window, is stored once", async () => {
    await rows(
      `INSERT INTO claw_sessions (session_id, user_id, agent_status, agent_gate_message_id) VALUES ($1, $2, 'running', $3)`,
      [SESSION, USER, RUNNING_TURN],
    );
    await rows(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata, input, prompt, queued_at, started_at)
       VALUES ('run-running', $1, 'chat', 'running', 'chat', 'brain', $2::jsonb, '{}'::jsonb, 'first', NOW(), NOW())`,
      [SESSION, JSON.stringify({ message_id: RUNNING_TURN, user_id: USER, dispatch: "fat" })],
    );
    const submit = await import("../src/sessions/submit-message.js");
    const secrets = await import("../src/tasks/run-secrets.js");
    const enqueue = async (content: string) => (await submit.insertPendingMessage(h.app.db.db, {
      sessionId: SESSION, content, userId: USER, toolIds: [],
      secrets: secrets.pendingSecretColumns({ llmKey: "vk", platformKey: "pk", userEnv: {}, doorbell: false }),
      sessionEnv: {},
    })).id!;
    const maxPayload = probe.info!.max_payload;
    const poisonId = await enqueue("p".repeat(maxPayload + 10));
    await enqueue("the message behind it");
    const messageId = `claw-pending-${poisonId}`;

    // The reply reaches the stream; its acknowledgement does not.
    const realPublish = dispatch.pendingDispatchPorts.publishSessionEvent;
    let lost = false;
    dispatch.pendingDispatchPorts.publishSessionEvent = async (sessionId, event, msgId) => {
      await realPublish(sessionId, event, msgId);
      if (!lost && event.type === "AssistantMessage" && event.message_id === messageId) {
        lost = true;
        throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
      }
    };
    try {
      const consumer = await import("../src/events/consumer.js");
      const sweeper = await import("../src/tasks/sweeper.js");
      await consumer.consumeEventDelivery({
        subject: `events.${SESSION}`,
        data: nats.sc.encode(JSON.stringify({
          type: "exec_complete", session_id: SESSION, task_id: "run-running", user_id: USER,
          message_id: RUNNING_TURN, prompt: "first", final_text: "done", failed: false, error_count: 0, skills_used: {},
        })),
        seq: 1,
        ack: () => {},
        nak: () => {},
      });
      await sweeper.drainOrphanedPendingMessages();
      assert.ok(lost, "the reply was published and its acknowledgement lost");
      let [held] = await rows("SELECT notified_at, notice_events, last_error FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
      assert.ok(held, "the poison was quarantined by the real drain");
      assert.match(held.last_error, /MAX_PAYLOAD_EXCEEDED/, "refused by the real client");
      assert.equal(held.notified_at, null);
      assert.equal(held.notice_events, 0, "an unacknowledged publish is not counted as out");

      // The sweeper's retry, after the server's default window has passed.
      await sleep(SERVER_DEFAULT_WINDOW_NS / 1e6 + 5_000);
      assert.equal(await quarantine.retryQuarantineNotices(), 1);
      [held] = await rows("SELECT notified_at, notice_events FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
      assert.ok(held.notified_at);
      assert.equal(held.notice_events, 3);
    } finally {
      dispatch.pendingDispatchPorts.publishSessionEvent = realPublish;
    }

    // What the stream holds for the message, read back from the server.
    const jsm = await probe.jetstreamManager();
    const state = (await jsm.streams.info(nats.EVENT_STREAM)).state;
    const stored: Record<string, number> = {};
    for (let seq = state.first_seq; seq <= state.last_seq; seq++) {
      const m = await jsm.streams.getMessage(nats.EVENT_STREAM, { seq }).catch(() => null);
      if (!m || m.subject !== `events.${SESSION}`) continue;
      const event = m.json<Record<string, unknown>>();
      if (event.message_id === messageId) stored[String(event.type)] = (stored[String(event.type)] ?? 0) + 1;
    }
    assert.deepEqual(stored, { AssistantMessage: 1, ResultMessage: 1, exec_complete: 1 },
      "the user is told once");
  });

  test("J3 streams unavailable past every bound: the good message waits and is sent, the poison's notice is given once", async () => {
    const session = "s-jetstream-outage";
    const running = "m-outage-running";
    await rows(
      `INSERT INTO claw_sessions (session_id, user_id, agent_status, agent_gate_message_id) VALUES ($1, $2, 'running', $3)`,
      [session, USER, running],
    );
    await rows(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata, input, prompt, queued_at, started_at)
       VALUES ('run-outage', $1, 'chat', 'running', 'chat', 'brain', $2::jsonb, '{}'::jsonb, 'first', NOW(), NOW())`,
      [session, JSON.stringify({ message_id: running, user_id: USER, dispatch: "fat" })],
    );
    const submit = await import("../src/sessions/submit-message.js");
    const secrets = await import("../src/tasks/run-secrets.js");
    const consumer = await import("../src/events/consumer.js");
    const sweeper = await import("../src/tasks/sweeper.js");
    const enqueue = async (content: string) => (await submit.insertPendingMessage(h.app.db.db, {
      sessionId: session, content, userId: USER, toolIds: [],
      secrets: secrets.pendingSecretColumns({ llmKey: "vk", platformKey: "pk", userEnv: {}, doorbell: false }),
      sessionEnv: {},
    })).id!;
    const poisonId = await enqueue("p".repeat(probe.info!.max_payload + 10));
    const goodId = await enqueue("the message behind it");
    const poisonMessage = `claw-pending-${poisonId}`;
    const goodMessage = `claw-pending-${goodId}`;

    // JetStream stops answering for both streams the API publishes to: what a
    // lost stream leader looks like to a client, a 503 from the real server.
    const jsm = await probe.jetstreamManager();
    const configs = await Promise.all([nats.EVENT_STREAM, nats.TASK_STREAM].map(async (n) => (await jsm.streams.info(n)).config));
    for (const c of configs) await jsm.streams.delete(c.name);
    const refusal = await nats.js.publish(`events.${session}`, nats.sc.encode("{}")).then(() => null, (e) => e);
    assert.ok(nats.natsUnreachable(refusal) && nats.publishCertainlyFailed(refusal),
      `the real client's refusal is the one the code classifies: ${refusal?.name}:${refusal?.code}`);

    await consumer.consumeEventDelivery({
      subject: `events.${session}`,
      data: nats.sc.encode(JSON.stringify({
        type: "exec_complete", session_id: session, task_id: "run-outage", user_id: USER,
        message_id: running, prompt: "first", final_text: "done", failed: false, error_count: 0, skills_used: {},
      })),
      seq: 100,
      ack: () => {},
      nak: () => {},
    });
    await sweeper.drainOrphanedPendingMessages();
    let [held] = await rows("SELECT notified_at, notice_events, notice_unsure_since FROM claw_pending_messages_quarantine WHERE id = $1", [poisonId]);
    assert.ok(held, "the poison was quarantined by the real drain");
    assert.equal(held.notified_at, null, "its notice could not be published");
    assert.equal(held.notice_unsure_since, null, "and stored nothing");

    // Twenty minutes and more of it, compressed: the drain's sweeps, and the
    // notice's retries a minute apart, past its attempts and its horizon.
    for (let i = 0; i < 40; i++) {
      await rows(
        `UPDATE claw_pending_messages_quarantine
            SET quarantined_at = quarantined_at - INTERVAL '61 seconds',
                notice_claimed_at = notice_claimed_at - INTERVAL '61 seconds'
          WHERE id = $1`,
        [poisonId],
      );
      await rows(
        "UPDATE claw_pending_messages SET drain_first_failed_at = drain_first_failed_at - INTERVAL '61 seconds' WHERE id = $1",
        [goodId],
      );
      await sweeper.drainOrphanedPendingMessages();
      assert.equal(await quarantine.retryQuarantineNotices(), 0);
    }
    const [queued] = await rows("SELECT drain_failures, drain_last_error FROM claw_pending_messages WHERE id = $1", [goodId]);
    assert.ok(queued, "the good message is still queued, not quarantined");
    assert.equal(queued.drain_failures, 0);
    assert.match(queued.drain_last_error, /NatsError:503/);
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages_quarantine WHERE id = $1", [goodId])).length, 0);
    [held] = await rows(
      "SELECT notified_at, notice_attempts, EXTRACT(EPOCH FROM NOW() - quarantined_at)::int AS age FROM claw_pending_messages_quarantine WHERE id = $1",
      [poisonId],
    );
    assert.equal(held.notified_at, null);
    assert.ok(held.age > quarantine.QUARANTINE_NOTICE_RETRY_HORIZON_SEC, "past the horizon");
    assert.ok(held.notice_attempts < 10, "and the refused attempts did not use up the notice's");

    // The streams are back.
    for (const c of configs) await jsm.streams.add(c);
    await rows("UPDATE claw_pending_messages_quarantine SET notice_claimed_at = notice_claimed_at - INTERVAL '61 seconds' WHERE id = $1", [poisonId]);
    assert.equal(await quarantine.retryQuarantineNotices(), 1, "the user is told");
    await sweeper.drainOrphanedPendingMessages();
    assert.equal((await rows("SELECT 1 FROM claw_pending_messages WHERE session_id = $1", [session])).length, 0,
      "and the good message is sent");

    // What the streams hold, read back from the server.
    const stored: Record<string, number> = {};
    const tasks: string[] = [];
    for (const name of [nats.EVENT_STREAM, nats.TASK_STREAM]) {
      const state = (await jsm.streams.info(name)).state;
      for (let seq = state.first_seq; seq <= state.last_seq && state.messages > 0; seq++) {
        const m = await jsm.streams.getMessage(name, { seq }).catch(() => null);
        if (!m) continue;
        const body = m.json<Record<string, unknown>>();
        if (name === nats.EVENT_STREAM && body.message_id === poisonMessage) {
          stored[String(body.type)] = (stored[String(body.type)] ?? 0) + 1;
        }
        if (name === nats.TASK_STREAM && body.session_id === session) tasks.push(String(body.message_id));
      }
    }
    assert.deepEqual(stored, { AssistantMessage: 1, ResultMessage: 1, exec_complete: 1 }, "the notice, once");
    assert.deepEqual(tasks, [goodMessage], "the good message, once");
  });
});
