// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { agent, connector } from "../../../../test-support/card-catalog/remote.js";
import { healthLines, machineProblems } from "../../src/remote/health.js";

const NOT_SIGNED_IN = {
  code: "agent_not_signed_in",
  severity: "fail",
  scope: "agent",
  detail: "Codex is not signed in on this machine",
  fix: "codex login",
};
const NO_SERVICE = {
  code: "no_service",
  severity: "warn",
  scope: "machine",
  detail: "not a service",
  fix: "claw-connector service install",
};

type Problems = unknown[] | null;

function machine(...agents: [string, string, string, Problems][]) {
  return connector({
    connectorId: "c1",
    name: "dev-pod",
    online: true,
    agents: agents.map(([agentId, kind, name, problems]) =>
      agent({
        agentId,
        kind,
        name,
        capabilities: problems === null ? {} : { health: { checked_at: "2026-11-07T08:00:00.000Z", problems } },
      }),
    ),
  });
}

test("each problem once failures first with the fix in the users language", () => {
  const m = machine(
    ["claude", "claude", "Claude Code", [NO_SERVICE]],
    ["codex", "codex", "Codex", [NO_SERVICE, NOT_SIGNED_IN]],
  );
  assert.deepEqual(healthLines(m, "zh"), [
    "⛔ Codex 未登录：在那台机器上运行 `codex login`",
    "⚠️ 连接器没装成服务：进程退出或机器重启后不会自动上线：在那台机器上运行 `claw-connector service install`",
  ]);
  assert.equal(healthLines(m, "en")[0], "⛔ Codex is not signed in: on that machine run `codex login`");
  const found = machineProblems(m);
  assert.deepEqual(
    found?.problems.map((p) => [p.agent ? p.agent.agentId : null, p.code]),
    [
      ["codex", "agent_not_signed_in"],
      [null, "no_service"],
    ],
  );
  assert.equal(found.checked, "2026-11-07T08:00:00.000Z");
});

test("no health is unknown and no problems is nothing to say", () => {
  assert.equal(machineProblems(machine(["claude", "claude", "Claude Code", null])), null); // an older connector
  assert.deepEqual(healthLines(machine(["claude", "claude", "Claude Code", null])), []);
  assert.deepEqual(healthLines(machine(["claude", "claude", "Claude Code", []])), []);
  assert.deepEqual(machineProblems(machine(["claude", "claude", "Claude Code", []]))?.problems, []);
});

test("what the connector wrote is inert and an unknown code shows its detail", () => {
  const odd = {
    code: "something_new",
    severity: "fail",
    scope: "machine",
    detail: "see [here](https://evil.test) <b>now</b>",
    fix: "run `rm -rf /` [x](https://evil.test)",
  };
  const bad = { code: "Not A Code", severity: "fail", scope: "machine", detail: "x", fix: "y" };
  const lines = healthLines(machine(["claude", "claude", "Claude Code", [odd, bad]]), "zh");
  assert.equal(lines.length, 1);
  const line = lines[0] ?? "";
  assert.ok(!line.includes("](") && !line.includes("<b>"), line);
  assert.ok(!line.includes("`"), "a fix in words is no code span, and a backtick it carried is gone");
  const cmd = { ...odd, fix: "codex login `; rm -rf /`" };
  assert.equal(
    (healthLines(machine(["codex", "codex", "Codex", [cmd]]), "en")[0] ?? "").split("`").length - 1,
    2,
    "a command is one code span: its own backtick cannot end it",
  );
  assert.ok(line.startsWith("⛔ see (here)(https:\u200b//evil.test) ‹b›now‹/b›"));
});

test("more than four problems points at doctor", () => {
  const many = ["agent_cli_missing", "root_missing", "root_not_writable", "node_too_old", "proxy_invalid"].map((c) => ({
    ...NOT_SIGNED_IN,
    code: c,
    detail: c,
  }));
  const lines = healthLines(machine(["codex", "codex", "Codex", many]), "zh");
  assert.equal(lines.length, 5);
  assert.equal(lines.at(-1), "还有 1 个问题：在那台机器上运行 `claw-connector doctor`");
});

test("a malformed report never breaks the card", () => {
  const weird = connector({
    connectorId: "c1",
    name: "dev-pod",
    online: true,
    agents: [
      agent({
        agentId: "",
        kind: "codex",
        name: "Codex",
        capabilities: {
          health: { checked_at: 7, problems: [...Array<unknown>(10_000).fill(NOT_SIGNED_IN), "x", null, { code: 3 }] },
        },
      }),
      agent({ agentId: "", kind: "claude", name: "Claude Code", capabilities: { health: { problems: "nope" } } }),
    ],
  });
  const found = machineProblems(weird);
  assert.deepEqual(
    found?.problems.map((p) => p.code),
    ["agent_not_signed_in"],
  );
  assert.equal(found.checked, null);
  assert.deepEqual(healthLines(weird, "zh"), ["⛔ Codex 未登录：在那台机器上运行 `codex login`"]);
});

test("a fix in words is not put as a command to run", () => {
  const words = {
    code: "root_not_writable",
    severity: "fail",
    scope: "agent",
    detail: "x",
    fix: "pick a root you own in agents.toml (/srv/x belongs to uid 0)",
  };
  const cron = {
    code: "keepalive_not_scheduled",
    severity: "warn",
    scope: "machine",
    detail: "y",
    fix: '(crontab -l 2>/dev/null; echo "*/5 * * * * sh /h/keepalive.sh") | crontab -',
  };
  const zh = healthLines(machine(["claude", "claude", "Claude Code", [words, cron]]), "zh");
  assert.ok(
    zh[0]?.startsWith("⛔ Claude Code 的工作目录不可写。修复：pick a root you own in agents.toml"),
    String(zh[0]),
  );
  assert.ok(!String(zh[0]).includes("`"));
  assert.ok(
    zh[1]?.startsWith("⚠️ 没有任何东西在定时调用保活脚本") && zh[1].includes("：在那台机器上运行 `(crontab -l"),
    String(zh[1]),
  );
  assert.ok(
    healthLines(machine(["claude", "claude", "Claude Code", [words]]), "en")[0]?.includes(". Fix: pick a root you own"),
  );
});

test("a detail the connector sent as an object is said as python would say it", () => {
  // (Python: `_lit(problem["detail"] or problem["code"], 160)`, `str()` of a dict is its repr)
  const m = machine([
    "claude",
    "claude",
    "Claude Code",
    [{ code: "something_new", severity: "warn", scope: "machine", detail: { a: 1, b: [true, null] } }],
  ]);
  assert.deepEqual(healthLines(m, "en"), ["⚠️ {'a': 1, 'b': (True, None)}"]);
});
