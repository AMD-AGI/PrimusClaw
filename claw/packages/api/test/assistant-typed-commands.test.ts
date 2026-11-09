// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The commands a user types back (approve #ref, deny #ref, undo #N) are given to them in the language they are answered in
 * (`typed-commands.ts`). 2026-11-09, an English conversation: "Say 撤销 #1343 to undo it", "or reply 批准 #5ec155": the tool results and
 * the router's state spelt them in Chinese only, and the router repeated them word for word.
 *
 *   C1  each command in each language, as the parsers read it back (`approvalCommand`, `denialCommand`)
 *   C2  the language of a message: Chinese only for Chinese; English, any other language and a message with no words of its own get English
 *   C3  what waits for the user is shown with the command of the turn's language, the English one when none is given
 *   C4  no prompt tells the router to give the Chinese form alone, and the router is told to give the one of its reply language
 */
import assert from "node:assert/strict";
import test from "node:test";

import { commandLanguage, commandLanguageOf, typedCommand, typedCommandEither, TYPED_COMMANDS_RULE } from "../src/assistant/typed-commands.js";

test("C1 each command reads back as itself, in either language", async () => {
  const { approvalCommand } = await import("../src/assistant/review-tools.js");
  const { denialCommand } = await import("../src/assistant/schedules.js");
  for (const lang of ["zh", "en"] as const) {
    assert.equal(approvalCommand(typedCommand("approve", "a3f9c2", lang)), "a3f9c2", lang);
    assert.equal(denialCommand(typedCommand("deny", "a3f9c2", lang)), "a3f9c2", lang);
  }
  assert.equal(typedCommand("approve", "a3f9c2", "en"), "approve #a3f9c2");
  assert.equal(typedCommand("approve", "a3f9c2", "zh"), "批准 #a3f9c2");
  assert.equal(typedCommand("undo", 1343, "en"), "undo #1343");
  assert.equal(typedCommand("undo", 1343, "zh"), "撤销 #1343");
  assert.equal(typedCommandEither("deny", "<ref>"), "deny #<ref> (拒绝 #<ref>)");
});

test("C2 Chinese only for a Chinese message; every other one is told the English command", async () => {
  assert.equal(await commandLanguageOf("记住：我主要做 ROCm GEMM 优化"), "zh");
  assert.equal(await commandLanguageOf("remember: I mainly work on ROCm GEMM kernel optimization, keep answers short"), "en");
  assert.equal(await commandLanguageOf("remind me this Friday at 3 pm to read the ROCm 7.1 release notes"), "en");
  assert.equal(await commandLanguageOf("フライデーにリマインドしてください"), "en", "the commands are read in Chinese and English only");
  // A message with no words of its own says nothing: the user's earlier messages, newest first, decide.
  assert.equal(await commandLanguageOf("#3", () => ["帮我看看这个 CI", "what is this"]), "zh");
  assert.equal(await commandLanguageOf("ok", () => ["why did the build fail on main?"]), "en");
  assert.equal(commandLanguage(null), "en");
  assert.equal(commandLanguage("Chinese"), "zh");
});

test("C3 what waits for the user is shown with the command of the turn's language", async () => {
  const { renderReviewState } = await import("../src/assistant/prompts.js");
  const confirmations = [{ id: "a3f9c2d1-5b7e-4c1a-9f00-000000000224", repo: "AMD-AGI/PrimusClaw", pr: 224, kind: "merge", expires_at: "2026-11-09T00:00:00.000Z" }];
  const base = { confirmations, reviewMode: "high_risk_confirm", people: [], actions: [], repos: [] };
  const en = renderReviewState({ ...base, commands: "en" });
  assert.match(en, /the user lets it through with: approve #a3f9c2$/m);
  assert.doesNotMatch(en, /批准/);
  assert.match(renderReviewState({ ...base, commands: "zh" }), /the user lets it through with: 批准 #a3f9c2$/m);
  assert.match(renderReviewState(base), /approve #a3f9c2$/m, "English when the turn's language is not given");
});

test("C4 no prompt gives the Chinese command alone, and the router gives the one of its reply language", async () => {
  const p = await import("../src/assistant/prompts.js");
  const { renderRouterProactiveSection } = await import("../src/assistant/proactive-prompt.js");
  const prompts = {
    router: p.renderRouterPrompt(), review: p.ROUTER_REVIEW_PROMPT, memory: p.ROUTER_MEMORY_PROMPT,
    devenv: p.renderRouterDevenvSection({ actions: true, send: true }),
    proactive: renderRouterProactiveSection({ schedules: true, jobs: false, pullRequests: false }),
  };
  let seen = 0;
  for (const [name, text] of Object.entries(prompts)) {
    // Each Chinese command is beside its English one, never the only one the router is given to repeat.
    for (const m of text.matchAll(/(批准|拒绝|撤销) #(<ref>|ref|N)(?!\w)/g)) {
      const english = { 批准: "approve", 拒绝: "deny", 撤销: "undo" }[m[1] as "批准" | "拒绝" | "撤销"];
      const near = text.slice(Math.max(0, m.index - 120), m.index + 120);
      assert.ok(near.includes(`${english} #${m[2]}`), `${name}: "${m[0]}" without "${english} #${m[2]}" beside it: …${near}…`);
      seen += 1;
    }
  }
  assert.ok(seen >= 5, `the prompts name the Chinese commands ${seen} times: the check above read none of them`);
  assert.ok(prompts.router.includes(TYPED_COMMANDS_RULE), "the router is told to give the command of the language it answers in");
  assert.match(prompts.memory, /the undo command the tool answered \(undo #N, or 撤销 #N in Chinese\)/);
});
