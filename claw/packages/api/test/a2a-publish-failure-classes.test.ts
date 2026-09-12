// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which publish failures may delete an A2A row, and which may only cancel it.
 *
 * A `PubAck` that never arrives does not mean the bytes never arrived. Only a
 * refusal that proves the message was never stored -- `NoResponders` -- lets the
 * request undo its own writes; a timeout, a closed or draining connection, any
 * unrecognised code and anything that is not a `NatsError` at all leave the
 * execution possibly live, so the row moves to `cancelling` and the session is
 * left exactly as the send wrote it. Deleting the accounting for work that may
 * be running is bounded by nothing.
 *
 * This file is also the NATS seam: `js` and `nc` are module bindings `initNats`
 * assigns, so a resolve hook points `routes/a2a.ts` at this module's exports
 * instead. The hook must be registered before `routes/a2a.js` loads, and the
 * admission cluster must set the environment before either -- `config.ts` reads
 * `ADMIT_*` once -- so both imports are dynamic and ordered inside `before`.
 *
 * The injected failure is scoped to `tasks.execute`: the cancel branch
 * publishes `tasks.{id}.cancel` through this same client, and that publish is
 * one of the things under test.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, before, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { ErrorCode, NatsError, StringCodec } from "nats";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const A2A_MODULE = new URL("../src/routes/a2a.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === A2A_MODULE && specifier === "../infra/nats.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const sc = StringCodec();

const published: Array<{ subject: string; payload: string }> = [];
let publishFailure: { subject: string; err: unknown } | null = null;

export const js = {
  async publish(subject: string, payload: Uint8Array): Promise<void> {
    if (publishFailure?.subject === subject) throw publishFailure.err;
    published.push({ subject, payload: new TextDecoder().decode(payload) });
  },
};

/**
 * `handleSendStreamingMessage` subscribes outside any try and before the
 * publish, so without this the streaming cases die on an undefined `nc` and
 * answer 500 for a reason that has nothing to do with compensation.
 */
export const nc = {
  subscribe(_subject: string) {
    return {
      unsubscribe(): void { /* nothing to release */ },
      async *[Symbol.asyncIterator]() { /* no events on this connection */ },
    };
  },
};

const publishedTo = (subject: string) => published.filter((m) => m.subject === subject);

const skip = postgresSkipReason();

const CALLER = { userId: "u-a2a", userName: "u-a2a", roles: ["user"], platformKey: "pk", virtualKey: "vk" };

const TASK_SUBJECT = "tasks.execute";
const EXISTING = "a2a-parented";
const PARENT = "a2a-parent";

/**
 * The classes §4.14 calls ambiguous: the row is cancelled, never deleted.
 *
 * The last three are not `NatsError`s. Nothing promises that a publish only
 * ever rejects with one -- a codec, an interceptor or a client upgrade can
 * raise anything -- and an error class this code cannot read says nothing
 * about whether the stream stored the message.
 */
const CANCEL_CLASSES: Array<[label: string, err: unknown]> = [
  ["Timeout", new NatsError("TIMEOUT", ErrorCode.Timeout)],
  ["ConnectionClosed", new NatsError("CONNECTION_CLOSED", ErrorCode.ConnectionClosed)],
  ["ConnectionDraining", new NatsError("CONNECTION_DRAINING", ErrorCode.ConnectionDraining)],
  ["an unrecognised code", new NatsError("BOOM", "NOT_A_REAL_NATS_CODE")],
  ["a plain Error", new Error("socket hang up")],
  ["a TypeError from the client", new TypeError("payload is not a Uint8Array")],
  ["a thrown non-Error", "publish exploded"],
];

interface Ctx {
  harness: AdmissionCluster;
  app: FastifyInstance;
}

const rpc = (ctx: Ctx, method: string, params: unknown) => ctx.app.inject({
  method: "POST",
  url: "/a2a",
  headers: { "a2a-version": "1.0" },
  payload: { jsonrpc: "2.0", id: 1, method, params },
});

const send = (ctx: Ctx, message: unknown) =>
  rpc(ctx, "SendMessage", { message, configuration: { returnImmediately: true } });

const streamSend = (ctx: Ctx, message: unknown) => rpc(ctx, "SendStreamingMessage", { message });

const invoke = (ctx: Ctx) =>
  ctx.app.inject({ method: "POST", url: "/invoke", payload: { question: "hello" } });

const errorOf = (raw: string) => (JSON.parse(raw) as { error?: { message?: string } }).error?.message;

const query = (ctx: Ctx, sql: string, params: unknown[] = []) =>
  ctx.harness.app.db.db.query(sql, params);

const clear = async (ctx: Ctx) => {
  await query(ctx, "DELETE FROM claw_tasks");
  await query(ctx, "DELETE FROM claw_workspace_refs");
  await query(ctx, "DELETE FROM claw_sessions WHERE user_id = 'a2a'");
  published.length = 0;
  publishFailure = null;
};

const rowFor = async (ctx: Ctx, sessionId: string) => (await query(
  ctx,
  `SELECT task_id, status, origin, metadata->>'message_id' AS message_id
     FROM claw_tasks WHERE session_id = $1`,
  [sessionId],
)).rows[0] as { task_id: string; status: string; origin: string; message_id: string } | undefined;

const sessionFor = async (ctx: Ctx, sessionId: string) => (await query(
  ctx,
  `SELECT agent_status, context_id, parent_session_id, team_role
     FROM claw_sessions WHERE session_id = $1`,
  [sessionId],
)).rows[0] as {
  agent_status: string; context_id: string;
  parent_session_id: string | null; team_role: string | null;
} | undefined;

const heldRefs = async (ctx: Ctx, sessionId: string, taskId: string) => (await query(
  ctx,
  `SELECT ref_kind, ref_id FROM claw_workspace_refs
    WHERE released_at IS NULL
      AND ((ref_kind = 'session' AND ref_id = $1) OR (ref_kind = 'run' AND ref_id = $2))`,
  [sessionId, taskId],
)).rows as Array<{ ref_kind: string; ref_id: string }>;

/** A caller-owned target that already has a parent and a team role to lose. */
const arrangeParented = async (ctx: Ctx, err: unknown) => {
  await clear(ctx);
  await query(
    ctx,
    `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status)
     VALUES ($1,'parent','a2a','claw','idle')`,
    [PARENT],
  );
  await query(
    ctx,
    `INSERT INTO claw_sessions
       (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id,
        parent_session_id, team_role)
     VALUES ($1,'parented','a2a','claw','input_required','ctx-keep',$2,$3,'researcher')`,
    [EXISTING, `user:${CALLER.userId}`, PARENT],
  );
  publishFailure = { subject: TASK_SUBJECT, err };
};

const assertCancelled = async (ctx: Ctx, sessionId: string, taskId: string) => {
  assert.deepEqual(await heldRefs(ctx, sessionId, taskId), [], "no workspace reference is left held");
  assert.equal(publishedTo(TASK_SUBJECT).length, 0, "the execute publish is the one that failed");
  const cancels = publishedTo(`tasks.${sessionId}.cancel`);
  assert.equal(cancels.length, 1, "a possibly-live execution is told to stop");
  assert.deepEqual(JSON.parse(cancels[0].payload), { type: "cancel", session_id: sessionId });
};

const assertParentedTargetKept = async (ctx: Ctx, messageId: string) => {
  const row = await rowFor(ctx, EXISTING);
  assert.ok(row, "the counted row is not deleted");
  assert.equal(row.status, "cancelling", "cancelling, not cancelled and not left preparing");
  assert.equal(row.origin, "a2a");
  assert.equal(row.message_id, messageId, "the execution identity survives");

  const session = await sessionFor(ctx, EXISTING);
  assert.ok(session, "the session is not deleted");
  assert.equal(session.agent_status, "pending", "the send's own write stands; nothing is restored");
  assert.equal(session.context_id, "ctx-keep");
  assert.equal(session.parent_session_id, PARENT, "a non-null parent link survives");
  assert.equal(session.team_role, "researcher");

  await assertCancelled(ctx, EXISTING, row.task_id);
};

/** `message/send`: the JSON-RPC reply carries the failure and the target survives. */
function registerSendCases(ctx: () => Ctx): void {
  for (const [label, err] of CANCEL_CLASSES) {
    test(`${label} on message/send leaves the row cancelling and the parented session untouched`, async () => {
      const c = ctx();
      await arrangeParented(c, err);
      const messageId = `m-send-${label}`;

      const res = await send(c, { messageId, role: "user", parts: [{ text: "hello" }], taskId: EXISTING });

      assert.equal(res.statusCode, 200);
      assert.equal(errorOf(res.body), "Failed to create task");
      await assertParentedTargetKept(c, messageId);
    });
  }
}

/** `message/stream`: the same compensation, answered without opening an SSE stream. */
function registerStreamCases(ctx: () => Ctx): void {
  for (const [label, err] of CANCEL_CLASSES) {
    test(`${label} on message/stream cancels the row without opening a stream`, async () => {
      const c = ctx();
      await arrangeParented(c, err);
      const messageId = `m-stream-${label}`;

      const res = await streamSend(
        c, { messageId, role: "user", parts: [{ text: "hello" }], taskId: EXISTING },
      );

      assert.equal(res.statusCode, 500);
      assert.equal(errorOf(res.body), "Failed to create task");
      assert.equal(
        res.headers["content-type"]?.toString().includes("text/event-stream"), false,
        "the failure is answered over the ordinary JSON-RPC reply",
      );
      await assertParentedTargetKept(c, messageId);
    });
  }
}

/** The legacy entry, whose target is a session the request itself minted. */
function registerLegacyInvokeCases(ctx: () => Ctx): void {
  for (const [label, err] of CANCEL_CLASSES) {
    test(`${label} on legacy invoke cancels the row and keeps the session it minted`, async () => {
      const c = ctx();
      await clear(c);
      publishFailure = { subject: TASK_SUBJECT, err };

      const res = await invoke(c);

      assert.equal(res.statusCode, 500);
      assert.deepEqual(JSON.parse(res.body), { success: false, error: "Failed to process request" });

      const rows = await query(c, "SELECT session_id, task_id, status, origin FROM claw_tasks");
      assert.equal(rows.rowCount, 1, "the counted row is not deleted");
      const row = rows.rows[0] as { session_id: string; task_id: string; status: string; origin: string };
      assert.equal(row.status, "cancelling");
      assert.equal(row.origin, "a2a");

      const session = await sessionFor(c, row.session_id);
      assert.ok(session, "the session the request minted is not deleted");
      assert.equal(session.agent_status, "pending");

      await assertCancelled(c, row.session_id, row.task_id);
    });
  }
}

/** The one refusal that proves nothing was stored, and may therefore delete. */
function registerNoRespondersCases(ctx: () => Ctx): void {
  test("NoResponders on message/send deletes the row and restores the parented target", async () => {
    const c = ctx();
    await arrangeParented(c, new NatsError("no responders", ErrorCode.NoResponders));
    const messageId = "m-send-noresponders";

    const res = await send(c, { messageId, role: "user", parts: [{ text: "hello" }], taskId: EXISTING });

    assert.equal(res.statusCode, 200);
    assert.equal(errorOf(res.body), "Failed to create task");
    assert.equal(await rowFor(c, EXISTING), undefined, "a refusal that stored nothing undoes the row");

    const session = await sessionFor(c, EXISTING);
    assert.ok(session, "an existing target is restored, never deleted");
    assert.equal(session.agent_status, "input_required", "the pre-image is written back");
    assert.equal(session.context_id, "ctx-keep");
    assert.equal(session.parent_session_id, PARENT);
    assert.equal(session.team_role, "researcher");
    assert.deepEqual(await heldRefs(c, EXISTING, ""), []);
    assert.equal(publishedTo(`tasks.${EXISTING}.cancel`).length, 0, "nothing is running to cancel");
  });

  test("NoResponders on legacy invoke deletes the session the request minted", async () => {
    const c = ctx();
    await clear(c);
    publishFailure = {
      subject: TASK_SUBJECT, err: new NatsError("no responders", ErrorCode.NoResponders),
    };

    const res = await invoke(c);

    assert.equal(res.statusCode, 500);
    assert.equal((await query(c, "SELECT 1 FROM claw_tasks")).rowCount, 0);
    assert.equal((await query(c, "SELECT 1 FROM claw_sessions WHERE user_id = 'a2a'")).rowCount, 0);
    assert.equal(published.length, 0, "the delete branch publishes no cancel");
  });
}

describe("an ambiguous A2A publish failure cancels the row and deletes nothing", { skip }, () => {
  const ctx = {} as Ctx;

  before(async () => {
    ctx.harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "8" });
    const a2a = await import("../src/routes/a2a.js");
    ctx.app = Fastify();
    ctx.app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = CALLER; });
    await a2a.registerA2ARoutes(ctx.app);
    await ctx.app.ready();
  });
  after(async () => {
    await ctx.app?.close();
    await ctx.harness?.stop();
  });

  registerSendCases(() => ctx);
  registerStreamCases(() => ctx);
  registerLegacyInvokeCases(() => ctx);
  registerNoRespondersCases(() => ctx);
});
