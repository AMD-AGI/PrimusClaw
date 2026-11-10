// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The session card as the window (test_session_window, the card itself). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteDomain, remoteView } from "@primusclaw/personal-agent";

import { cardOf } from "../../../../test-support/adaptive-card.js";
import { assertValidCard } from "./card-schema.js";
import { windowState as windowOf } from "../../../../test-support/card-catalog/remote.js";
import { windowCard } from "../../src/views/remote/index.js";
import { status } from "./fixtures.js";

type Json = Record<string, unknown>;
const data = (b: Json): Json => b["data"] as Json;

function card(
  lang: "en" | "zh",
  view: ReturnType<typeof windowOf>,
  approvals: remoteDomain.WindowApproval[] = [],
  phase: remoteDomain.StatusPhase = "working",
  extra: Partial<remoteDomain.WindowInput> = {},
): Json {
  const built = cardOf(
    windowCard(
      remoteView.windowView({
        label: "🟠 Claude Code",
        host: "robin-dev",
        cwd: "/root/ws/active",
        mode: "default",
        sessionId: "rs-1",
        phase,
        at: 1_794_000_000,
        lang,
        view,
        approvals,
        hasModes: true,
        bot: "Clawy",
        ...extra,
      }),
    ),
  );
  assertValidCard(built);
  return built;
}

function words(node: unknown): string {
  return JSON.stringify(node);
}
const titles = (c: Json): unknown[] => (c["actions"] as Json[]).map((a) => a["title"]);
const hasBox = (c: Json): boolean => (c["body"] as Json[]).some((b) => b["type"] === "Input.Text");

test("the card in both languages", () => {
  const cases: ["en" | "zh", string[]][] = [
    [
      "zh",
      [
        "会话窗口 · robin-dev · Claude Code",
        "状态：运行中（Run pytest）",
        "你从卡片发的：run the tests",
        "在聊天框里打字是跟 Clawy 说",
        "更新于",
      ],
    ],
    [
      "en",
      [
        "Session window · robin-dev · Claude Code",
        "Status: running (Run pytest)",
        "You sent from the card: run the tests",
        "What you type in the chat box goes to Clawy",
        "Updated",
      ],
    ],
  ];
  for (const [lang, expected] of cases) {
    const view = windowOf({ text: "hello", step: "Run pytest", sent: "run the tests" });
    const c = card(lang, view);
    for (const w of expected) assert.ok(words(c).includes(w), w);
    // a running turn's card has no text box (and no Send): it is edited every few seconds
    assert.deepEqual(
      titles(c),
      lang === "zh" ? ["停止", "回到助理", "切换会话"] : ["Stop", "Back to assistant", "Switch"],
    );
    assert.ok(!hasBox(c));
    assert.ok(
      words(c).includes(
        lang === "zh" ? "这一轮结束后，输入框会回到卡片上" : "The text box comes back on the card when this turn ends",
      ),
    );
    const idle = card(lang, view, [], "idle");
    assert.deepEqual(
      titles(idle),
      lang === "zh" ? ["发送", "停止", "回到助理", "切换会话"] : ["Send", "Stop", "Back to assistant", "Switch"],
    );
    assert.ok((idle["body"] as Json[]).some((b) => b["type"] === "Input.Text" && b["id"] === "window_text"));
    assert.equal(
      remoteView.windowView({
        label: "x",
        host: "h",
        cwd: "/",
        mode: null,
        sessionId: "s",
        phase: "idle",
        at: 0,
        lang,
        view,
        approvals: [],
        bot: "Clawy",
      }).takesInput,
      true,
    );
  }
});

test("the output is bounded with more behind a toggle and made inert", () => {
  const text = Array.from({ length: 200 }, (_, i) => `row ${String(i)} [link](http://evil) <b>x</b> __bold__`).join(
    "\n",
  );
  const c = card("en", windowOf({ text }));
  const body = c["body"] as Json[];
  const tail = body.find((b) => b["id"] === "window_tail") ?? {};
  const more = body.find((b) => b["id"] === "window_more") ?? {};
  const items = tail["items"] as Json[];
  assert.ok(items.length <= remoteView.TAIL_LINES);
  assert.ok(items.reduce((n, i) => n + String(i["text"]).length, 0) <= remoteView.TAIL_CHARS + 400);
  assert.equal(more["isVisible"], false);
  assert.ok((more["items"] as Json[]).length > 0);
  const shown = items.map((i) => String(i["text"])).join("\n");
  assert.ok(
    shown.includes("row 199") && !shown.includes("](") && !shown.includes("<b>") && shown.includes("\\_\\_bold"),
  );
  const row = body.find((b) => b["type"] === "ActionSet") ?? {};
  const actions = row["actions"] as Json[];
  assert.deepEqual(
    actions.slice(0, 2).map((a) => a["type"]),
    ["Action.ToggleVisibility", "Action.Execute"],
  );
  assert.equal(data(actions[1] ?? {})["op"], "full");
});

test("an output line is never read as markup or a list item", () => {
  assert.equal(remoteView.outputLine("- item\t1\u0007"), "\u{200b}- item    1");
  assert.equal(remoteView.outputLine("  12) twelve"), "\u{200b}  12) twelve");
  assert.equal(remoteView.outputLine("x".repeat(500)).length, remoteView.LINE_MAX);
});

test("the agents words outside the output are inert too", () => {
  const approval = { actionId: "a1", tool: "**APPROVED** `x` [y](http://evil)", expiresAt: 1_794_000_600, buttons: [] };
  const view = windowOf({ step: "**fake status**", sent: "__hi__", note: "*n*" });
  const all = words(card("en", view, [approval]));
  for (const raw of ["**fake status**", "**APPROVED**", "`x`", "](", "__hi__", " *n*"])
    assert.ok(!all.includes(raw), raw);
  const running = words(card("en", view));
  assert.ok(!running.includes("**fake status**") && running.includes("\\\\*\\\\*fake status\\\\*\\\\*"));
});

test("a waiting approval and a busy terminal are its state", () => {
  const button: remoteDomain.DecisionButton = {
    title: "Allow once",
    sessionId: "rs-1",
    actionId: "a1",
    optionId: "y",
    primary: false,
  };
  const approval = { actionId: "a1", tool: "Bash: rm -rf build", expiresAt: 1_794_000_600, buttons: [button] };
  assert.ok(words(card("zh", windowOf(), [approval], "idle")).includes("状态：等你批准"));
  assert.ok(
    words(card("en", windowOf({ queued: "a turn is running" }), [], "idle")).includes(
      "Status: the terminal is busy; your message waits (a turn is running)",
    ),
  );
  assert.ok(!hasBox(card("en", windowOf(), [], "watching")), "a watched session takes no input");
  const many = Array.from({ length: 5 }, (_, i) => ({ ...approval, actionId: `a${String(i)}` }));
  assert.ok(words(card("en", windowOf(), many, "idle")).includes("2 more requests wait"));
  const group = card("zh", windowOf(), [approval], "idle", { group: true });
  assert.ok(words(group).includes("它在等批准") && !words(group).includes("Allow once"));
});

test("stop says it interrupts the terminal where messages are typed into one", () => {
  const shared = card("zh", windowOf(), [], "working", { terminal: true, mode: null, hasModes: false });
  assert.equal(titles(shared)[0], "停止（会打断终端里正在跑的这一轮）");
  assert.equal(titles(card("zh", windowOf()))[0], "停止");
  const st = status({
    label: "🟠 Claude Code",
    host: "h",
    cwd: "/",
    mode: null,
    sessionId: "rs-1",
    phase: "idle",
    at: 0,
    terminal: true,
  });
  assert.ok(words(st).includes("Stop (interrupts the turn running in the terminal)"));
});

test("a watched session can be taken over and a starting one says when the box comes", () => {
  const watching = card("en", windowOf(), [], "watching", {
    takeover: { connector_id: "c1", agent_id: "a1", resume: "r1" },
  });
  const takeover = (watching["actions"] as Json[]).find((a) => data(a)["op"] === "takeover") ?? {};
  assert.deepEqual(data(takeover), {
    primusclaw: "remote",
    op: "takeover",
    connector_id: "c1",
    agent_id: "a1",
    resume: "r1",
  });
  assert.ok(!words(watching).includes('"op":"mode"'));
  const starting = card("en", windowOf(), [], "starting", {
    unattended: true,
    conversation: "fix",
    lead: "Attached.",
  });
  for (const w of ["Once the session has started", "Unattended: runs", "conversation “fix”", "Attached."]) {
    assert.ok(words(starting).includes(w), w);
  }
  assert.ok(words(card("en", windowOf(), [], "offline")).includes("the machine is offline"));
});

test("a blank line of the output holds a no-break space as the python worker's does", () => {
  const c = card("en", windowOf({ text: "first\n\n   \nlast" }), [], "idle");
  const tail = (c["body"] as Json[]).find((b) => b["id"] === "window_tail") ?? {};
  assert.deepEqual(
    (tail["items"] as Json[]).map((i) => i["text"]),
    ["first", " ", " ", "last"],
  );
});
