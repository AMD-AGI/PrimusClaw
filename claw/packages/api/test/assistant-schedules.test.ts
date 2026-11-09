// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The router's scheduled tasks (`assistant/schedules.ts`) on a real Postgres, with triggers, the trigger tools and the assistant on.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   S1  trigger_create creates nothing: it stores a confirmation and puts a card to the user (the say carries confirm_write, on the
 *       outbox and on the session's event), with the schedule, the timezone, the next run in the user's own time and the prompt
 *   S2  the card's button (`POST /v1/assistant/confirmations/:id/decision`) creates the trigger once, with the cron and timezone shown,
 *       on the key of the request; only the person signed in (or the chat the operator named, for them) may press it, never a key; a
 *       second press is told what the first did; deny creates nothing; another user's press is a 404
 *   S3  trigger_cancel holds too, and its press really deletes the trigger
 *   S4  a typed approval command (批准 #ref) creates it through confirmation_answer, only from a signed-in message written after the
 *       card was shown; a yes in other words, and an unattended message, let nothing through; a no likewise needs 拒绝 #ref
 *   S5  the limits are asked before a card is shown: an invalid schedule, a full trigger list, no key, a report's turn, a turn that
 *       has read what others wrote (the brief), a worker
 *   S6  trigger_list shows the user's triggers and the cards waiting; the router's state lists the cards
 *   S6b each card is shown by its own kind, in the router's state and in trigger_list: a comment card is a comment to post, not a
 *       scheduled task with an empty name; a brief card is a brief; an instruction card is the instruction; an unknown kind is named
 *   S7  the tools are offered to a router only with the trigger tools on, and confirmation_answer reaches a card with the review tools
 *       on or off
 *   S8  a lapsed card does nothing when pressed
 *   S9  a card answered after the next run it showed: the trigger starts from the run after, and the answer says so
 *  S10  the same proposal again in a turn whose card was answered (or lapsed) says what became of it, and shows no new card
 *  S11  the same proposal again in a turn is the same card even after a run time has passed between the two calls
 *   S12 trigger_create with action brief: a card naming the brief (the week, for a weekly schedule), no prompt needed; the press
 *       creates a brief trigger; a run's card keeps its old params (no action); an unknown action is refused
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

describe("assistant schedules", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };
  let sch: typeof import("../src/assistant/schedules.js");
  let inbound: typeof import("../src/assistant/inbound.js");

  before(async () => {
    w = await startWorld({
      CLAW_TRIGGERS_ENABLED: "true", CLAW_TRIGGER_TOOLS_ENABLED: "true", CLAW_TRIGGER_TOOLS_TOKEN_KEY: "trigger-tools-test-key-0123456789abcdef",
      CLAW_ASSISTANT_ATTENDED_TTL_SEC: "600", TRIGGER_MAX_PER_USER: "3", CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS: "clawy",
    });
    sch = await import("../src/assistant/schedules.js");
    inbound = await import("../src/assistant/inbound.js");
    sch.schedulePorts.sayDeps = w.sayDeps;
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id !== "string") return;
      const client = req.headers["x-test-client"];
      (req as any).user = {
        userId: id, userName: `Name ${id}`, platformKey: `pk-button-${id}`, virtualKey: `vk-button-${id}`, roles: ["default"],
        ...(typeof client === "string" ? { delegation: { actorSub: "svc", clientId: client } } : {}),
      };
      const method = req.headers["x-test-method"];
      (req as any).authMethod = typeof method === "string" ? method : "identity_token";
    });
    await (await import("../src/routes/assistant-proactive.js")).registerAssistantProactiveRoutes(app);
    await app.ready();
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_triggers, claw_trigger_fires, claw_assistant_confirmations, claw_assistant_says, claw_assistant_messages,
      claw_notification_outbox, claw_notification_subscriptions, claw_work_item_events, claw_work_items, claw_pending_messages, claw_tasks,
      claw_assistants, claw_sessions CASCADE`);
    w.events.length = 0;
    alice = await w.user("alice");
    bob = await w.user("bob");
  });

  const PERSON = { kind: "person" } as const;
  const DAILY = { name: "PR 早报", prompt: "List my open pull requests in AMD-AGI/PrimusClaw and any red CI; send me the list.", schedule: "0 9 * * *", timezone: "Asia/Shanghai" };

  /** A live router turn answering a message the user sent, written down as the route writes it. */
  async function userTurn(u: { routerSid: string; userId: string }, content: string, o: { via?: object | null; agoSec?: number } = {}): Promise<Claims> {
    const turn = await w.routerTurn(u);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, $3, 'A', $4, $5::jsonb, $6::jsonb, NOW() - make_interval(secs => $7::int))`,
      [u.routerSid, turn.mid, u.userId, content, o.via === null ? null : JSON.stringify(o.via ?? PERSON),
        JSON.stringify(inbound.parseChannelContext({ channel: "teams", channel_message_id: "m-1" })), o.agoSec ?? 0],
    );
    return turn;
  }
  const code = async (p: Promise<unknown>): Promise<string> => {
    try { await p; } catch (err) {
      assert.equal((err as Error).name, "ToolRefused", `a fault, not a refusal: ${err}`);
      return (err as { code: string }).code;
    }
    return assert.fail("accepted");
  };
  const count = async (table: string, where = "TRUE", params: unknown[] = []) =>
    Number((await w.q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`, params))[0].n);
  const press = async (user: string, id: string, decision: string, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method: "POST", url: `/v1/assistant/confirmations/${id}/decision`, payload: { decision }, headers: { "x-test-user": user, ...headers } });
    return { status: r.statusCode, body: r.json() };
  };

  test("S1 trigger_create creates nothing and puts the whole of it to the user as a card", async () => {
    await w.subscribe(alice.userId);
    const turn = await userTurn(alice, "每天早上 9 点把我开着的 PR 和红色 CI 发给我");
    const out = await sch.triggerCreateTool(turn, DAILY) as Record<string, any>;
    assert.equal(out.ok, true);
    assert.equal(out.done, false);
    assert.match(out.note, /never say it is done/);
    assert.equal(out.approve, `批准 #${out.ref}`, "a Chinese request is told the Chinese command");
    assert.equal(await count("claw_triggers"), 0, "nothing is scheduled by the call");
    const [c] = await w.q("SELECT * FROM claw_assistant_confirmations");
    assert.equal(c.kind, "trigger_create");
    assert.equal(c.status, "pending");
    assert.equal(c.params.schedule, "0 9 * * *");
    assert.equal(c.params.timezone, "Asia/Shanghai");
    assert.equal(out.ref, (await import("../src/assistant/prompts.js")).confirmationRef(c.confirmation_id));

    const [say] = await w.q("SELECT * FROM claw_assistant_says");
    assert.equal(say.fallback, true, "the system's own words, not counted as the router speaking");
    assert.match(say.text, /PR 早报/);
    assert.match(say.text, /0 9 \* \* \*（Asia\/Shanghai）/);
    assert.match(say.text, /下次 \d{4}-\d{2}-\d{2} 09:00/, "the next run in the user's own time");
    assert.match(say.text, /List my open pull requests/);
    assert.match(say.text, new RegExp(`批准 #${out.ref}`));
    const [row] = await w.q("SELECT payload FROM claw_notification_outbox");
    assert.deepEqual(
      { ...row.payload.confirm_write, expires_at: undefined },
      { confirmation_id: c.confirmation_id, ref: out.ref, kind: "trigger_create", allow_label: "创建", expires_at: undefined },
    );
    const event = w.events.find((e) => e.type === "AssistantSay");
    assert.equal(event?.confirm_write?.confirmation_id, c.confirmation_id, "a web client and an evaluation see the card too");

    // The same call again in this turn is the same card.
    const again = await sch.triggerCreateTool(turn, DAILY) as Record<string, any>;
    assert.equal(again.confirmation_id, out.confirmation_id);
    assert.equal(await count("claw_assistant_says"), 1);
  });

  test("S1e an English request gets the card, the note and the command to type in English", async () => {
    // 2026-11-09 (English conversation): "Check the card and press it, or reply 批准 #5ec155." The note is what the router repeats.
    await w.subscribe(alice.userId);
    const turn = await userTurn(alice, "remind me this Friday at 3 pm to read the ROCm 7.1 release notes");
    const out = await sch.triggerCreateTool(turn, { ...DAILY, name: "Read ROCm 7.1 release notes" }) as Record<string, any>;
    assert.equal(out.approve, `approve #${out.ref}`);
    assert.match(out.note, new RegExp(`or reply exactly approve #${out.ref}\\.`));
    assert.doesNotMatch(JSON.stringify(out), /\p{Script=Han}/u, "no Chinese in what an English turn is answered");
    const [say] = await w.q("SELECT * FROM claw_assistant_says");
    assert.match(say.text, new RegExp(`Press "Create" below to confirm, or reply approve #${out.ref}\\.$`));
    assert.doesNotMatch(say.text, /\p{Script=Han}/u);
  });

  test("S2 the button creates it once, as shown, on the key of the press; deny creates nothing; another user's press is a 404", async () => {
    const out = await sch.triggerCreateTool(await userTurn(alice, "每天 9 点提醒我"), DAILY) as Record<string, any>;
    assert.equal((await press("bob", out.confirmation_id, "allow")).status, 404);
    // Only the person signed in, or their chat for them: never a key (any sandbox of theirs holds it), a cookie, or another service.
    for (const [headers, error] of [[{ "x-test-method": "api_key" }, "interactive_sign_in_required"], [{ "x-test-method": "cookie" }, "interactive_sign_in_required"],
      [{ "x-test-client": "some-bot" }, "service_client_not_allowed"]] as const) {
      const refused = await press("alice", out.confirmation_id, "allow", headers);
      assert.deepEqual([refused.status, refused.body.error], [403, error], JSON.stringify(headers));
    }
    assert.equal(await count("claw_triggers"), 0);
    const first = await press("alice", out.confirmation_id, "allow");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.status, "done");
    assert.equal(first.body.data.answered_now, true);
    const [t] = await w.q("SELECT * FROM claw_triggers");
    assert.equal(t.owner_user_id, "alice");
    assert.equal(t.schedule, "0 9 * * *");
    assert.equal(t.timezone, "Asia/Shanghai");
    assert.equal(t.action, "run");
    assert.equal(t.prompt, DAILY.prompt);
    assert.equal(new Date(t.next_fire_at).getUTCHours(), 1, "09:00 in Shanghai is 01:00 UTC");
    const fire = await import("../src/triggers/fire.js");
    assert.equal(fire.triggerPorts.getCredentialsFor(t as never)?.platformKey, "pk-button-alice", "it runs on the key of the press");
    assert.equal(first.body.data.result.trigger.trigger_id, t.trigger_id);
    assert.equal(first.body.data.result.next_run, first.body.data.result.shown_next_run, "it first runs when the card said");
    assert.equal(first.body.data.result.first_run_moved, undefined);

    assert.equal((await w.q("SELECT decided_via FROM claw_assistant_confirmations WHERE confirmation_id = $1", [out.confirmation_id]))[0].decided_via, "button");
    const second = await press("alice", out.confirmation_id, "allow", { "x-test-client": "clawy" });
    assert.equal(second.status, 200, "the chat the operator named answers for the person");
    assert.equal(second.body.data.answered_now, false);
    assert.equal(second.body.data.status, "done");
    assert.equal(await count("claw_triggers"), 1, "one card, one trigger");

    const other = await sch.triggerCreateTool(await userTurn(alice, "每周一 10 点也来一次"), { ...DAILY, name: "weekly", schedule: "0 10 * * 1" }) as Record<string, any>;
    const denied = await press("alice", other.confirmation_id, "deny");
    assert.equal(denied.body.data.status, "denied");
    assert.equal((await press("alice", other.confirmation_id, "allow")).body.data.status, "denied", "a denied card stays denied");
    assert.equal(await count("claw_triggers"), 1);
    assert.equal((await press("alice", other.confirmation_id, "maybe")).status, 400);
  });

  test("S3 trigger_cancel holds too, and the press really deletes the trigger", async () => {
    const made = await sch.triggerCreateTool(await userTurn(alice, "每天 9 点"), DAILY) as Record<string, any>;
    await press("alice", made.confirmation_id, "allow");
    const [t] = await w.q("SELECT trigger_id FROM claw_triggers");
    assert.equal(await code(sch.triggerCancelTool(await userTurn(bob, "取消它"), { trigger_id: t.trigger_id })), "not_found", "not bob's");
    const cancel = await sch.triggerCancelTool(await userTurn(alice, "把 PR 早报取消掉"), { trigger_id: t.trigger_id }) as Record<string, any>;
    assert.equal(cancel.done, false);
    assert.equal(await count("claw_triggers"), 1, "nothing is cancelled by the call");
    const [say] = await w.q("SELECT text FROM claw_assistant_says ORDER BY created_at DESC LIMIT 1");
    assert.match(say.text, /要取消定时任务「PR 早报」/);
    const pressed = await press("alice", cancel.confirmation_id, "allow");
    assert.equal(pressed.body.data.status, "done");
    assert.equal(await count("claw_triggers"), 0, "the trigger is gone");
  });

  test("S4 批准 #ref lets it through only as a signed-in message written after the card", async () => {
    const out = await sch.triggerCreateTool(await userTurn(alice, "每天 9 点"), DAILY) as Record<string, any>;
    // Another yes lets nothing through, and is not taken for this card.
    assert.equal(await sch.scheduleConfirmationAnswer(await userTurn(alice, "好的，创建吧"), { decision: "allow" }), null);
    // The command, unattended (a key, not a sign-in), is refused with what to do instead.
    assert.equal(await code(sch.scheduleConfirmationAnswer(await userTurn(alice, `批准 #${out.ref}`, { via: null }), { decision: "allow" }) as Promise<unknown>), "not_attended");
    assert.equal(await count("claw_triggers"), 0);
    const answered = await sch.scheduleConfirmationAnswer(await userTurn(alice, `批准 #${out.ref}`), { decision: "allow" }) as Record<string, any>;
    assert.equal(answered.status, "done", JSON.stringify(answered));
    const [t] = await w.q("SELECT * FROM claw_triggers");
    const fire = await import("../src/triggers/fire.js");
    assert.equal(fire.triggerPorts.getCredentialsFor(t as never)?.platformKey, "pk-alice", "a typed answer runs on the key the user's messages gave");
    assert.equal((await w.q("SELECT decided_via FROM claw_assistant_confirmations"))[0].decided_via, "command");

    // A command written before the card was shown is not an answer to it.
    const later = await sch.triggerCreateTool(await userTurn(alice, "每周一"), { ...DAILY, name: "weekly", schedule: "0 10 * * 1" }) as Record<string, any>;
    const early = await userTurn(alice, `批准 #${later.ref}`, { agoSec: 120 });
    assert.equal(await code(sch.scheduleConfirmationAnswer(early, { decision: "allow" }) as Promise<unknown>), "confirmation_after_message");
    // deny names the card by its id.
    // A no is as exact as a yes: a no in other words, an unattended command, or a report's turn closes nothing.
    assert.equal(await code(sch.scheduleConfirmationAnswer(await userTurn(alice, "不要了"), { decision: "deny", confirmation_id: later.confirmation_id }) as Promise<unknown>), "not_a_denial_command");
    assert.equal(await code(sch.scheduleConfirmationAnswer(await userTurn(alice, `拒绝 #${later.ref}`, { via: null }), { decision: "deny" }) as Promise<unknown>), "not_attended");
    assert.equal(await code(sch.scheduleConfirmationAnswer(await w.routerTurn(alice), { decision: "deny", confirmation_id: later.confirmation_id }) as Promise<unknown>), "not_a_denial_command");
    assert.equal((await w.q("SELECT status FROM claw_assistant_confirmations WHERE confirmation_id = $1", [later.confirmation_id]))[0].status, "pending");
    const deny = await sch.scheduleConfirmationAnswer(await userTurn(alice, `拒绝 #${later.ref}`), { decision: "deny", confirmation_id: later.confirmation_id }) as Record<string, any>;
    assert.equal(deny.status, "denied");
    assert.equal(await count("claw_triggers"), 1);
  });

  test("S5 a card is shown only for what could be created, from a user's message to the router", async () => {
    const turn = await userTurn(alice, "每 5 分钟检查一次");
    assert.equal(await code(sch.triggerCreateTool(turn, { ...DAILY, schedule: "*/5 * * * *" })), "invalid_arguments");
    assert.equal(await code(sch.triggerCreateTool(turn, { ...DAILY, timezone: "Mars/Olympus" })), "invalid_arguments");
    // A prompt the card could not show whole.
    assert.equal(await code(sch.triggerCreateTool(turn, { ...DAILY, prompt: "x".repeat(sch.ROUTER_PROMPT_MAX + 1) })), "prompt_too_long");
    // A report's turn answers no message of the user's.
    const report = await w.routerTurn(alice);
    assert.equal(await code(sch.triggerCreateTool(report, DAILY)), "not_from_user");
    // No key reached the assistant yet.
    await w.q("UPDATE claw_sessions SET config = '{}'::jsonb WHERE session_id = $1", [bob.routerSid]);
    assert.equal(await code(sch.triggerCreateTool(await userTurn(bob, "每天 9 点"), DAILY)), "no_credentials");
    // A full list.
    const sealed = (await import("../src/triggers/store.js")).sealTriggerCredentials({ platformKey: "pk", virtualKey: "vk", userName: "alice" });
    for (let i = 0; i < 3; i += 1) {
      await w.q(
        `INSERT INTO claw_triggers (trigger_id, owner_user_id, name, prompt, schedule, timezone, credential_enc) VALUES ($1, 'alice', $2, 'p', '0 9 * * *', 'UTC', $3)`,
        [`t${i}`, `n${i}`, sealed],
      );
    }
    assert.equal(await code(sch.triggerCreateTool(await userTurn(alice, "每天 9 点"), DAILY)), "trigger_limit_reached");
    // A turn that has read what others wrote (the brief holds run titles and workload names) proposes nothing more, to create or cancel.
    const read = await userTurn(alice, "看看今天的简报，然后取消 n0");
    await (await import("../src/assistant/brief.js")).briefTool(read);
    assert.equal(await code(sch.triggerCreateTool(read, DAILY)), "read_untrusted");
    assert.equal(await code(sch.triggerCancelTool(read, { trigger_id: "t0" })), "read_untrusted");
    // A worker never has the router's tools.
    const item = await w.createItem(alice, "something");
    assert.equal(await code(sch.triggerCreateTool(await w.workerTurn(item.itemId), DAILY)), "not_allowed");
    assert.equal(await count("claw_assistant_confirmations"), 0);
  });

  test("S6 trigger_list shows the triggers and the cards; the router's state lists the cards", async () => {
    const out = await sch.triggerCreateTool(await userTurn(alice, "每天 9 点"), DAILY) as Record<string, any>;
    const listed = await sch.triggerListTool(await userTurn(alice, "我有哪些定时任务")) as Record<string, any>;
    assert.deepEqual(listed.triggers, []);
    assert.equal(listed.waiting_for_confirmation.length, 1);
    assert.equal(listed.waiting_for_confirmation[0].ref, out.ref);
    const state = await sch.renderScheduleState("alice");
    assert.match(state, new RegExp(`ref #${out.ref} .*create scheduled task "PR 早报" \\(0 9 \\* \\* \\*, Asia/Shanghai\\)`));
    assert.equal(await sch.renderScheduleState("bob"), "", "nothing for a user with no card");
    // The command each card is let through with, in the language of the turn the router answers (`typed-commands.ts`).
    assert.match(state, new RegExp(`or: approve #${out.ref}( \\| told: .*)?$`, "m"));
    assert.doesNotMatch(state, /批准/, "an English turn is shown the English command only");
    assert.match(await sch.renderScheduleState("alice", "zh"), new RegExp(`or: 批准 #${out.ref}( \\| told: .*)?$`, "m"));
    await press("alice", out.confirmation_id, "allow");
    const after = await sch.triggerListTool(await userTurn(alice, "现在呢")) as Record<string, any>;
    assert.equal(after.triggers.length, 1);
    assert.equal(after.triggers[0].schedule, "0 9 * * *");
    assert.equal("credential_enc" in after.triggers[0], false);
    assert.deepEqual(after.waiting_for_confirmation, []);
    const routes = await app.inject({ method: "GET", url: "/v1/assistant/confirmations", headers: { "x-test-user": "alice" } });
    assert.deepEqual(routes.json().data, []);
  });

  test("S6b every card is shown by its own kind: a comment card is a comment, never a scheduled task with no name", async () => {
    const card = (id: string, kind: string, params: object) => w.q(
      `INSERT INTO claw_assistant_confirmations (confirmation_id, user_id, session_id, message_id, kind, params, dedupe_key, expires_at)
       VALUES ($1, 'alice', $2, 'm', $3, $4::jsonb, $1, NOW() + INTERVAL '1 hour')`,
      [id, alice.routerSid, kind, JSON.stringify(params)],
    );
    await card("c1000000-0000-4000-8000-000000000000", "github_comment",
      { repo: "AMD-AGI/PrimusClaw", number: 322, body: "LGTM.\nThe count in citations.ts is off by one." });
    await card("c2000000-0000-4000-8000-000000000000", "trigger_create",
      { name: "周报", schedule: "0 9 * * 1", timezone: "Asia/Shanghai", action: "brief", until: null, max_runs: null });
    await card("c3000000-0000-4000-8000-000000000000", "trigger_cancel", { trigger_id: "t1", name: "PR 早报", schedule: "0 9 * * *", timezone: "UTC" });
    await card("c4000000-0000-4000-8000-000000000000", "devenv_send", { agent_id: "claude", machine: "laptop", text: "run make test" });
    await card("c5000000-0000-4000-8000-000000000000", "some_future_kind", { name: "x" });
    const { confirmationRef: ref } = await import("../src/assistant/prompts.js");

    const state = await sch.renderScheduleState("alice");
    const line = (id: string) => state.split("\n").find((l) => l.startsWith(`- ref #${ref(id)} `)) ?? "";
    assert.match(line("c1000000-0000-4000-8000-000000000000"),
      /\| post a comment as the user's GitHub account on AMD-AGI\/PrimusClaw#322 \(no scheduled task\): "LGTM\. The count in citations\.ts is off by one\." \|/);
    assert.match(line("c2000000-0000-4000-8000-000000000000"), /\| create scheduled brief "周报" \(0 9 \* \* 1, Asia\/Shanghai\) \|/);
    assert.match(line("c3000000-0000-4000-8000-000000000000"), /\| cancel scheduled task "PR 早报" \(0 9 \* \* \*, UTC\) \|/);
    assert.match(line("c4000000-0000-4000-8000-000000000000"), /\| send to "claude" on the machine "laptop": "run make test" \|/);
    assert.match(line("c5000000-0000-4000-8000-000000000000"), /\| a "some_future_kind" card \|/);
    assert.match(state, /^Cards waiting for the user's confirmation \(/);
    assert.doesNotMatch(state, /scheduled task ""/, "no card is a scheduled task with an empty name");
    for (const id of ["c1", "c2", "c3", "c4", "c5"]) assert.match(line(`${id}000000-0000-4000-8000-000000000000`), /or: approve #[0-9a-f]{6}/);

    const listed = await sch.triggerListTool(await userTurn(alice, "我有哪些定时任务")) as Record<string, any>;
    const what = Object.fromEntries(listed.waiting_for_confirmation.map((c: any) => [c.kind, c.what]));
    assert.match(what.github_comment, /^post a comment as the user's GitHub account on AMD-AGI\/PrimusClaw#322 \(no scheduled task\)/);
    assert.match(what.trigger_create, /^create scheduled brief "周报"/);
    assert.match(what.devenv_send, /^send to "claude"/);
  });

  test("S7 the router has the tools with the trigger tools on; confirmation_answer reaches a card with the review tools on or off", async () => {
    const { createAssistantMcpServer } = await import("../src/assistant/mcp.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const connect = async (claims: Claims, reviewTools: boolean) => {
      const server = createAssistantMcpServer(claims as never, reviewTools, false, false);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      await Promise.all([server.connect(a), client.connect(b)]);
      return client;
    };
    const router = await connect(await userTurn(alice, "hi"), false);
    const names = (await router.listTools()).tools.map((t) => t.name);
    for (const n of ["trigger_list", "trigger_create", "trigger_cancel", "confirmation_answer", "brief"]) assert.ok(names.includes(n), n);
    await router.close();
    const item = await w.createItem(alice, "x");
    const worker = await connect(await w.workerTurn(item.itemId), false);
    assert.ok(!(await worker.listTools()).tools.some((t) => t.name.startsWith("trigger_")), "a worker has the trigger MCP service, not these");
    await worker.close();

    for (const reviewTools of [false, true]) {
      const card = await sch.triggerCreateTool(await userTurn(alice, `每天 ${reviewTools ? 8 : 7} 点`), { ...DAILY, name: `t${reviewTools}`, schedule: `0 ${reviewTools ? 8 : 7} * * *` }) as Record<string, any>;
      const client = await connect(await userTurn(alice, `批准 #${card.ref}`), reviewTools);
      const res = await client.callTool({ name: "confirmation_answer", arguments: { decision: "allow" } });
      const body = JSON.parse((res.content as Array<{ text: string }>)[0].text);
      assert.equal(res.isError ?? false, false, JSON.stringify(body));
      assert.equal(body.status, "done");
      await client.close();
    }
    assert.equal(await count("claw_triggers"), 2);
  });

  test("S9 a card answered after the run it showed has passed says when it really runs first", async () => {
    const out = await sch.triggerCreateTool(await userTurn(alice, "每天 9 点"), DAILY) as Record<string, any>;
    const [c] = await w.q("SELECT params FROM claw_assistant_confirmations");
    assert.match(c.params.next_run, /T01:00:00\.000Z$/, "the card's next run is kept with it");
    const [say] = await w.q("SELECT text FROM claw_assistant_says");
    assert.match(say.text, /之后才确认就从再下一次开始/, "the card says the next run is the next one only if confirmed before it");
    await w.q("UPDATE claw_assistant_confirmations SET params = jsonb_set(params, '{next_run}', '\"2020-01-01T01:00:00.000Z\"')");
    const pressed = await press("alice", out.confirmation_id, "allow");
    assert.equal(pressed.body.data.status, "done");
    assert.equal(pressed.body.data.result.first_run_moved, true);
    assert.ok(Date.parse(pressed.body.data.result.next_run) > Date.now());
  });

  test("S10 the same proposal again after its card was answered says what became of it", async () => {
    await w.subscribe(alice.userId);
    const said = () => count("claw_assistant_says");
    // Denied: not shown again as if it were waiting.
    const t1 = await userTurn(alice, "每天 9 点");
    const first = await sch.triggerCreateTool(t1, DAILY) as Record<string, any>;
    await press("alice", first.confirmation_id, "deny");
    const denied = await sch.triggerCreateTool(t1, DAILY) as Record<string, any>;
    assert.deepEqual([denied.confirmation_id, denied.status, denied.done], [first.confirmation_id, "denied", false]);
    assert.match(denied.note, /said no to this same card/);
    assert.doesNotMatch(denied.note, /press/);
    // Done: said as done.
    const t2 = await userTurn(alice, "每周一 10 点");
    const weekly = { ...DAILY, name: "weekly", schedule: "0 10 * * 1" };
    const second = await sch.triggerCreateTool(t2, weekly) as Record<string, any>;
    await press("alice", second.confirmation_id, "allow");
    const done = await sch.triggerCreateTool(t2, weekly) as Record<string, any>;
    assert.deepEqual([done.status, done.done], ["done", true]);
    assert.match(done.note, /done already/);
    assert.equal(done.result.trigger.schedule, "0 10 * * 1");
    assert.equal(await count("claw_triggers"), 1, "asking again creates nothing more");
    // Lapsed unanswered: said as lapsed, though nobody has pressed it since.
    const t3 = await userTurn(alice, "每天 8 点");
    const daily8 = { ...DAILY, name: "eight", schedule: "0 8 * * *" };
    const third = await sch.triggerCreateTool(t3, daily8) as Record<string, any>;
    await w.q("UPDATE claw_assistant_confirmations SET expires_at = NOW() - INTERVAL '1 second' WHERE confirmation_id = $1", [third.confirmation_id]);
    const lapsed = await sch.triggerCreateTool(t3, daily8) as Record<string, any>;
    assert.deepEqual([lapsed.status, lapsed.done], ["expired", false]);
    assert.match(lapsed.note, /lapsed unanswered/);
    // Still open: the card it is.
    const t4 = await userTurn(alice, "每天 7 点");
    const daily7 = { ...DAILY, name: "seven", schedule: "0 7 * * *" };
    const fourth = await sch.triggerCreateTool(t4, daily7) as Record<string, any>;
    const open = await sch.triggerCreateTool(t4, daily7) as Record<string, any>;
    assert.deepEqual([open.confirmation_id, open.status, open.done], [fourth.confirmation_id, "pending", false]);
    assert.match(open.note, /never say it is done/);
    assert.equal(await said(), 4, "one card per proposal, none for asking again");
  });

  test("S11 the same proposal again is the same card even when its next run has moved on between the calls", async (t) => {
    await w.subscribe(alice.userId);
    const turn = await userTurn(alice, "每小时提醒我看一下 CI");
    // An hourly schedule whose run falls a minute or two from now, and the clock just before it and then just after it.
    const run = Math.ceil(Date.now() / 60_000) * 60_000 + 60_000;
    const hourly = { ...DAILY, name: "hourly", schedule: `${new Date(run).getUTCMinutes()} * * * *`, timezone: "UTC" };
    t.mock.timers.enable({ apis: ["Date"], now: run - 1000 });
    let first: Record<string, any>;
    let again: Record<string, any>;
    try {
      first = await sch.triggerCreateTool(turn, hourly) as Record<string, any>;
      t.mock.timers.setTime(run + 1000);
      again = await sch.triggerCreateTool(turn, hourly) as Record<string, any>;
    } finally {
      t.mock.timers.reset();
    }
    assert.notEqual(again.next_run, first.next_run, "a run time really passed between the two calls");
    assert.equal(again.confirmation_id, first.confirmation_id);
    assert.equal(await count("claw_assistant_confirmations"), 1, "one card, so one press can create it at most once");
    assert.equal(await count("claw_assistant_says"), 1);
  });

  test("S12 a brief is scheduled through the same card: the week for a weekly schedule, created as action brief", async () => {
    await w.subscribe(alice.userId);
    const turn = await userTurn(alice, "每周一 9 点给我周报");
    const out = await sch.triggerCreateTool(turn, { name: "周报", schedule: "0 9 * * 1", timezone: "Asia/Shanghai", action: "brief" }) as Record<string, any>;
    assert.equal(out.done, false);
    const [c] = await w.q("SELECT * FROM claw_assistant_confirmations WHERE confirmation_id = $1", [out.confirmation_id]);
    assert.equal(c.params.action, "brief");
    const [say] = await w.q("SELECT text FROM claw_assistant_says");
    assert.match(say.text, /要创建定时简报「周报」吗/);
    assert.match(say.text, /你这一周的周报/, "a weekly schedule sends the week");
    assert.match(say.text, /不运行模型/);
    assert.match(say.text, new RegExp(`批准 #${out.ref}`));
    const [row] = await w.q("SELECT payload FROM claw_notification_outbox");
    assert.equal(row.payload.confirm_write.kind, "trigger_create", "the same card the chat draws");
    assert.equal(await count("claw_triggers"), 0);
    const pressed = await press("alice", out.confirmation_id, "allow");
    assert.equal(pressed.body.data.status, "done", JSON.stringify(pressed.body));
    const [t] = await w.q("SELECT * FROM claw_triggers");
    assert.deepEqual([t.action, t.schedule, t.timezone, t.name], ["brief", "0 9 * * 1", "Asia/Shanghai", "周报"]);
    assert.match(t.prompt, /daily brief/i, "the stored description; no model is ever given it");
    assert.equal(pressed.body.data.result.trigger.action, "brief");

    // Its bounds are on the card, as for a run: what the press creates is what the card showed.
    const until = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const bounded = await sch.triggerCreateTool(await userTurn(alice, "每周一 9 点给我周报，发 4 次，到下个月为止"),
      { name: "周报到月底", schedule: "0 9 * * 1", timezone: "Asia/Shanghai", action: "brief", max_runs: 4, until }) as Record<string, any>;
    const boundedSay = (await w.q("SELECT text FROM claw_assistant_says ORDER BY created_at DESC LIMIT 1"))[0].text;
    assert.match(boundedSay, /最多 4 次/);
    assert.match(boundedSay, new RegExp(`到 ${sch.localTime(until, "Asia/Shanghai")} 为止`));
    await press("alice", bounded.confirmation_id, "allow");
    const [bt] = await w.q("SELECT max_runs, ends_at FROM claw_triggers WHERE name = '周报到月底'");
    assert.deepEqual([bt.max_runs, new Date(bt.ends_at).toISOString()], [4, until]);
    // A daily one says the day; a run's card is as it was, without an action of its own.
    await sch.triggerCreateTool(await userTurn(alice, "每天早上 8 点给我简报"), { name: "简报", schedule: "0 8 * * *", timezone: "Asia/Shanghai", action: "brief" });
    assert.match((await w.q("SELECT text FROM claw_assistant_says ORDER BY created_at DESC LIMIT 1"))[0].text, /你的每日简报/);
    const run = await sch.triggerCreateTool(await userTurn(alice, "每天 9 点"), DAILY) as Record<string, any>;
    const [rc] = await w.q("SELECT params FROM claw_assistant_confirmations WHERE confirmation_id = $1", [run.confirmation_id]);
    assert.equal("action" in rc.params, false);
    assert.equal(await code(sch.triggerCreateTool(await userTurn(alice, "x"), { ...DAILY, action: "dance" })), "invalid_arguments");
    assert.equal(await code(sch.triggerCreateTool(await userTurn(alice, "x"), { ...DAILY, prompt: undefined })), "invalid_arguments", "a run still needs its prompt");
  });

  test("S8 a card pressed after it lapsed does nothing", async () => {
    const out = await sch.triggerCreateTool(await userTurn(alice, "每天 9 点"), DAILY) as Record<string, any>;
    await w.q("UPDATE claw_assistant_confirmations SET expires_at = NOW() - INTERVAL '1 second'");
    const pressed = await press("alice", out.confirmation_id, "allow");
    assert.equal(pressed.body.data.status, "expired");
    assert.equal(pressed.body.data.answered_now, false);
    assert.equal(await count("claw_triggers"), 0);
  });
});
