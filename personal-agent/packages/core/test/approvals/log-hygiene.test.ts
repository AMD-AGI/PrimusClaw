// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { openTestStore } from "../../../../test-support/store.js";
import { FakeSurface, testConversation } from "../../../../test-support/surface.js";
import { ApprovalDecisions } from "../../src/approvals/decide.js";
import { turnApprovalsFor } from "../../src/approvals/records.js";
import { ClawError } from "../../src/claw/errors.js";
import type { LogFields, Logger } from "../../src/ports/logger.js";
import type { ClickRoute } from "../../src/ports/routing.js";
import { err } from "../../src/result.js";

const TOOL_INPUT_MARK = "TOOL-INPUT-MARK-5521";
const SAFE_KEY = "ak-" + "q7Lm2Xv9Rt4Bn8Wc3Yp6";
const PASTED_KEY = "ak-" + "Pasted1x2y3z4w5v6u7t";
const ECHO_BODY = `{"error":"bad","detail":"echo ${TOOL_INPUT_MARK} ${PASTED_KEY}"}`;

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  private add(level: string, message: string, fields?: LogFields): void {
    this.lines.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`);
  }
  debug(m: string, f?: LogFields): void {
    this.add("debug", m, f);
  }
  info(m: string, f?: LogFields): void {
    this.add("info", m, f);
  }
  warn(m: string, f?: LogFields): void {
    this.add("warn", m, f);
  }
  error(m: string, f?: LogFields): void {
    this.add("error", m, f);
  }
  child(): Logger {
    return this;
  }
}

it("an approval card and its answers do not log the tool input", async () => {
  const { store } = openTestStore();
  const logger = new RecordingLogger();
  const surface = new FakeSurface();
  const conversation = surface.conversation(testConversation("conv-aad-a"));
  const records = turnApprovalsFor(store, "aad-a");
  const card = { body: { type: "text" as const, text: `echo ${TOOL_INPUT_MARK} ${PASTED_KEY}` } };
  assert.equal(records.record("s1", "tu1", "bash", undefined, conversation.outgoing(card)), true);
  records.sent("s1", "tu1");
  const calls: string[] = [];
  let fail: Error | undefined = undefined;
  const decisions = new ApprovalDecisions({
    store,
    claw: {
      decide: (key) => {
        calls.push(`decide ${key === SAFE_KEY ? "key" : "?"}`);
        return fail ? Promise.reject(fail) : Promise.resolve();
      },
      answer: () => Promise.resolve(),
    },
    exchange: {
      enabled: false,
      tokenFor: () => Promise.resolve(err({ kind: "exchange_unavailable" as const })),
      bindingRequest: () => Promise.resolve(err({ kind: "exchange_unavailable" as const })),
      invalidate: () => undefined,
    },
    allowance: { take: () => undefined, giveBack: () => undefined },
    audit: (record) => {
      logger.info("approval_answered", { tool: record.tool, outcome: record.outcome, status: record.status });
    },
    logger,
  });
  const press = (id: string) =>
    ({
      sender: { id: "aad-a", name: "Alice", email: "", channelUserId: "29:a" },
      conversation,
      scope: "",
      action: {
        data: { primusclaw: "decision", session_id: "s1", tool: "bash", tool_use_id: "tu1", action: "allow" },
        id,
      },
      lang: () => "en",
      settle: () => Promise.resolve(true),
    }) as unknown as ClickRoute;
  await decisions.decide(press("c1"), SAFE_KEY);
  fail = new ClawError(500, ECHO_BODY); // (Claw refuses the second answer with a body that echoes it)
  store.approvals.closeApproval("s1", "tu1", "pending", { onlyIfPending: false });
  await decisions.decide(press("c2"), SAFE_KEY);
  assert.deepEqual(calls, ["decide key", "decide key"]);
  const text = logger.lines.join("\n");
  for (const marker of [TOOL_INPUT_MARK, PASTED_KEY, SAFE_KEY])
    assert.ok(!text.includes(marker), `${marker} reached the log:\n${text}`);
});
