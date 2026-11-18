// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { FakeAssistantClaw } from "../../../../test-support/assistant/claw.js";
import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { SeededRandom } from "../../../../test-support/random.js";
import { FakeSurface, testConversation, type Recorded } from "../../../../test-support/surface.js";
import {
  AssistantChat,
  OFF_SECONDS,
  attachedOf,
  type AssistantChatOptions,
  type ChatStore,
} from "../../src/assistant/chat.js";
import { Receipts } from "../../src/assistant/receipts.js";
import { ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import { DirectChat } from "../../src/direct-chat/direct-chat.js";
import { silentLogger } from "../../src/ports/logger.js";
import type { Prefs } from "../../src/ports/store/index.js";
import type { InboundFile, SurfaceCaps } from "../../src/ports/surface.js";

const ALICE = "aad-a";

class Store {
  now = 1_700_000_000;
  lang = "";
  langSet = false;
  timezone = "";
  userIds = new Map([[ALICE, "u-a"]]);
  sessions = new Map<string, string>();
  slices(): ChatStore {
    return {
      now: () => this.now,
      prefs: {
        getPrefs: () => ({ lang: this.lang, langSet: this.langSet, timezone: this.timezone }) as Prefs,
      } as unknown as ChatStore["prefs"],
      sessions: { getSession: (u: string) => this.sessions.get(u) ?? null } as unknown as ChatStore["sessions"],
      remoteState: { getRemote: () => null } as unknown as ChatStore["remoteState"],
      links: { clawUserIdOf: (u: string) => this.userIds.get(u) ?? null },
    };
  }
}

function world(options: Partial<AssistantChatOptions> & { streaming?: boolean; caps?: Partial<SurfaceCaps> } = {}) {
  const store = new Store();
  const claw = new FakeAssistantClaw();
  const clock = new FakeClock();
  const surface = new FakeSurface({ caps: { streaming: options.streaming ?? true, ...options.caps } });
  const ref = { ...testConversation(`c-${ALICE}`), wire: { conversation: { id: `c-${ALICE}` }, activityId: "act-1" } };
  const conversation = surface.conversation(ref);
  const dropped: number[] = [];
  let legacy = false;
  const chat = new AssistantChat({
    store: store.slices(),
    claw,
    hasAssistantTypes: () => true,
    receipts: new Receipts(clock, silentLogger),
    directChat: new DirectChat(false),
    clock,
    random: new SeededRandom(3),
    logger: silentLogger,
    stepLabel: (tool) => tool,
    style: () => ({ assistantProgress: true, assistantStreamSay: true }),
    enabled: true,
    users: new Set(),
    understanding: new Set(),
    pluginId: undefined,
    assistantName: "",
    legacyTurn: () => legacy,
    files: undefined,
    onFilesDropped: (_path, count) => dropped.push(count),
    board: { show: () => Promise.resolve() },
    commands: {
      parse: (t) => /^\/(\w+)/.exec(t)?.[1],
      args: (t, name) => (t.startsWith(`/${name}`) ? t.slice(name.length + 1).trim() : undefined),
    },
    ...options,
  });
  return {
    store,
    claw,
    clock,
    surface,
    conversation,
    chat,
    dropped,
    setLegacy: (on: boolean) => {
      legacy = on;
    },
  };
}

function said(outbox: readonly Recorded[], finals = true): string[] {
  return outbox.flatMap((r) => {
    if (r.op === "send" && r.message.body.type === "text") return [r.message.body.text];
    if (r.op === "stream.finish" && r.message.body.type === "text")
      return [`${finals ? "final:" : ""}${r.message.body.text}`];
    return [];
  });
}

const route = (
  w: ReturnType<typeof world>,
  prompt: string,
  extra: { files?: InboundFile[]; attached?: null | Record<string, string | boolean | number> } = {},
) =>
  w.chat.route({
    userId: ALICE,
    credential: "ak-alice",
    prompt,
    conversation: w.conversation,
    files: extra.files ?? [],
    ...(extra.attached === undefined ? {} : { attached: extra.attached }),
  });

it("a message goes to the assistant as typed and nothing waits for the answer", async () => {
  const w = world();
  assert.equal(await route(w, "看看 SaFE 节点"), true);
  assert.deepEqual(
    w.claw.heard.map((h) => [h.key, h.sessionId, h.text, h.context, h.plugin]),
    [["ak-alice", "asst-ak-alice", "看看 SaFE 节点", { channel: "teams", timezone: "Asia/Shanghai" }, undefined]],
  );
  assert.deepEqual(w.surface.outbox[0], {
    op: "stream.open",
    conversation: `c-${ALICE}`,
    replyTo: "act-1",
    text: "收到，处理中",
    id: "m1",
  });
  assert.equal(await route(w, "and another thing"), true);
  assert.equal(w.claw.heard.length, 2);
});

it("without a stream the typing indicator acknowledges the message", async () => {
  const w = world({ streaming: false });
  await route(w, "hello there friend");
  assert.equal(w.surface.outbox[0]?.op, "typing");
});

it("the plugin id and the attached session ride on the message", async () => {
  const w = world({ pluginId: 7 });
  await route(w, "which session is this chat on", { attached: { label: "Claude", busy: true, n: 3 } });
  assert.deepEqual(w.claw.heard[0]?.context, {
    channel: "teams",
    attached: { label: "Claude", busy: true },
    timezone: "Asia/Shanghai",
  });
  assert.equal(w.claw.heard.at(0)?.plugin, 7);
  await route(w, "again", { attached: null });
  assert.deepEqual(w.claw.heard[1]?.context, { channel: "teams", attached: null, timezone: "Asia/Shanghai" });
});

it("the language the person chose rides on the message, whatever it is written in; none chosen sends nothing", async () => {
  const w = world();
  // /lang en, a message in Chinese: the assistant is told to answer in English.
  w.store.lang = "en";
  w.store.langSet = true;
  await route(w, "看看 SaFE 节点");
  assert.deepEqual(w.claw.heard[0]?.context, { channel: "teams", reply_language: "en", timezone: "Asia/Shanghai" });
  // /lang zh, a message in English, beside the attached session.
  w.store.lang = "zh";
  await route(w, "check the nodes", { attached: null });
  assert.deepEqual(w.claw.heard[1]?.context, {
    channel: "teams",
    attached: null,
    reply_language: "zh",
    timezone: "Asia/Shanghai",
  });
  // /lang auto (a language learnt from what they write is no choice): no language is sent, and Claw reads the message as before.
  w.store.langSet = false;
  await route(w, "看看 SaFE 节点");
  assert.deepEqual(w.claw.heard[2]?.context, { channel: "teams", timezone: "Asia/Shanghai" });
  // A choice of a language the agent does not speak is none.
  w.store.lang = "fr";
  w.store.langSet = true;
  await route(w, "regarde les nœuds");
  assert.deepEqual(w.claw.heard[3]?.context, { channel: "teams", timezone: "Asia/Shanghai" });
});

it("a message names the surface it came from, so Claw sends the turn's replies back there and not to another surface", async () => {
  const w = world({ caps: { channel: "slack", name: "Slack", shortName: "Slack" } });
  await route(w, "deploy the fix");
  assert.deepEqual(w.claw.heard[0]?.context, { channel: "slack", timezone: "Asia/Shanghai" });
});

it("a claw without the assistant keeps the old path and is not asked again for a minute", async () => {
  const w = world();
  w.claw.fail.set("session", new ClawError(404));
  assert.equal(await route(w, "hi"), false);
  assert.equal(w.chat.on(ALICE), false);
  w.claw.fail.clear();
  w.store.now += OFF_SECONDS - 1;
  assert.equal(await route(w, "hi"), false);
  w.store.now += 1;
  assert.equal(await route(w, "hi"), true);
});

it("any other failure tells the user and does not fall back to a session", async () => {
  for (const [fail, text] of [
    [new ClawError(500), "I cannot reach your assistant just now. Please send that again in a moment."],
    [
      new ClawUnreachable("network", "x"),
      "I cannot reach your assistant just now. Please send that again in a moment.",
    ],
    [
      new ClawError(401),
      "PrimusClaw rejected your linked key (it may have expired or been deleted). Send /unlink, then link again.",
    ],
  ] as const) {
    const w = world();
    w.claw.fail.set("session", fail);
    assert.equal(await route(w, "hi"), true);
    assert.deepEqual(said(w.surface.outbox), [text]);
  }
});

it("a message claw did not take closes the receipt with why", async () => {
  const w = world();
  w.claw.fail.set("send", new ClawError(503));
  assert.equal(await route(w, "hi"), true);
  assert.deepEqual(said(w.surface.outbox), [
    "final:I cannot reach your assistant just now. Please send that again in a moment.",
  ]);
});

it("only a person whose subscription has the assistants events and whose claw id is known talks to it", () => {
  const w = world({ hasAssistantTypes: () => false });
  assert.equal(w.chat.on(ALICE), false);
  const x = world();
  x.store.userIds.clear();
  assert.equal(x.chat.on(ALICE), false);
  const none = world({ hasAssistantTypes: undefined });
  assert.equal(none.chat.reachable(ALICE), false);
});

it("a turn of the old kind that is running is let finish", async () => {
  const w = world();
  w.setLegacy(true);
  assert.equal(await route(w, "hi"), false);
  w.setLegacy(false);
  assert.equal(await route(w, "hi"), true);
});

it("the first message waits for a busy old session and later ones never do", async () => {
  const w = world();
  w.store.sessions.set(ALICE, "old-1");
  w.claw.running.add("old-1");
  assert.equal(await route(w, "hi"), false);
  w.claw.running.delete("old-1");
  assert.equal(await route(w, "hi"), true);
  w.claw.running.add("old-1");
  assert.equal(await route(w, "hi"), true);
  w.chat.forget(ALICE);
  assert.equal(await route(w, "hi"), false);
  w.claw.fail.set("turn", new ClawError(404));
  assert.equal(await route(w, "hi"), true);
  w.chat.forget(ALICE);
  w.claw.fail.set("turn", new ClawError(500));
  assert.equal(await route(w, "hi"), false);
  w.claw.fail.set("turn", new ClawUnreachable("timeout", "turn"));
  assert.equal(await route(w, "hi"), false);
});

it("with the switch off or the person not listed nothing asks for the assistant", async () => {
  const off = world({ enabled: false });
  assert.equal(await route(off, "hi"), false);
  assert.deepEqual(off.claw.calls, []);
  const listed = world({ users: new Set(["aad-b"]) });
  assert.equal(listed.chat.forUser(ALICE), false);
  assert.equal(listed.chat.forUser("AAD-B"), true);
});

it("new sessions and repo are not commands with the assistant", () => {
  const w = world();
  assert.ok(w.chat.hiddenCommand("/new", "en")?.startsWith("I keep one conversation"));
  assert.ok(w.chat.hiddenCommand("/sessions", "zh")?.includes("会话"));
  assert.ok(w.chat.hiddenCommand("/repo AMD-AGI/PrimusClaw", "en")?.startsWith("Just say which repository"));
  assert.equal(w.chat.hiddenCommand("/board", "en"), undefined);
});

it("stop interrupts what the assistant is doing and says how to stop a task", async () => {
  const w = world();
  w.claw.running.add("asst-ak-alice");
  await w.chat.stop(ALICE, "ak-alice", w.conversation);
  await w.chat.stop(ALICE, "ak-alice", w.conversation);
  w.claw.fail.set("turn", new ClawUnreachable("network", "turn"));
  await w.chat.stop(ALICE, "ak-alice", w.conversation);
  const lines = said(w.surface.outbox);
  assert.ok(lines[0]?.startsWith("Stopped what I was doing. To stop a task"));
  assert.ok(lines[1]?.startsWith("I am not busy right now. "));
  assert.equal(lines[2], "I could not reach your assistant just now. Please try again in a moment.");
});

it("stop answers in the chat's language", async () => {
  const w = world();
  w.claw.running.add("asst-ak-alice");
  await w.chat.stop(ALICE, "ak-alice", w.conversation, undefined, "zh");
  await w.chat.stop(ALICE, "ak-alice", w.conversation, undefined, "zh");
  w.claw.fail.set("turn", new ClawUnreachable("network", "turn"));
  await w.chat.stop(ALICE, "ak-alice", w.conversation, undefined, "zh");
  assert.deepEqual(said(w.surface.outbox), [
    "已停下刚才在做的事。要停止某个任务，说「停止 #2」（编号见 /board），或者点它卡片下的「停止」。",
    "我现在没有在忙。要停止某个任务，说「停止 #2」（编号见 /board），或者点它卡片下的「停止」。",
    "暂时连不上你的助理，请稍后再试。",
  ]);
});

it("the person's time zone rides on every message to the assistant: the one they set, else the default their quiet hours use", async () => {
  // None set, or one this runtime does not know: Asia/Shanghai, as quiet hours read it. Claw answers "what day is it" in it.
  const w = world();
  await route(w, "今天是星期几？");
  assert.equal(w.claw.heard[0]?.context?.["timezone"], "Asia/Shanghai");
  w.store.timezone = "Mars/Olympus";
  await route(w, "what day is it");
  assert.equal(w.claw.heard[1]?.context?.["timezone"], "Asia/Shanghai");
  // /timezone America/Los_Angeles: theirs.
  w.store.timezone = "America/Los_Angeles";
  await route(w, "what day is it");
  assert.equal(w.claw.heard[2]?.context?.["timezone"], "America/Los_Angeles");
});

it("the bot's configured name rides on every message to the assistant, trimmed; none configured sends none", async () => {
  // A deployment that names its bot "Clawy": the assistant is told the name its people use, on both ways a message reaches it.
  const w = world({ assistantName: " Clawy ", understanding: new Set([ALICE]) });
  await route(w, "how is Clawy doing");
  assert.deepEqual(w.claw.heard[0]?.context, { channel: "teams", assistant_name: "Clawy", timezone: "Asia/Shanghai" });
  w.store.lang = "zh";
  w.store.langSet = true;
  await route(w, "Clawy最近运行如何", { attached: null });
  assert.deepEqual(w.claw.heard[1]?.context, {
    channel: "teams",
    attached: null,
    reply_language: "zh",
    assistant_name: "Clawy",
    timezone: "Asia/Shanghai",
  });
  const understood = {
    userId: ALICE,
    credential: "idt-token",
    modelKey: "",
    prompt: "how is Clawy doing",
    context: { channel_message_id: "m-1" },
    lang: "en" as const,
    conversation: w.conversation,
    files: [],
  };
  assert.equal(await w.chat.understand(understood), true);
  assert.deepEqual(w.claw.heard[2]?.context, {
    channel_message_id: "m-1",
    reply_language: "zh",
    assistant_name: "Clawy",
    timezone: "Asia/Shanghai",
  });
  // A deployment left with the default name sends that name.
  const unset = world({ assistantName: "PrimusClaw Assistant" });
  await route(unset, "hello");
  assert.deepEqual(unset.claw.heard[0]?.context, {
    channel: "teams",
    assistant_name: "PrimusClaw Assistant",
    timezone: "Asia/Shanghai",
  });
  // No name (or only spaces): nothing is sent, and the message is as it was.
  const none = world({ assistantName: "  " });
  await route(none, "hello");
  assert.deepEqual(none.claw.heard[0]?.context, { channel: "teams", timezone: "Asia/Shanghai" });
});

it("a person the assistant understands sends with their token and model key and is told when it cannot be reached", async () => {
  const w = world({ understanding: new Set([ALICE]) });
  assert.equal(w.chat.understands(ALICE), true);
  const request = {
    userId: ALICE,
    credential: "idt-token",
    modelKey: "ak-alice",
    prompt: "review #12",
    context: { channel_message_id: "m-1" },
    lang: "en" as const,
    conversation: w.conversation,
    files: [],
  };
  assert.equal(await w.chat.understand(request), true);
  assert.deepEqual(
    [w.claw.heard[0]?.key, w.claw.heard[0]?.modelKey, w.claw.heard[0]?.context],
    ["idt-token", "ak-alice", { channel_message_id: "m-1", timezone: "Asia/Shanghai" }],
  );
  // The language they chose goes beside the chat's context.
  w.store.lang = "zh";
  w.store.langSet = true;
  assert.equal(await w.chat.understand({ ...request, prompt: "review #12 please" }), true);
  assert.deepEqual(w.claw.heard[1]?.context, {
    channel_message_id: "m-1",
    reply_language: "zh",
    timezone: "Asia/Shanghai",
  });
  w.store.langSet = false;
  w.claw.fail.set("send", new ClawError(403));
  assert.equal(await w.chat.understand({ ...request, credential: "ak-alice", modelKey: "" }), false);
  assert.ok(said(w.surface.outbox).at(-1)?.includes("PrimusClaw rejected your linked key"));
  assert.equal(await w.chat.understand({ ...request, lang: "zh" }), false);
  assert.ok(said(w.surface.outbox, false).at(-1)?.startsWith("暂时连不上你的助理"));
  const unreachable = world({ understanding: new Set([ALICE]), hasAssistantTypes: () => false });
  assert.equal(await unreachable.chat.understand({ ...request, conversation: unreachable.conversation }), false);
  assert.deepEqual(unreachable.claw.calls, []);
});

it("files go before the message names them and those that do not are named back", async () => {
  const fetched = { name: "a.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
  const w = world({
    files: {
      fetch: () =>
        Promise.resolve({ fetched: [fetched, { ...fetched, name: "b.png" }], failed: [["c.pdf", "too large"]] }),
      uploadFolder: (id) => `.uploads/${id}`,
      failedLine: (failed) => `could not: ${failed.map(([n, why]) => `${n} (${why})`).join("; ")}`,
    },
  });
  w.claw.refuseFiles.add("b.png");
  const file: InboundFile = { name: "a.png", type: "image/png", handle: {} };
  await route(w, "look", { files: [file] });
  const context = w.claw.heard[0]?.context;
  assert.ok(context && Array.isArray(context["files"]));
  assert.deepEqual((context["files"] as unknown[])[0], {
    path: `${w.claw.uploads[0]?.folder.replace(".uploads/", "") ?? ""}/a.png`,
    name: "a.png",
    media_type: "image/png",
    size: 3,
  });
  assert.deepEqual(w.dropped, [2]);
  assert.ok(said(w.surface.outbox).includes("could not: c.pdf (too large); b.png (Claw did not take it)"));
  const none = world();
  await route(none, "look", { files: [file] });
  assert.ok(said(none.surface.outbox).includes("I could not pass on `a.png` (this worker does not take files)."));
  assert.equal(none.chat.filesOnly("zh"), "（发来了文件，没有附言）");
});

it("the turn that answers is followed into the receipt", async () => {
  const w = world();
  w.claw.script = [
    { id: "", name: "toolUsed", data: { message_id: "msg-1", tool: "mcp__safe__nodes", status: "start" } },
  ];
  await route(w, "nodes?");
  await new Promise((r) => setTimeout(r, 5));
  await flushMicrotasks();
  assert.ok(w.surface.outbox.some((r) => r.op === "stream.inform" && r.text === "mcp__safe__nodes…"));
});

it("the attached session is told with its text clipped", () => {
  assert.deepEqual(attachedOf({ a: "x".repeat(300), b: false, c: 1 }), { a: "x".repeat(200), b: false });
  assert.equal(attachedOf(null), null);
});

it("claw taking a message is told once and a failure of what follows never fails the message", async () => {
  const w = world();
  const told: (string | null)[] = [];
  assert.equal(
    await w.chat.route({
      userId: ALICE,
      credential: "ak-alice",
      prompt: "hi",
      conversation: w.conversation,
      files: [],
      onSent: (sessionId, messageId) => {
        told.push(`${sessionId} ${String(messageId)}`);
        throw new Error("the stop card could not be sent");
      },
    }),
    true,
  );
  assert.deepEqual(told, ["asst-ak-alice msg-1"]);
  w.claw.queue = true;
  await w.chat.understand({
    userId: ALICE,
    credential: "ak-alice",
    modelKey: "",
    prompt: "again",
    context: {},
    lang: "en",
    conversation: w.conversation,
    files: [],
    onSent: (sessionId, messageId) => told.push(`${sessionId} ${String(messageId)}`),
  });
  assert.deepEqual(told, ["asst-ak-alice msg-1", "asst-ak-alice null"]);
});

it("a stop for one message interrupts only the turn answering it", async () => {
  const w = world();
  w.claw.running.add("asst-ak-alice");
  w.claw.turnMessage = "msg-7";
  assert.equal(await w.chat.stop(ALICE, "ak-alice", w.conversation, "msg-6"), false);
  assert.ok(w.claw.running.has("asst-ak-alice"));
  assert.equal(await w.chat.stop(ALICE, "ak-alice", w.conversation, "msg-7"), true);
  assert.ok(!w.claw.running.has("asst-ak-alice"));
  assert.equal(await w.chat.stop(ALICE, "ak-alice", w.conversation, "msg-7"), false);
  assert.equal(said(w.surface.outbox).length, 1);
});

it("new sessions and repo answer in the chats language", () => {
  const w = world();
  for (const [command, mentions] of [
    ["/new", "没有会话需要新建或切换"],
    ["/sessions", "没有会话需要新建或切换"],
    ["/repo AMD-AGI/PrimusClaw main", "在消息里直接说是哪个仓库"],
  ] as const) {
    const said = w.chat.hiddenCommand(command, "zh") ?? "";
    assert.ok(said.includes(mentions), said);
    assert.ok(!said.includes("sessions to start or switch") && !said.includes("Just say which repository"));
  }
  assert.deepEqual(w.claw.calls, []);
});
