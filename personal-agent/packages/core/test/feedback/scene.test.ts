// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { fixed1 } from "../../src/text/py-text.js";
import {
  lastTurnId,
  lastTurns,
  sceneMarkdown,
  secondsOf,
  splitTurns,
  summarizeTurn,
  type HistoryRow,
  type Scene,
} from "../../src/feedback/scene.js";

const NOW = 1_000_000;

function row(type: string, data: Record<string, unknown>, at: number | null, id = "e"): HistoryRow {
  return { event_id: id, event_type: type, data, created_at: at };
}
const user = (m: string, at: number | null): HistoryRow => row("UserMessage", { message_id: m }, at, `u-${m}`);
const result = (at: number | null, subtype = "success"): HistoryRow =>
  row("ResultMessage", { data: { subtype }, elapsed_ms: 1234 }, at);

function summary(rows: HistoryRow[]): string {
  const [turn] = lastTurns(rows, NOW).slice(-1);
  assert.ok(turn);
  return sceneMarkdown({ ...BASE, turns: [turn] });
}

const BASE: Scene = {
  name: "Alice",
  platformUserId: "u-1",
  chat: "1:1",
  at: 1_762_689_600,
  sessionId: "sess-1",
  pluginId: "",
  workerVersion: "1.2.3",
  workerImage: "unknown",
  apiImage: "api-7",
  brainImage: "brain-7",
  busy: false,
  turns: [],
  turnsNote: "",
  logs: [],
};

test("turn status is finished failed stopped stuck or running", () => {
  const start = NOW - 100;
  const cases: readonly (readonly [HistoryRow[], string])[] = [
    [[user("m1", start), result(start + 30)], "`m1`: finished, 30.0 s"],
    [[user("m1", start), result(start + 30, "error")], "`m1`: failed"],
    [[user("m1", start), row("error", { code: "rate_limited" }, start + 30)], "errors: `error code=rate_limited`"],
    [[user("m1", start), row("statusUpdate", { agentStatus: "stopped" }, start + 30)], "`m1`: stopped"],
    [[user("m1", NOW - 1000), row("toolUsed", { tool: "bash", status: "start" }, NOW - 970)], "`m1`: stuck"],
    [[user("m1", start), row("toolUsed", { tool: "bash", status: "start" }, NOW - 5)], "`m1`: running"],
  ];
  for (const [rows, expected] of cases) assert.ok(summary(rows).includes(expected), expected);
});

test("only the last two turns are listed", () => {
  const rows = [0, 1, 2, 3].flatMap((i) => [user(`t${String(i)}`, NOW - 400 + i * 10), result(NOW - 395 + i * 10)]);
  const text = sceneMarkdown({ ...BASE, turns: lastTurns(rows, NOW) });
  assert.ok(text.includes("`t2`") && text.includes("`t3`") && !text.includes("`t1`") && !text.includes("`t0`"));
});

test("a turn from the stream history has no times: its duration is the result's elapsed time", () => {
  const rows = [user("m1", null), row("toolUsed", { tool: "bash", status: "success" }, null), result(null)];
  assert.ok(summary(rows).includes("`m1`: finished, 1.2 s; tools: `bash`; errors: none"));
  assert.equal(summarizeTurn(splitTurns([user("m2", null)])[0] ?? [], NOW).status, "unfinished");
});

test("nothing the scene reads can carry a message body or an error text", () => {
  const rows = [
    user("m1", NOW - 10),
    row("toolUsed", { tool: "a tool with spaces and private words", status: "error" }, NOW - 9),
    row("toolUsed", { tool: "read", status: "error" }, NOW - 8),
    row("error", { message: "secret body", error: { type: "overloaded", message: "x" } }, NOW - 7),
    row("statusUpdate", { agentStatus: "failed" }, NOW - 6),
    row("error", { code: "has space" }, NOW - 5),
  ];
  const text = summary(rows);
  assert.ok(!text.includes("private") && !text.includes("secret body") && !text.includes("has space"));
  assert.ok(text.includes("failed, 5.0 s, 2 tool error(s); tools: `read`"));
  assert.ok(text.includes("errors: `error code=overloaded`; `statusUpdate failed`; `error`"));
});

test("a turn is named by its message id, else its event id, else unknown", () => {
  const byEvent = splitTurns([row("UserMessage", {}, null, "ev-9")]);
  assert.equal(summarizeTurn(byEvent[0] ?? [], NOW).turnId, "ev-9");
  const neither = splitTurns([row("UserMessage", { message_id: "has space" }, null, "")]);
  assert.equal(summarizeTurn(neither[0] ?? [], NOW).turnId, "unknown");
  assert.equal(summarizeTurn([], NOW).turnId, "unknown");
  assert.deepEqual(splitTurns([result(1)]), []);
  const typed = splitTurns([
    { event_id: "x", event_type: "", data: { type: "UserMessage", message_id: 5 }, created_at: 1 },
  ]);
  assert.equal(summarizeTurn(typed[0] ?? [], NOW).turnId, "5");
});

test("tools are listed once each, at most fifteen, and errors at most five", () => {
  const tools = Array.from({ length: 20 }, (_, i) => row("toolUsed", { tool: `t${String(i)}` }, null));
  const errors = Array.from({ length: 8 }, (_, i) => row("error", { error_code: `c${String(i)}` }, null));
  const turn = summarizeTurn(
    splitTurns([user("m", null), ...tools, row("toolUsed", { tool: "t0" }, null), ...errors])[0] ?? [],
    NOW,
  );
  assert.equal(turn.tools.length, 15);
  assert.deepEqual(turn.errors, ["error code=c0", "error code=c1", "error code=c2", "error code=c3", "error code=c4"]);
});

test("timestamps are epoch seconds, epoch milliseconds or ISO 8601", () => {
  assert.equal(secondsOf(1_700_000_000), 1_700_000_000);
  assert.equal(secondsOf(1_700_000_000_000), 1_700_000_000);
  assert.equal(secondsOf("2026-01-01T00:00:00Z"), Date.UTC(2026, 0, 1) / 1000);
  // microseconds count, as Python's fromisoformat reads them: these two are 0.0499 s apart, "0.0 s" in Python
  const a = secondsOf("2026-01-01T00:00:00.001100Z") ?? 0;
  const b = secondsOf("2026-01-01T00:00:00.051000Z") ?? 0;
  assert.equal(fixed1(b - a), "0.0");
  assert.equal(secondsOf("not a date"), undefined);
  assert.equal(secondsOf(""), undefined);
  assert.equal(secondsOf(true), undefined);
});

test("the scene says who, where, the images, the state and the log lines", () => {
  const text = sceneMarkdown({ ...BASE, busy: undefined, logs: ["l1", "l2"] });
  assert.equal(
    text,
    [
      "### Context (recorded automatically)",
      "",
      "- Reporter: `Alice` (SaFE user `u-1`)",
      "- Chat: 1:1",
      "- Reported at (UTC): 2025-11-09 12:00:00",
      "- Plugin id: `none`",
      "- Worker: version `1.2.3`, image tag `unknown`",
      "- Claw api image tag: `api-7`; brain image tag: `brain-7`",
      "- Session state: unknown",
      "",
      "**Last turns** (ids, states and counts only; no message text)",
      "",
      "- none (the session has no turns)",
      "",
      "**Worker log, last 30 lines for this chat** (ids and levels only)",
      "",
      "```text\nl1\nl2\n```",
    ].join("\n"),
  );
  const unlinked = sceneMarkdown({ ...BASE, platformUserId: "", name: "", busy: true, turnsNote: "not linked" });
  assert.ok(unlinked.includes("`unknown` (SaFE user unknown (chat not linked))"));
  assert.ok(unlinked.includes("Session state: running now") && unlinked.includes("- none (not linked)"));
  assert.ok(unlinked.includes("(no log lines for this chat)"));
  assert.equal(lastTurnId(BASE), "");
  assert.equal(lastTurnId({ ...BASE, turns: lastTurns([user("m9", 1)], NOW) }), "m9");
});
