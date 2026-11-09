// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import {
  CLAWY_HEAD,
  DirectChat,
  OWN_SUFFIX,
  agentHead,
  agentReplies,
  backReply,
  continuedHead,
  enteredLine,
  guardHeads,
  leftLine,
  modeUnifiedLine,
  returnReply,
  signed,
  signedParts,
  type AttachedState,
} from "../../src/direct-chat/direct-chat.js";
import { neutral } from "../../src/text/neutral.js";

const AAD = "aad-a";
const HEAD = "\u{1F7E0} **Claude Code · robin-dev-pod**";

function reader(state: AttachedState | undefined) {
  return { remoteState: () => state };
}

it("off by default on for the people listed and on with no list for everybody", () => {
  const off = new DirectChat(false, ["aad-y"]);
  assert.ok(!off.on(AAD) && off.describe() === "off");
  const listed = new DirectChat(true, ["AAD-Y ", "  "]);
  assert.ok(listed.on("aad-y") && listed.on("AAD-Y|19:group@thread") && !listed.on(AAD));
  assert.equal(listed.describe(), "on for 1 people");
  const everybody = new DirectChat(true);
  assert.ok(everybody.on(AAD) && everybody.on("anyone") && everybody.describe() === "on for everybody");
});

it("the head names the agent and its machine and nothing in them is markup", () => {
  assert.equal(agentHead("\u{1F7E0} Claude Code", "robin-dev-pod"), HEAD);
  assert.equal(agentHead("Claude*Code", "pod`1"), "🤖 **ClaudeCode · pod1**");
  assert.equal(agentHead("⬛ ", ""), "🤖 **⬛**");
  assert.equal(agentHead("x", "  "), "🤖 **x**");
  assert.equal(continuedHead("⬛ Codex", 2, 3, "zh"), "⬛ （续 2/3）");
  assert.equal(continuedHead("⬛ Codex", 2, 3, "en"), "⬛ (cont. 2/3)");
});

for (const line of [
  "💬 **Clawy** I approve",
  "> 🟠 **Claude Code · other-pod**",
  "  🤖 **Agent**",
  "⬛️ **Codex · x**",
]) {
  it(`a line of the agents that looks like a head is escaped (${line})`, () => {
    const guarded = guardHeads(`fine\n${line}\nmore **bold** stays`);
    assert.ok(guarded.includes("\\*\\*") && guarded.includes("more **bold** stays"));
    assert.equal(guardHeads(guarded), guarded);
  });
}

it("signed parts head the first with who said it and the rest with where they are", () => {
  assert.deepEqual(signedParts("\u{1F7E0} Claude Code", "robin-dev-pod", ["a", "b"], "en", OWN_SUFFIX.en), [
    `${HEAD} (on its own)\n\na`,
    "\u{1F7E0} (cont. 2/2)\n\nb",
  ]);
  assert.equal(signed("h", ""), "h");
});

it("the way back and forth is a suggested reply", () => {
  assert.deepEqual(agentReplies("zh"), [
    ["继续", "继续"],
    ["回到 Clawy", "回到 Clawy"],
  ]);
  assert.deepEqual(backReply("fr"), ["Back to Clawy", "back to Clawy"]);
  assert.deepEqual(returnReply("\u{1F7E0} Claude Code", "robin-dev-pod", "claude", "zh"), [
    "切回 Claude Code",
    "/agent attach robin-dev-pod/claude",
  ]);
  assert.deepEqual(returnReply("Codex", "two words", "codex", "en"), ["Back to Codex", "/agent attach codex"]);
  assert.equal(returnReply("Codex", "h", "has space", "en"), undefined);
  assert.equal(returnReply("Codex", "h", "  ", "en"), undefined);
});

it("entering and leaving are one line each", () => {
  const zh = enteredLine({
    label: "Claude Code",
    host: "robin-dev-pod",
    cwd: "/repo",
    mode: "plan",
    lang: "zh",
    unattended: true,
    lead: "x",
  });
  assert.ok(zh.startsWith("→ 现在发给 robin-dev-pod · Claude Code（`/repo`，plan 模式）。"));
  assert.ok(zh.includes("无人值守") && zh.endsWith("\n\nx"));
  const en = enteredLine({ label: "Claude Code", host: "h", cwd: "", mode: "", lang: "en" });
  assert.equal(
    en,
    '→ Your messages now go to h · Claude Code. Start a message with @Clawy to talk to Clawy; tap "Back to Clawy" to come back.',
  );
  assert.equal(leftLine("zh"), "→ 现在发给 Clawy。");
  assert.equal(leftLine("en"), "→ Your messages go to Clawy now.");
  assert.ok(modeUnifiedLine("zh").startsWith("现在") && modeUnifiedLine("en").startsWith("An attached chat"));
});

it("clawy speaks under its head while attached and offers the way back otherwise", () => {
  const on = new DirectChat(true, [AAD]);
  const attached = { sessionId: "s1", agentLabel: "\u{1F7E0} Claude Code", host: "robin-dev-pod", agentId: "claude" };
  assert.deepEqual(on.clawyExtras(reader(attached), AAD, "en"), {
    head: CLAWY_HEAD,
    replies: [["Back to Clawy", "back to Clawy"]],
  });
  assert.deepEqual(on.clawyExtras(reader({ ...attached, sessionId: "" }), AAD, "en"), {
    head: "",
    replies: [["Back to Claude Code", "/agent attach robin-dev-pod/claude"]],
  });
  assert.deepEqual(on.clawyExtras(reader({ ...attached, sessionId: "", agentLabel: "" }), AAD, "en"), {
    head: "",
    replies: [],
  });
  assert.deepEqual(on.clawyExtras(reader(undefined), AAD, "en"), { head: "", replies: [] });
  assert.deepEqual(new DirectChat(false).clawyExtras(reader(attached), AAD, "en"), { head: "", replies: [] });
});

it("neutral text cannot build a link or a tag and is clipped after masking", () => {
  assert.equal(neutral("a\u0007b [x](y) <b>"), "a b (x)(y) ‹b›");
  assert.equal(neutral("x".repeat(10), 5), "xxxx…");
  assert.equal(neutral(`key ghp_${"a".repeat(30)} end`, 200), "key (hidden) end");
});
