// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The model sees the user's message once, on every route a turn's request is finished by, over a real Postgres.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 *
 * Brain builds the model's input as the request's `history`, as given, followed by one user message made from
 * `prompt` (brain/src/agent/engine.ts; pinned on that side by brain/test/model-input-prompt-once.test.ts). So the
 * history the API hands over must end with the turns already stored and never with this turn's prompt: when it did,
 * every turn reached the model twice and the model said so ("your message was duplicated").
 *
 *   P1  the fat dispatch (sessions/dispatch.ts)
 *   P2  a queued message drained when the session frees (events/consumer.ts)
 *   P3  a doorbell run, its history rebuilt at the claim (tasks/run-claim.ts)
 *   P4  an assistant router turn, whose prompt carries a reply-language line, on the fat route and at the claim
 *
 * The A2A follow-up (routes/a2a.ts) is pinned in a2a-context-tasks.test.ts C2.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

type Msg = { role: string; content: unknown };

/** What Brain sends the model for this request: the history, then the prompt as one user message. */
function modelInput(task: { history?: Msg[]; prompt?: string }): Msg[] {
  return [...(task.history ?? []), { role: "user", content: task.prompt ?? "" }];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b && typeof b === "object" && typeof (b as any).text === "string" ? (b as any).text : "")).join("");
  return "";
}

/** How many of the model's messages carry these words. */
function timesSeen(messages: Msg[], words: string): number {
  return messages.filter((m) => textOf(m.content).includes(words)).length;
}

describe("the model sees the user's message once", { skip }, () => {
  let w: World;
  let dispatch: typeof import("../src/sessions/dispatch.js");
  let alice: { userId: string; routerSid: string };
  const user = (id: string) => ({ userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}` });
  const EARLIER = "earlier question about pods";
  const ANSWER = "earlier answer: kubectl get pods";

  before(async () => {
    w = await startWorld();
    dispatch = await import("../src/sessions/dispatch.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_conversation_turns, claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions CASCADE");
    alice = await w.user("alice");
    await w.q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('plain', 'a chat', 'alice', 'claw')");
    for (const sid of ["plain", alice.routerSid]) {
      await w.q(
        "INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, token_count) VALUES ($1, 0, 'user', $2, 8), ($1, 1, 'assistant', $3, 8)",
        [sid, EARLIER, ANSWER],
      );
    }
    await w.q("DELETE FROM claw_tasks");
    await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL");
  });

  const pristineDispatch = (() => { let p: any = null; return () => (p ??= { ...dispatch.sessionDispatchPorts }); })();
  async function send(sessionId: string, content: string, doorbell: boolean) {
    const p = dispatch.sessionDispatchPorts as any;
    Object.assign(p, pristineDispatch());
    p.doorbellDispatch = doorbell ? () => ({ release() {} }) : () => null;
    p.publishSse = () => {};
    p.admit = async () => ({ kind: "admit" });
    const published: string[] = [];
    p.publishTask = async (_s: string, payload: string) => { published.push(payload); return published.length; };
    try {
      const result = await dispatch.dispatchTaskToBrain({
        sessionId, userId: "alice", user: user("alice"), content, messageType: "text", toolIds: [], pluginId: undefined,
        requestImage: undefined, requestResource: undefined, requestTimeout: undefined, workspaceId: undefined,
        mcpServers: undefined, capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
      } as never, async () => {});
      assert.equal(result.kind, "dispatched", JSON.stringify(result));
    } finally { Object.assign(p, pristineDispatch()); }
    return published.map((x) => JSON.parse(x));
  }
  /** The doorbell claim, with the history rebuilt by the real builder. */
  async function claim(): Promise<any> {
    const runClaim = await import("../src/tasks/run-claim.js");
    const { DOORBELL_SEMANTICS_VERSION } = await import("@claw/protocol");
    const claimed = await runClaim.claimNextRun("brain-claim", DOORBELL_SEMANTICS_VERSION);
    assert.ok(claimed, "a queued doorbell row was claimed");
    return claimed!.request;
  }

  const assertOnce = (task: any, words: string) => {
    const input = modelInput(task);
    assert.equal(timesSeen(input, words), 1, `the model sees "${words}" once: ${JSON.stringify(input.map((m) => [m.role, textOf(m.content)]))}`);
    assert.equal(timesSeen(input, EARLIER), 1, "and the earlier turn once");
    assert.equal(timesSeen(input, ANSWER), 1, "and the earlier answer once");
    const turns = (task.history ?? []).filter((m: Msg) => m.role !== "system").map((m: Msg) => [m.role, textOf(m.content)]);
    assert.deepEqual(turns, [["user", EARLIER], ["assistant", ANSWER]], "the history is the stored turns, and ends there");
  };

  test("P1 the fat dispatch", async () => {
    const published = await send("plain", "what about the nodes?", false);
    assert.equal(published.length, 1);
    assert.equal(published[0].prompt, "what about the nodes?");
    assertOnce(published[0], "what about the nodes?");
  });

  test("P2 a queued message drained when the session frees", async () => {
    const { pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
    const { drainOldestPendingMessage } = await import("../src/events/consumer.js");
    const original = { ...pendingDispatchPorts };
    const realQuery = w.h.app.db.db.query.bind(w.h.app.db.db);
    const published: string[] = [];
    Object.assign(pendingDispatchPorts, {
      doorbellDispatch: () => null,
      admit: async () => ({ kind: "admit" }),
      bindWorkspace: async () => "kws_1",
      requireWorkspaceBinding: (x?: string) => x as string,
      publishSessionEvent: async () => {},
      openChatRun: async () => ({ taskId: "ktsk_replay_1", workspaceId: "kws_1", lease: { url: "http://api/lease", token: "t" } }),
      publish: async (_s: string, payload: string) => { published.push(payload); return published.length; },
    });
    (w.h.app.db.db as any).query = async (text: string, params: unknown[] = []) =>
      /SET dispatch_task_id = COALESCE/.test(text) ? { rows: [{ dispatch_task_id: params[1] }], rowCount: 1 }
        : /UPDATE claw_tasks/.test(text) ? { rows: [], rowCount: 1 }
        : realQuery(text, params);
    await w.q(
      "INSERT INTO claw_pending_messages (session_id, user_id, content, platform_key, llm_api_key) VALUES ('plain', 'alice', 'and the services?', 'pk-alice', 'vk-alice')",
    );
    try { await drainOldestPendingMessage("plain", "alice"); } finally {
      (w.h.app.db.db as any).query = realQuery;
      Object.assign(pendingDispatchPorts, original);
    }
    assert.equal(published.length, 1);
    const task = JSON.parse(published[0]!);
    assert.equal(task.prompt, "and the services?");
    assertOnce(task, "and the services?");
  });

  test("P3 a doorbell run, its history rebuilt at the claim", async () => {
    await send("plain", "and the deployments?", true);
    const request = await claim();
    assert.equal(request.prompt, "and the deployments?");
    assertOnce(request, "and the deployments?");
  });

  test("P4 an assistant router turn, whose prompt carries a reply-language line", async () => {
    const words = "Can you check why the nightly build is red?";
    const [fat] = await send(alice.routerSid, words, false);
    assert.match(fat.prompt, /\[Reply language: English\]/);
    assertOnce(fat, words);
    await w.q("DELETE FROM claw_tasks");
    await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL");
    await send(alice.routerSid, words, true);
    const claimed = await claim();
    assert.match(claimed.prompt, /\[Reply language: English\]/);
    assertOnce(claimed, words);
  });
});
