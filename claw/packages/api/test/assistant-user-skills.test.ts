// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The user's personal skills as the assistant's router sees them (`assistant/skill-tools.ts`), over a real Postgres, through the paths
 * production runs: a router turn's request finished by `applySessionRoleToTask`, and `skill_read` called over the assistant's MCP
 * service the way Brain's client calls it. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   U1 a router turn is given the list with its message: each current, enabled skill that applies on its own, by name and description
 *      (one line, cut to 200), an imported one marked; never a manual, disabled, probation or deleted one, nor another user's, nor any
 *      skill's text; and still no `user_skills` on the request
 *   U2 the system prompt is the same on every turn, with no skill, after one is saved and after one is read; the list goes with the
 *      message, and a turn with nothing to list has no list
 *   U3 the list keeps to 2000 characters: the most recently used that fit, then how many are left out
 *   U4 skill_read over the wire: the router is offered it and a worker and an observer are not; it reads the user's skill in pages with
 *      its files on the last, one file by path, a manual one by its name, an imported one marked; a read sets last_used_at; a skill
 *      the user does not have now (another user's, turned off, on probation, deleted, never saved) is not found, all alike; a read
 *      of a file alone is a use too; a page may be given as text
 *   U5 only the user's own assistant: a router session marked as one other people read has neither list nor tool; an ended turn reads
 *      nothing; a worker or an observer calling it is refused; an observer turn is given no list
 *   U6 skill_read is no source of the router's read rule (`read_taint`): Brain lets the turn start work after it, and lets it read a
 *      skill after a lookup
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, TOKEN_KEY, type World } from "./support/assistant-world.js";
import { parseReadTaint } from "../../brain/src/tools/allowlist.js";

const skip = postgresSkipReason();
const PATH = "/v1/internal/assistant-mcp";

describe("assistant: the user's personal skills", { skip }, () => {
  let w: World;
  let app: FastifyInstance;
  let base = "";
  let svc: typeof import("../src/marketplace/skill-service.js");
  let tools: typeof import("../src/assistant/skill-tools.js");
  let prompts: typeof import("../src/assistant/prompts.js");
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };

  before(async () => {
    w = await startWorld({ CLAW_USER_SKILLS_ENABLED: "true", CLAW_ASSISTANT_MEMORY_TOOLS: "false" });
    svc = await import("../src/marketplace/skill-service.js");
    tools = await import("../src/assistant/skill-tools.js");
    prompts = await import("../src/assistant/prompts.js");
    app = Fastify();
    await (await import("../src/assistant/mcp.js")).registerAssistantMcpRoutes(app, true);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => { await app?.close(); await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_skills, claw_skill_files, claw_skill_events, claw_work_item_events, claw_work_items, claw_assistant_says,
      claw_assistant_scopes, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions RESTART IDENTITY CASCADE`);
    alice = await w.user("alice");
    bob = await w.user("bob");
  });

  /** A skill row as the table holds it; `files` are written beside it. */
  async function skill(user: string, name: string, o: {
    version?: number; status?: string; enabled?: boolean; deleted?: boolean; invocation?: string; origin?: string | null;
    description?: string; content?: string; usedAgo?: string | null; files?: Array<{ path: string; content: string; binary?: boolean }>;
  } = {}): Promise<number> {
    const content = o.content ?? `## ${name}\n1. the body of ${name}`;
    const files = o.files ?? [];
    const [row] = await w.q(
      `INSERT INTO claw_skills (user_id, skill_name, version, content, description, status, enabled, deleted_at, invocation, origin, last_used_at, content_sha, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $8 THEN NOW() END, $9, $10, NOW() - $11::interval, $12, 'manual') RETURNING id`,
      [user, name, o.version ?? 1, content, o.description ?? `use for ${name}`, o.status ?? "active", o.enabled ?? true, o.deleted ?? false,
        o.invocation ?? "auto", o.origin === undefined ? "chat" : o.origin, o.usedAgo ?? null,
        svc.skillContentSha(content, files.map((f) => ({ path: f.path, content: f.content, is_binary: f.binary })))],
    );
    for (const f of files) {
      await w.q(
        "INSERT INTO claw_skill_files (skill_id, user_id, file_path, content, size_bytes, is_binary) VALUES ($1, $2, $3, $4, $5, $6)",
        [row.id, user, f.path, f.content, Buffer.byteLength(f.content), f.binary ?? false],
      );
    }
    return row.id;
  }

  /** A router turn's request, finished as the dispatcher finishes it. */
  async function routerTask(u: { routerSid: string }, prompt = "帮我写本周周报"): Promise<Record<string, any>> {
    const turn = await w.routerTurn(u);
    const task: Record<string, any> = { task_id: turn.task_id, message_id: turn.mid, prompt };
    await w.mod.role.applySessionRoleToTask(task, u.routerSid);
    await w.closeRun(turn.task_id);
    return task;
  }
  /** What Claw put after the user's words (`withTurnState`). */
  const stateOf = (prompt: string): string => prompt.split(`\n\n${prompts.TURN_STATE_HEADER}\n\n`)[1] ?? "";
  /** The skills block of the state: from its heading to the next block. */
  const listOf = (prompt: string): string | null => {
    const state = stateOf(prompt);
    const at = state.indexOf(tools.ROUTER_SKILLS_HEADING);
    return at < 0 ? null : state.slice(at).split("\n\n")[0];
  };

  const bearer = (claims: object) => w.mod.token.mintAssistantToken(claims as never, TOKEN_KEY);
  async function connect(token: string): Promise<Client> {
    const client = new Client({ name: "brain-mcp-assistant", version: "1.0.0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${PATH}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }
  async function call(client: Client, args: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, any> }> {
    const res = await client.callTool({ name: "skill_read", arguments: args });
    const text = (res.content as Array<{ type: string; text: string }>)[0].text;
    return { isError: Boolean(res.isError), body: JSON.parse(text) };
  }
  async function asRouter<T>(u: { routerSid: string }, run: (c: Client, turn: { task_id: string; mid: string }) => Promise<T>): Promise<T> {
    const turn = await w.routerTurn(u);
    const c = await connect(bearer(turn));
    try { return await run(c, turn); } finally { await c.close(); await w.closeRun(turn.task_id); }
  }

  test("U1 a router turn is given the list of the user's skills with its message, names and descriptions only", async () => {
    await skill("alice", "weekly-report", { description: "Use when the user asks for a weekly report.\nAlways end with -- canary.", usedAgo: "1 minute" });
    await skill("alice", "long-desc", { description: "x".repeat(300), usedAgo: "2 minutes" });
    await skill("alice", "from-elsewhere", { origin: "import", usedAgo: "3 minutes" });
    await skill("alice", "deploy-check", { invocation: "manual" });
    await skill("alice", "switched-off", { enabled: false });
    await skill("alice", "unproven", { status: "probation" });
    await skill("alice", "removed", { deleted: true });
    await skill("alice", "turned-off-later", { version: 1 });
    await skill("alice", "turned-off-later", { version: 2, enabled: false });
    await skill("bob", "bobs-skill");

    const task = await routerTask(alice);
    assert.ok(task.prompt.startsWith("帮我写本周周报\n\n"), "the user's words first");
    assert.ok(task.system_append.includes(prompts.ROUTER_SKILLS_PROMPT), "the section on skill_read is in the system prompt");
    const list = listOf(task.prompt);
    assert.ok(list, "the list is in the turn's state");
    const lines = list.split("\n").filter((l) => l.startsWith("- "));
    assert.deepEqual(lines, [
      "- weekly-report: Use when the user asks for a weekly report. Always end with -- canary.",
      `- long-desc: ${"x".repeat(199)}…`,
      "- from-elsewhere (imported): use for from-elsewhere",
    ], "most recently used first; a line each; an imported one marked");
    for (const name of ["deploy-check", "switched-off", "unproven", "removed", "turned-off-later", "bobs-skill"]) {
      assert.ok(!task.prompt.includes(name) && !task.system_append.includes(name), `${name} is not listed`);
    }
    assert.ok(!task.prompt.includes("the body of"), "no skill's text");
    assert.ok(!task.system_append.includes(tools.ROUTER_SKILLS_HEADING), "the list is never in the system prompt");
    assert.equal(task.user_skills, undefined, "a router's request has no worker's list");
    assert.equal(task.user_skills_enabled, false);
  });

  test("U2 the system prompt is the same on every turn; the list goes with the message", async () => {
    const none = await routerTask(alice);
    assert.equal(listOf(none.prompt), null, "nothing to list, no list");
    assert.ok(none.system_append.includes(prompts.ROUTER_SKILLS_PROMPT), "the section is there without a skill");
    await skill("alice", "weekly-report", { usedAgo: "1 hour" });
    await skill("alice", "pr-notes", { usedAgo: "2 hours" });
    const saved = await routerTask(alice);
    assert.match(listOf(saved.prompt) ?? "", /- weekly-report:[^\n]*\n- pr-notes:/);
    // A read makes pr-notes the most recently used: the list's order changes, the system prompt does not.
    await asRouter(alice, async (c) => assert.equal((await call(c, { name: "pr-notes" })).body.ok, true));
    const read = await routerTask(alice);
    assert.match(listOf(read.prompt) ?? "", /- pr-notes:[^\n]*\n- weekly-report:/);
    assert.equal(saved.system_append, none.system_append);
    assert.equal(read.system_append, none.system_append);
  });

  test("U3 the list keeps to 2000 characters: the most recently used that fit, then how many are left out", async () => {
    for (let i = 0; i < 40; i++) {
      await skill("alice", `skill-${String(i).padStart(2, "0")}`, { description: `${i} `.repeat(150), usedAgo: `${i + 1} minutes` });
    }
    const list = listOf((await routerTask(alice)).prompt) ?? "";
    assert.ok([...list].length <= tools.ROUTER_SKILLS_MAX_CHARS, `${[...list].length} characters`);
    const names = [...list.matchAll(/^- (skill-\d\d):/gm)].map((m) => m[1]);
    assert.ok(names.length >= 5, `${names.length} listed`);
    assert.deepEqual(names, Array.from({ length: names.length }, (_, i) => `skill-${String(i).padStart(2, "0")}`), "the most recently used");
    assert.ok(list.endsWith(`${40 - names.length} more not listed here (the least recently used): when the user names one, read it by that name.`));

    // At the limit and one past it, by the renderer itself: a list of exactly 2000 characters is whole; one more and it is cut.
    const entry = (name: string, description: string) => ({ name, version: 1, description, invocation: "auto" as const, content_sha: "s", origin: "chat" as const });
    const len = (es: ReturnType<typeof entry>[]) => [...tools.renderRouterSkills(es)!.text].length;
    const full: ReturnType<typeof entry>[] = [];
    while (len([...full, entry(`s${full.length + 10}`, "z".repeat(150))]) <= tools.ROUTER_SKILLS_MAX_CHARS - 60) full.push(entry(`s${full.length + 10}`, "z".repeat(150)));
    const last = tools.ROUTER_SKILLS_MAX_CHARS - len(full) - `\n- s99: `.length;
    assert.ok(last > 0 && last < tools.ROUTER_SKILL_DESCRIPTION_MAX, String(last));
    const exact = tools.renderRouterSkills([...full, entry("s99", "q".repeat(last))])!;
    assert.deepEqual([[...exact.text].length, exact.unlisted], [tools.ROUTER_SKILLS_MAX_CHARS, 0]);
    const over = tools.renderRouterSkills([...full, entry("s99", "q".repeat(last + 1))])!;
    assert.ok(over.unlisted > 0 && [...over.text].length <= tools.ROUTER_SKILLS_MAX_CHARS, "one character more and it is cut");
    // Lines that fill the budget exactly, and one skill more: the closing line needs room, so the lines before it give way.
    const more = tools.renderRouterSkills([...full, entry("s99", "q".repeat(last)), entry("s98", "r")])!;
    assert.ok([...more.text].length <= tools.ROUTER_SKILLS_MAX_CHARS, `${[...more.text].length} characters`);
    assert.ok(more.unlisted >= 2 && more.listed + more.unlisted === full.length + 2);
    const many = Array.from({ length: 50 }, (_, i) => entry(`n${i}`, "z".repeat(150)));
    const cut = tools.renderRouterSkills(many)!;
    assert.ok([...cut.text].length <= tools.ROUTER_SKILLS_MAX_CHARS);
    assert.equal(cut.listed + cut.unlisted, 50);
    assert.equal(tools.renderRouterSkills([entry("m", "d")].map((e) => ({ ...e, invocation: "manual" as const }))), null, "only manual: no list");
  });

  test("U4 skill_read over the wire: offered to the router only; reads the user's skill, in pages, and its files", async () => {
    const long = `# weekly\n${"步骤。".repeat(6000)}`; // 18009 characters: two pages
    await skill("alice", "weekly-report", {
      content: long, files: [{ path: "templates/report.md", content: "## Week {{n}}" }, { path: "assets/logo.png", content: "iVBORw0K", binary: true }],
    });
    await skill("alice", "deploy-check", { invocation: "manual" });
    await skill("alice", "from-elsewhere", { origin: "import" });
    await skill("alice", "switched-off", { enabled: false });
    await skill("alice", "unproven", { status: "probation" });
    await skill("alice", "removed", { deleted: true });
    await skill("bob", "bobs-skill");

    const item = await w.createItem(alice, "Fix the build");
    const worker = await connect(bearer(await w.workerTurn(item.itemId)));
    try {
      assert.ok(!(await worker.listTools()).tools.some((t) => t.name === "skill_read"), "not a worker's");
    } finally { await worker.close(); }

    await asRouter(alice, async (c) => {
      assert.ok((await c.listTools()).tools.some((t) => t.name === "skill_read"), "the router is offered it");
      const p1 = await call(c, { name: "weekly-report" });
      assert.equal(p1.isError, false);
      assert.equal(p1.body.ok, true);
      assert.deepEqual([p1.body.name, p1.body.version, p1.body.page, p1.body.pages], ["weekly-report", 1, 1, 2]);
      assert.equal(p1.body.content, [...long].slice(0, tools.SKILL_READ_PAGE_CHARS).join(""));
      assert.equal(p1.body.files, undefined, "the files are on the last page");
      assert.match(p1.body.more, /page=2/);
      assert.match(p1.body.note, /user's own instructions/);
      const p2 = await call(c, { name: "weekly-report", page: 2 });
      assert.equal(p1.body.content + p2.body.content, long);
      assert.deepEqual(p2.body.files.map((f: any) => [f.path, f.binary ?? false]).sort(), [["assets/logo.png", true], ["templates/report.md", false]]);
      const p3 = await call(c, { name: "weekly-report", page: 3 });
      assert.deepEqual([p3.isError, p3.body.error], [true, "invalid_arguments"]);

      const file = await call(c, { name: "weekly-report", path: "templates/report.md" });
      assert.deepEqual([file.body.ok, file.body.content, file.body.pages], [true, "## Week {{n}}", 1]);
      const bin = await call(c, { name: "weekly-report", path: "assets/logo.png" });
      assert.deepEqual([bin.body.ok, bin.body.binary, bin.body.content], [true, true, undefined], "a binary file is described, not read");
      assert.equal((await call(c, { name: "weekly-report", path: "nope.md" })).body.error, "not_found");

      const manual = await call(c, { name: "deploy-check" });
      assert.deepEqual([manual.body.ok, manual.body.manual], [true, true], "a manual skill is read when the user names it");
      const imported = await call(c, { name: "from-elsewhere" });
      assert.equal(imported.body.imported, true);
      assert.match(imported.body.note, /imported by the user from someone else/);

      for (const name of ["bobs-skill", "switched-off", "unproven", "removed", "never-saved"]) {
        const r = await call(c, { name });
        assert.deepEqual([r.isError, r.body.ok, r.body.error], [false, false, "not_found"], name);
        assert.equal(r.body.message, `the user has no personal skill named ${name} now`, `${name}: told as any missing skill is`);
      }
      assert.equal((await call(c, { name: "" })).body.error, "invalid_arguments");
    });
    const [used] = await w.q("SELECT last_used_at FROM claw_skills WHERE user_id = 'alice' AND skill_name = 'weekly-report'");
    assert.ok(used.last_used_at, "a read is a use");
    // A read of a file alone is a use as well: it orders the list as a read of the skill does.
    await skill("alice", "file-only", { files: [{ path: "references/a.md", content: "notes" }] });
    await asRouter(alice, async (c) => {
      assert.equal((await call(c, { name: "file-only", path: "references/a.md" })).body.ok, true);
      const asText = await call(c, { name: "weekly-report", page: "2" });
      assert.deepEqual([asText.body.ok, asText.body.page], [true, 2], "a page number written as text");
      assert.equal((await call(c, { name: "weekly-report", page: "two" })).body.error, "invalid_arguments");
      assert.equal((await call(c, { name: "weekly-report", page: 0 })).body.error, "invalid_arguments");
    });
    const [fileUsed] = await w.q("SELECT last_used_at FROM claw_skills WHERE user_id = 'alice' AND skill_name = 'file-only'");
    assert.ok(fileUsed.last_used_at, "a file read is a use");
    const [bobs] = await w.q("SELECT last_used_at FROM claw_skills WHERE user_id = 'bob'");
    assert.equal(bobs.last_used_at, null, "another user's skill is not touched");

    // Bob's router reads his own, and none of alice's.
    await asRouter(bob, async (c) => {
      assert.equal((await call(c, { name: "bobs-skill" })).body.ok, true);
      assert.equal((await call(c, { name: "deploy-check" })).body.error, "not_found");
    });
  });

  test("U5 only the user's own assistant: not a session others read, not an ended turn, not a worker's or an observer's", async () => {
    await skill("alice", "weekly-report");
    // A router session marked as one other people read: no section, no list, and the tool refuses.
    await w.q(`UPDATE claw_sessions SET config = config || '{"memory":"off"}'::jsonb WHERE session_id = $1`, [alice.routerSid]);
    const marked = await routerTask(alice);
    assert.ok(!marked.system_append.includes(prompts.ROUTER_SKILLS_PROMPT));
    assert.equal(listOf(marked.prompt), null);
    await asRouter(alice, async (c) => {
      const r = await call(c, { name: "weekly-report" });
      assert.deepEqual([r.isError, r.body.error], [true, "skills_not_here"]);
    });
    await w.q(`UPDATE claw_sessions SET config = config - 'memory' WHERE session_id = $1`, [alice.routerSid]);

    // A turn that has ended reads nothing.
    const turn = await w.routerTurn(alice);
    const c = await connect(bearer(turn));
    try {
      assert.equal((await call(c, { name: "weekly-report" })).body.ok, true);
      await w.closeRun(turn.task_id);
      const r = await call(c, { name: "weekly-report" });
      assert.deepEqual([r.isError, r.body.error], [true, "turn_not_live"]);
    } finally { await c.close(); }

    // Called in process by any other role: refused before anything is read.
    const item = await w.createItem(alice, "Fix the build");
    const worker = await w.workerTurn(item.itemId);
    await assert.rejects(tools.skillRead(worker as never, { name: "weekly-report" }), /for the router, not the worker/);
    await assert.rejects(tools.skillRead({ ...worker, role: "observer" } as never, { name: "weekly-report" }), /for the router, not the observer/);

    // An observer of a group the user is in: no list on its turn, and not offered the tool.
    const observerSid = `obs-${randomUUID().slice(0, 8)}`;
    await w.q("INSERT INTO claw_sessions (session_id, name, user_id, mode, config) VALUES ($1, 'group', 'alice', 'claw', '{}')", [observerSid]);
    await w.q("INSERT INTO claw_assistant_scopes (user_id, scope, session_id) VALUES ('alice', 'teams:group-1', $1)", [observerSid]);
    const run = await w.openRun(observerSid);
    const task: Record<string, any> = { task_id: run.taskId, message_id: run.messageId, prompt: "帮我写本周周报" };
    await w.mod.role.applySessionRoleToTask(task, observerSid);
    assert.ok(!String(task.system_append).includes(prompts.ROUTER_SKILLS_PROMPT) && !String(task.prompt).includes(tools.ROUTER_SKILLS_HEADING));
    const watcher = await connect(bearer({ sid: observerSid, role: "observer", mid: run.messageId, task_id: run.taskId, exp: Math.floor(Date.now() / 1000) + 600 }));
    try {
      assert.ok(!(await watcher.listTools()).tools.some((t) => t.name === "skill_read"), "not an observer's");
    } finally { await watcher.close(); }
    // Nor does the router path serve a session that is not the user's assistant.
    assert.equal(await tools.routerSkillsServe((t, p) => w.h.app.db.db.query(t, p), observerSid, "alice"), false);
    assert.equal(await tools.routerSkillsServe((t, p) => w.h.app.db.db.query(t, p), alice.routerSid, "bob"), false);
    assert.equal(await tools.routerSkillsServe((t, p) => w.h.app.db.db.query(t, p), alice.routerSid, "alice"), true);
  });

  test("U6 skill_read is no source of the read rule: the turn still acts after it, and reads a skill after a lookup", async () => {
    const task = await routerTask(alice);
    const allows = (list: string[], name: string) => list.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));
    const READ = "mcp__assistant__skill_read";
    assert.ok(task.read_taint.sources.length > 0, "the rule has its lookups");
    assert.ok(!allows(task.read_taint.sources, READ), "not a source");
    assert.ok(allows(task.read_taint.allow_after, READ), "allowed after a lookup");

    // Brain's own rule, built from this request.
    const afterSkill = parseReadTaint(task.read_taint)!;
    assert.equal(afterSkill.refusal(READ), null);
    afterSkill.ran(READ, false);
    assert.equal(afterSkill.refusal("mcp__assistant__work_create"), null, "a router that read a skill starts the work");
    const afterLookup = parseReadTaint(task.read_taint)!;
    assert.equal(afterLookup.refusal("web_fetch"), null);
    afterLookup.ran("web_fetch", false);
    assert.equal(afterLookup.refusal(READ), null, "a skill is read after a lookup");
    assert.ok(afterLookup.refusal("mcp__assistant__work_create"), "and the rule still holds for acting");
  });
});
