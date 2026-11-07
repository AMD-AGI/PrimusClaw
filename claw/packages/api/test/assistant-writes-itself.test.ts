// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the router writes itself, and what a worker wrote reaching the user, on a real Postgres (2026-11-06 parity run: F1, G2, R1, R2).
 * The object store and GitHub stand behind their ports. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   W1 deliver_text from a router: the file is stored as a delivery of the assistant's own session and reaches the user at once, as
 *      one system message carrying the file (outbox and session event), its content redacted; a bad name, an empty or too large text
 *      is refused and stores nothing
 *   W2 deliver_text from a worker: stored in the worker's session, with no sandbox, and announced with the item's next report
 *   W3 a worker that reported a line and wrote the document into its last words: the words become item-<n>-reply.md, announced to
 *      the user; short last words, or a report that already held them, make no file; a second completion writes the same file
 *   W4 github_comment posts nothing by itself: the card shows the exact comment; the press posts that comment as the user once; a
 *      deny posts nothing; a GitHub refusal is the card's failure; a key in the draft is masked on the card and in what is posted
 *      alike; a report's turn cannot propose one; the card's session event names the turn that proposed it
 *   W5 the router is offered deliver_text always and github_comment with the confirmation cards; both may follow a lookup; a worker
 *      gets deliver_text and not github_comment
 *   W6 a say whose [n] lost its source (an address no lookup returned) is refused, so no bare number reaches the user; one whose
 *      numbers all kept theirs, and one that cites nothing, go out
 *   W7 a turn that ended in plain text with [n] in it is said without the numbers (plain text carries no sources); an index a[1] stays
 *   W8 the router's prompt: writing is its own (a file by deliver_text, a comment by github_comment), lists item by item from the
 *      result, numbers as returned, and earlier lookups never denied; the worker's: deliver_text needs no sandbox
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import { CITE_DROPPED_META, CITE_SOURCES_META } from "@claw/protocol";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type Claims, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();

const DOC = `# Kubernetes 调度器工作原理\n\n${"调度器为没有绑定节点的 Pod 选择节点。".repeat(120)}\n\nGH_TOKEN=ghp_${"a".repeat(36)}\n`;

describe("the router writes itself, and a worker's words reach the user", { skip }, () => {
  let w: World;
  let alice: { userId: string; routerSid: string };
  let td: typeof import("../src/assistant/text-delivery.js");
  let deliveries: typeof import("../src/assistant/deliveries.js");
  let sch: typeof import("../src/assistant/schedules.js");
  let inbound: typeof import("../src/assistant/inbound.js");
  let stored: Map<string, { body: Buffer; contentType: string; at: Date }>;
  let posted: Array<{ userId: string; repo: string; number: number; body: string }>;
  let postAnswer: () => { url: string } | { error: string };

  before(async () => {
    w = await startWorld({ CLAW_TRIGGERS_ENABLED: "true", CLAW_TRIGGER_TOOLS_ENABLED: "true", CLAW_TRIGGER_TOOLS_TOKEN_KEY: "trigger-tools-test-key-0123456789abcdef", CLAW_ASSISTANT_CITATIONS: "true" });
    td = await import("../src/assistant/text-delivery.js");
    deliveries = await import("../src/assistant/deliveries.js");
    sch = await import("../src/assistant/schedules.js");
    inbound = await import("../src/assistant/inbound.js");
    td.textDeliveryPorts.put = async (key, body, contentType) => { stored.set(key, { body, contentType, at: new Date() }); };
    td.textDeliveryPorts.sayDeps = w.sayDeps;
    sch.schedulePorts.sayDeps = w.sayDeps;
    deliveries.deliveryPorts.list = async (prefix) =>
      [...stored].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.body.length, at: o.at }));
    deliveries.deliveryPorts.read = async (key) => stored.get(key)?.body ?? Buffer.alloc(0);
    sch.githubCommentPorts.post = async (userId, p) => {
      posted.push({ userId, ...p });
      return postAnswer();
    };
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants,
      claw_sessions, claw_notification_outbox, claw_notification_subscriptions, claw_assistant_messages, claw_work_item_delivery_checks,
      claw_assistant_confirmations CASCADE`);
    w.events.length = 0;
    w.drains.length = 0;
    alice = await w.user("alice");
    stored = new Map();
    posted = [];
    postAnswer = () => ({ url: "https://github.com/AMD-AGI/PrimusClaw/pull/322#issuecomment-1" });
  });

  /** A live router turn answering a message alice sent. */
  async function userTurn(content: string): Promise<Claims> {
    const turn = await w.routerTurn(alice);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, user_name, content, attended_via, channel_context, received_at)
       VALUES ($1, $2, $3, 'A', $4, $5::jsonb, $6::jsonb, NOW())`,
      [alice.routerSid, turn.mid, alice.userId, content, JSON.stringify({ kind: "person" }),
        JSON.stringify(inbound.parseChannelContext({ channel: "teams", channel_message_id: "m-1" }))],
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
  const says = async () => w.q("SELECT * FROM claw_assistant_says ORDER BY created_at");

  test("W1 a router's file reaches the user at once, from the assistant's own session, redacted; a bad one stores nothing", async () => {
    await w.subscribe(alice.userId);
    const turn = await userTurn("写一份 1500 字左右的 Kubernetes 调度器工作原理介绍，存成 markdown 文件给我。");
    const out = await td.deliverText(turn as never, { name: "k8s-scheduler.md", text: DOC });
    assert.equal(out.ok, true);
    assert.match(out.note, /never paste its text into say/);
    const [[key, obj]] = [...stored];
    assert.match(key, new RegExp(`^users/${alice.userId}/sessions/${alice.routerSid}/\\.deliveries/[0-9a-f-]{36}/k8s-scheduler\\.md$`),
      "a delivery of the assistant's own session, where the download route serves it to its owner");
    assert.equal(obj.contentType, "text/markdown");
    const text = obj.body.toString("utf8");
    assert.match(text, /^# Kubernetes 调度器工作原理/);
    assert.ok(!text.includes(`ghp_${"a".repeat(36)}`), "a key copied into the text is masked, as in a message");

    const [say] = await says();
    assert.equal(say.fallback, true, "the system's own line, not counted as the router speaking");
    assert.match(say.text, /^文件：`k8s-scheduler\.md`（\d+ KB）/);
    const [row] = await w.q("SELECT payload FROM claw_notification_outbox");
    const file = row.payload.files?.[0];
    assert.equal(file?.session_id, alice.routerSid);
    assert.equal(file?.name, "k8s-scheduler.md");
    assert.equal(file?.size, obj.body.length);
    assert.equal(key.split("/").at(-2), file?.id, "the download route finds it by this id");
    assert.equal(w.events.find((e) => e.type === "AssistantSay")?.files?.[0]?.id, file?.id, "the web client gets the file too");

    for (const [args, refusal] of [
      [{ name: "notes", text: "x" }, "invalid_name"],
      [{ name: "../x.md", text: "x" }, "invalid_name"],
      [{ name: "a/b.md", text: "x" }, "invalid_name"],
      [{ name: "run.exe", text: "x" }, "invalid_name"],
      [{ name: "x.md", text: "  " }, "empty"],
      [{ name: "x.md", text: "x".repeat(td.TEXT_DELIVERY_MAX_BYTES + 1) }, "too_large"],
    ] as const) {
      assert.equal(await code(td.deliverText(turn as never, args)), refusal, JSON.stringify(args.name));
    }
    assert.equal(stored.size, 1, "nothing refused was stored");
    await w.closeRun(turn.task_id);
    assert.equal(await code(td.deliverText(turn as never, { name: "late.md", text: "x" })), "turn_not_live");
  });

  test("W2 a worker's text file is stored in its session with no sandbox and reaches the user with its report", async () => {
    await w.subscribe(alice.userId);
    const item = await w.createItem(alice, "K8s 调度器原理文档");
    const turn = await w.workerTurn(item.itemId);
    const out = await td.deliverText(turn as never, { name: "k8s-scheduler.md", text: DOC });
    assert.match(out.note, /next report/);
    const [key] = [...stored.keys()];
    assert.ok(key.startsWith(`users/${alice.userId}/sessions/${item.workerSid}/.deliveries/`));
    assert.equal((await says()).length, 0, "nothing is said before the report");
    await w.mod.tools.report(turn as never, { kind: "ready", summary: "写好了 k8s-scheduler.md" });
    const told = (await says()).filter((s) => /交付了文件/.test(s.text));
    assert.equal(told.length, 1);
    assert.match(told[0].text, new RegExp(`#${item.seq} K8s 调度器原理文档 交付了文件：\`k8s-scheduler\\.md\``));
  });

  test("W3 a document left in a worker's last words becomes a file of its item; short words or a report that held them make none", async () => {
    await w.subscribe(alice.userId);
    const item = await w.createItem(alice, "K8s 调度器原理 markdown 文档");
    const turn = await w.workerTurn(item.itemId);
    await w.mod.tools.report(turn as never, { kind: "ready", summary: "沙箱创建失败，文件没存成；正文已在最终回复中给出。" });
    await w.closeRun(turn.task_id);
    const finalText = `Writing the markdown file now.\n${DOC}`;
    await w.mod.turnEnd.recordRunEnd(item.workerSid, turn.task_id, "finished", { finalText });
    const files = [...stored].filter(([k]) => k.endsWith(`/item-${item.seq}-reply.md`));
    assert.equal(files.length, 1, "the words are a file of the item");
    assert.match(files[0][1].body.toString("utf8"), /Kubernetes 调度器工作原理/);
    assert.ok(files[0][0].startsWith(`users/${alice.userId}/sessions/${item.workerSid}/.deliveries/`));
    const told = (await says()).filter((s) => s.text.includes(`item-${item.seq}-reply.md`));
    assert.equal(told.length, 1, "and the user is told, with the file");

    // The same completion again (a retry): the same file, said once.
    await w.mod.turnEnd.recordRunEnd(item.workerSid, turn.task_id, "finished", { finalText });
    assert.equal([...stored.keys()].filter((k) => k.endsWith("-reply.md")).length, 1);
    assert.equal((await says()).filter((s) => s.text.includes(`item-${item.seq}-reply.md`)).length, 1);

    // Short last words: nothing.
    const short = await w.createItem(alice, "short");
    const t2 = await w.workerTurn(short.itemId);
    await w.mod.tools.report(t2 as never, { kind: "ready", summary: "done" });
    await w.closeRun(t2.task_id);
    await w.mod.turnEnd.recordRunEnd(short.workerSid, t2.task_id, "finished", { finalText: "Done, see the report." });
    // An answer that held the words: nothing either.
    const answered = await w.createItem(alice, "answered");
    const t3 = await w.workerTurn(answered.itemId);
    await w.mod.tools.report(t3 as never, { kind: "answer", summary: DOC.slice(0, 2000) });
    await w.closeRun(t3.task_id);
    await w.mod.turnEnd.recordRunEnd(answered.workerSid, t3.task_id, "finished", { finalText: DOC.slice(0, 2400) });
    assert.equal([...stored.keys()].filter((k) => k.endsWith("-reply.md")).length, 1, "only the first item's words became a file");
  });

  test("W4 github_comment posts nothing until the press, then exactly the comment shown, once; deny and refusals post nothing", async () => {
    await w.subscribe(alice.userId);
    const turn = await userTurn("看一下 https://github.com/AMD-AGI/PrimusClaw/pull/322，然后在这个 PR 上留一条评论");
    const body = "`claw/packages/api/src/assistant/citations.ts:212` 用未脱敏的正文判定 cited，Clawy 收到的是脱敏后的正文，计数会偏高。";
    const out = await sch.githubCommentTool(turn, { pr: "https://github.com/AMD-AGI/PrimusClaw/pull/322", body }) as Record<string, any>;
    assert.equal(out.done, false);
    assert.equal(out.pr, "AMD-AGI/PrimusClaw#322");
    assert.equal(posted.length, 0, "nothing is posted by the call");
    const [c] = await w.q("SELECT * FROM claw_assistant_confirmations");
    assert.equal(c.kind, "github_comment");
    const [card] = await says();
    assert.ok(card.text.includes(body), "the card shows the whole comment");
    assert.match(card.text, /AMD-AGI\/PrimusClaw#322/);
    assert.match(card.text, new RegExp(`批准 #${out.ref}`));
    const [row] = await w.q("SELECT payload FROM claw_notification_outbox");
    assert.equal(row.payload.confirm_write?.kind, "github_comment");
    assert.equal(row.payload.confirm_write?.allow_label, "发表");
    // The card's session event names the turn that proposed it, so whoever follows the session reads it as that message's answer; the
    // delivery a later say is matched against (`turnFirstSay`) stays as it was.
    const shownCard = w.events.find((e) => e.confirm_write?.kind === "github_comment");
    assert.equal(shownCard?.turn_message_id, turn.mid, "the card's event names its turn");
    assert.equal(row.payload.turn_message_id, undefined, "the card's delivery is unchanged");

    const first = await sch.decideConfirmation({ userId: alice.userId, confirmationId: c.confirmation_id, decision: "allow", via: "button" });
    assert.equal(first.status, "done");
    assert.equal((first.result as any)?.url, "https://github.com/AMD-AGI/PrimusClaw/pull/322#issuecomment-1");
    assert.deepEqual(posted, [{ userId: alice.userId, repo: "AMD-AGI/PrimusClaw", number: 322, body }], "exactly what the card showed, as the user");
    const again = await sch.decideConfirmation({ userId: alice.userId, confirmationId: c.confirmation_id, decision: "allow", via: "button" });
    assert.equal(again.answered_now, false);
    assert.equal(posted.length, 1, "a second press posts nothing");

    // Deny: nothing. A GitHub refusal: the card failed, with its code.
    const t2 = await userTurn("在 AMD-AGI/PrimusClaw#323 留言");
    await sch.githubCommentTool(t2, { pr: "AMD-AGI/PrimusClaw#323", body: "a" });
    const denied = (await w.q("SELECT confirmation_id FROM claw_assistant_confirmations WHERE params->>'number' = '323'"))[0];
    assert.equal((await sch.decideConfirmation({ userId: alice.userId, confirmationId: denied.confirmation_id, decision: "deny", via: "button" })).status, "denied");
    const t3 = await userTurn("在 AMD-AGI/PrimusClaw#324 留言");
    await sch.githubCommentTool(t3, { pr: "AMD-AGI/PrimusClaw#324", body: "b" });
    const failing = (await w.q("SELECT confirmation_id FROM claw_assistant_confirmations WHERE params->>'number' = '324'"))[0];
    postAnswer = () => ({ error: "no_github_token" });
    const failed = await sch.decideConfirmation({ userId: alice.userId, confirmationId: failing.confirmation_id, decision: "allow", via: "button" });
    assert.equal(failed.status, "failed");
    assert.equal((failed.result as any)?.error, "no_github_token");
    assert.deepEqual(posted.map((p) => p.number), [322, 324]);
    postAnswer = () => ({ url: "https://github.com/AMD-AGI/PrimusClaw/pull/322#issuecomment-1" });

    // A key in the draft is masked before the card is stored: the press posts what the card showed, never the key.
    const t4 = await userTurn("在 AMD-AGI/PrimusClaw#325 留言");
    const key = `ghp_${"b".repeat(36)}`;
    await sch.githubCommentTool(t4, { pr: "AMD-AGI/PrimusClaw#325", body: `token was ${key} in the log` });
    const masked = (await w.q("SELECT confirmation_id, params FROM claw_assistant_confirmations WHERE params->>'number' = '325'"))[0];
    assert.ok(!JSON.stringify(masked.params).includes(key), "the stored comment holds no key");
    const shown = (await says()).at(-1);
    assert.ok(shown.text.includes(masked.params.body), "the card shows exactly what is stored");
    postAnswer = () => ({ url: "https://github.com/AMD-AGI/PrimusClaw/pull/325#issuecomment-2" });
    await sch.decideConfirmation({ userId: alice.userId, confirmationId: masked.confirmation_id, decision: "allow", via: "button" });
    assert.equal(posted.at(-1)?.body, masked.params.body);
    assert.ok(!posted.at(-1)?.body.includes(key));

    // A malformed target, an empty or too long body, a report's turn: refused, no card.
    assert.equal(await code(sch.githubCommentTool(turn, { pr: "PrimusClaw 322", body: "x" })), "invalid_arguments");
    assert.equal(await code(sch.githubCommentTool(turn, { pr: "AMD-AGI/PrimusClaw#322", body: " " })), "invalid_arguments");
    assert.equal(await code(sch.githubCommentTool(turn, { pr: "AMD-AGI/PrimusClaw#322", body: "x".repeat(sch.ROUTER_COMMENT_MAX + 1) })), "comment_too_long");
    const reportTurn = await w.routerTurn(alice);
    assert.equal(await code(sch.githubCommentTool(reportTurn, { pr: "AMD-AGI/PrimusClaw#322", body: "x" })), "not_from_user");
    assert.equal(sch.commentTarget("https://github.com/AMD-AGI/PrimusClaw/issues/7")?.number, 7);
    assert.equal(sch.commentTarget("https://evil.example/AMD-AGI/PrimusClaw/pull/7"), null);
  });

  test("W5 the router has deliver_text and github_comment, both callable after a lookup; a worker has deliver_text only", async () => {
    const mcp = await import("../src/assistant/mcp.js");
    const read = await import("../src/assistant/read-tools.js");
    const names = (claims: Record<string, unknown>) => Object.keys((mcp.createAssistantMcpServer(claims as never) as any)._registeredTools);
    const router = names({ sid: alice.routerSid, role: "router", mid: "m", task_id: "t", exp: 0 });
    assert.ok(router.includes("deliver_text"));
    assert.ok(router.includes("github_comment"));
    const worker = names({ sid: "s", role: "worker", mid: "m", task_id: "t", exp: 0 });
    assert.ok(worker.includes("deliver_text"));
    assert.ok(!worker.includes("github_comment"));
    for (const t of ["deliver_text", "github_comment"]) assert.ok((read.AFTER_READ_TOOLS as readonly string[]).includes(t), t);
  });

  test("W6 a say whose [n] lost its source is refused; one whose numbers kept theirs, or that cites nothing, goes out", async () => {
    const turn = await userTurn("Kubernetes 当前最新的稳定版本是多少？附上官方来源链接。");
    const k8s = { n: 1, url: "https://kubernetes.io/releases/", title: "Releases", kind: "web" };
    const meta = (sources: unknown[], notInTurn = 0) => ({ [CITE_SOURCES_META]: sources, [CITE_DROPPED_META]: { not_in_turn: notInTurn, invalid: 0, over_cap: 0 } });
    const lost = w.mod.tools.say(turn as never, {
      text: "最新稳定版是 v1.37 [1]，SchedulerQueueingHints 在 v1.34 GA [2]。",
      sources: ["https://kubernetes.io/releases/", "https://github.com/kubernetes/kubernetes/releases/tag/v1.37.2"],
    }, w.sayDeps, meta([k8s], 1));
    assert.equal(await code(lost), "citation_not_found");
    try {
      await w.mod.tools.say(turn as never, { text: "见 [2]", sources: ["https://x.example/"] }, w.sayDeps, meta([], 1));
    } catch (err) {
      assert.match((err as Error).message, /cites \[2\]/);
      assert.match((err as Error).message, /web_search for it first/);
    }
    assert.equal((await says()).length, 0, "nothing with a bare number reached the user");
    await w.mod.tools.say(turn as never, { text: "最新稳定版是 v1.37 [1]。", sources: ["https://kubernetes.io/releases/"] }, w.sayDeps, meta([k8s]));
    await w.mod.tools.say(turn as never, { text: "数组下标 a[1] 是第二个元素。" }, w.sayDeps, meta([]));
    const sent = w.events.filter((e) => e.type === "AssistantSay");
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].sources?.map((s: { url: string }) => s.url), ["https://kubernetes.io/releases/"]);
    assert.match(sent[1].text, /a\[1\]/);
  });

  test("W7 a turn's plain text is said without its bare [n]; an index stays", async () => {
    const rte = await import("../src/assistant/router-turn-end.js");
    assert.equal(rte.answerToDeliver("最新稳定版是 v1.37[1]。默认开启 [2].", ["问题"]), "最新稳定版是 v1.37。默认开启.");
    assert.equal(rte.answerToDeliver("a[1] is the second element", ["q"]), "a[1] is the second element");
    assert.equal(rte.withoutBareCitations("see [docs](https://x.example) [1]"), "see [docs](https://x.example) [1]", "a text with a link cites nothing");
  });

  test("W8 the prompts: writing is the router's, lists come from the result, earlier lookups are never denied", async () => {
    const wp = await import("../src/assistant/writing-prompt.js");
    const prompts = await import("../src/assistant/prompts.js");
    const on = wp.renderRouterWritingSection({ comment: true });
    assert.match(on, /deliver_text/);
    assert.match(on, /github_comment/);
    assert.match(on, /Never start a work item to write or post a comment/);
    assert.match(on, /When the user also asked about it \(what it changes, how many files, its CI, its open threads\), say those answers first, with the numbers, and that the comment waits for them on a card; then call github_comment with it/);
    assert.equal(wp.ROUTER_WRITING_PROMPT_VERSION, "router-write-v2");
    assert.match(on, /no heading such as 译文/);
    assert.doesNotMatch(wp.renderRouterWritingSection({ comment: false }), /github_comment/, "never a tool the turn does not have");
    const read = prompts.renderRouterReadSection({ servers: ["autopilot"], github: ["issue_search"] });
    assert.match(read, /owner\/repo#number/);
    assert.match(read, /Never an estimate made from it/);
    assert.match(read, /Never tell the user an earlier answer was not checked/);
    assert.match(read, /say it as a change \(上次查是 17 个，其间 #447 合入了，现在是 16 个\), never as your earlier mistake/);
    assert.match(prompts.WORKER_PROMPT, /deliver_text/);
    assert.equal(prompts.WORKER_PROMPT_VERSION, "worker-v8");
    // M2 (2026-11-06): 678.7 from the rounded figures where the unrounded ones give 678.6.
    assert.match(prompts.WORKER_PROMPT, /compute a difference, ratio or percentage from the unrounded values, and round only the figure you report[^\n]*never from figures you already rounded/);
    assert.match(prompts.WORKER_PROMPT, /Before a write the user approves \(a comment, a review, a merge, a push, an issue, a message to someone\), when the task also asked you to find things out[^\n]*first report\(kind="progress", summary\) with everything you found that answers what was asked, with the numbers, then make the write/);
  });
});
