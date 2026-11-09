// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The person's own settings and the chat's session commands, through the router. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE } from "./fixtures.js";
import { clickOf, link, message, said, world } from "./world.js";

test("/timezone shows, refuses what is no zone, and sets one, in the person's language", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/timezone"));
  await w.router.handle(message("/timezone asia/shanghai"));
  await w.router.handle(message("/timezone America/Los_Angeles"));
  await w.router.handle(message("/timezone", { locale: "zh-CN" }));
  assert.deepEqual(said(w), [
    "Your time zone is Asia/Shanghai. Change it with `/timezone Area/City`, e.g. `/timezone America/Los_Angeles`.",
    'I do not know the time zone "asia/shanghai". Use an IANA name such as `Asia/Shanghai` or `America/Los_Angeles`.',
    "Time zone set to America/Los_Angeles.",
    "你的时区是 America/Los_Angeles。用 `/timezone 区域/城市` 修改，例如 `/timezone Asia/Shanghai`。",
  ]);
});

test("/quiet shows, turns off, refuses a bad window and sets one; held notices go once nothing mutes", async () => {
  const released: string[] = [];
  const w = world();
  w.deps.proactive.release = (userId) => {
    released.push(userId);
    return Promise.resolve();
  };
  link(w, ALICE.id, "ak");
  for (const text of [
    "/quiet",
    "/quiet off",
    "/quiet 25:00-8:00",
    "/quiet 23:00-07:00",
    "晚上 10 点到早上 8 点别打扰我",
  ]) {
    await w.router.handle(message(text));
  }
  const [shown = "", off = "", bad = "", set = "", zh = ""] = said(w);
  assert.ok(shown.startsWith("Quiet hours are 22:00-08:00 (Asia/Shanghai). During quiet hours"));
  assert.ok(off.startsWith("Quiet hours are off.") && bad.startsWith("Use a 24-hour window"));
  assert.ok(set.startsWith("Quiet hours set to 23:00-07:00 (Asia/Shanghai)."));
  assert.ok(zh.startsWith("免打扰时段设为 22:00-08:00（Asia/Shanghai）。"));
  assert.deepEqual(released, [ALICE.id, ALICE.id, ALICE.id]);
  const prefs = w.store.prefs.getPrefs(ALICE.id);
  assert.deepEqual([prefs.quietEnabled, prefs.quietStart, prefs.quietEnd], [true, "22:00", "08:00"]);
});

test("/pause holds everything until /resume or for a while; /resume says whether it was paused", async () => {
  const w = world();
  w.deps.proactive.muted = () => "quiet";
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/pause"));
  await w.router.handle(message("/pause forever"));
  await w.router.handle(message("/resume"));
  await w.router.handle(message("/resume"));
  await w.router.handle(message("/pause 2h"));
  await w.router.handle(message("暂停通知 2 小时"));
  const [forever = "", bad = "", resumed = "", notPaused = "", hours = "", zh = ""] = said(w);
  assert.ok(forever.startsWith("Paused until you send /resume. Nothing is pushed meanwhile"));
  assert.ok(bad.startsWith("Use a duration such as `/pause 2h`"));
  assert.equal(resumed, "Resumed. Quiet hours (22:00-08:00) still apply; held notices arrive when they end.");
  assert.ok(notPaused.startsWith("You were not paused."));
  assert.match(hours, /^Paused until [A-Z][a-z]{2} \d\d:\d\d \(Asia\/Shanghai\)\./u);
  assert.match(zh, /^已暂停，到 \d\d-\d\d \d\d:\d\d（Asia\/Shanghai）。/u);
  assert.ok((w.store.prefs.getPrefs(ALICE.id).pausedUntil ?? 0) > w.store.now());
});

test("/lang chooses, explains and goes back to following what is written", async () => {
  const w = world();
  await w.router.handle(message("/lang"));
  await w.router.handle(message("/lang zh"));
  await w.router.handle(message("/lang"));
  await w.router.handle(message("/lang klingon"));
  await w.router.handle(message("/lang auto"));
  assert.deepEqual(said(w), [
    "I answer you in English (from your Teams client's language). Change it with `/lang zh` or `/lang en`; `/lang auto` follows what you write.",
    "好的，以后用中文回复你。发 `/lang auto` 改回按你写的话自动选。",
    "我用中文回复你（你设定的）。改：`/lang zh`、`/lang en`，`/lang auto` 按你写的话自动选。",
    "用 `/lang zh`、`/lang en` 或 `/lang auto`。",
    "我用中文回复你（按你最近写的话）。改：`/lang zh`、`/lang en`，`/lang auto` 按你写的话自动选。",
  ]);
});

test("/memory on|off switches memory in Claw as the person, and says how to write it otherwise", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/memory on"));
  await w.router.handle(message("关掉记忆"));
  await w.router.handle(message("/memory maybe"));
  assert.deepEqual(w.claw.memoryWrites, [true, false]);
  const [on = "", off = "", usage = ""] = said(w);
  assert.ok(on.startsWith("Memory is **on**: from now on") && off.startsWith("记忆已**关闭**"));
  assert.ok(usage.startsWith("用 `/memory on` 打开记忆"));
});

test("/repo binds the next session, lists the recent ones with a button each, and a tap does the same", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/repo"));
  await w.router.handle(message("/repo not a repo"));
  await w.router.handle(message("/repo AMD-AGI/PrimusClaw dev"));
  await w.router.handle(message("/repo"));
  await w.router.handle(message("first task"));
  await w.router.settled();
  assert.deepEqual(w.turns.runs[0]?.repo, { url: "https://github.com/AMD-AGI/PrimusClaw", branch: "dev" });
  await w.router.handle(message("second"));
  await w.router.settled();
  assert.equal(w.turns.runs[1]?.repo, null); // (the choice is used up)
  await w.router.handle(clickOf("repo", { repo: "o/r", branch: "" }));
  await w.router.handle(clickOf("repo", { repo: "../x", branch: "" }));
  const lines = said(w);
  assert.ok(lines[0]?.startsWith("You have not picked a repository yet. Use `/repo owner/name [branch]`"));
  assert.ok(lines[1]?.startsWith("I could not read that as a repository."));
  assert.ok(lines[2]?.startsWith("Your next message starts a new session in **AMD-AGI/PrimusClaw** (branch dev)."));
  assert.equal(lines[3], "Tap a repository to start a new session in it, or send `/repo owner/name [branch]`.");
  assert.equal(lines[4], "<view:repo>");
  assert.ok(
    lines.includes(
      "note::Your next message starts a new session in o/r (the default branch). PrimusClaw checks the repository out when the task starts, so the first answer takes a little longer. `/new` leaves the repository.",
    ),
  );
  assert.ok(lines.includes("note::That button is no longer valid."));
  assert.deepEqual(w.store.repoHistory.getPendingRepo(ALICE.id), { repo: "o/r", branch: "" });
});

test("/repo and its tap are refused while a task runs; /new too", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  let release = (): void => undefined;
  w.turns.hold = new Promise((resolve) => {
    release = resolve;
  });
  await w.router.handle(message("long task"));
  await w.router.handle(message("/repo o/r"));
  await w.router.handle(clickOf("repo", { repo: "o/r", branch: "" }));
  await w.router.handle(message("/new"));
  release();
  await w.router.settled();
  const lines = said(w);
  assert.ok(lines.includes("A task is still running. Send /stop first, then /repo."));
  assert.ok(
    lines.includes("note::A task is still running. Send /stop first, then tap the repository again. [Use this repo]"),
  );
  assert.ok(lines.includes("A task is still running. Send /stop first, then /new."));
  assert.equal(w.store.repoHistory.getPendingRepo(ALICE.id), null);
});

test("/sessions lists the caller's own sessions checked with their key, and forgets the ones Claw refuses", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  await w.router.handle(message("/sessions"));
  for (const id of ["s1", "s2", "s3"]) w.store.repoHistory.noteSession(ALICE.id, id, { title: `t-${id}` });
  w.claw.busy.set("s2", 404);
  w.claw.busy.set("s3", 503);
  w.store.sessions.setSession(ALICE.id, { sessionId: "s1" });
  await w.router.handle(message("/sessions"));
  const lines = said(w);
  assert.equal(lines[0], "There are no earlier sessions in this chat yet. Send me a message to start one.");
  assert.deepEqual(lines.slice(1), [
    "Your last sessions. Show here puts one back as this chat's session, with everything it remembers.",
    "<view:session>",
  ]);
  assert.deepEqual(
    w.store.repoHistory
      .sessionHistory(ALICE.id)
      .map((s) => s.sessionId)
      .sort(),
    ["s1", "s3"],
  );
  w.claw.busy.set("s1", 503);
  await w.router.handle(message("/sessions"));
  assert.equal(said(w).at(-1), "I could not check your sessions just now. Please try again in a minute.");
});

test("/stop with no turn of mine interrupts a session that is busy on Claw, and says so", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  w.store.sessions.setSession(ALICE.id, { sessionId: "s1" });
  w.claw.busy.set("s1", true);
  await w.router.handle(message("/stop"));
  assert.equal(
    said(w).at(-1),
    "PrimusClaw is still busy on this session (I have no reply open for it). I sent it a stop.",
  );
  w.claw.busy.set("s1", false);
  await w.router.handle(message("停一下"));
  assert.equal(said(w).at(-1), "现在没有在运行的任务。"); // (said in Chinese: what they wrote says their language)
  w.claw.busy.set("s1", 404);
  await w.router.handle(message("/stop"));
  assert.equal(said(w).at(-1), "现在没有在运行的任务。");
});

test("a message sent while a turn runs waits for it to run and goes behind it; a third is refused", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  let release = (): void => undefined;
  w.turns.hold = new Promise((resolve) => {
    release = resolve;
  });
  await w.router.handle(message("first"));
  await w.router.handle(message("second"));
  await w.router.handle(message("third"));
  await w.router.handle(message("/stop"));
  release();
  await w.router.settled();
  assert.deepEqual(
    w.turns.calls.map((c) => c.at(-1)),
    ["first", "second"],
  );
  assert.ok(said(w).some((t) => t.startsWith("One message is already waiting behind the running task")));
  assert.ok(
    said(w).includes(
      "Stopping the running task. The message you sent after it runs next; send /stop again to interrupt that one too.",
    ),
  );
});

test("the task limit refuses one task too many, in the person's language", async () => {
  const w = world({ limits: { maxConcurrentTasks: 1 } });
  link(w, ALICE.id, "ak");
  w.store.sessions.setSession(ALICE.id, { sessionId: "s1" });
  let release = (): void => undefined;
  w.turns.hold = new Promise((resolve) => {
    release = resolve;
  });
  await w.router.handle(message("one", { kind: "group", conversation: "g-9" }));
  await w.router.handle(message("two"));
  release();
  await w.router.settled();
  assert.ok(said(w).includes("en: 1 running"));
  assert.equal(w.events.at(-1)?.["operation"], "claw_turn");
});

test("a message over the person's rate is dropped and said once; /stop always goes through", async () => {
  const w = world({
    limits: {
      checkMessage: () => ({ allowed: false, notify: true, retryAfterSeconds: 4.2, limit: 3, windowSeconds: 60 }),
    },
  });
  link(w, ALICE.id, "ak");
  await w.router.handle(message("hello"));
  await w.router.handle(message("/stop"));
  assert.deepEqual(said(w), ["en: wait 4.2", "Nothing is running."]);
  assert.deepEqual(w.limited, ["user_limit"]);
  assert.equal(w.events[0]?.["retry_after_seconds"], 5);
});

test("Create PR asks the agent in the chat's own session, and nowhere else", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  w.store.sessions.setSession(ALICE.id, { sessionId: "s1" });
  await w.router.handle(clickOf("create_pr", { session_id: "other" }));
  await w.router.handle(clickOf("create_pr", { session_id: "s1" }));
  await w.router.settled();
  assert.ok(said(w)[0]?.startsWith("note::That button belongs to another session."));
  assert.ok(
    said(w).includes(
      "note::Asking the agent to open a pull request. If it needs to push, you will get an approval request.",
    ),
  );
  assert.ok(w.turns.calls[0]?.at(-1)?.toString().startsWith("Open a pull request for the changes in this session."));
});

test("a button of an unconnected chat, and one nobody handles, are settled with a note", async () => {
  const w = world();
  await w.router.handle(clickOf("repo", { repo: "o/r" }));
  link(w, ALICE.id, "ak");
  await w.router.handle(clickOf("mystery", {}));
  assert.deepEqual(said(w), [
    "note::This chat is not connected to a PrimusClaw account (or I could not check it just now). Send me a message to see how to connect.",
    "This chat is not connected to a PrimusClaw account (or I could not check it just now). Send me a message to see how to connect.",
    "note::That button is not active any more.",
    "That button is not active any more.",
  ]);
});

test("the unlink word of the menu asks first; the typed /unlink unlinks", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  await w.router.handle(message("断开我的账号"));
  assert.ok(said(w)[0]?.startsWith("`unlink` 会断开这个聊天"));
  assert.notEqual(w.store.links.getKey(ALICE.id), null);
});

test("/memory with memory on says how to turn it off, in each language (internal #463)", async () => {
  const w = world();
  link(w, ALICE.id, "ak");
  w.claw.memory = new Map([["ak", { enabled: true, available: true, items: ["likes tabs"] }]]);
  await w.router.handle(message("/memory"));
  await w.router.handle(message("/memory", { locale: "zh-CN", user: { ...ALICE } }));
  w.store.prefs.setLang(ALICE.id, "zh");
  await w.router.handle(message("/memory"));
  const page = "https://claw.example.com/primus-claw?memory=1";
  assert.equal(
    said(w)[0],
    'Memory is **on** (on by default; say "turn memory off" or send `/memory off` to turn it off). ' +
      `Latest items:\n- likes tabs\n\nSee all or delete at ${page}`,
  );
  assert.equal(
    said(w).at(-1),
    `记忆是**开**的（默认开启，说“关闭记忆”或发 \`/memory off\` 可关）。最近的条目：\n- likes tabs\n\n查看全部或删除：${page}`,
  );
});
