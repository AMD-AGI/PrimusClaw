// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A skill the platform drafts after a router turn (`assistant/skill-auto-draft.ts`), and the facts of the user's skills every router turn
 * is given (`renderSkillFacts`), over a real Postgres, through the paths production runs: the router turn's completion through the event
 * consumer, the router's tools over the assistant's MCP service, and a router turn's request finished by `applySessionRoleToTask`. The
 * model that writes the draft is a port the tests answer. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   D0 which messages state a way the user always works ("我每次都按…写", "以后…都…", "from now on …") and which do not
 *   D1 the meeting-notes case: a router turn that answered in the user's format and drafted nothing ends, and the platform drafts the
 *      skill from the conversation, with the card skill_draft shows (Save and Discard), in the user's assistant; nothing is saved
 *   D2 kept rare: a second preference in the same conversation for the same skill shows no second card; a turn that drafted or saved
 *      itself gets none; nor one whose message was not the person's, signed in; nor a worker's session; nor after a Discard here;
 *      nor when the model writing it declines, or for a skill the user has
 *   D3 the router's state says what the user's skills are now, every turn: none, the ones deleted or undone lately (whatever the
 *      conversation said of them), and how many are turned off or manual, by count only
 *   D6 a draft's card waiting is listed for the router as answered on its card, with no approval command to give the user
 *   D4 the deleted-then-asked-again case: a skill saved, then deleted in the same conversation; "以后我的会议纪要都是这个格式" gets a
 *      state that says it is gone and a new draft, never "you already have it"
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const PATH = "/v1/internal/assistant-mcp";

const P1 = "帮我把今天的会议整理成纪要：讨论了发布节奏，结论是周四发，待办是写变更日志。我每次都按议题、结论、待办写";
const P2 = "以后我的会议纪要都是这个格式";
const NOTES = { worth: true, name: "meeting-notes", description: "按议题、结论、待办写会议纪要时使用", content: "## 何时用\n写会议纪要时。\n## 格式\n1. 议题\n2. 结论\n3. 待办" };

describe("assistant: skills drafted after a turn, and the skills a turn is told of", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let auto: typeof import("../src/assistant/skill-auto-draft.js");
  let tools: typeof import("../src/assistant/skill-tools.js");
  let prompts: typeof import("../src/assistant/prompts.js");
  let schedules: typeof import("../src/assistant/schedules.js");
  let alice: { userId: string; routerSid: string };
  let asked: Array<{ conversation: string; message: string; skills: string }> = [];
  let answer: Record<string, unknown> = NOTES;

  before(async () => {
    w = await startWorld({ CLAW_USER_SKILLS_ENABLED: "true", CLAW_ASSISTANT_MEMORY_TOOLS: "false" });
    auto = await import("../src/assistant/skill-auto-draft.js");
    tools = await import("../src/assistant/skill-tools.js");
    prompts = await import("../src/assistant/prompts.js");
    schedules = await import("../src/assistant/schedules.js");
    const writes = await import("../src/assistant/skill-writes.js");
    writes.skillWritePorts.sayDeps = w.sayDeps;
    schedules.schedulePorts.sayDeps = w.sayDeps;
    auto.autoDraftPorts.propose = async (_userId, vars) => { asked.push(vars); return answer; };
    app = Fastify();
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(app, true);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_skills, claw_skill_files, claw_skill_events, claw_skill_drafts, claw_skill_changes, claw_assistant_confirmations,
      claw_work_item_events, claw_work_items, claw_assistant_says, claw_assistant_messages, claw_notification_outbox, claw_notification_subscriptions,
      claw_assistant_scopes, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_conversation_turns RESTART IDENTITY CASCADE`);
    w.events.length = 0;
    asked = [];
    answer = NOTES;
    alice = await w.user("alice");
  });

  const bearer = (claims: object) => w.mod.token.mintAssistantToken(claims as never, TOKEN_KEY);
  async function connect(claims: object): Promise<Client> {
    const client = new Client({ name: "brain-mcp-assistant", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${PATH}`), { requestInit: { headers: { Authorization: `Bearer ${bearer(claims)}` } } }));
    return client;
  }
  async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, any> }> {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { isError: Boolean(res.isError), body: JSON.parse(text) };
  }
  async function message(content: string, o: { attended?: boolean } = {}): Promise<Claims> {
    const turn = await w.routerTurn(alice);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, $3, NULL, $4, $5::jsonb, '{}'::jsonb, NOW())`,
      [turn.sid, turn.mid, alice.userId, content, o.attended === false ? null : JSON.stringify({ kind: "person" })],
    );
    return turn;
  }
  /** A router turn answering `content`: its tool calls, then its completion through the event consumer; the platform's draft awaited. */
  async function turn(content: string, run: (c: Client) => Promise<void> = async () => {}, o: { attended?: boolean } = {}): Promise<string[]> {
    const t = await message(content, o);
    const c = await connect(t);
    try { await run(c); } finally { await c.close(); }
    return complete(t, "议题：发布节奏。结论：周四发。待办：写变更日志。");
  }
  let seq = 0;
  async function complete(t: Claims, finalText: string): Promise<string[]> {
    const consumer = w.mod.consumer;
    const { sc } = await import("../src/infra/nats.js");
    const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
    const original = { ...consumer.completionPorts };
    const tombstone = { ...consumer.tombstoneReader };
    const drafting: Array<Promise<string>> = [];
    Object.assign(consumer.completionPorts, {
      maybeSummarize: async () => {}, maybeRecordTaskPattern: async () => {}, enqueueEvolutionJob: async () => {},
      recordSkillFeedback: async () => {}, checkProbationGraduation: async () => {},
      maybeAutoDraft: (input: never) => { const p = original.maybeAutoDraft(input); drafting.push(p); return p; },
    });
    Object.assign(consumer.tombstoneReader, { has: async () => false });
    resetDeletedSessionCache();
    try {
      await consumer.consumeEventDelivery({
        subject: `events.${t.sid}`, seq: ++seq, ack: () => {}, nak: () => { throw new Error("nak"); },
        data: sc.encode(JSON.stringify({
          type: "exec_complete", session_id: t.sid, user_id: alice.userId, message_id: t.mid, task_id: t.task_id,
          prompt: "x", final_text: finalText, failed: false, error_count: 0, skills_used: {},
        })),
      } as any);
      return await Promise.all(drafting);
    } finally {
      Object.assign(consumer.completionPorts, original);
      Object.assign(consumer.tombstoneReader, tombstone);
      resetDeletedSessionCache();
    }
  }
  const drafts = () => w.q("SELECT skill_name, origin, content FROM claw_skill_drafts ORDER BY created_at");
  const cards = () => w.events.filter((e) => e.type === "AssistantSay" && e.skill_card);
  const routerState = async (content: string) => {
    const t = await message(content);
    const task: Record<string, any> = { task_id: t.task_id, message_id: t.mid, prompt: content };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    await w.closeRun(t.task_id);
    return String(task.prompt).split(`\n\n${prompts.TURN_STATE_HEADER}\n\n`)[1] ?? "";
  };
  const saveAndDelete = async (name: string) => {
    let c: Client | undefined;
    const s = await message(`请把会议纪要的做法存成我的一个技能，名字叫 ${name}`);
    c = await connect(s);
    try {
      const saved = await call(c, "skill_save", { name, description: "会议纪要", content: NOTES.content, request_quote: "存成我的一个技能" });
      assert.equal(saved.isError, false, JSON.stringify(saved.body));
    } finally { await c.close(); await w.closeRun(s.task_id); }
    const d = await message(`删掉 ${name} 技能`);
    c = await connect(d);
    try {
      const gone = await call(c, "skill_delete", { name, request_quote: `删掉 ${name} 技能` });
      assert.equal(gone.isError, false, JSON.stringify(gone.body));
    } finally { await c.close(); await w.closeRun(d.task_id); }
  };

  test("D1 a stated way of working the turn drafted nothing for becomes a draft with its card; nothing is saved", async () => {
    assert.deepEqual(await turn(P1), ["drafted"]);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].message, P1);
    assert.match(asked[0].conversation, /我每次都按议题、结论、待办写/, "written from the conversation");
    assert.match(asked[0].conversation, /assistant: 议题：发布节奏。/, "with the turn's answer");
    assert.equal(asked[0].skills, "(none)", "told the skills the user has now");
    assert.deepEqual((await drafts()).map((d) => [d.skill_name, d.origin]), [["meeting-notes", "auto"]]);
    assert.deepEqual(await w.q("SELECT 1 FROM claw_skills"), [], "nothing saved");
    const [ev] = await w.q("SELECT op, actor, session_id FROM claw_skill_events");
    assert.deepEqual([ev.op, ev.actor, ev.session_id], ["draft", "auto", alice.routerSid]);
    const [conf] = await w.q("SELECT * FROM claw_assistant_confirmations");
    assert.deepEqual([conf.kind, conf.status, conf.session_id], ["skill_save", "pending", alice.routerSid]);
    const card = cards().at(-1)!;
    assert.deepEqual([card.session_id, card.skill_card.kind, card.skill_card.name, card.confirm_write.allow_label], [alice.routerSid, "draft", "meeting-notes", "保存"]);
    // Save, pressed: saved as the user's, from the draft.
    const pressed = await schedules.decideConfirmation({ userId: "alice", confirmationId: conf.confirmation_id, decision: "allow", via: "button" });
    assert.deepEqual([pressed.status, pressed.result?.ok], ["done", true]);
    assert.deepEqual((await w.q("SELECT skill_name FROM claw_skills")).map((s) => s.skill_name), ["meeting-notes"]);
  });

  test("D2 kept rare: one card per conversation per skill, none when the turn wrote one, none unasked", async () => {
    assert.deepEqual(await turn(P1), ["drafted"]);
    // Context of a later preference: an item's report and a say of another session are not the conversation.
    await w.q(`INSERT INTO claw_assistant_says (say_id, user_id, item_id, text, created_at, session_id)
      VALUES (gen_random_uuid(), 'alice', 'kwi_other', 'ITEM REPORT TEXT', NOW(), NULL),
             (gen_random_uuid(), 'alice', NULL, 'OTHER SESSION TEXT', NOW(), 'some-other-session')`);
    asked = [];
    assert.deepEqual(await turn("以后会议纪要都按这个来"), ["drafted_here"], "the same skill again in this conversation");
    assert.ok(!/ITEM REPORT TEXT|OTHER SESSION TEXT/.test(asked[0]?.conversation ?? ""), asked[0]?.conversation);
    assert.equal(cards().length, 1);

    // The turn drafted it itself: the model is not asked.
    await w.q("TRUNCATE claw_skill_events, claw_skill_drafts, claw_assistant_confirmations");
    asked = [];
    assert.deepEqual(await turn(P1, async (c) => {
      const d = await call(c, "skill_draft", { name: "notes-format", description: "会议纪要格式", content: NOTES.content });
      assert.equal(d.isError, false, JSON.stringify(d.body));
    }), ["turn_wrote_skill"]);
    assert.equal(asked.length, 0);

    // The router took the statement for a request to save: skill_save is refused (not_asked) and saves nothing; the draft is still made.
    await w.q("TRUNCATE claw_skill_events, claw_skill_drafts, claw_assistant_confirmations");
    assert.deepEqual(await turn(P2, async (c) => {
      const s = await call(c, "skill_save", { name: "meeting-notes", content: NOTES.content, request_quote: P2 });
      assert.deepEqual([s.isError, s.body.error], [true, "not_asked"]);
    }), ["drafted"]);
    assert.deepEqual(await w.q("SELECT 1 FROM claw_skills"), [], "nothing saved by the refused call");
    // A save refused for what the skill holds is the turn's answer about it: no draft after it.
    await w.q("TRUNCATE claw_skill_events, claw_skill_drafts, claw_assistant_confirmations");
    assert.deepEqual(await turn(P1, async (c) => {
      const s = await call(c, "skill_draft", { name: "notes-format", content: `token: ${["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("")}` });
      assert.equal(s.isError, true, JSON.stringify(s.body));
    }), ["turn_wrote_skill"]);
    // Not the person, signed in.
    await w.q("TRUNCATE claw_skill_events, claw_skill_drafts, claw_assistant_confirmations");
    assert.deepEqual(await turn(P1, async () => {}, { attended: false }), ["not_attended"]);
    // No preference stated.
    assert.deepEqual(await turn("帮我整理一下会议纪要"), ["no_preference"]);
    // The model writing it declines.
    answer = { worth: false };
    assert.deepEqual(await turn("我一般都周五写周报"), ["declined"]);
    answer = NOTES;
    // A Discard here keeps it quiet for a while.
    assert.deepEqual(await turn(P1), ["drafted"]);
    const [conf] = await w.q("SELECT confirmation_id FROM claw_assistant_confirmations WHERE status = 'pending'");
    await schedules.decideConfirmation({ userId: "alice", confirmationId: conf.confirmation_id, decision: "deny", via: "button" });
    answer = { ...NOTES, name: "weekly-report" };
    assert.deepEqual(await turn("以后周报都按这个模板来"), ["quiet"]);
    // A skill the user has: no draft of it.
    await w.q("TRUNCATE claw_skill_events, claw_skill_drafts, claw_assistant_confirmations");
    await w.q(`INSERT INTO claw_skills (user_id, skill_name, version, content, description, status, source)
      VALUES ('alice', 'weekly-report', 1, 'c', 'd', 'active', 'user')`);
    assert.deepEqual(await turn("以后周报都按这个模板来"), ["has_skill"]);
    // A worker's session is not one the user's skills are drafted in.
    const item = await w.createItem(alice, "notes");
    const run = await w.workerTurn(item.itemId);
    assert.equal(await auto.maybeAutoDraft({ sessionId: run.sid, userId: alice.userId, messageId: run.mid }), "not_served");
  });

  test("D3 the router's state says what the user's skills are now, by count where they are not listed", async () => {
    const none = await routerState("在吗");
    assert.ok(none.includes(tools.SKILL_FACTS_HEADING), none);
    assert.match(none, /They have no personal skill now\./);
    assert.doesNotMatch(none, /Gone lately/);

    await w.q(`INSERT INTO claw_skills (user_id, skill_name, version, content, description, status, source, invocation, enabled)
      VALUES ('alice', 'deploy-check', 1, 'c', 'd', 'active', 'user', 'manual', true),
             ('alice', 'standup', 1, 'c', 'd', 'active', 'user', 'auto', true),
             ('alice', 'switched-off', 1, 'c', 'd', 'active', 'user', 'auto', false)`);
    const some = await routerState("在吗");
    assert.match(some, /They have 3 personal skills now \(2 of them turned off or used only when named: skill_list shows them\)\./);
    assert.ok(!some.includes("deploy-check") && !some.includes("switched-off"), "a manual or turned-off skill is counted, never named");
  });

  test("D4 deleted earlier in the conversation: the state says it is gone, and the preference gets a new draft", async () => {
    await saveAndDelete("meeting-notes");
    const state = await routerState(P2);
    assert.match(state, /They have no personal skill now\./);
    assert.match(state, /Gone lately, not theirs any more: meeting-notes \(deleted \d{4}-\d\d-\d\d \d\d:\d\dZ\)/);
    assert.ok(!state.includes("## The user's personal skills\n"), "no list of skills to read one from");
    // skill_list says the same.
    const t = await message("meeting-notes 这个技能还在吗");
    const c = await connect(t);
    try {
      const listed = await call(c, "skill_list", {});
      assert.deepEqual([listed.body.skills.length, listed.body.deleted_lately.map((r: any) => r.name)], [0, ["meeting-notes"]]);
    } finally { await c.close(); await w.closeRun(t.task_id); }
    asked = [];
    assert.deepEqual(await turn(P2), ["drafted"]);
    assert.equal(asked[0].skills, "(none)", "the deleted skill is not among them");
    assert.deepEqual((await drafts()).map((d) => [d.skill_name, d.origin]), [["meeting-notes", "auto"]]);
    assert.equal(cards().at(-1)!.skill_card.kind, "draft");
  });

  test("D6 a draft's card waiting is told to the router as answered on its card, never as a command to type", async () => {
    assert.deepEqual(await turn(P1), ["drafted"]);
    // The cards-waiting block of the router's state (with scheduled tasks on), as the turn is given it.
    const state = await schedules.renderScheduleState(alice.userId, "zh");
    const line = state.split("\n").find((l) => l.includes("save the personal skill \"meeting-notes\"")) ?? "";
    assert.match(line, /the user answers it on its card \(Save \/ Discard\); never ask them about it in words/, state);
    assert.doesNotMatch(line, /批准 #|approve #/);
  });

  test("D5 the rule that the state, not the conversation, says what exists is in the router's skills prompt", () => {
    assert.match(prompts.ROUTER_SKILLS_PROMPT, /never what the conversation said earlier/);
  });
});

// After the suite: importing the module loads the configuration, which the suite sets first.
test("D0 which messages state a way the user always works", async () => {
  const { statesRecurringWay } = await import("../src/assistant/skill-auto-draft.js");
  for (const yes of [
    P1, P2, "以后周报都按这个模板来", "我习惯先写结论再写过程", "今后发给我的日报都用表格", "我一般都按时间线写复盘",
    "I always write meeting notes as topics, decisions and action items", "From now on, use bullet points for my status updates",
    "Going forward, format release notes like this.",
  ]) assert.equal(statesRecurringWay(yes), true, yes);
  for (const no of [
    "帮我整理一下会议纪要", "这个技能存在吗", "以后别都用表格了", "以后不要这样写", "周四发布，记得写变更日志",
    "Summarize this meeting please", "Don't always use bullet points from now on", "What do you usually do on Fridays?", "",
  ]) assert.equal(statesRecurringWay(no), false, no);
});
