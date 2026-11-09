// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The sessions card (test_remote_view). */
import assert from "node:assert/strict";
import { test } from "node:test";

import { assertValidCard, buttonsOf, elements, textsOf } from "../../../../test-support/adaptive-card.js";
import { CONNECTORS, SESSIONS, agent, connector, sessions } from "./fixtures.js";

type Json = Record<string, unknown>;
const data = (b: Json): Json => b["data"] as Json;
const C0 = CONNECTORS[0] as (typeof CONNECTORS)[number];
const C1 = CONNECTORS[1] as (typeof CONNECTORS)[number];

function laptop(capabilities: Record<string, unknown>, online = false) {
  return connector({
    connectorId: "c2",
    name: "laptop",
    online,
    heartbeatAt: "2026-11-06T03:45:10Z",
    agents: [agent({ agentId: "claude", kind: "claude-code", capabilities })],
  });
}
const RESUMABLE = () => [
  { ref: "r1", title: "Fix it", cwd: "/w", state: "live" },
  { ref: "r2", title: "Idle one", cwd: "/w", state: "idle" },
];

test("the sessions card lists every machine and session and what a terminal has open", () => {
  const caps: Record<string, unknown> = { resumable: RESUMABLE() };
  const { card, listing } = sessions({
    connectors: [C0, laptop(caps)],
    sessions: SESSIONS,
    attached: "s2",
    now: 1_761_720_000.0,
    lang: "zh",
  });
  const texts = textsOf(card).join(" | ");
  assert.deepEqual(listing, ["s1", "s2"]);
  assert.ok(texts.includes("(在线)"));
  assert.ok(
    texts.includes("离线（最后在线 11-06 03:45Z）") &&
      texts.includes("终端里正在用，暂时只能在终端操作") &&
      texts.includes("（当前）"),
  );
  const watch = sessions({
    connectors: [C0, laptop({ ...caps, watch_live: true }, true)],
    sessions: SESSIONS,
    attached: "s2",
    now: 1_761_720_000.0,
    lang: "zh",
  }).card;
  assert.ok(
    textsOf(watch)
      .join(" | ")
      .includes("终端里正在用：这台机器的连接器还不能往终端里输入（需要 0.1.9 或更新），现在只能看"),
  );
  assert.deepEqual(
    buttonsOf(watch)
      .filter((b) => b["title"] === "只看（终端照常用）")
      .map((b) => [data(b)["op"], data(b)["resume"]]),
    [["new", "r1"]],
  );
  const noTmux = sessions({
    connectors: [C0, laptop({ ...caps, watch_live: true, terminal_input: true }, true)],
    sessions: SESSIONS,
    attached: "s2",
    now: 1_761_720_000.0,
    lang: "zh",
  }).card;
  assert.ok(
    textsOf(noTmux).includes(
      "终端里正在用：这里发的消息现在打不进那个终端，只能看。要能发：在 tmux 里打开这个会话，并且只在这一个终端里开着它",
    ),
  );
  const typed = RESUMABLE().map((e, i) => (i === 0 ? { ...e, input: "terminal" } : e));
  const shared = sessions({
    connectors: [C0, laptop({ resumable: typed, watch_live: true, terminal_input: true, takeover: true }, true)],
    sessions: SESSIONS,
    attached: "s2",
    now: 1_761_720_000.0,
    lang: "zh",
  }).card;
  assert.deepEqual(
    buttonsOf(shared)
      .filter((b) => data(b)["resume"] === "r1")
      .map((b) => [b["title"], data(b)["op"], data(b)["resume"], b["style"]]),
    [["连上（终端照常用）", "new", "r1", "positive"]],
  );
  assert.ok(!texts.includes("/gone") && !texts.includes("/closed"));
  const ops = buttonsOf(card).map((b) => [data(b)["op"], data(b)["session_id"] ?? data(b)["resume"]]);
  const has = (op: string, id: string) => ops.some(([o, i]) => o === op && i === id);
  assert.ok(has("attach", "s1") && !has("attach", "s2") && has("close", "s1"));
  assert.ok(!has("new", "r2")); // (the machine is offline: nothing to take over there now)
  assert.deepEqual(ops.slice(-2), [
    ["row", "s2"],
    ["switch", "s2"],
  ]); // Back to the status card, Refresh
  const online = buttonsOf(
    sessions({ connectors: [laptop(caps, true)], sessions: [], attached: null, now: 0 }).card,
  ).map((b) => [data(b)["op"], data(b)["resume"]]);
  assert.ok(online.some(([o, r]) => o === "new" && r === "r2") && !online.some(([o, r]) => o === "new" && r === "r1"));
});

const WAITING = agent({
  agentId: "claude-sessions",
  kind: "attach",
  name: "Claude Code (existing sessions)",
  capabilities: {
    resumable: [
      { ref: "r1", title: "Newest, busy", cwd: "/w", updated_at: 1_761_719_990, state: "live", activity: "working" },
      {
        ref: "r2",
        title: "Idle one",
        cwd: "/w",
        updated_at: 1_761_719_900,
        state: "idle",
        activity: "waiting",
        waiting_for: "x",
      },
      {
        ref: "r3",
        title: "Needs me",
        cwd: "/w",
        updated_at: 1_761_719_000,
        state: "live",
        activity: "waiting",
        waiting_for: "input needed",
      },
      { ref: "r4", title: "Odd", cwd: "/w", updated_at: 1_761_718_000, state: "live", activity: "constructor" },
    ],
  },
});

test("the sessions card puts what waits for the user first and says so", () => {
  const connectors = [{ ...C0, agents: [...C0.agents, WAITING] }, C1];
  const { card } = sessions({
    connectors,
    sessions: SESSIONS,
    attached: null,
    now: 1_761_720_000.0,
    lang: "zh",
    waiting: new Set(["s1", "s4", "elsewhere"]),
  });
  assertValidCard(card);
  const texts = textsOf(card);
  assert.ok(texts.includes("⚠️ 有 2 个会话在等你"));
  const heads = new Map(
    [...elements(card["body"])]
      .filter((b) => typeof b["text"] === "string" && b["text"].startsWith("**"))
      .map((b) => [String(b["text"]).split("**")[1], b]),
  );
  assert.equal(heads.get("dev-pod")?.["color"], "good");
  assert.ok(heads.get("laptop")?.["isSubtle"] && !("color" in (heads.get("laptop") ?? {})));
  assert.ok(texts.some((t) => t.startsWith("⚠️ **等你批准** · 1. /a")));
  const conv = texts.filter((t) => t.includes("· /w"));
  assert.ok(conv[0]?.startsWith("⚠️ **等你**（input needed） · Needs me"), String(conv[0]));
  assert.ok(conv[1]?.startsWith("⏳ 正在做 · Newest, busy") && conv[2]?.startsWith("Idle one"));
  assert.equal(conv.length, 3);
  assert.ok(conv[0]?.endsWith("· 16 分钟前") && conv[1]?.endsWith("· 刚刚"));
  const en = textsOf(sessions({ connectors, sessions: [], attached: null, now: 1_761_720_000.0 }).card);
  assert.ok(
    en.includes("⚠️ 1 waiting for you") &&
      en.some((t) => t.startsWith("⚠️ **Waiting for you** (input needed) · Needs me")),
  );
});

test("the sessions card leaves quiet agents out and its element ids are unique", () => {
  const connectors = [{ ...C0, agents: [...C0.agents, WAITING] }, C1];
  const beside = textsOf(
    sessions({
      connectors: [{ ...C0, agents: [C0.agents[1] ?? agent({ agentId: "x" }), WAITING] }],
      sessions: [],
      attached: null,
      now: 1_761_720_000.0,
      lang: "zh",
    }).card,
  );
  assert.ok(
    !beside.includes("没有会话") &&
      !beside.join(" | ").includes("🟠 Claude Code") &&
      beside.join(" | ").includes("🤖 Claude Code (existing sessions)"),
  );
  const empty = textsOf(
    sessions({ connectors: [C0], sessions: [], attached: null, now: 1_761_720_000.0, lang: "zh" }).card,
  );
  assert.equal(empty.filter((t) => t === "没有会话").length, 1);
  const tricky = [
    ["c1", "a-b", "c"],
    ["c1-a", "b", "c"],
  ].map(([cid, aid, ref]) =>
    connector({
      connectorId: String(cid),
      name: String(cid),
      online: true,
      agents: [
        agent({
          agentId: String(aid),
          kind: "attach",
          name: "x",
          capabilities: { resumable: [{ ref, title: "t", cwd: "/w", state: "live", activity: "waiting" }] },
        }),
      ],
    }),
  );
  const ids = [...elements(sessions({ connectors: tricky, sessions: [], attached: null, now: 0 }).card["body"])]
    .filter((b) => "id" in b)
    .map((b) => b["id"]);
  assert.equal(ids.length, new Set(ids).size);
  const offline = textsOf(
    sessions({
      connectors: [{ ...(connectors[0] as typeof C0), online: false }],
      sessions: [],
      attached: null,
      now: 1_761_720_000.0,
    }).card,
  );
  assert.ok(!offline.some((t) => t.includes("waiting for you")));
});

test("the sessions card with no machine gives each command as a line to copy", () => {
  for (const lang of ["en", "zh"] as const) {
    const body = sessions({ connectors: [], sessions: [], attached: null, now: 0, lang }).card["body"] as Json[];
    assert.deepEqual(
      body.filter((b) => b["fontType"] === "Monospace").map((b) => b["text"]),
      [
        "npm install -g @primusclaw/connector",
        "claw-connector init",
        "claw-connector login --server https://claw.example.com/claw-api --identity-url https://claw.example.com",
        "claw-connector service install",
      ],
    );
  }
});
