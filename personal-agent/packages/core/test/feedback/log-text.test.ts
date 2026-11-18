// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { renderLogLine, safeLogText } from "../../src/feedback/log-text.js";
import { redactText } from "../../src/security/redact.js";

const mask = (text: string): string => redactText(text).text;

test("log lines keep ids levels and numbers and never a message body or a credential", () => {
  assert.equal(
    safeLogText(mask, "outbound", { op: "send", chars: 12, activity_id: "teams-1" }),
    "outbound op=send chars=12 activity_id=teams-1",
  );
  const leaked = safeLogText(mask, "handling", {
    text: "please summarise my private plan for the quarter",
    ok: true,
    none: null,
  });
  assert.ok(!leaked.includes("private plan"));
  assert.equal(leaked, "handling text=<str> ok=True none=None");
  assert.equal(safeLogText(mask, "stream dropped", { why: "Claw returned 502" }), "stream dropped why=<str>");
  assert.equal(safeLogText(mask, `oops Bearer ${"a".repeat(30)} here`), "oops [hidden] here");
  assert.equal(safeLogText(mask, "x".repeat(1000)).length, 200);
  assert.equal(safeLogText(mask, "two\nlines"), "two lines");
});

test("a kept line is rendered with its utc time, level and logger", () => {
  assert.equal(
    renderLogLine({ at: 1_762_689_600.7, level: "warn", logger: "feedback", text: "x=1" }),
    "2025-11-09T12:00:00Z WARNING feedback x=1",
  );
});
