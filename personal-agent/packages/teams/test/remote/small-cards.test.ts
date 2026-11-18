// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The smaller remote-agent cards: disconnecting a machine, taking over a conversation, the mode and agent pickers. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteDomain, remoteView } from "@primusclaw/personal-agent";

import { buttonsOf, cardOf, textsOf } from "../../../../test-support/adaptive-card.js";
import { assertValidCard } from "./card-schema.js";
import { disconnectCard, machineChoiceCard, modeCard, takeoverCard } from "../../src/views/remote/index.js";
import { SETUP, agent, connector } from "./fixtures.js";

type Json = Record<string, unknown>;
const data = (b: Json): Json => b["data"] as Json;

test("a paired machine is told only the pairing way back", () => {
  const card = cardOf(disconnectCard(remoteView.disconnectView("robin-dev", "c1", SETUP, "zh", true)));
  assertValidCard(card);
  const texts = textsOf(card);
  assert.ok(texts.some((t) => t.includes("连接我的开发环境")));
  assert.ok(!JSON.stringify(card).includes("claw-connector login"));
  assert.deepEqual(
    buttonsOf(card).map((b) => [b["style"], data(b)["confirm"]]),
    [
      ["destructive", true],
      [undefined, false],
    ],
  );
});

test("the takeover confirmation says what happens and carries the conversation", () => {
  const c = connector({ connectorId: "c-on", name: "devbox-7", online: true });
  const a = agent({ agentId: "cx", kind: "codex" });
  const entry = remoteDomain.resumableOf(
    agent({ agentId: "cx", capabilities: { resumable: [{ ref: "r-1", title: "", cwd: "/srv/p", state: "live" }] } }),
  )[0];
  assert.ok(entry);
  const card = cardOf(takeoverCard(remoteView.takeoverView(c, a, entry, "en", "sessions", "tk-1")));
  assertValidCard(card);
  assert.ok(textsOf(card).includes("**Untitled conversation**") && textsOf(card).includes("devbox-7 · /srv/p"));
  assert.deepEqual(
    buttonsOf(card).map((b) => data(b)),
    [
      {
        primusclaw: "remote",
        op: "new",
        takeover: "tk-1",
        connector_id: "c-on",
        agent_id: "cx",
        resume: "r-1",
        view: "sessions",
      },
      { primusclaw: "remote", op: "list", view: "sessions" },
    ],
  );
  const plain = cardOf(takeoverCard(remoteView.takeoverView(c, a, entry)));
  assert.deepEqual(
    buttonsOf(plain).map((b) => data(b)["takeover"]),
    ["1", undefined],
  );
});

test("the machine choice offers each agent and names the typed folder by its token", () => {
  const c = connector({ connectorId: "c1", name: "dev-pod", online: true });
  const many = Array.from({ length: 5 }, (_, n) =>
    agent({
      agentId: `a${String(n)}`,
      kind: "codex",
      name: `cx${String(n)}`,
      capabilities: { unattended: true, unattended_allowed: true },
    }),
  );
  const card = cardOf(machineChoiceCard(remoteView.machineChoiceView(c, many, "tok", "/srv/x", "zh")));
  assertValidCard(card);
  const buttons = buttonsOf(card);
  assert.equal(buttons.length, remoteDomain.OPTION_BUTTONS_MAX);
  assert.deepEqual(data(buttons[0] ?? {}), {
    primusclaw: "remote",
    op: "new",
    connector_id: "c1",
    agent_id: "a0",
    slot: 0,
    typed: "tok",
  });
  const texts = textsOf(card);
  assert.ok(texts.includes("还有 1 个没列出：发 /agents。") && texts.includes("⚠️ 无人值守：执行前不会请求批准"));
});

test("the mode card marks a mode that does not ask and starts on the current one", () => {
  const card = cardOf(modeCard(remoteView.modeView("s1", "plan", ["default", "plan"], new Set(["plan"]), "en")));
  const choice = (card["body"] as Json[])[1] as Json;
  assert.equal(choice["value"], "plan");
  assert.deepEqual(
    (choice["choices"] as Json[]).map((c) => c["title"]),
    ["default", "plan (unattended)"],
  );
  assert.deepEqual(
    (card["actions"] as Json[]).map((a) => [a["title"], a["style"]]),
    [
      ["Set mode", "positive"],
      ["Back", undefined],
    ],
  );
  assert.equal((cardOf(modeCard(remoteView.modeView("s1", null, ["a"])))["body"] as Json[]).length, 2);
});
