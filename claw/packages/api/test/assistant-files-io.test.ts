// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Files in, results out, on the assistant path, over a real Postgres with the production schema. The object store is a seam
 * (`files.filePorts`, `deliveries.deliveryPorts`), so what was copied, listed and read is what the code asked for. Skipped without
 * DATABASE_URL, and a skip is not a pass.
 *
 *   F1  a channel's files are kept with the message, bounded: only paths below `.uploads/` of the message's own session, at most
 *       CONTEXT_FILES_MAX, each once
 *   F2  the router turn answering the message is told what came and shown the pictures itself (`prompt_images`, images only, below
 *       `.uploads/`); a turn a report started has none
 *   F3  work_create copies every file into the new worker's session before its first message is queued, and the message says where they
 *       are; a file the store refused is named back to the router and not promised to the worker
 *   F4  work_send does the same for an item that already has a worker; a turn that answers no message of the user's sends no files
 *   F5  a worker's delivered files reach the user after its report: one message each, carrying the file (a small image inline), never
 *       twice; a progress report announces nothing; an expired or malformed object is not a file
 *   F6  an answer longer than a usual message is given whole (up to REPORT_ANSWER_MAX) and said to the user whole by the system, at once,
 *       with its line breaks; the router is told it was sent; any other report stays at REPORT_SUMMARY_MAX
 *   F7  say takes a long answer whole, up to SAY_TEXT_MAX, and refuses past it; a router turn that ended in plain text is cut only there
 *   F8  no delivered file is lost: every one is announced however many there are; a report whose announcement the store failed is
 *       announced by the sweep (and recorded, so the next sweep reads nothing); a file delivered after the item's last report is
 *       announced when the run ends; the listing reads every page
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const DELIVERY_A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const DELIVERY_B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
/** A whole 1x1 PNG is not needed here: the inline copy is the bytes as stored, whatever they are. */
const SMALL_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("assistant files in, results out", { skip }, () => {
  let w: World;
  let files: typeof import("../src/assistant/files.js");
  let deliveries: typeof import("../src/assistant/deliveries.js");
  let inbound: typeof import("../src/assistant/inbound.js");
  let report: typeof import("../src/assistant/report.js");
  let outbound: typeof import("../src/assistant/outbound.js");
  let alice: { userId: string; routerSid: string };
  let copies: Array<{ from: string; to: string }>;
  let refuseCopy: (from: string) => boolean;
  let stored: Map<string, { size: number; at: Date; bytes?: Buffer }>;
  let listed: string[];
  let read: string[];
  /** The store's own listing, before the test stands in for it. */
  let storeList: typeof import("../src/assistant/deliveries.js").deliveryPorts.list;

  before(async () => {
    w = await startWorld();
    files = await import("../src/assistant/files.js");
    deliveries = await import("../src/assistant/deliveries.js");
    inbound = await import("../src/assistant/inbound.js");
    report = await import("../src/assistant/report.js");
    outbound = await import("../src/assistant/outbound.js");
    files.filePorts.copy = async (from, to) => {
      if (refuseCopy(from)) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
      copies.push({ from, to });
    };
    storeList = deliveries.deliveryPorts.list;
    deliveries.deliveryPorts.list = async (prefix) => {
      listed.push(prefix);
      return [...stored].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.size, at: o.at }));
    };
    deliveries.deliveryPorts.read = async (key) => {
      read.push(key);
      return stored.get(key)?.bytes ?? Buffer.alloc(0);
    };
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q(`TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants,
      claw_sessions, claw_notification_outbox, claw_notification_subscriptions, claw_assistant_messages, claw_work_item_delivery_checks CASCADE`);
    w.drains.length = 0;
    alice = await w.user("alice");
    copies = [];
    refuseCopy = () => false;
    stored = new Map();
    listed = [];
    read = [];
  });

  /** A live router turn that answers a message alice sent with `context`. */
  async function turnWith(context: unknown, content = "please look at these") {
    const turn = await w.routerTurn(alice);
    await w.q(
      `INSERT INTO claw_assistant_messages (session_id, message_id, user_id, content, attended_via, channel_context)
       VALUES ($1, $2, $3, $4, '{"kind":"person"}'::jsonb, $5::jsonb)`,
      [alice.routerSid, turn.mid, alice.userId, content, JSON.stringify(inbound.parseChannelContext(context))],
    );
    return turn;
  }
  const prefix = (sid: string) => `users/alice/sessions/${sid}/`;
  const TWO = { files: [
    { path: "teams/m1/report.pdf", name: "report.pdf", media_type: "application/pdf", size: 120_000 },
    { path: "teams/m1/screen.png", name: "screen.png", media_type: "image/png", size: 80_000 },
  ] };

  test("F1 a channel's files are kept with the message, bounded", () => {
    const ctx = inbound.parseChannelContext({ files: [
      { path: "teams/m1/a.png", name: "a.png", media_type: "IMAGE/PNG", size: 10 },
      { path: "teams/m1/a.png", name: "again" },
      { path: "../other/b.txt" }, { path: "/etc/passwd" }, { path: "teams/../../x" }, { path: "a\\b" }, { path: "a//b" }, { path: 7 },
      { path: "teams/m1/c.bin", media_type: "not a type", size: -1 },
      ...Array.from({ length: 20 }, (_, i) => ({ path: `teams/m2/f${i}.txt` })),
    ] });
    assert.deepEqual(ctx.files[0], { path: "teams/m1/a.png", name: "a.png", media_type: "image/png", size: 10 });
    assert.deepEqual(ctx.files[1], { path: "teams/m1/c.bin", name: "c.bin" }, "a bad type or size is left out, the file is not");
    assert.equal(ctx.files.length, inbound.CONTEXT_FILES_MAX);
    assert.ok(ctx.files.every((f) => !f.path.includes("..") && !f.path.startsWith("/")));
    assert.deepEqual(inbound.parseChannelContext({}).files, []);
  });

  test("F2 the router turn is told what came and shown the pictures itself", async () => {
    const turn = await turnWith(TWO);
    const task: Record<string, unknown> = { task_id: turn.task_id, message_id: turn.mid, prompt: "please look at these" };
    await w.mod.role.applySessionRoleToTask(task, alice.routerSid);
    assert.deepEqual(task.prompt_images, [".uploads/teams/m1/screen.png"], "only the image, as a path below the session");
    const prompt = String(task.prompt);
    assert.ok(prompt.includes("Files the user sent with this message"));
    assert.ok(prompt.includes("\"report.pdf\"") && prompt.includes("\"screen.png\""));
    assert.ok(/screen\.png.*shown to you with this message/.test(prompt));
    assert.ok(!/report\.pdf.*shown to you/.test(prompt));

    // A turn that answers no message of the user's (a worker's report woke it) has no files.
    const other = await w.routerTurn(alice);
    const bare: Record<string, unknown> = { task_id: other.task_id, message_id: other.mid, prompt: "[work_event] #1 progress: x" };
    await w.mod.role.applySessionRoleToTask(bare, alice.routerSid);
    assert.equal(bare.prompt_images, undefined);
    assert.ok(!String(bare.prompt).includes("Files the user sent"));
  });

  test("F3 work_create hands every file to the new worker before its message is queued", async () => {
    const turn = await turnWith(TWO);
    const out = await w.mod.tools.workCreate(turn, { title: "Read the report", brief: "Summarise page 7 of the report." });
    const workerSid = (await w.item(out.item_id)).worker_session_id as string;
    assert.deepEqual(copies, [
      { from: `${prefix(alice.routerSid)}.uploads/teams/m1/report.pdf`, to: `${prefix(workerSid)}.uploads/teams/m1/report.pdf` },
      { from: `${prefix(alice.routerSid)}.uploads/teams/m1/screen.png`, to: `${prefix(workerSid)}.uploads/teams/m1/screen.png` },
    ]);
    const queued = await w.pending(workerSid);
    assert.equal(queued.length, 1);
    assert.ok(String(queued[0].content).startsWith("Summarise page 7 of the report."));
    assert.ok(String(queued[0].content).includes("/workspace/.uploads/teams/m1/report.pdf"));
    assert.ok(String(queued[0].content).includes("/workspace/.uploads/teams/m1/screen.png"));
    assert.equal(out.files_attached, 2);
    assert.equal(out.files_not_attached, undefined);

    // One the store refused: named back to the router, and not promised to the worker.
    refuseCopy = (from) => from.endsWith("report.pdf");
    copies = [];
    const turn2 = await turnWith(TWO);
    const out2 = await w.mod.tools.workCreate(turn2, { title: "Again", brief: "Look." });
    const worker2 = (await w.item(out2.item_id)).worker_session_id as string;
    const content2 = String((await w.pending(worker2))[0].content);
    assert.ok(!content2.includes("report.pdf"));
    assert.ok(content2.includes("/workspace/.uploads/teams/m1/screen.png"));
    assert.equal(out2.files_attached, 1);
    assert.deepEqual(out2.files_not_attached, ["report.pdf"]);

    // The copy reads the store, so it checks the path itself, whoever hands it the list.
    copies = [];
    const handed = await files.handFilesToWorker({
      userId: "alice", routerSessionId: alice.routerSid, workerSessionId: worker2,
      files: [{ path: "../../bob/sessions/x/.uploads/a.pdf", name: "a.pdf" }, { path: "/abs.pdf", name: "abs.pdf" }],
    });
    assert.deepEqual(copies, []);
    assert.deepEqual(handed.failed.map((f) => f.name), ["a.pdf", "abs.pdf"]);
  });

  test("F4 work_send hands the files to an item's worker; a turn that answers no message sends none", async () => {
    const item = await w.createItem(alice, "Fix the build");
    assert.deepEqual(copies, [], "no message, no files");
    const turn = await turnWith({ files: [{ path: "teams/m9/log.txt", name: "log.txt", media_type: "text/plain" }] });
    const out = await w.mod.tools.workSend(turn, { item_id: item.itemId, text: "Here is the failing log." });
    assert.deepEqual(copies, [{ from: `${prefix(alice.routerSid)}.uploads/teams/m9/log.txt`, to: `${prefix(item.workerSid)}.uploads/teams/m9/log.txt` }]);
    const content = String((await w.pending(item.workerSid)).at(-1)!.content);
    assert.ok(content.startsWith("Here is the failing log."));
    assert.ok(content.includes("/workspace/.uploads/teams/m9/log.txt"));
    assert.equal(out.files_attached, 1);

    copies = [];
    const plain = await w.routerTurn(alice);
    const out2 = await w.mod.tools.workSend(plain, { item_id: item.itemId, text: "Also check main." });
    assert.deepEqual(copies, []);
    assert.equal(out2.files_attached, undefined);
  });

  test("F5 a worker's delivered files reach the user once each, after a report that says something", async () => {
    await w.subscribe("alice");
    const item = await w.createItem(alice, "周报图表");
    const base = `${prefix(item.workerSid)}.deliveries/`;
    stored.set(`${base}${DELIVERY_A}/chart.png`, { size: SMALL_PNG.length, at: new Date(Date.now() - 60_000), bytes: SMALL_PNG });
    stored.set(`${base}${DELIVERY_B}/report.docx`, { size: 48_000, at: new Date() });
    stored.set(`${base}not-an-id/x.txt`, { size: 1, at: new Date() });
    stored.set(`${base}${DELIVERY_B.replace("7c", "8c")}/old.csv`, { size: 1, at: new Date(Date.now() - 30 * 86_400_000) });

    const progress = await w.workerTurn(item.itemId);
    await w.mod.tools.report(progress, { kind: "progress", summary: "chart drawn" });
    assert.equal((await w.q("SELECT * FROM claw_assistant_says")).length, 0, "a progress report announces nothing");
    await w.closeRun(progress.task_id);

    const turn = await w.workerTurn(item.itemId);
    await w.mod.tools.report(turn, { kind: "ready", summary: "chart and report delivered" });
    const says = await w.q("SELECT say_id::text, text, fallback, item_id FROM claw_assistant_says ORDER BY created_at, text");
    assert.equal(says.length, 2, "one message per file, and none for what is not a delivery");
    assert.ok(says.every((s) => s.fallback === true && s.item_id === null), "the system's own words, about no item's acceptance");
    assert.ok(says.some((s) => s.text.includes("chart.png")) && says.some((s) => s.text.includes("report.docx")));
    assert.ok(says.every((s) => s.text.startsWith(`#${item.seq} 周报图表 交付了文件`)), "in the language of the item");
    const payloads = (await w.q("SELECT payload FROM claw_notification_outbox ORDER BY id")).map((r) => r.payload);
    const chart = payloads.find((p) => p.files?.[0]?.name === "chart.png");
    assert.deepEqual(chart.files, [{
      item_id: item.itemId, session_id: item.workerSid, id: DELIVERY_A, name: "chart.png", size: SMALL_PNG.length, content_type: "image/png",
      data_base64: SMALL_PNG.toString("base64"),
    }]);
    const doc = payloads.find((p) => p.files?.[0]?.name === "report.docx");
    assert.equal(doc.files[0].data_base64, undefined, "only a small image comes inline");
    assert.equal(doc.files[0].content_type, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.deepEqual(read, [`${base}${DELIVERY_A}/chart.png`]);

    // The next report announces nothing again, and reads nothing it does not need.
    await w.closeRun(turn.task_id);
    read = [];
    await w.q("UPDATE claw_work_items SET board_state = 'in_progress' WHERE item_id = $1", [item.itemId]);
    const again = await w.workerTurn(item.itemId);
    await w.mod.tools.report(again, { kind: "blocked", summary: "need a decision", question: "Which week?" });
    assert.equal((await w.q("SELECT * FROM claw_assistant_says WHERE fallback")).length, 2);
    assert.deepEqual(read, []);
  });

  test("F6 a long answer is given whole and said whole by the system; other reports stay short", async () => {
    await w.subscribe("alice");
    const item = await w.createItem(alice, "Count the PRs");
    const lines = Array.from({ length: 60 }, (_, i) => `- PR ${i + 1}: something was changed in module ${i}`);
    const answer = `There are 60 open pull requests:\n${lines.join("\n")}`;
    assert.ok(answer.length > 600 && answer.length <= report.REPORT_ANSWER_MAX);
    const turn = await w.workerTurn(item.itemId);
    const ok = await w.mod.tools.report(turn, { kind: "answer", summary: answer });
    assert.equal(ok.status, "recorded");
    const says = await w.q("SELECT text, fallback, item_id FROM claw_assistant_says");
    assert.equal(says.length, 1, "said at once, not left to the sweep");
    assert.equal(says[0].text, `#${item.seq} "Count the PRs": ${answer}`, "whole, with its line breaks");
    assert.equal(says[0].item_id, item.itemId);
    const wake = (await w.pending(alice.routerSid)).at(-1)!;
    assert.ok(String(wake.content).includes("already sent to the user in full"));
    assert.ok(String(wake.content).length < 1200, "the router is not handed the whole answer to retype");

    // A short answer is still the router's to say.
    const item2 = await w.createItem(alice, "One number");
    const turn2 = await w.workerTurn(item2.itemId);
    await w.mod.tools.report(turn2, { kind: "answer", summary: "42" });
    assert.equal((await w.q("SELECT * FROM claw_assistant_says WHERE item_id = $1", [item2.itemId])).length, 0);
    assert.ok(!String((await w.pending(alice.routerSid)).at(-1)!.content).includes("already sent"));

    // The bounds: an answer past REPORT_ANSWER_MAX and any other report past REPORT_SUMMARY_MAX are refused, with why.
    const item3 = await w.createItem(alice, "Bounds");
    const turn3 = await w.workerTurn(item3.itemId);
    await assert.rejects(w.mod.tools.report(turn3, { kind: "answer", summary: "x".repeat(report.REPORT_ANSWER_MAX + 1) }), /at most 8800 characters even for an answer.*deliver_file/);
    await assert.rejects(w.mod.tools.report(turn3, { kind: "ready", summary: "x".repeat(report.REPORT_SUMMARY_MAX + 1) }), /only an answer may be longer/);
    assert.equal(report.parseReport({ kind: "ready", summary: "x".repeat(report.REPORT_SUMMARY_MAX) }).ok, true);
  });

  test("F7 say takes a long answer whole up to SAY_TEXT_MAX; a plain-text end is cut only past it", async () => {
    assert.equal(outbound.SAY_TEXT_MAX, 9000);
    const { SAY_MAX_CHARS } = await import("../src/assistant/prompts.js");
    assert.equal(SAY_MAX_CHARS, outbound.SAY_TEXT_MAX, "the prompt states the bound the store enforces");
    const turn = await w.routerTurn(alice);
    const long = "这是一段很长的回答。\n\n".repeat(700).trim();
    assert.ok(long.length > 600 && long.length <= 9000);
    await w.mod.tools.say(turn, { text: long }, w.sayDeps);
    const said = await w.q("SELECT text FROM claw_assistant_says");
    assert.equal(said[0].text, long, "whole");
    await assert.rejects(w.mod.tools.say(turn, { text: "a".repeat(9001) }, w.sayDeps), /at most 9000/);
    const { answerToDeliver } = w.mod.routerTurnEnd;
    assert.equal(answerToDeliver(long, ["hi"]), long, "a plain-text end within the bound is delivered whole");
    assert.equal(answerToDeliver("b".repeat(9500), ["hi"])!.length, 9000);
  });
  test("F8 no delivered file is lost", async () => {
    const item = await w.createItem(alice, "Charts");
    const base = `${prefix(item.workerSid)}.deliveries/`;
    const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
    for (let n = 1; n <= 12; n++) stored.set(`${base}${id(n)}/chart-${n}.png`, { size: 100 + n, at: new Date(Date.now() - (20 - n) * 1000) });

    // Twelve files: twelve messages, oldest first, and the report recorded as announced.
    const turn = await w.workerTurn(item.itemId);
    await w.mod.tools.report(turn, { kind: "ready", summary: "twelve charts" });
    const names = async () => (await w.q("SELECT text FROM claw_assistant_says ORDER BY created_at, text")).map((r) => String(r.text).split(": ")[1]?.split(" (")[0]);
    assert.equal((await names()).length, 12);
    assert.ok((await names()).includes("chart-1.png"), "the oldest one too");
    const ready = (await w.itemEvents(item.itemId)).filter((e) => e.kind === "ready").at(-1)!;
    assert.equal(Number((await w.q("SELECT event_id FROM claw_work_item_delivery_checks WHERE item_id = $1", [item.itemId]))[0].event_id), Number(ready.id));
    await w.closeRun(turn.task_id);

    // A report whose announcement the store failed: nothing recorded, and the sweep announces it once the report has settled.
    stored.set(`${base}${id(13)}/late.csv`, { size: 3, at: new Date() });
    const realList = deliveries.deliveryPorts.list;
    deliveries.deliveryPorts.list = async () => { throw Object.assign(new Error("store down"), { name: "ServiceUnavailable" }); };
    await w.q("UPDATE claw_work_items SET board_state = 'in_progress' WHERE item_id = $1", [item.itemId]);
    const again = await w.workerTurn(item.itemId);
    assert.equal((await w.mod.tools.report(again, { kind: "blocked", summary: "which week?", question: "Which week?" })).status, "recorded");
    deliveries.deliveryPorts.list = realList;
    assert.ok(!(await names()).includes("late.csv"));
    assert.equal(await deliveries.announceMissedDeliveries(), 0, "not before the report has settled");
    await w.q("UPDATE claw_work_item_events SET created_at = NOW() - INTERVAL '5 minutes' WHERE item_id = $1", [item.itemId]);
    const { sweepAssistant } = await import("../src/assistant/sweep.js");
    await sweepAssistant();   // the sweeper's tick, as it runs
    assert.ok((await names()).includes("late.csv"));
    listed = [];
    assert.equal(await deliveries.announceMissedDeliveries(), 0);
    assert.deepEqual(listed, [], "an item announced through its newest report is not listed again");
    await w.closeRun(again.task_id);

    // A file delivered after the item's last report: the run's end announces it.
    await w.q("UPDATE claw_work_items SET board_state = 'in_progress' WHERE item_id = $1", [item.itemId]);
    const last = await w.workerTurn(item.itemId);
    await w.mod.tools.report(last, { kind: "answer", summary: "done" });
    stored.set(`${base}${id(14)}/after.txt`, { size: 5, at: new Date() });
    await w.q("UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = $1", [last.task_id]);
    await w.mod.turnEnd.recordRunEnd(item.workerSid, last.task_id, "finished", { finalText: "bye" });
    assert.ok((await names()).includes("after.txt"));
  });

  test("F8b the store's listing is read page after page", async () => {
    const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const original = S3Client.prototype.send;
    const tokens: Array<string | undefined> = [];
    S3Client.prototype.send = (async function (command: unknown) {
      if (!(command instanceof ListObjectsV2Command)) throw new Error("unexpected");
      tokens.push(command.input.ContinuationToken);
      const page = tokens.length;
      return {
        Contents: [{ Key: `p/${page}`, Size: page, LastModified: new Date() }],
        IsTruncated: page < 3, NextContinuationToken: page < 3 ? `t${page}` : undefined,
      };
    }) as typeof S3Client.prototype.send;
    try {
      const keys = (await storeList("p/")).map((o) => o.key);
      assert.deepEqual(keys, ["p/1", "p/2", "p/3"]);
      assert.deepEqual(tokens, [undefined, "t1", "t2"]);
    } finally {
      S3Client.prototype.send = original;
    }
  });
});
