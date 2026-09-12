// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Both A2A send paths mint sessions, and both must book the creation.
 *
 * `claw_api_session_created_total` is the rollout's answer to "is anything
 * creating sessions on this pod". A2A writes `claw_sessions` itself rather
 * than calling the standard create, so a counter only that route increments
 * reads as a quiet fleet while these two paths run.
 *
 * The count belongs after the admission transaction commits, not to the
 * statement: a send whose parent check throws rolls the insert back, and a send
 * to a session that already exists writes no row at all. Both are driven, since
 * "counted a session nothing backs" and "counted nothing" are different bugs.
 *
 * The NATS seam is this file's own exports, as in
 * `a2a-publish-failure-classes.test.ts`: `js` and `nc` are module bindings
 * `initNats` assigns, so a resolve hook points `routes/a2a.ts` here instead.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import test, { after, before, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { StringCodec } from "nats";

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

export const js = {
  async publish(): Promise<void> { /* the send succeeds; the count is the subject */ },
};

export const nc = {
  subscribe(_subject: string) {
    return {
      unsubscribe(): void { /* nothing to release */ },
      async *[Symbol.asyncIterator]() { /* no events on this connection */ },
    };
  },
};

const skip = postgresSkipReason();
const CREATED = "claw_api_session_created_total";
const CALLER = { userId: "u-a2a", userName: "u-a2a", roles: ["user"], platformKey: "pk", virtualKey: "vk" };
const EXISTING = "a2a-existing";

describe("every A2A send that mints a session books the creation", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;
  let registry: typeof import("../src/infra/metrics.js")["registry"];

  before(async () => {
    harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "8" });
    registry = (await import("../src/infra/metrics.js")).registry;
    const a2a = await import("../src/routes/a2a.js");
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = CALLER; });
    await a2a.registerA2ARoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });

  const query = (sql: string, params: unknown[] = []) => harness.app.db.db.query(sql, params);

  const clear = async () => {
    await query("DELETE FROM claw_tasks");
    await query("DELETE FROM claw_workspace_refs");
    await query("DELETE FROM claw_sessions WHERE user_id = 'a2a'");
  };

  const sessionCount = async () => Number(
    ((await query("SELECT COUNT(*)::int AS n FROM claw_sessions WHERE user_id = 'a2a'"))
      .rows[0] as { n: number }).n,
  );

  const okCreated = (text: string) => {
    for (const line of text.split("\n")) {
      if (line.startsWith(`${CREATED}{`) && line.includes('outcome="ok"')) {
        return Number(line.slice(line.lastIndexOf(" ") + 1));
      }
    }
    return 0;
  };

  async function moved(act: () => Promise<{ statusCode: number; body: string }>) {
    const before = okCreated(await registry.metrics());
    const res = await act();
    return { ok: okCreated(await registry.metrics()) - before, res };
  }

  const send = (message: unknown) => app.inject({
    method: "POST",
    url: "/a2a",
    headers: { "a2a-version": "1.0" },
    payload: {
      jsonrpc: "2.0", id: 1, method: "SendMessage",
      params: { message, configuration: { returnImmediately: true } },
    },
  });

  test("message/send that mints a new task session books one creation", async () => {
    await clear();
    const { ok, res } = await moved(() => send({
      messageId: "m-new", role: "user", parts: [{ text: "hello" }],
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(await sessionCount(), 1, "the send minted exactly one session");
    assert.equal(ok, 1);
  });

  test("message/send onto a session that already exists books nothing", async () => {
    await clear();
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id)
       VALUES ($1,'existing','a2a','claw','input_required','ctx-keep',$2)`,
      [EXISTING, `user:${CALLER.userId}`],
    );
    const { ok, res } = await moved(() => send({
      messageId: "m-existing", role: "user", parts: [{ text: "hello" }], taskId: EXISTING,
    }));
    assert.equal(res.statusCode, 200);
    assert.equal(await sessionCount(), 1, "the send reused the session it was given");
    assert.equal(ok, 0);
  });

  test("a minted A2A session names the message that gates it", async () => {
    // The same pairing the native create owes, on the surface that mints its
    // own sessions. `releaseSessionGateIfLastRun` matches on the marker once
    // ownership is enforced, and null matches nothing -- so without it the
    // completion of an A2A turn cannot hand the session back and the caller
    // polls a task that never leaves pending.
    await clear();
    await moved(() => send({ messageId: "m-gate", role: "user", parts: [{ text: "hello" }] }));

    const r = await query(
      "SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE user_id = 'a2a'",
    );
    const row = r.rows[0] as { agent_status: string; agent_gate_message_id: string | null };
    assert.equal(row.agent_status, "pending");
    assert.equal(row.agent_gate_message_id, "m-gate");
  });

  test("and so does one an existing session is gated for", async () => {
    // The update arm, which is the commoner one: a caller sending a second
    // message onto a task it already has.
    await clear();
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id)
       VALUES ($1,'existing','a2a','claw','input_required','ctx-keep',$2)`,
      [EXISTING, `user:${CALLER.userId}`],
    );

    await moved(() => send({
      messageId: "m-second", role: "user", parts: [{ text: "hello" }], taskId: EXISTING,
    }));

    const r = await query(
      "SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1",
      [EXISTING],
    );
    const row = r.rows[0] as { agent_status: string; agent_gate_message_id: string | null };
    assert.equal(row.agent_status, "pending");
    assert.equal(row.agent_gate_message_id, "m-second");
  });

  test("a resend the task already executed leaves the live turn's marker alone", async () => {
    // The duplicate is detected by `openA2ARun`, which runs after
    // `resolveSendTarget` has already written this message's marker -- on the
    // same transaction, so it commits. A resend of a finished message while a
    // later one is still running therefore renames the gate behind that run,
    // and its completion no longer matches: both turns end and the task polls
    // pending for ever. Nothing executed, so nothing may have moved.
    await clear();
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id, agent_gate_message_id)
       VALUES ($1,'existing','a2a','claw','pending','ctx-keep',$2,'m-live')`,
      [EXISTING, `user:${CALLER.userId}`],
    );
    // The execution that makes the resend a duplicate, and the live one the gate
    // is named after. Both are seeded because a marker naming no run at all is
    // a state production does not produce -- the restore treats one as stale
    // and clears it, which is the case below this one.
    await query(
      `INSERT INTO claw_tasks (task_id, session_id, name, origin, executor, mode, status, metadata)
       VALUES ('ktsk-dup',$1,'chat','a2a','brain','llm','completed', jsonb_build_object('message_id','m-dup')),
              ('ktsk-live',$1,'chat','a2a','brain','llm','running', jsonb_build_object('message_id','m-live'))`,
      [EXISTING],
    );

    const res = await send({
      messageId: "m-dup", role: "user", parts: [{ text: "hello" }], taskId: EXISTING,
    });

    assert.equal(res.statusCode, 200);
    const r = await query(
      "SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1",
      [EXISTING],
    );
    const row = r.rows[0] as { agent_status: string; agent_gate_message_id: string | null };
    assert.equal(
      row.agent_gate_message_id, "m-live",
      "the running turn still owns the gate it has to release",
    );
    assert.equal(row.agent_status, "pending", "and nothing else about the session moved either");
  });

  test("the send that failed to publish puts back only the gate it still owns", async () => {
    // The rollback runs after its own transaction committed, so a later send
    // may already own the session by then. A snapshot is evidence about a
    // moment, not a claim on the row: restoring it over the newer owner takes
    // that turn's marker away, and its completion can no longer hand the gate
    // back.
    //
    // Asserted as "it goes through the one writer of the column" rather than by
    // quoting SQL. The ownership predicate now lives in
    // `applySessionGateTransition`, which has its own cases; a copy of its text
    // here would pin the caller to a spelling instead of to the rule, and would
    // go stale the next time the rule moves.
    const src = await readFile(
      new URL("../src/routes/a2a.ts", import.meta.url), "utf8",
    );
    const fn = src.slice(src.indexOf("async function restoreTouchedTarget"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /applySessionGateTransition\(/, "the restore goes through the one writer");
    assert.match(body, /intent: "restore"/, "under the intent whose rule this is");
    assert.match(body, /owner: target\.markerWritten/, "scoped to the marker this send wrote");
    assert.ok(
      !/UPDATE claw_sessions/.test(body),
      "and writes no statement of its own",
    );
  });

  test("a rollback does not reinstate a gate whose own send has already rolled back", async () => {
    // The chain the ownership check alone does not stop. A commits pending/A;
    // B commits pending/B and snapshots pending/A; both publishes fail. A rolls
    // back first, deletes its run, and declines to restore because B owns the
    // marker -- then B restores pending/A, naming a run that is no longer
    // there. No completion can release it, and the stale-session sweep does not
    // look at `pending`.
    //
    // Driven through the statement rather than two interleaved sends, which
    // this harness cannot hold open: the row is put in the exact state B's
    // rollback finds, and the restore is asked to run against it.
    await clear();
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id, agent_gate_message_id)
       VALUES ($1,'chain','a2a','claw','pending','ctx-keep',$2,'m-b')`,
      [EXISTING, `user:${CALLER.userId}`],
    );
    // A's run is gone: its own rollback deleted it.
    const { restoreForTest } = await import("../src/routes/a2a.js");

    await restoreForTest({
      taskId: EXISTING,
      contextId: "ctx-keep",
      created: false,
      markerWritten: "m-b",
      preImage: {
        agent_status: "pending",
        context_id: "ctx-keep",
        updated_at: new Date(),
        agent_gate_message_id: "m-a",
      },
    });

    const r = await query(
      "SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1",
      [EXISTING],
    );
    const row = r.rows[0] as { agent_status: string; agent_gate_message_id: string | null };
    assert.equal(
      row.agent_gate_message_id, null,
      "a marker whose turn no longer exists is cleared, not put back",
    );
  });

  test("but it does put back a marker whose turn is still there", async () => {
    // The positive control. Without it the case above holds just as well
    // against a restore that has stopped writing the marker at all.
    await clear();
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id, agent_gate_message_id)
       VALUES ($1,'chain','a2a','claw','pending','ctx-keep',$2,'m-b')`,
      [EXISTING, `user:${CALLER.userId}`],
    );
    await query(
      `INSERT INTO claw_tasks (task_id, session_id, name, origin, executor, mode, status, metadata)
       VALUES ('ktsk-live',$1,'chat','a2a','brain','llm','running', jsonb_build_object('message_id','m-a'))`,
      [EXISTING],
    );
    const { restoreForTest } = await import("../src/routes/a2a.js");

    await restoreForTest({
      taskId: EXISTING,
      contextId: "ctx-keep",
      created: false,
      markerWritten: "m-b",
      preImage: {
        agent_status: "pending",
        context_id: "ctx-keep",
        updated_at: new Date(),
        agent_gate_message_id: "m-a",
      },
    });

    const r = await query(
      "SELECT agent_gate_message_id FROM claw_sessions WHERE session_id = $1",
      [EXISTING],
    );
    assert.equal(
      (r.rows[0] as { agent_gate_message_id: string | null }).agent_gate_message_id, "m-a",
      "the predecessor still has a turn, so the gate goes back to it",
    );
  });

  test("a rollback hands the gate to whoever still owes a completion", async () => {
    // Not "whoever the snapshot named", and not "nobody". The snapshot's holder
    // may have completed while a later send held the marker -- its completion
    // was spent failing an ownership check -- so its row exists and owes
    // nothing. Meanwhile a third turn may be running and does owe one. The
    // marker has to name that one.
    await clear();
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id, agent_gate_message_id)
       VALUES ($1,'chain','a2a','claw','pending','ctx-keep',$2,'m-b')`,
      [EXISTING, `user:${CALLER.userId}`],
    );
    await query(
      `INSERT INTO claw_tasks (task_id, session_id, name, origin, executor, mode, status, metadata)
       VALUES ('ktsk-spent',$1,'chat','a2a','brain','llm','completed', jsonb_build_object('message_id','m-a')),
              ('ktsk-owing',$1,'chat','a2a','brain','llm','running',   jsonb_build_object('message_id','m-c'))`,
      [EXISTING],
    );
    const { restoreForTest } = await import("../src/routes/a2a.js");

    await restoreForTest({
      taskId: EXISTING, contextId: "ctx-keep", created: false, markerWritten: "m-b",
      preImage: {
        agent_status: "pending", context_id: "ctx-keep",
        updated_at: new Date(), agent_gate_message_id: "m-a",
      },
    });

    const r = await query(
      "SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1",
      [EXISTING],
    );
    const row = r.rows[0] as { agent_status: string; agent_gate_message_id: string | null };
    assert.equal(
      row.agent_gate_message_id, "m-c",
      "the running turn owes the completion, so the gate is named after it",
    );
    assert.equal(row.agent_status, "pending", "and the session stays gated for it");
  });

  test("and opens the gate only when nothing owes one", async () => {
    // The other half. With the snapshot's holder spent and no other turn live,
    // there is no completion coming, so a gated status would wait for ever.
    await clear();
    await query(
      `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id, agent_gate_message_id)
       VALUES ($1,'chain','a2a','claw','pending','ctx-keep',$2,'m-b')`,
      [EXISTING, `user:${CALLER.userId}`],
    );
    await query(
      `INSERT INTO claw_tasks (task_id, session_id, name, origin, executor, mode, status, metadata)
       VALUES ('ktsk-spent',$1,'chat','a2a','brain','llm','completed', jsonb_build_object('message_id','m-a'))`,
      [EXISTING],
    );
    const { restoreForTest } = await import("../src/routes/a2a.js");

    await restoreForTest({
      taskId: EXISTING, contextId: "ctx-keep", created: false, markerWritten: "m-b",
      preImage: {
        agent_status: "pending", context_id: "ctx-keep",
        updated_at: new Date(), agent_gate_message_id: "m-a",
      },
    });

    const r = await query(
      "SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1",
      [EXISTING],
    );
    const row = r.rows[0] as { agent_status: string; agent_gate_message_id: string | null };
    assert.equal(row.agent_gate_message_id, null, "a completed row owes nothing, so it is not put back");
    assert.equal(row.agent_status, "idle", "and the gated status does not outlive the gate");
  });

  test("legacy invoke books the creation for the session it mints", async () => {
    await clear();
    const { ok, res } = await moved(() => app.inject({
      method: "POST", url: "/invoke", payload: { question: "hello" },
    }));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(await sessionCount(), 1);
    assert.equal(ok, 1);
  });
});
