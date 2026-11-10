// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { SETUP, agent, connector, session } from "../../../../test-support/card-catalog/remote.js";
import { unsolicitedParts } from "../../src/remote/answer.js";
import { decode } from "../../src/remote/events.js";
import {
  DELIVERY_UNCONFIRMED,
  NOT_DELIVERED,
  NO_ASK_MODES,
  backLine,
  disconnectedText,
  isStopReason,
  noAskLine,
  pairText,
  queuedLine,
  readOnlyRefused,
  recoveredLine,
  sessionTitle,
  stopNote,
  switchedLine,
  terminalClosedLine,
  typedLine,
} from "../../src/remote/lines.js";
import { healthLines } from "../../src/remote/health.js";
import { agentsText, sessionsText } from "../../src/remote/listing.js";
import { PLAIN_ERRORS, frame } from "./frames.js";

test("agents are listed per machine with their state and a way to start one", () => {
  const text = agentsText(
    [
      connector({
        connectorId: "c1",
        name: "dev-pod",
        online: true,
        agents: [
          agent({ agentId: "codex", kind: "codex", name: "Codex" }),
          agent({ agentId: "claude", kind: "claude" }),
        ],
      }),
      connector({ connectorId: "c2", name: "laptop" }),
    ],
    SETUP,
  );
  assert.ok(text.includes("**dev-pod** (\u{1f7e2} online)") && text.includes("**laptop** (offline)"));
  assert.ok(text.includes("- ⬛ Codex (`codex`)") && text.includes("- \u{1f7e0} Claude Code (`claude`)"));
  assert.ok(text.includes("no agent reported yet") && text.includes("`/agent new AGENT PATH`"));
});

test("nothing connected says how to connect a machine", () => {
  for (const [lang, lead] of [
    ["en", "You have no machine connected."],
    ["zh", "你还没有连接任何机器。"],
  ] as const) {
    const text = agentsText([], SETUP, lang);
    assert.ok(text.startsWith(lead));
    assert.ok(
      text.includes(
        "```\nnpm install -g @primusclaw/connector\nclaw-connector init\n" +
          "claw-connector login --server https://claw.example.com/claw-api --identity-url https://claw.example.com\n" +
          "claw-connector service install\n```",
      ),
    );
    assert.ok(text.includes("WSL") && text.includes("loginctl enable-linger") && text.includes("EACCES"));
    assert.ok(!/(?<!claw-)connector (login|run)/.test(text));
  }
});

test("an old connector is shown with the command that upgrades it", () => {
  const rows = [
    connector({ connectorId: "1", name: "old", online: true, version: "0.1.2", versionStatus: "unsupported" }),
    connector({ connectorId: "2", name: "behind", online: true, version: "0.1.3", versionStatus: "outdated" }),
    connector({ connectorId: "3", name: "new", online: true, version: "0.1.4", versionStatus: "current" }),
    connector({
      connectorId: "4",
      name: "evil",
      online: true,
      version: "0.1.0 [x](http://e)",
      versionStatus: "outdated",
    }),
  ];
  const text = agentsText(rows, SETUP);
  const upgrade =
    "`npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install`";
  assert.ok(text.includes(`Its connector (0.1.2) is too old for a new session. On that machine, run ${upgrade}`));
  assert.ok(text.includes(`Its connector (0.1.3) is out of date. On that machine, run ${upgrade}`));
  assert.equal(text.split(upgrade).length - 1, 3);
  assert.ok(!text.includes("curl") && !text.includes("http://e"));
});

test("a machine name cannot make markup", () => {
  assert.ok(
    !agentsText([connector({ connectorId: "c", name: "x [y](http://e)", online: true })], SETUP).includes("]("),
  );
});

test("an offline machine says when it was last seen", () => {
  const text = agentsText(
    [connector({ connectorId: "c", name: "lab", heartbeatAt: "2026-11-06T03:45:10Z" })],
    SETUP,
    "zh",
  );
  assert.ok(text.includes("**lab** (离线（最后在线 11-06 03:45Z）)"), text);
});

test("sessions are numbered newest first with the attached one marked", () => {
  const connectors = [
    connector({
      connectorId: "c1",
      name: "dev-pod",
      agents: [agent({ agentId: "codex", kind: "codex", name: "Codex" })],
    }),
  ];
  const sessions = [
    session({
      sessionId: "s-old",
      connectorId: "c1",
      agentId: "codex",
      cwd: "/a",
      status: "closed",
      updatedAt: "2026-10-28T06:00:00Z",
    }),
    session({
      sessionId: "s-new",
      connectorId: "c1",
      agentId: "codex",
      cwd: "/b",
      status: "active",
      updatedAt: "2026-10-29T05:00:00Z",
    }),
  ];
  const now = Date.UTC(2026, 9, 29, 6, 0) / 1000;
  const { text, listing } = sessionsText(sessions, connectors, "s-new", now);
  assert.deepEqual(listing, ["s-new", "s-old"]);
  const lines = text.split("\n\n");
  assert.ok(lines[1]?.startsWith("1. ⬛ Codex on dev-pod - `/b` (attached, active, 1 h ago)"));
  assert.ok(lines[2]?.startsWith("2. ⬛ Codex on dev-pod - `/a` (closed, 1 d ago)"));
  assert.deepEqual(sessionsText([], connectors, null, now).listing, []);
  const odd = sessionsText(
    [session({ sessionId: "x", connectorId: "gone", status: "pending" })],
    [],
    null,
    now,
    "zh",
  ).text;
  assert.ok(odd.includes("一台机器") && odd.includes("pending"), odd);
});

test("pair text puts the command alone in a code block in the users language", () => {
  const zh = pairText(
    "npm install -g x && claw-connector pair AB --server https://c",
    10,
    "zh",
    "你还没有连接任何机器。",
  );
  assert.ok(zh.startsWith("你还没有连接任何机器。\n\n"));
  assert.ok(zh.includes("\n```\nnpm install -g x && claw-connector pair AB --server https://c\n```\n"));
  assert.ok(zh.includes("10 分钟内有效，只能用一次"));
  const en = pairText("cmd", 0, "en");
  assert.ok(en.includes("within 10 minutes") && en.includes("```\ncmd\n```"));
});

test("the no ask line is said in the chats language for each mode that does not ask", () => {
  assert.deepEqual(Object.keys(NO_ASK_MODES).sort(), ["acceptEdits", "auto", "bypassPermissions", "dontAsk"]);
  assert.equal(
    noAskLine("bypassPermissions", "zh"),
    "⚠️ 这个终端是 bypass permissions 模式：手机发的指令会直接执行，不会再弹审批卡。",
  );
  for (const mode of ["default", "plan", null, "something-new", "constructor"]) {
    assert.equal(noAskLine(mode, "zh"), null);
    assert.equal(noAskLine(mode, "en"), null);
  }
});

test("what claw writes for an instruction its machine never got is read as that", () => {
  const closed = decode(frame("session_closed", { reason: "not_delivered", by: "claw" }), PLAIN_ERRORS);
  assert.equal(closed.closed, NOT_DELIVERED);
  const ended = decode(
    frame("turn_end", { stopReason: "error", error: "not_delivered", cmd_seq: 3, by: "claw" }),
    PLAIN_ERRORS,
  );
  assert.deepEqual([ended.finished, ended.stopReason, ended.note], [true, "error", NOT_DELIVERED]);
  assert.equal(DELIVERY_UNCONFIRMED, "delivery_unconfirmed");
});

test("the lines of an attached chat in either language", () => {
  assert.equal(queuedLine("terminal_typing", "en"), "⏳ Box in use");
  assert.equal(queuedLine("something", "zh"), "⏳ 等终端");
  assert.ok(readOnlyRefused("en", true).endsWith("but it ends the terminal's session for it."));
  assert.ok(!readOnlyRefused("en").includes("Take over"));
  assert.equal(switchedLine("⬛ Codex", "dev-pod", "en"), "—— Now: dev-pod · ⬛ Codex ——");
  assert.equal(backLine("zh"), "—— 已回到助理 ——");
  assert.ok(terminalClosedLine("en").startsWith("The conversation was closed in the terminal"));
  assert.ok(recoveredLine("cx", "box", "en", true, true).includes("comes back as a new card"));
  assert.ok(recoveredLine("cx", "box", "zh", true, false).includes("发「继续」"));
  assert.ok(recoveredLine("cx", "box", "en", false, false).includes("just keep writing"));
  assert.equal(typedLine("fix it\n\nnow", "en"), "🖥 **Typed in the terminal:**\n\n> fix it\n>\n> now");
  assert.equal(sessionTitle("  Fix the flaky test in the loader please\nmore"), "Fix the flaky test in the loa…");
  assert.equal(sessionTitle(""), "");
  assert.ok(isStopReason("max_tokens") && !isStopReason("end_turn"));
  assert.equal(stopNote("cancelled", "zh"), "已停止。");
  assert.ok(disconnectedText("box", "claw-connector login", "en").includes("run `claw-connector login`"));
  assert.ok(disconnectedText("box", "", "zh", true).includes("连接我的开发环境"));
  const parts = unsolicitedParts("cx", "done.", "en", true);
  assert.equal(parts[0], "**cx**, replying to what was typed in the terminal:\n\ndone.");
});

test("what was typed at the terminal cannot make a link or a tag in the chat", () => {
  const line = typedLine("[Open](https://attacker.example) ![x](https://e/p.png) <a href=x>y</a>", "en");
  for (const bad of ["](", "<a", "</"]) assert.ok(!line.includes(bad), bad);
  assert.ok(line.includes("Open") && line.includes("attacker.example")); // (shown, only inert)
});

test("a word that names a property of every object is no key of our tables", () => {
  // (Python reads these tables with `dict.get`/`in`: `constructor`, `__proto__` and `toString` are no entries)
  for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(queuedLine(word, "en"), "⏳ Waiting", word);
    assert.equal(noAskLine(word, "en"), null, word);
    assert.equal(isStopReason(word), false, word);
    assert.equal(decode(frame(word, { text: "x" }), PLAIN_ERRORS).chunk, null, word);
    const text = sessionsText(
      [session({ sessionId: "s", connectorId: "c", status: word, updatedAt: "" })],
      [],
      null,
      0,
    ).text;
    assert.ok(text.includes(`(${word})`), text);
  }
  const health = healthLines(
    connector({
      connectorId: "c",
      agents: [
        agent({
          agentId: "a",
          capabilities: { health: { problems: [{ code: "constructor", severity: "fail", detail: "odd" }] } },
        }),
      ],
    }),
  );
  assert.deepEqual(health, ["⛔ odd"]);
});
