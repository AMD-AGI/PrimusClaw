// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The remote-agent cards (test_remote_view): they validate, their ids and buttons are sound, and they say what they should. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteView } from "@primusclaw/personal-agent";

import { assertValidCard, buttonsOf, cardOf, elements, textsOf } from "../../../../test-support/adaptive-card.js";
import { hiddenCard, machineChoiceCard, modeCard } from "../../src/views/remote/index.js";
import { CONNECTORS, SESSIONS, agent, agents, connector, sessions, status } from "./fixtures.js";

type Json = Record<string, unknown>;
const data = (b: Json): Json => b["data"] as Json;
const NOW = 1_761_700_000.0;

const AGENTS_CASES: [string, Parameters<typeof agents>[0], string[]][] = [
  [
    "machines and sessions",
    { connectors: CONNECTORS, sessions: SESSIONS, attached: "s1", now: NOW },
    ["s2", "s1", "s3"],
  ],
  [
    "with a line on top",
    { connectors: CONNECTORS, sessions: SESSIONS, attached: null, now: NOW, lead: "Closed the session." },
    ["s2", "s1", "s3"],
  ],
  ["no sessions", { connectors: CONNECTORS, sessions: [], attached: null, now: NOW }, []],
  ["no machines", { connectors: [], sessions: SESSIONS, attached: null, now: NOW }, ["s2", "s1", "s3"]],
  [
    "the sessions part alone",
    { connectors: CONNECTORS, sessions: SESSIONS, attached: "s2", now: NOW, machines: false },
    ["s2", "s1", "s3"],
  ],
  [
    "the sessions part alone, none active",
    { connectors: CONNECTORS, sessions: SESSIONS.slice(3), attached: null, now: NOW, machines: false },
    [],
  ],
  [
    "more sessions than the card lists",
    {
      connectors: CONNECTORS,
      sessions: Array.from({ length: 8 }, (_, n) => ({
        ...(SESSIONS[0] as (typeof SESSIONS)[number]),
        sessionId: `n${String(n)}`,
        updatedAt: `2026-10-29T0${String(n)}:00:00Z`,
      })),
      attached: null,
      now: NOW,
    },
    ["n7", "n6", "n5", "n4", "n3"],
  ],
];

test("the agents card validates against adaptive cards 1 5 and its ids and buttons are sound", () => {
  for (const [label, input, listed] of AGENTS_CASES) {
    const { card, listing } = agents(input);
    assertValidCard(card);
    const items = [...elements(card["body"])];
    const ids = items.filter((i) => String(i["type"]).startsWith("Input.")).map((i) => i["id"]);
    assert.equal(ids.length, new Set(ids).size, label); // a card's inputs all come back with every button: no id twice
    const buttons = buttonsOf(card);
    assert.ok(buttons.length > 0, label);
    for (const b of buttons) {
      assert.ok(b["type"] === "Action.Execute" && data(b)["primusclaw"] === "remote" && data(b)["op"], label);
      assert.equal(b["verb"], `primusclaw.remote_${String(data(b)["op"])}`, label);
    }
    assert.deepEqual(listing, listed, label);
    if (listed.length > 0) {
      const closed = new Set(buttons.filter((b) => data(b)["op"] === "close").map((b) => data(b)["session_id"]));
      assert.deepEqual(closed, new Set(listed), label);
    }
  }
});

test("the smaller cards validate too", () => {
  const cards: [string, Json][] = [
    [
      "the status card",
      status({
        label: "⬛ Codex",
        host: "dev-pod",
        cwd: "/home/me/a_b_c",
        mode: "default",
        sessionId: "s1",
        phase: "idle",
        at: 1_762_444_265.0,
        hasModes: true,
      }),
    ],
    [
      "the status card with a lead and the note, in Chinese",
      status({
        label: "⬛ Codex",
        host: "dev-pod",
        cwd: "/a",
        mode: null,
        sessionId: "s1",
        phase: "working",
        at: 0,
        lang: "zh",
        lead: "Attached.",
        unattended: true,
      }),
    ],
    [
      "the status card back at the assistant",
      status({ label: "⬛ Codex", host: "dev-pod", cwd: "/a", mode: null, sessionId: "s1", phase: "detached", at: 0 }),
    ],
    [
      "the status card of a session that ended",
      status({
        label: "⬛ Codex",
        host: "dev-pod",
        cwd: "/a",
        mode: null,
        sessionId: "s1",
        phase: "ended",
        at: 0,
        lang: "zh",
      }),
    ],
    [
      "the sessions card",
      sessions({ connectors: CONNECTORS, sessions: SESSIONS, attached: "s1", now: 1_761_720_000.0 }).card,
    ],
    [
      "the sessions card in Chinese",
      sessions({ connectors: CONNECTORS, sessions: SESSIONS, attached: null, now: 1_761_720_000.0, lang: "zh" }).card,
    ],
    ["the sessions card with no machine", sessions({ connectors: [], sessions: [], attached: null, now: 0 }).card],
    ["the mode picker", cardOf(modeCard(remoteView.modeView("s1", "plan", ["default", "plan"], new Set(["plan"]))))],
    ["the mode picker, not the current one", cardOf(modeCard(remoteView.modeView("s1", "gone", ["default", "plan"])))],
    [
      "the machine choice",
      cardOf(
        machineChoiceCard(
          remoteView.machineChoiceView(
            CONNECTORS[0] as (typeof CONNECTORS)[number],
            (CONNECTORS[0] as (typeof CONNECTORS)[number]).agents,
            "tok",
            "/mnt/x y",
          ),
        ),
      ),
    ],
  ];
  for (const [label, card] of cards)
    assert.doesNotThrow(() => {
      assertValidCard(card);
    }, label);
});

test("the status card says where the chat is and its buttons are the system operations", () => {
  let card = status({
    label: "⬛ Codex",
    host: "dev-pod",
    cwd: "/a",
    mode: null,
    sessionId: "s1",
    phase: "idle",
    at: 1_762_444_265.0,
  });
  const actions = card["actions"] as Json[];
  assert.deepEqual(
    actions.map((a) => a["title"]),
    ["Switch", "Back to assistant", "Stop"],
  );
  assert.deepEqual(new Set(actions.map((a) => data(a)["session_id"])), new Set(["s1"]));
  assert.deepEqual(
    actions.map((a) => data(a)["op"]),
    ["switch", "detach", "stop"],
  );
  assert.ok(
    textsOf(card).includes("🔌 Connected to dev-pod · ⬛ Codex") && textsOf(card).includes("Updated 15:51:05Z"),
  );
  card = status({
    label: "⬛ Codex",
    host: "dev-pod",
    cwd: "/a",
    mode: "plan",
    sessionId: "s1",
    phase: "working",
    at: 0,
    lang: "zh",
    hasModes: true,
  });
  assert.deepEqual(
    (card["actions"] as Json[]).map((a) => a["title"]),
    ["切换会话", "回到助理", "停止", "模式"],
  );
  const texts = textsOf(card);
  assert.ok(
    texts.includes("🔌 已连到 dev-pod · ⬛ Codex") &&
      texts.includes("状态：正在处理") &&
      texts.some((t) => t.includes("模式 plan")),
  );
});

test("the unattended note on the status card follows the users language", () => {
  const zh = textsOf(
    status({
      label: "⬛ Codex",
      host: "dev-pod",
      cwd: "/a",
      mode: null,
      sessionId: "s1",
      phase: "idle",
      at: 0,
      lang: "zh",
      unattended: true,
    }),
  );
  assert.ok(zh.includes("⚠️ 无人值守：执行前不会请求批准") && !zh.some((t) => t.includes("Unattended")));
  const en = textsOf(
    status({
      label: "⬛ Codex",
      host: "dev-pod",
      cwd: "/a",
      mode: null,
      sessionId: "s1",
      phase: "idle",
      at: 0,
      unattended: true,
    }),
  );
  assert.ok(en.includes("Unattended: runs without asking for approval") && !en.some((t) => t.includes("无人值守")));
});

test("the status card back at the assistant offers to go back and one that ended does not", () => {
  let card = status({
    label: "⬛ Codex",
    host: "dev-pod",
    cwd: "/a",
    mode: null,
    sessionId: "s1",
    phase: "detached",
    at: 0,
    lang: "zh",
  });
  assert.deepEqual(
    (card["actions"] as Json[]).map((a) => [a["title"], data(a)["op"]]),
    [
      ["切回这个会话", "attach"],
      ["会话列表", "switch"],
    ],
  );
  assert.ok(textsOf(card).includes("🔌 已回到助理"));
  card = status({ label: "⬛ Codex", host: "dev-pod", cwd: "/a", mode: null, sessionId: "s1", phase: "ended", at: 0 });
  assert.deepEqual(
    (card["actions"] as Json[]).map((a) => data(a)["op"]),
    ["switch"],
  );
});

test("the status card links its session page only while the chat is in the session", () => {
  const sid = "2f6c0b8e-8f6e-4c5e-9d0a-1b2c3d4e5f60";
  const url = remoteView.sessionPageUrl("https://h.example", sid);
  const of = (phase: remoteView.StatusPhase, page = url, lang: "en" | "zh" = "en") =>
    JSON.stringify(
      status({ label: "Claude Code", host: "devbox", cwd: "/r", mode: null, sessionId: sid, phase, at: 0, lang, page }),
    );
  assert.ok(of("idle", url, "zh").includes(`[在单独窗口打开](${url})`));
  assert.ok(of("watching").includes(`[Open in its own window](${url})`)); // (a conversation open in a terminal is watched there too)
  assert.ok(!of("detached").includes(url));
  assert.ok(!of("idle", "").includes("agent-sessions"));
});

test("the page of a session and of the list are under the console", () => {
  const sid = "2f6c0b8e-8f6e-4c5e-9d0a-1b2c3d4e5f60";
  assert.equal(
    remoteView.sessionPageUrl("https://h.example/", sid),
    `https://h.example/primus-claw/agent-sessions/${sid}`,
  );
  assert.equal(remoteView.sessionPageUrl("https://h.example"), "https://h.example/primus-claw/agent-sessions");
  assert.equal(remoteView.sessionPageUrl("", sid), ""); // (no console known: no link)
  // Only an id goes into the path: anything else links the list, never a path someone else's text chose
  assert.equal(
    remoteView.sessionPageUrl("https://h.example", "../../oauth/x"),
    "https://h.example/primus-claw/agent-sessions",
  );
});

test("at most twelve conversations are read and the card with them validates", () => {
  const many = Array.from({ length: 20 }, (_, n) => ({
    ref: `r${String(n)}`,
    title: `T${String(n)}`,
    cwd: "/a",
    updated_at: 1_761_700_000 - n,
    state: ["idle", "live", "attached", "unknown"][n % 4],
  }));
  const a = agent({ agentId: "a", kind: "attach", name: "Attach", capabilities: { resumable: many, roots: ["/a"] } });
  const { card } = agents({
    connectors: [connector({ connectorId: "c1", name: "dev-pod", online: true, agents: [a] })],
    sessions: [],
    attached: null,
    now: 1_761_700_100.0,
  });
  assertValidCard(card);
  const items = [...elements(card["body"])];
  assert.ok(!items.some((i) => String(i["type"]).startsWith("Input."))); // an agent of kind attach starts nothing of its own
  const takeOver = buttonsOf(card).filter((b) => b["title"] === "Take over");
  assert.equal(takeOver.length, remoteView.IDLE_SHOWN);
});

test("conversations are hidden one at a time or all the idle ones and the hidden come back from show hidden", () => {
  const resumable = [
    ...Array.from({ length: 3 }, (_, n) => ({
      ref: `h${String(n)}`,
      title: `t${String(n)}`,
      cwd: "/w",
      updated_at: NOW - n,
      state: "idle",
    })),
    { ref: "u1", title: "unsure", cwd: "/w", state: "unknown" },
    { ref: "old", title: "gone", cwd: "/w", state: "idle", hidden: true },
  ];
  const a = agent({ agentId: "at", kind: "attach", name: "at-main", capabilities: { hidden_count: 2, resumable } });
  const c = connector({ connectorId: "c-hid", name: "devbox-8", online: true, agents: [a] });
  const { card } = agents({ connectors: [c], sessions: [], attached: null, now: NOW });
  assertValidCard(card);
  const hide = buttonsOf(card)
    .filter((b) => data(b)["op"] === "hide")
    .map((b) => [b["title"], data(b)]);
  assert.deepEqual(hide, [
    ["Hide", { primusclaw: "remote", op: "hide", connector_id: "c-hid", ref: "h0" }],
    ["Hide", { primusclaw: "remote", op: "hide", connector_id: "c-hid", ref: "h1" }],
    ["Hide", { primusclaw: "remote", op: "hide", connector_id: "c-hid", ref: "u1" }],
    [
      "Hide all 4 earlier conversations",
      { primusclaw: "remote", op: "hide", connector_id: "c-hid", agent_id: "at", all: "idle" },
    ],
  ]);
  assert.ok(textsOf(card).includes("2 conversations hidden (nothing deleted)."));
  assert.deepEqual(
    buttonsOf(card)
      .filter((b) => data(b)["op"] === "hidden")
      .map(data),
    [{ primusclaw: "remote", op: "hidden", connector_id: "c-hid" }],
  );
  const hidden = cardOf(hiddenCard(remoteView.hiddenView(c, NOW, "zh")));
  assertValidCard(hidden);
  assert.ok(textsOf(hidden).includes("🗂️ devbox-8 上隐藏的会话") && textsOf(hidden).includes("gone"));
  assert.deepEqual(
    buttonsOf(hidden).map((b) => [b["title"], data(b)]),
    [
      ["取消隐藏", { primusclaw: "remote", op: "unhide", connector_id: "c-hid", ref: "old" }],
      ["全部取消隐藏", { primusclaw: "remote", op: "unhide", connector_id: "c-hid", all: "1" }],
      ["返回列表", { primusclaw: "remote", op: "list" }],
    ],
  );
  const none = cardOf(hiddenCard(remoteView.hiddenView(connector({ connectorId: "x", name: "box" }), NOW)));
  assert.ok(textsOf(none).includes("Nothing is hidden on this machine."));
  assert.deepEqual(
    buttonsOf(none).map((b) => data(b)["op"]),
    ["list"],
  );
  assert.equal(remoteView.hiddenCount(agent({ agentId: "a", capabilities: { hidden_count: true } })), 0);
});
