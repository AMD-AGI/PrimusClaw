// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the card of a question a terminal asks says of the terminal meanwhile, per coding agent (`remote.ask`'s `terminal_asks`):
 * Claude Code's terminal asks alongside the card and the first answer counts; Cursor's asks only after the card (which offers to
 * decline or hand it back); Codex's once someone types there. In each language, whole or cut short.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteDomain, remoteView } from "@primusclaw/personal-agent";

import { cardOf, textsOf } from "../../../../test-support/adaptive-card.js";
import { assertValidCard } from "./card-schema.js";
import { terminalAskCard } from "../../src/views/remote/index.js";

type Json = Record<string, unknown>;
const COMMAND_OPTIONS = [
  { optionId: "allow", name: "Yes", kind: "allow_once" },
  { optionId: "allow-session", name: "Always allow this session: Bash(npm test)", kind: "allow_always" },
  { optionId: "deny", name: "No", kind: "reject_once" },
  { optionId: "deny-stop", name: "No, and stop", kind: "reject_once" },
];

function card(ask: Json, lang: "en" | "zh" = "en"): Json {
  const view = remoteView.terminalAskView(
    { ask, options: remoteDomain.parseOptions(ask["options"]), sessionId: "s-1", machine: "dev-pod", agent: "claude" },
    lang,
  );
  const out = cardOf(terminalAskCard(view));
  assertValidCard(out);
  return out;
}
const titles = (c: Json): string[] => ((c["actions"] as Json[] | undefined) ?? []).map((a) => String(a["title"]));
const ids = (c: Json): string[] =>
  ((c["actions"] as Json[] | undefined) ?? []).map((a) => String((a["data"] as Json)["option_id"]));
const all = (c: Json): string => textsOf(c).join("\n");

test("how the terminal asks too is said per agent, in the person's language: alongside, after the card, or once typed there", () => {
  const command = {
    action_id: "a1",
    origin: "terminal",
    kind: "execute",
    tool: "Run: make test",
    input: { command: "make test" },
  };
  const CURSOR_OPTIONS = [
    { optionId: "deny", name: "No", kind: "reject_once" },
    { optionId: "terminal", name: "Ask me at the terminal", kind: "allow_once" },
  ];
  const CODEX_OPTIONS = [
    { optionId: "allow", name: "Yes", kind: "allow_once" },
    { optionId: "deny", name: "No", kind: "reject_once" },
  ];
  const cases: Array<{ who: string; ask: Json; en: RegExp; zh: RegExp }> = [
    {
      who: "Claude Code (no terminal_asks)",
      ask: { ...command, options: COMMAND_OPTIONS },
      en: /The terminal is asking too: the first answer, here or there, counts\./,
      zh: /终端里也在等你回答，先答的算数。/,
    },
    {
      who: "Cursor (after_card)",
      ask: { ...command, options: CURSOR_OPTIONS, terminal_asks: "after_card" },
      en: /The terminal asks only after this card is answered or its wait is over: decline it here, or hand it back to the terminal and approve it there\./,
      zh: /终端要等这张卡片答完或等待时间到了才会问：在这里拒绝，或交回终端、到终端里批准。/,
    },
    {
      who: "Codex (on_input)",
      ask: { ...command, options: CODEX_OPTIONS, terminal_asks: "on_input" },
      en: /To answer at the terminal instead, type anything there: the question goes back to it and this card is withdrawn\./,
      zh: /想改在终端里回答，就在终端里随便输入点什么：问题回到终端，这张卡片随之撤回。/,
    },
  ];
  for (const c of cases) {
    const en = all(card(c.ask));
    const zh = all(card(c.ask, "zh"));
    assert.match(en, c.en, c.who);
    assert.match(zh, c.zh, c.who);
    // Only Claude Code's terminal asks alongside the card: the others never say the first answer counts.
    if (c.ask["terminal_asks"] !== undefined) {
      assert.doesNotMatch(en, /first answer/, c.who);
      assert.doesNotMatch(zh, /先答的算数/, c.who);
    }
  }
  // Cursor's "hand it back" option is named in the person's language.
  const cursor = { ...command, options: CURSOR_OPTIONS, terminal_asks: "after_card" };
  assert.deepEqual(titles(card(cursor)), ["Ask me at the terminal", "No"]);
  assert.deepEqual(titles(card(cursor, "zh")), ["交回终端", "拒绝"]);
  // A value this client does not know is read as absent: Claude Code's words.
  assert.match(all(card({ ...command, options: COMMAND_OPTIONS, terminal_asks: "whenever" })), /first answer/);

  // Too long to show whole: only the turn-down options, and the note says how that agent's terminal asks.
  const long = { ...command, input: { command: "x".repeat(17_000) } };
  const cut: Array<{ asks: string; options: Json[]; en: RegExp; zh: RegExp }> = [
    { asks: "", options: COMMAND_OPTIONS, en: /approve it at the terminal\./, zh: /请到终端批准。/ },
    {
      asks: "after_card",
      options: CURSOR_OPTIONS,
      en: /it can only be declined from the phone; the terminal asks once this card's wait is over\./,
      zh: /手机上只能拒绝；这张卡片的等待时间一过，终端就会问你。/,
    },
    {
      asks: "on_input",
      options: CODEX_OPTIONS,
      en: /to approve it, type anything at the terminal and answer it there\./,
      zh: /要批准，在终端里随便输入点什么，到终端里回答。/,
    },
  ];
  for (const c of cut) {
    const ask = { ...long, options: c.options, ...(c.asks ? { terminal_asks: c.asks } : {}) };
    const en = card(ask);
    assert.deepEqual(
      ids(en),
      c.options.filter((o) => String(o["kind"]).startsWith("reject")).map((o) => o["optionId"]),
      c.asks,
    );
    assert.match(all(en), c.en, c.asks);
    assert.match(all(card(ask, "zh")), c.zh, c.asks);
    if (c.asks) assert.doesNotMatch(all(en), /first answer|hand it back/, c.asks);
  }
});
