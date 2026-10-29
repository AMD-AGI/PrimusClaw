// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The A2A server's context/task model (CLAW_A2A_CONTEXT_TASKS), driven through
 * the real routes against a real Postgres, with NATS replaced by this file's
 * own exports (a resolve hook, as in a2a-session-counter.test.ts).
 *
 *   contextId  a session, owned by the authenticated caller
 *   taskId     one run of it
 *
 * Coverage:
 *   C1 a context is a session of the caller's, a task is a run of it
 *   C2 a follow-up in a context is a conversation: the turns so far go to Brain
 *   C3 a context runs one task at a time, a resend is that task, a stranger's context is theirs
 *   C4 GetTask / ListTasks read the run, and only the caller's
 *   C5 a held call or a question is INPUT_REQUIRED, and a message with the taskId answers it
 *   C6 CancelTask stops the run and the task stays CANCELED
 *   C7 the stream: running, text, the request, the end
 *   C9 with the switch off the server is the one it was
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, before, beforeEach, describe } from "node:test";

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

interface Sent { subject: string; payload: Record<string, unknown> | string }
const executes: Sent[] = [];
const core: Sent[] = [];
type Feed = { push(event: Record<string, unknown>): void; end(): void; subject: string; unsubscribed: boolean };
const feeds: Feed[] = [];

export const js = {
  async publish(subject: string, data: Uint8Array): Promise<void> {
    executes.push({ subject, payload: JSON.parse(sc.decode(data)) });
  },
};

export const nc = {
  publish(subject: string, data?: Uint8Array): void {
    const text = data ? sc.decode(data) : "";
    core.push({ subject, payload: text.startsWith("{") ? JSON.parse(text) : text });
  },
  subscribe(subject: string) {
    const queue: Array<Uint8Array | null> = [];
    let wake: (() => void) | null = null;
    const feed: Feed = {
      subject,
      unsubscribed: false,
      push(event) { queue.push(sc.encode(JSON.stringify(event))); wake?.(); },
      end() { queue.push(null); wake?.(); },
    };
    feeds.push(feed);
    return {
      unsubscribe(): void { feed.unsubscribed = true; feed.end(); },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (!queue.length) await new Promise<void>((resolve) => { wake = resolve; });
          const next = queue.shift();
          if (next === null) return;
          yield { data: next as Uint8Array };
        }
      },
    };
  },
};

const skip = postgresSkipReason();

type Caller = { userId: string; userName: string; roles: string[]; platformKey: string; virtualKey: string };
const ALICE: Caller = { userId: "u-alice", userName: "alice", roles: ["default"], platformKey: "pk-a", virtualKey: "vk-a" };
const BOB: Caller = { userId: "u-bob", userName: "bob", roles: ["default"], platformKey: "pk-b", virtualKey: "vk-b" };

describe("the A2A context/task model", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;
  let who: Caller = ALICE;
  let seq = 0;

  before(async () => {
    harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "50", CLAW_A2A_CONTEXT_TASKS: "1" });
    const a2a = await import("../src/routes/a2a.js");
    app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as unknown as { user: unknown }).user = who;
    });
    await a2a.registerA2ARoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });
  beforeEach(() => {
    executes.length = 0;
    core.length = 0;
    feeds.length = 0;
    who = ALICE;
    process.env.CLAW_A2A_CONTEXT_TASKS = "1";
  });

  const query = (sql: string, params: unknown[] = []) => harness.app.db.db.query(sql, params);

  async function rpc(name: string, params: unknown, headers: Record<string, string> = {}) {
    const res = await app.inject({
      method: "POST", url: "/a2a", headers: { "a2a-version": "1.0", ...headers },
      payload: { jsonrpc: "2.0", id: ++seq, method: name, params },
    });
    return { status: res.statusCode, body: res.body, json: res.body.startsWith("{") ? JSON.parse(res.body) : null };
  }

  const msg = (text: string, extra: Record<string, unknown> = {}) => ({
    messageId: `m-${++seq}`, role: "ROLE_USER", parts: [{ text }], ...extra,
  });

  /** A send that returns at once, as the task it opened. */
  async function send(text: string, extra: Record<string, unknown> = {}) {
    const r = await rpc("SendMessage", { message: msg(text, extra), configuration: { returnImmediately: true } });
    return { ...r, task: r.json?.result?.task as { id: string; contextId: string; status: { state: string } } | undefined };
  }

  /** What Brain's events and the consumer leave behind. */
  async function event(sessionId: string, type: string, data: Record<string, unknown> = {}) {
    await query(
      "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, $3, $4)",
      [`ev-${++seq}`, sessionId, type, { type, ...data }],
    );
  }
  const sessionOf = async (taskId: string) =>
    String((await query("SELECT session_id FROM claw_tasks WHERE task_id = $1", [taskId])).rows[0].session_id);
  const finish = async (taskId: string, status = "completed") => {
    await query("UPDATE claw_tasks SET status = $2, completed_at = NOW() WHERE task_id = $1", [taskId, status]);
  };
  const said = (sessionId: string, text: string) => event(sessionId, "AssistantMessage", { data: { content: [{ type: "text", text }] } });
  const get = async (id: string, historyLength?: number) =>
    (await rpc("GetTask", { id, ...(historyLength === undefined ? {} : { historyLength }) })).json;

  describe("C1 a context is a session of the caller's, a task is a run of it", () => {
    test("a first message opens both, and the session belongs to the caller", async () => {
      const r = await send("hello");
      assert.ok(r.task, r.body);
      assert.equal(r.task.status.state, "TASK_STATE_SUBMITTED");
      const session = (await query(
        "SELECT user_id, a2a_caller_id, context_id, agent_status FROM claw_sessions WHERE context_id = $1", [r.task.contextId],
      )).rows[0] as Record<string, string>;
      assert.equal(session.user_id, "u-alice", "not the shared 'a2a' owner");
      assert.equal(session.a2a_caller_id, "user:u-alice");
      assert.equal(session.agent_status, "pending");
      const run = (await query("SELECT origin, session_id, status FROM claw_tasks WHERE task_id = $1", [r.task.id])).rows[0] as Record<string, string>;
      assert.equal(run.origin, "a2a");
      assert.match(run.session_id, /^a2a-/);
      assert.notEqual(r.task.id, run.session_id, "the task is the run, not the session");
      const user = (await query(
        "SELECT event_id FROM claw_session_events WHERE session_id = $1 AND event = 'UserMessage'", [run.session_id],
      )).rows;
      assert.equal(user.length, 1, "the turn is in the transcript");
    });

    test("a contextId the caller names is the one used", async () => {
      const r = await send("hello", { contextId: "ctx-mine" });
      assert.equal(r.task?.contextId, "ctx-mine");
    });

    test("the payload Brain gets runs as the caller", async () => {
      await send("hello");
      const payload = executes.find((e) => e.subject === "tasks.execute")!.payload as Record<string, unknown>;
      assert.equal(payload.user_id, "u-alice");
      assert.deepEqual(payload.history, []);
    });

    test("a session an earlier version minted under the shared owner becomes the caller's", async () => {
      await query(
        `INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, context_id, a2a_caller_id)
         VALUES ('a2a-legacy-1', 'old', 'a2a', 'claw', 'idle', 'ctx-legacy', 'user:u-alice')`,
      );
      const r = await send("again", { contextId: "ctx-legacy" });
      assert.ok(r.task, r.body);
      assert.equal((await query("SELECT user_id FROM claw_sessions WHERE session_id = 'a2a-legacy-1'")).rows[0].user_id, "u-alice");
    });
  });

  describe("C2 a follow-up in a context is a conversation", () => {
    test("the turns so far go to Brain as history, without the new prompt", async () => {
      const first = await send("what is a wavefront?", { contextId: "ctx-conv" });
      const sessionId = await sessionOf(first.task!.id);
      const { recordCompletionTurns } = await import("../src/events/completion-turns.js");
      const firstMessage = String((await query("SELECT metadata->>'message_id' AS m FROM claw_tasks WHERE task_id = $1", [first.task!.id])).rows[0].m);
      await recordCompletionTurns(sessionId, { final_text: "64 lanes", prompt: "what is a wavefront?" }, firstMessage);
      await finish(first.task!.id);
      await query("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [sessionId]);
      executes.length = 0;

      const second = await send("and on RDNA?", { contextId: "ctx-conv" });
      assert.ok(second.task, second.body);
      assert.equal(second.task.contextId, "ctx-conv");
      assert.notEqual(second.task.id, first.task!.id, "a new task");
      assert.equal(await sessionOf(second.task.id), sessionId, "in the same session");
      const payload = executes.find((e) => e.subject === "tasks.execute")!.payload as { history: Array<{ role: string; content: string }>; prompt: string };
      const turns = payload.history.filter((m) => m.role !== "system").map((m) => `${m.role}:${m.content}`);
      assert.deepEqual(turns, ["user:what is a wavefront?", "assistant:64 lanes"]);
      assert.equal(payload.prompt, "and on RDNA?");
    });
  });

  describe("C3 one task at a time", () => {
    test("a second message while a task runs is refused, naming the task, and nothing is published", async () => {
      const first = await send("long job", { contextId: "ctx-busy" });
      executes.length = 0;
      const second = await send("impatient", { contextId: "ctx-busy" });
      assert.equal(second.json.error.code, -32004);
      assert.match(second.json.error.message, new RegExp(`context busy.*${first.task!.id}`));
      assert.equal(executes.length, 0);
      assert.equal((await query("SELECT COUNT(*)::int AS n FROM claw_tasks WHERE session_id = $1", [await sessionOf(first.task!.id)])).rows[0].n, 1);
      // Once it ends the context takes the next.
      await finish(first.task!.id);
      await query("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE context_id = 'ctx-busy'");
      assert.ok((await send("now", { contextId: "ctx-busy" })).task);
    });

    test("a cancelling task still occupies its context", async () => {
      const first = await send("job", { contextId: "ctx-cancelling" });
      await finish(first.task!.id, "cancelling");
      assert.equal((await send("next", { contextId: "ctx-cancelling" })).json.error.code, -32004);
    });

    test("a resend of the same message is that task and runs nothing twice", async () => {
      const m = msg("once", { contextId: "ctx-dupe" });
      const call = () => rpc("SendMessage", { message: m, configuration: { returnImmediately: true } });
      const a = (await call()).json.result.task;
      executes.length = 0;
      const b = (await call()).json.result.task;
      assert.equal(b.id, a.id);
      assert.equal(executes.length, 0);
    });

    test("a retry of a message that named no context is that message's task, even in the middle of its run", async () => {
      const m = msg("lost answer");
      const call = () => rpc("SendMessage", { message: m, configuration: { returnImmediately: true } });
      const a = (await call()).json.result.task;
      executes.length = 0;
      const [b, c] = (await Promise.all([call(), call()])).map((r) => r.json.result.task);
      assert.equal(b.id, a.id);
      assert.equal(c.id, a.id);
      assert.equal(b.contextId, a.contextId, "in the context it was started in");
      assert.equal(executes.length, 0, "nothing runs twice");
      assert.equal((await query("SELECT COUNT(*)::int AS n FROM claw_tasks WHERE metadata->>'message_id' = $1", [m.messageId])).rows[0].n, 1);
      who = BOB;
      const theirs = (await rpc("SendMessage", { message: m, configuration: { returnImmediately: true } })).json.result.task;
      assert.notEqual(theirs.id, a.id, "another caller's message with the same id is theirs");
    });

    test("the same contextId from another caller is another context", async () => {
      const mine = await send("a", { contextId: "ctx-shared-name" });
      who = BOB;
      const theirs = await send("b", { contextId: "ctx-shared-name" });
      assert.ok(theirs.task, theirs.body);
      assert.notEqual(await sessionOf(mine.task!.id), await sessionOf(theirs.task.id));
      assert.equal((await query("SELECT user_id FROM claw_sessions WHERE session_id = $1", [await sessionOf(theirs.task.id)])).rows[0].user_id, "u-bob");
    });

    test("an unknown topology is refused before anything is written", async () => {
      const before = Number((await query("SELECT COUNT(*)::int AS n FROM claw_sessions")).rows[0].n);
      const r = await rpc("SendMessage", {
        message: msg("x"), metadata: { topology: { nodes: -3 } }, configuration: { returnImmediately: true },
      });
      assert.equal(r.json.error.code, -32602);
      assert.equal(Number((await query("SELECT COUNT(*)::int AS n FROM claw_sessions")).rows[0].n), before);
    });
  });

  describe("C4 reading tasks", () => {
    test("GetTask gives the accumulated text, the tool log and the prompt", async () => {
      const r = await send("report", { contextId: "ctx-read" });
      const sessionId = await sessionOf(r.task!.id);
      await event(sessionId, "statusUpdate", { agentStatus: "running" });
      await said(sessionId, "part one");
      await event(sessionId, "toolUsed", { tool: "bash", status: "success", description: "ls", full_output: "x".repeat(5000) });
      await said(sessionId, "part two");
      const t = (await get(r.task!.id)).result;
      assert.equal(t.status.state, "TASK_STATE_WORKING");
      assert.equal(t.artifacts[0].parts[0].text, "part one\npart two");
      assert.equal(t.artifacts[1].parts[0].text, "[Tool: bash] ls");
      assert.equal(t.history[0].parts[0].text, "report");
      assert.equal((await get(r.task!.id, 0)).result.history, undefined);
    });

    test("the events of an earlier task of the context are not this task's", async () => {
      const first = await send("one", { contextId: "ctx-window" });
      const sessionId = await sessionOf(first.task!.id);
      await said(sessionId, "answer one");
      await finish(first.task!.id);
      await query("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [sessionId]);
      const second = await send("two", { contextId: "ctx-window" });
      await said(sessionId, "answer two");
      assert.equal((await get(first.task!.id)).result.artifacts[0].parts[0].text, "answer one");
      assert.equal((await get(second.task!.id)).result.artifacts[0].parts[0].text, "answer two");
    });

    test("a failed run says why", async () => {
      const r = await send("doomed");
      await query("UPDATE claw_tasks SET status = 'failed', error_message = 'sandbox died', completed_at = NOW() WHERE task_id = $1", [r.task!.id]);
      const t = (await get(r.task!.id)).result;
      assert.equal(t.status.state, "TASK_STATE_FAILED");
      assert.equal(t.status.message.parts[0].text, "sandbox died");
    });

    test("another caller's task, and one that does not exist, are the same answer", async () => {
      const r = await send("private");
      who = BOB;
      const other = await get(r.task!.id);
      const missing = await get("ktsk_nope");
      assert.equal(other.error.code, -32001);
      assert.equal(missing.error.code, -32001);
      assert.equal((await rpc("CancelTask", { id: r.task!.id })).json.error.code, -32001);
      assert.equal((await rpc("SubscribeToTask", { id: r.task!.id })).json.error.code, -32001);
    });

    test("ListTasks is the caller's own, filtered by context and state, and pages", async () => {
      who = { ...ALICE, userId: "u-lister" };
      const ids: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const r = await send(`job ${i}`, { contextId: `ctx-list-${i % 2}` });
        ids.push(r.task!.id);
        if (i < 2) await finish(r.task!.id, i === 0 ? "completed" : "failed");
      }
      who = BOB;
      assert.equal((await rpc("ListTasks", {})).json.result.tasks.some((t: { id: string }) => ids.includes(t.id)), false, "not another caller's");
      who = { ...ALICE, userId: "u-lister" };
      const all = (await rpc("ListTasks", { pageSize: 3 })).json.result;
      assert.equal(all.totalSize, 4);
      assert.equal(all.tasks.length, 3);
      assert.ok(all.nextPageToken);
      const rest = (await rpc("ListTasks", { pageSize: 3, pageToken: all.nextPageToken })).json.result;
      assert.deepEqual([...all.tasks, ...rest.tasks].map((t: { id: string }) => t.id).sort(), [...ids].sort());
      assert.equal(rest.nextPageToken, "");
      assert.equal((await rpc("ListTasks", { contextId: "ctx-list-0" })).json.result.tasks.length, 2);
      const byState = async (status: string) => (await rpc("ListTasks", { status })).json.result;
      assert.equal((await byState("TASK_STATE_COMPLETED")).tasks.length, 1);
      assert.equal((await byState("TASK_STATE_FAILED")).tasks.length, 1);
      const submitted = await byState("TASK_STATE_SUBMITTED");
      assert.equal(submitted.tasks.length, 2);
      assert.equal(submitted.totalSize, 2);
      assert.equal((await byState("TASK_STATE_WORKING")).tasks.length, 0);
      assert.equal((await rpc("ListTasks", { status: "bogus" })).json.error.code, -32602);
      assert.equal((await rpc("ListTasks", { pageToken: "garbage" })).json.error.code, -32602);
    });
  });

  describe("C5 a request is INPUT_REQUIRED and a message with the taskId answers it", () => {
    async function waiting(kind: "approval" | "question", contextId: string) {
      const r = await send(`needs ${kind}`, { contextId });
      const sessionId = await sessionOf(r.task!.id);
      await event(sessionId, "statusUpdate", { agentStatus: "running" });
      if (kind === "approval") {
        await event(sessionId, "permissionRequest", { actionId: "act-1", tool: "bash", input: { command: "rm -rf build", api_key: "sk-secret-123" }, summary: "Deletes build/", timeout_ms: 60000 });
      } else {
        await event(sessionId, "userQuestion", { actionId: "act-q", questions: [{ id: "q1", question: "Which?", options: [{ id: "a", label: "A" }] }] });
      }
      return { task: r.task!, sessionId };
    }
    const answerWith = (task: { id: string; contextId: string }, parts: unknown[]) => rpc("SendMessage", {
      message: { messageId: `m-${++seq}`, role: "ROLE_USER", taskId: task.id, contextId: task.contextId, parts },
      configuration: { returnImmediately: true },
    });

    test("the task reads INPUT_REQUIRED, with the request, masked", async () => {
      const { task } = await waiting("approval", "ctx-in-1");
      const t = (await get(task.id)).result;
      assert.equal(t.status.state, "TASK_STATE_INPUT_REQUIRED");
      assert.equal(t.status.message.parts[0].text, "Deletes build/");
      const data = t.status.message.parts[1].data;
      assert.equal(data.kind, "approval");
      assert.equal(data.actionId, "act-1");
      assert.deepEqual(data.options, ["allow", "deny"]);
      assert.equal(data.input.api_key, "[REDACTED]", "a credential in the held call does not leave the API");
      assert.equal(data.timeoutMs, 60000);
    });

    test("a blocking send returns the finished task, and returns early for a request", async () => {
      const waitForRun = async () => {
        for (let i = 0; i < 100; i += 1) {
          const row = (await query("SELECT task_id, session_id FROM claw_tasks ORDER BY created_at DESC LIMIT 1")).rows[0];
          if (row && executes.length) return row as { task_id: string; session_id: string };
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("the run never opened");
      };
      executes.length = 0;
      const done = rpc("SendMessage", { message: msg("blocks", { contextId: "ctx-block-1" }) });
      const first = await waitForRun();
      await said(first.session_id, "the answer");
      await finish(first.task_id);
      const t = (await done).json.result.task;
      assert.equal(t.status.state, "TASK_STATE_COMPLETED");
      assert.equal(t.artifacts[0].parts[0].text, "the answer");

      await query("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE context_id = 'ctx-block-1'");
      executes.length = 0;
      const waiting = rpc("SendMessage", { message: msg("asks", { contextId: "ctx-block-1" }) });
      const second = await waitForRun();
      await event(second.session_id, "permissionRequest", { actionId: "act-b", tool: "bash", input: {} });
      const r = (await waiting).json.result.task;
      assert.equal(r.status.state, "TASK_STATE_INPUT_REQUIRED", "the caller is needed, so the call returns");
    });

    test("allow answers with the message Brain's dispatcher reads, as the caller", async () => {
      const { task, sessionId } = await waiting("approval", "ctx-in-2");
      const r = await answerWith(task, [{ data: { actionId: "act-1", decision: "allow" } }]);
      assert.ok(r.json.result.task, r.body);
      const published = core.find((c) => c.subject === `decision.${sessionId}`);
      assert.deepEqual(published?.payload, {
        type: "decision", session_id: sessionId, user_id: "u-alice", action_id: "act-1",
        decision: "allow", feedback: "",
      });
    });

    test("deny carries the reason", async () => {
      const { task, sessionId } = await waiting("approval", "ctx-in-3");
      await answerWith(task, [{ data: { decision: "deny", reason: "too risky" } }]);
      const published = core.find((c) => c.subject === `decision.${sessionId}`)!.payload as Record<string, unknown>;
      assert.equal(published.decision, "deny");
      assert.equal(published.feedback, "too risky");
    });

    test("a text answer to a question is published as an answer", async () => {
      const { task, sessionId } = await waiting("question", "ctx-in-4");
      await answerWith(task, [{ text: "A" }]);
      assert.deepEqual(core.find((c) => c.subject === `decision.${sessionId}`)?.payload, {
        type: "answer", session_id: sessionId, user_id: "u-alice", action_id: "act-q", answers: { q1: "A" }, skipped: [],
      });
    });

    test("what is not an answer publishes nothing", async () => {
      const { task } = await waiting("approval", "ctx-in-5");
      for (const parts of [[{ text: "sure, why not" }], [{ data: { actionId: "other", decision: "allow" } }], [{ data: { decision: "edit" } }]]) {
        const r = await answerWith(task, parts);
        assert.equal(r.json.error.code, -32602, JSON.stringify(parts));
      }
      assert.equal(core.filter((c) => c.subject.startsWith("decision.")).length, 0);
    });

    test("a message to a task that is not waiting, or is finished, is refused", async () => {
      const r = await send("plain", { contextId: "ctx-in-6" });
      const notWaiting = await rpc("SendMessage", {
        message: { messageId: "m-x1", role: "ROLE_USER", taskId: r.task!.id, parts: [{ text: "allow" }] },
        configuration: { returnImmediately: true },
      });
      assert.equal(notWaiting.json.error.code, -32004);
      await finish(r.task!.id);
      const finished = await rpc("SendMessage", {
        message: { messageId: "m-x2", role: "ROLE_USER", taskId: r.task!.id, parts: [{ text: "allow" }] },
        configuration: { returnImmediately: true },
      });
      assert.equal(finished.json.error.code, -32004);
      assert.match(finished.json.error.message, /terminal/);
    });

    test("only the caller who owns the task can answer it, and the contextId must match", async () => {
      const { task } = await waiting("approval", "ctx-in-7");
      who = BOB;
      assert.equal((await answerWith(task, [{ text: "allow" }])).json.error.code, -32001);
      who = ALICE;
      const wrongContext = await rpc("SendMessage", {
        message: { messageId: "m-x3", role: "ROLE_USER", taskId: task.id, contextId: "ctx-elsewhere", parts: [{ text: "allow" }] },
      });
      assert.equal(wrongContext.json.error.code, -32602);
      assert.equal(core.filter((c) => c.subject.startsWith("decision.")).length, 0);
    });
  });

  describe("C6 CancelTask", () => {
    test("stops the run, reads CANCELED at once and stays CANCELED", async () => {
      const r = await send("long", { contextId: "ctx-cancel" });
      const sessionId = await sessionOf(r.task!.id);
      const cancelled = (await rpc("CancelTask", { id: r.task!.id })).json.result;
      assert.equal(cancelled.status.state, "TASK_STATE_CANCELED");
      assert.ok(core.some((c) => c.subject === `interrupt.${sessionId}`), "Brain is told to stop");
      assert.equal((await query("SELECT status FROM claw_tasks WHERE task_id = $1", [r.task!.id])).rows[0].status, "cancelling");
      // The worker winding down says WORKING-looking things; the task does not go back.
      await event(sessionId, "statusUpdate", { agentStatus: "running" });
      assert.equal((await get(r.task!.id)).result.status.state, "TASK_STATE_CANCELED");
      await finish(r.task!.id, "cancelled");
      assert.equal((await get(r.task!.id)).result.status.state, "TASK_STATE_CANCELED");
      assert.equal((await rpc("CancelTask", { id: r.task!.id })).json.error.code, -32002);
    });

    test("a worker that finishes its answer after the stop does not un-cancel the task", async () => {
      const r = await send("finishing anyway", { contextId: "ctx-cancel-late" });
      const sessionId = await sessionOf(r.task!.id);
      assert.equal((await rpc("CancelTask", { id: r.task!.id })).json.result.status.state, "TASK_STATE_CANCELED");
      // What the consumer does with a completion that is not flagged as interrupted:
      // the answer was already on its way, so the row is closed as completed.
      await said(sessionId, "the late answer");
      await finish(r.task!.id, "completed");
      const t = (await get(r.task!.id)).result;
      assert.equal(t.status.state, "TASK_STATE_CANCELED", "CANCELED is not overwritten");
      assert.equal(t.artifacts[0].parts[0].text, "the late answer", "what arrived is kept");
      const list = async (status: string) => (await rpc("ListTasks", { status })).json.result.tasks.map((x: { id: string }) => x.id);
      assert.ok((await list("TASK_STATE_CANCELED")).includes(r.task!.id), "listed as canceled");
      assert.equal((await list("TASK_STATE_COMPLETED")).includes(r.task!.id), false, "and not as completed");
      assert.equal((await rpc("CancelTask", { id: r.task!.id })).json.error.code, -32002);
      assert.equal((await rpc("SubscribeToTask", { id: r.task!.id })).json.error.code, -32004);
      // The context is free for the next task.
      await query("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [sessionId]);
      assert.ok((await send("after", { contextId: "ctx-cancel-late" })).task);
    });

    test("a cancel on a task that finished is refused and does not mark it", async () => {
      const r = await send("done already");
      await finish(r.task!.id);
      assert.equal((await rpc("CancelTask", { id: r.task!.id })).json.error.code, -32002);
      assert.equal((await query("SELECT metadata->>'a2a_cancel_requested_at' AS c FROM claw_tasks WHERE task_id = $1", [r.task!.id])).rows[0].c, null);
      assert.equal((await get(r.task!.id)).result.status.state, "TASK_STATE_COMPLETED");
    });

    test("a finished task cannot be cancelled and nothing is sent", async () => {
      const r = await send("short");
      await finish(r.task!.id);
      core.length = 0;
      assert.equal((await rpc("CancelTask", { id: r.task!.id })).json.error.code, -32002);
      assert.equal(core.length, 0);
    });
  });

  describe("C7 the stream", () => {
    function sse(body: string): Array<Record<string, any>> {
      return body.split("\n\n").map((chunk) => chunk.split("\n").find((l) => l.startsWith("data: ")))
        .filter((l): l is string => Boolean(l)).map((l) => JSON.parse(l.slice(6)).result);
    }

    async function stream(script: (feed: Feed, sessionId: () => Promise<string>) => Promise<void>, extra: Record<string, unknown> = {}) {
      const pending = app.inject({
        method: "POST", url: "/a2a", headers: { "a2a-version": "1.0" },
        payload: { jsonrpc: "2.0", id: ++seq, method: "SendStreamingMessage", params: { message: msg("stream me", extra) } },
      });
      // The subscription is made before the run is published.
      for (let i = 0; i < 200 && !executes.length; i += 1) await new Promise((r) => setTimeout(r, 25));
      assert.ok(executes.length, "the run was published");
      const sid = String((executes[0].payload as Record<string, unknown>).session_id);
      const feed = feeds.find((f) => f.subject === `events.${sid}`)!;
      assert.ok(feed, "subscribed to the session's events");
      await script(feed, async () => sid);
      return sse((await pending).body);
    }

    test("task, running, text chunks, then the closed row's state", async () => {
      const events = await stream(async (feed, sid) => {
        feed.push({ type: "statusUpdate", agentStatus: "running" });
        feed.push({ type: "AssistantMessage", data: { content: [{ text: "one" }] } });
        feed.push({ type: "AssistantMessage", data: { content: [{ text: "two" }] } });
        // The consumer closes the row from the same event a moment after it is published.
        const sessionId = await sid();
        const taskId = String((await query("SELECT task_id FROM claw_tasks WHERE session_id = $1", [sessionId])).rows[0].task_id);
        setTimeout(() => { void finish(taskId); }, 150);
        feed.push({ type: "exec_complete", final_text: "one\ntwo" });
      });
      const kinds = events.map((e) => (e.task ? `task:${e.task.status.state}` : e.statusUpdate ? `status:${e.statusUpdate.status.state}` : `artifact:${e.artifactUpdate.append ? "+" : ""}${e.artifactUpdate.lastChunk ? "!" : ""}`));
      assert.deepEqual(kinds, [
        "task:TASK_STATE_SUBMITTED", "status:TASK_STATE_WORKING", "artifact:", "artifact:+", "artifact:+!", "status:TASK_STATE_COMPLETED",
      ]);
      assert.equal(events[2].artifactUpdate.artifact.parts[0].text, "one");
      assert.equal(events[3].artifactUpdate.artifact.parts[0].text, "\ntwo");
    });

    test("a held call ends the stream at INPUT_REQUIRED, with the request", async () => {
      const events = await stream(async (feed) => {
        feed.push({ type: "statusUpdate", agentStatus: "running" });
        feed.push({ type: "permissionRequest", actionId: "act-s", tool: "bash", input: { command: "ls" }, summary: "Lists files" });
      });
      const last = events[events.length - 1];
      assert.equal(last.statusUpdate.status.state, "TASK_STATE_INPUT_REQUIRED");
      assert.equal(last.statusUpdate.status.message.parts[1].data.actionId, "act-s");
    });

    test("the state a stream ends on is the closed row's, not a reading of the event", async () => {
      const events = await stream(async (feed, sid) => {
        const sessionId = await sid();
        const taskId = String((await query("SELECT task_id FROM claw_tasks WHERE session_id = $1", [sessionId])).rows[0].task_id);
        setTimeout(() => { void query("UPDATE claw_tasks SET status = 'failed', error_message = 'worker lost', completed_at = NOW() WHERE task_id = $1", [taskId]); }, 150);
        feed.push({ type: "exec_complete" });
      });
      const last = events[events.length - 1].statusUpdate.status;
      assert.equal(last.state, "TASK_STATE_FAILED");
      assert.equal(last.message.parts[0].text, "worker lost");
    });

    test("a cancelled task's stream ends CANCELED even when the row was closed as completed", async () => {
      const events = await stream(async (feed, sid) => {
        const sessionId = await sid();
        const taskId = String((await query("SELECT task_id FROM claw_tasks WHERE session_id = $1", [sessionId])).rows[0].task_id);
        assert.equal((await rpc("CancelTask", { id: taskId })).json.result.status.state, "TASK_STATE_CANCELED");
        setTimeout(() => { void finish(taskId, "completed"); }, 100);
        feed.push({ type: "AssistantMessage", data: { content: [{ text: "late" }] } });
        feed.push({ type: "exec_complete", final_text: "late" });
      });
      assert.equal(events[events.length - 1].statusUpdate.status.state, "TASK_STATE_CANCELED");
    });

    test("a stopped run closes as CANCELED, not COMPLETED", async () => {
      const events = await stream(async (feed, sid) => {
        const sessionId = await sid();
        const taskId = String((await query("SELECT task_id FROM claw_tasks WHERE session_id = $1", [sessionId])).rows[0].task_id);
        await finish(taskId, "cancelled");
        feed.push({ type: "statusUpdate", agentStatus: "stopped" });
        feed.push({ type: "exec_complete", interrupted: true });
      });
      assert.equal(events[events.length - 1].statusUpdate.status.state, "TASK_STATE_CANCELED");
    });

    test("an event from another turn is not streamed", async () => {
      const events = await stream(async (feed, sid) => {
        const sessionId = await sid();
        feed.push({ type: "AssistantMessage", message_id: "someone-else", data: { content: [{ text: "stale" }] } });
        const taskId = String((await query("SELECT task_id FROM claw_tasks WHERE session_id = $1", [sessionId])).rows[0].task_id);
        await finish(taskId);
        feed.push({ type: "exec_complete" });
      });
      assert.equal(events.some((e) => e.artifactUpdate?.artifact.parts[0].text === "stale"), false);
    });

    test("a busy context is refused before any stream is opened", async () => {
      await send("holds the context", { contextId: "ctx-stream-busy" });
      const res = await app.inject({
        method: "POST", url: "/a2a", headers: { "a2a-version": "1.0" },
        payload: { jsonrpc: "2.0", id: ++seq, method: "SendStreamingMessage", params: { message: msg("second", { contextId: "ctx-stream-busy" }) } },
      });
      assert.ok(String(res.headers["content-type"]).includes("application/json"), "a plain JSON-RPC error, not an event stream");
      assert.equal(JSON.parse(res.body).error.code, -32004);
    });

    test("SubscribeToTask opens with the snapshot, text so far included, and refuses a finished task", async () => {
      const r = await send("subscribe", { contextId: "ctx-sub" });
      const sessionId = await sessionOf(r.task!.id);
      await event(sessionId, "statusUpdate", { agentStatus: "running" });
      await said(sessionId, "already said");
      const pending = app.inject({
        method: "POST", url: "/a2a", headers: { "a2a-version": "1.0" },
        payload: { jsonrpc: "2.0", id: ++seq, method: "SubscribeToTask", params: { id: r.task!.id } },
      });
      for (let i = 0; i < 200 && !feeds.some((f) => f.subject === `events.${sessionId}`); i += 1) await new Promise((x) => setTimeout(x, 25));
      const feed = feeds.find((f) => f.subject === `events.${sessionId}`)!;
      feed.push({ type: "AssistantMessage", data: { content: [{ text: "and more" }] } });
      await finish(r.task!.id);
      feed.push({ type: "exec_complete" });
      const events = sse((await pending).body);
      assert.equal(events[0].task.artifacts[0].parts[0].text, "already said", "the snapshot accumulates the text");
      assert.equal(events[1].artifactUpdate.artifact.parts[0].text, "\nand more", "and the stream carries on from it");
      assert.equal(events[events.length - 1].statusUpdate.status.state, "TASK_STATE_COMPLETED");
      assert.equal((await rpc("SubscribeToTask", { id: r.task!.id })).json.error.code, -32004);
    });
  });

  describe("C9 with the switch off", () => {
    test("a send mints a session under the shared owner, as before", async () => {
      process.env.CLAW_A2A_CONTEXT_TASKS = "0";
      const r = await rpc("SendMessage", { message: msg("legacy", { contextId: "ctx-legacy-off" }), configuration: { returnImmediately: true } });
      const id = r.json.result.task.id as string;
      assert.match(id, /^a2a-/, "the task is the session");
      assert.equal((await query("SELECT user_id FROM claw_sessions WHERE session_id = $1", [id])).rows[0].user_id, "a2a");
    });

    test("push notification methods are unsupported", async () => {
      process.env.CLAW_A2A_CONTEXT_TASKS = "0";
      const r = await rpc("CreateTaskPushNotificationConfig", { taskId: "x", url: "https://example.com/h" });
      assert.equal(r.json.error.code, -32003);
    });
  });

  describe("C10 push notifications are not part of this model yet", () => {
    test("the four methods, and a send that carries a config, are unsupported, as before", async () => {
      for (const name of ["CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig"]) {
        assert.equal((await rpc(name, { taskId: "x", id: "y", url: "https://example.com/h" })).json.error.code, -32003, name);
      }
      const sessions = async () => Number((await query("SELECT COUNT(*)::int AS n FROM claw_sessions")).rows[0].n);
      const before = await sessions();
      const sent = await rpc("SendMessage", {
        message: msg("with a config"),
        configuration: { returnImmediately: true, taskPushNotificationConfig: { url: "https://example.com/h" } },
      });
      assert.equal(sent.json.error.code, -32003);
      assert.equal(await sessions(), before, "and it opened nothing");
    });
  });
});
