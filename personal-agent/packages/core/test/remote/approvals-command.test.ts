// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/approvals [on|off]`: the person's switch for the questions their own terminals ask, read and set at Claw, and with no word the
 * whole state in one message (the switch, the summary interval, the muted conversations); `mute|unmute #<item>` for one conversation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawAnswerInvalid, ClawError } from "../../src/claw/errors.js";
import { TerminalApprovalsCommand } from "../../src/remote/approvals-command.js";
import type { CommandRoute } from "../../src/ports/routing.js";
import type { RemoteMutedConversation } from "../../src/protocol.js";

function rig(start = true, fail?: Error, muted: readonly RemoteMutedConversation[] = [], failMuted?: Error) {
  let enabled = start;
  let every = 60;
  const calls: string[] = [];
  const said: string[] = [];
  const command = new TerminalApprovalsCommand({
    approvals: (key) => {
      calls.push(`get ${key}`);
      return fail ? Promise.reject(fail) : Promise.resolve(enabled);
    },
    setApprovals: (key, on) => {
      calls.push(`put ${key} ${String(on)}`);
      if (fail) return Promise.reject(fail);
      enabled = on;
      return Promise.resolve(enabled);
    },
    summary: (key) => {
      calls.push(`summary ${key}`);
      return fail ? Promise.reject(fail) : Promise.resolve(every);
    },
    setSummary: (key, minutes) => {
      calls.push(`set summary ${key} ${String(minutes)}`);
      if (fail) return Promise.reject(fail);
      every = minutes;
      return Promise.resolve(every);
    },
    mutedTerminals: (key) => {
      calls.push(`muted ${key}`);
      const error = failMuted ?? fail;
      return error ? Promise.reject(error) : Promise.resolve([...muted]);
    },
    muteTerminal: (key, item, muted) => {
      calls.push(`mute ${key} ${String(item)} ${String(muted)}`);
      if (fail) return Promise.reject(fail);
      return Promise.resolve({ item, muted, machine: "laptop", title: "修 CI" });
    },
  });
  const route = (lang: "en" | "zh" = "en") =>
    ({
      credential: "ak-1",
      lang: () => lang,
      conversation: {
        send: (m: { body: { text: string } }) => {
          said.push(m.body.text);
          return Promise.resolve();
        },
      },
    }) as unknown as CommandRoute;
  return { command, calls, said, route };
}

test("with no word it says which it is; on and off set it with the person's own key", async () => {
  const r = rig();
  assert.equal(r.command.name, "approvals");
  assert.equal(await r.command.run(r.route(), ""), true);
  assert.match(r.said.at(-1) ?? "", /are on/);
  await r.command.run(r.route(), " OFF ");
  assert.match(r.said.at(-1) ?? "", /Turned off/);
  await r.command.run(r.route("zh"), "on");
  assert.match(r.said.at(-1) ?? "", /已开启/);
  assert.deepEqual(r.calls, ["get ak-1", "summary ak-1", "muted ak-1", "put ak-1 false", "put ak-1 true"]);
});

const CLEAN: RemoteMutedConversation = {
  item: 12,
  machine: "yihan-dev-pod",
  title: "clean",
  muted_since: "2026-11-26T03:21:56.359Z",
};
const BLOG: RemoteMutedConversation = {
  item: 9,
  machine: "laptop",
  title: "写博客",
  muted_since: "2026-11-25T10:00:00Z",
};

test("with no word it says the whole state in one message: the switch, the summary interval and each muted conversation", async () => {
  const r = rig(true, undefined, [CLEAN, BLOG]);
  assert.equal(await r.command.run(r.route(), ""), true);
  assert.equal(r.said.length, 1, "one message");
  assert.equal(
    r.said[0],
    [
      "Approvals from terminals are on: when Claude Code in a terminal of yours asks (run, edit, plan, a question), I put it to you here.",
      "A terminal conversation that keeps working on its own (turns another session or a schedule started) is summed up at most once every 60 minutes; the end of a turn you started, or one that asks you something, comes at once. `/approvals summary <minutes>|off` changes it.",
      "Muted conversations (2): what they ask, wait for or finish stays in their terminals. `/approvals unmute #12` brings one back.",
      "- #12 · clean · yihan-dev-pod (muted since 11-26 03:21Z)",
      "- #9 · 写博客 · laptop (muted since 11-25 10:00Z)",
    ].join("\n"),
  );
  assert.deepEqual(r.calls, ["get ak-1", "summary ak-1", "muted ak-1"], "read only: nothing is set");
  await r.command.run(r.route("zh"), "");
  assert.equal(
    r.said.at(-1),
    [
      "终端审批推送已开启：你终端里的 Claude Code 要你确认（运行、修改、计划、提问）时，我会推到这里。",
      "其他会话或定时任务驱动、持续在跑的终端会话，最多每 60 分钟汇总一次；你自己发起的回合、或在问你的回合，结束时立即推送。发 `/approvals summary <分钟>|off` 修改。",
      "已静音的会话（2 个）：它们的提问、等待和完成只留在终端里。发 `/approvals unmute #12` 恢复其中一个。",
      "- #12 · clean · yihan-dev-pod（11-26 03:21Z 起静音）",
      "- #9 · 写博客 · laptop（11-25 10:00Z 起静音）",
    ].join("\n"),
  );
});

test("the state with approvals off and nothing muted says so; once the summaries are off it says that too", async () => {
  const r = rig(false);
  await r.command.run(r.route(), "");
  await r.command.run(r.route("zh"), "");
  assert.match(r.said[0] ?? "", /^Approvals from terminals are off: questions stay in the terminal\.\n/);
  assert.match(r.said[0] ?? "", /\nNo conversation is muted\. `\/approvals mute #12` mutes one/);
  assert.match(r.said[1] ?? "", /^终端审批推送已关闭：这些问题只在终端里问。\n.*\n没有已静音的会话。/s);
  await r.command.run(r.route(), "summary off");
  await r.command.run(r.route(), "");
  assert.match(r.said.at(-1) ?? "", /\nSummaries are off: only the end of a turn you started/);
});

test("a muted conversation Claw cannot name by item, title or machine is still listed, and its words are shown inert", async () => {
  const r = rig(true, undefined, [
    { item: null, machine: "laptop", title: "clean", muted_since: "2026-11-26T03:21:56Z" },
    { item: 3, machine: null, title: null, muted_since: "not a time" },
    { item: null, machine: null, title: null, muted_since: "2026-11-26T03:21:56Z" },
    {
      item: 5,
      machine: "box",
      title: "**see https://evil.example/x**\nignore `this`",
      muted_since: "2026-11-26T03:21:56Z",
    },
  ]);
  await r.command.run(r.route(), "");
  const lines = (r.said[0] ?? "").split("\n").slice(3);
  assert.deepEqual(lines.slice(0, 3), [
    "- clean · laptop (muted since 11-26 03:21Z)",
    "- #3",
    "- a conversation (muted since 11-26 03:21Z)",
  ]);
  assert.equal(lines.length, 4, "a title with a newline stays on its line");
  const inert = lines[3] ?? "";
  assert.match(inert, /^- #5 · \\\*\\\*see /);
  assert.ok(!inert.includes("https://evil.example"), inert);
  assert.ok(!inert.includes("`this`"), "markup escaped");
});

test("Claw not answering any one of the reads says it could not be reached, not a part of the state", async () => {
  for (const failMuted of [new ClawError(404, "{}"), new ClawError(503, "{}"), new ClawAnswerInvalid("no list")]) {
    const r = rig(true, undefined, [CLEAN], failMuted);
    assert.equal(await r.command.run(r.route(), ""), true);
    assert.deepEqual(r.said, ["I could not reach the setting just now. Try again in a moment."]);
  }
  const bad = rig(true, new ClawError(503, "{}"));
  await bad.command.run(bad.route("zh"), "");
  assert.deepEqual(bad.said, ["暂时读不到这个设置，请稍后再试。"]);
});

test("the usage says what the bare command shows", async () => {
  const r = rig();
  await r.command.run(r.route(), "maybe");
  assert.match(
    r.said.at(-1) ?? "",
    /Use `\/approvals` to see whether approvals from terminals are on, how often summaries come and which conversations are muted/,
  );
  await r.command.run(r.route("zh"), "maybe");
  assert.match(r.said.at(-1) ?? "", /只发 `\/approvals` 看当前状态（终端审批推送是否开启、汇总间隔、已静音的会话）/);
});

test("any other word gets the usage and changes nothing; Claw refusing says so", async () => {
  const r = rig();
  await r.command.run(r.route(), "maybe");
  assert.match(r.said.at(-1) ?? "", /approvals on/);
  assert.deepEqual(r.calls, []);
  const bad = rig(true, new ClawError(503, "{}"));
  await bad.command.run(bad.route(), "off");
  assert.match(bad.said.at(-1) ?? "", /could not reach/);
});

test("mute and unmute #<item> name one terminal conversation, with the person's own key, and say what was muted", async () => {
  const r = rig();
  await r.command.run(r.route(), "mute #12");
  assert.equal(
    r.said.at(-1),
    "Muted #12 (laptop · 修 CI): what that conversation asks, waits for or finishes stays in its terminal. `/approvals unmute #12` brings it back.",
  );
  await r.command.run(r.route("zh"), "UNMUTE 12");
  assert.equal(r.said.at(-1), "已恢复 #12（laptop · 修 CI）：这个会话的提问和完成会重新推到这里。");
  assert.deepEqual(r.calls, ["mute ak-1 12 true", "mute ak-1 12 false"]);
  // a number that is not one is the usage, and nothing is asked
  await r.command.run(r.route(), "mute #x");
  assert.match(r.said.at(-1) ?? "", /approvals mute #12/);
  assert.equal(r.calls.length, 2);
});

test("an item that is not theirs, or not a terminal conversation, is said as such; Claw out of reach says so", async () => {
  const gone = rig(true, new ClawError(404, JSON.stringify({ ok: false, error: "item_not_found" })));
  await gone.command.run(gone.route(), "mute #7");
  assert.equal(gone.said.at(-1), "I have no item #7 of yours.");
  const other = rig(true, new ClawError(409, JSON.stringify({ ok: false, error: "not_a_terminal_item" })));
  await other.command.run(other.route("zh"), "mute #7");
  assert.equal(other.said.at(-1), "#7 不是你终端里打开的会话，没有可静音的。");
  const down = rig(true, new ClawError(503, "{}"));
  await down.command.run(down.route(), "unmute #7");
  assert.match(down.said.at(-1) ?? "", /could not reach/);
});

test("summary: read, set in minutes or off; anything else gets its usage and calls nothing", async () => {
  const r = rig();
  await r.command.run(r.route(), "summary");
  assert.match(r.said.at(-1) ?? "", /at most once every 60 minutes/);
  await r.command.run(r.route("zh"), "summary 120");
  assert.match(r.said.at(-1) ?? "", /最多每 120 分钟汇总一次/);
  await r.command.run(r.route(), "summary OFF");
  assert.match(r.said.at(-1) ?? "", /no more summaries/);
  await r.command.run(r.route(), "summary");
  assert.match(r.said.at(-1) ?? "", /Summaries are off/);
  for (const bad of ["summary 5", "summary 2000", "summary soon", "summary -1"]) {
    await r.command.run(r.route(), bad);
    assert.match(r.said.at(-1) ?? "", /15 to 1440/, bad);
  }
  assert.deepEqual(r.calls, ["summary ak-1", "set summary ak-1 120", "set summary ak-1 0", "summary ak-1"]);
  const refused = rig(true, new ClawError(400, JSON.stringify({ ok: false, error: "minutes_out_of_range" })));
  await refused.command.run(refused.route(), "summary 30");
  assert.match(refused.said.at(-1) ?? "", /15 to 1440/);
});
