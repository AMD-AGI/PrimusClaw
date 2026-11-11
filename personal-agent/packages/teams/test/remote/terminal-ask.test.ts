// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card of a question a terminal asks (a connector's approval hooks; `remote.ask` with `origin: "terminal"`): what it shows of
 * each kind of request, the options as buttons, and that nothing can be approved the card does not show whole.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteDomain, remoteView } from "@primusclaw/personal-agent";

import { cardOf, textsOf } from "../../../../test-support/adaptive-card.js";
import { assertValidCard } from "./card-schema.js";
import { terminalAskCard } from "../../src/views/remote/index.js";
import { remoteAskCard } from "../../src/assembly/features-assistant.js";

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

test("a command: shown whole in a fixed-width block, with every option as a button (in the person's language)", () => {
  const ask = {
    action_id: "a1",
    origin: "terminal",
    kind: "execute",
    tool: "Run: npm test",
    input: { command: "npm test -- --grep 'a_b'", description: "Run the tests" },
    options: COMMAND_OPTIONS,
  };
  const c = card(ask);
  assert.deepEqual(ids(c), ["allow", "allow-session", "deny", "deny-stop"]);
  assert.deepEqual(titles(c), ["Yes", "Always allow (this session)", "No", "No, and stop"]);
  const mono = (c["body"] as Json[]).find((b) => b["fontType"] === "Monospace");
  assert.equal(mono?.["text"], "npm test -- --grep 'a\\_b'");
  assert.match(all(c), /Run the tests/);
  // What the "always" option grants is written out whole (a button shows 40 characters).
  assert.match(all(c), /means: Always allow this session: Bash\(npm test\)/);
  assert.match(all(c), /first answer/);
  assert.deepEqual(titles(card(ask, "zh")), ["允许", "本会话始终允许", "拒绝", "拒绝并停止"]);
  assert.match(all(card(ask, "zh")), /先答的算数/);
});

test("a plan as words (lists kept, no link can be made), a question with each answer's meaning, an edit with both sides", () => {
  const plan = card({
    action_id: "p1",
    origin: "terminal",
    kind: "switch_mode",
    tool: "Plan: Refactor",
    input: { plan: "## Refactor\n1. **Extract** it\n2. See [docs](https://evil.example)" },
    options: [
      { optionId: "plan-approve", name: "Approve (ask before each edit)", kind: "allow_once" },
      { optionId: "plan-keep", name: "Keep planning", kind: "reject_once" },
    ],
  });
  assert.match(all(plan), /\*\*Extract\*\*/);
  assert.doesNotMatch(all(plan), /\]\(https/);
  assert.deepEqual(ids(plan), ["plan-approve", "plan-keep"]);

  const q = card({
    action_id: "q1",
    origin: "terminal",
    kind: "question",
    tool: "Which color?",
    question_index: 0,
    question_count: 2,
    input: {
      header: "Color",
      question: "Which color?",
      options: [
        { label: "Red", description: "warm" },
        { label: "Blue", description: "cool" },
      ],
    },
    options: [
      { optionId: "a0", name: "Red", kind: "allow_once" },
      { optionId: "a1", name: "Blue", kind: "allow_once" },
    ],
  });
  assert.deepEqual(titles(q), ["Red", "Blue"]);
  assert.match(all(q), /cool/);
  assert.match(all(q), /Question 1 of 2/);

  const edit = card({
    action_id: "e1",
    origin: "terminal",
    kind: "edit",
    tool: "Edit /w/a.ts",
    input: { file_path: "/w/a.ts", old_string: "let a = 1", new_string: "const a = 1" },
    options: COMMAND_OPTIONS.slice(0, 1),
  });
  assert.match(all(edit), /a\.ts/);
  assert.match(all(edit), /let a = 1/);
  assert.match(all(edit), /const a = 1/);
});

test("nothing is approved unseen: a field the kind does not show is shown as JSON, a line too long to show whole keeps only the turn-down options", () => {
  const extra = card({
    action_id: "f1",
    origin: "terminal",
    kind: "execute",
    tool: "Run",
    input: { command: "ls", run_in_background: true, timeout: 5 },
    options: COMMAND_OPTIONS,
  });
  assert.match(all(extra), /run\\_in\\_background|run_in_background/);
  assert.deepEqual(ids(extra), ["allow", "allow-session", "deny", "deny-stop"]);
  const longDescription = card({
    action_id: "f2",
    origin: "terminal",
    kind: "execute",
    tool: "Run",
    input: { command: "ls", description: "d".repeat(401) },
    options: COMMAND_OPTIONS,
  });
  assert.deepEqual(ids(longDescription), ["deny", "deny-stop"]);
  const longPath = card({
    action_id: "f3",
    origin: "terminal",
    kind: "edit",
    tool: "Edit",
    input: { file_path: `/w/${"p".repeat(500)}.ts`, content: "x" },
    options: COMMAND_OPTIONS,
  });
  assert.deepEqual(ids(longPath), ["deny", "deny-stop"]);
  const longRule = card({
    action_id: "f4",
    origin: "terminal",
    kind: "execute",
    tool: "Run",
    input: { command: "ls" },
    options: [
      { optionId: "allow-session", kind: "allow_always", name: `Always allow this session: ${"r".repeat(300)}` },
      { optionId: "allow", name: "Yes", kind: "allow_once" },
    ],
  });
  assert.deepEqual(ids(longRule), ["allow"]);
});

test("nothing is approved unseen: content that did not come, or is longer than a card shows, keeps only the options that turn it down", () => {
  const missing = card({
    action_id: "x1",
    origin: "terminal",
    kind: "execute",
    tool: "Run: …",
    options: COMMAND_OPTIONS,
  });
  assert.deepEqual(ids(missing), ["deny", "deny-stop"]);
  assert.match(all(missing), /approve it at the terminal/);
  const long = "x".repeat(remoteView.TERMINAL_CONTENT_MAX + 10);
  const big = card({
    action_id: "x2",
    origin: "terminal",
    kind: "execute",
    tool: "Run",
    input: { command: `${long}; rm -rf ~` },
    options: COMMAND_OPTIONS,
  });
  assert.deepEqual(ids(big), ["deny", "deny-stop"]);
  assert.doesNotMatch(all(big), /rm -rf/);
  // The largest card that may still be approved fits in a Teams message (about 28 KB).
  const fits = card({
    action_id: "x3",
    origin: "terminal",
    kind: "execute",
    tool: "Run",
    input: { command: "y".repeat(remoteView.TERMINAL_CONTENT_MAX - 10) },
    options: COMMAND_OPTIONS,
  });
  assert.deepEqual(ids(fits), ["allow", "allow-session", "deny", "deny-stop"]);
  assert.ok(Buffer.byteLength(JSON.stringify(fits)) < 26_000);
});

test("the assembly draws a terminal's question with this card, and any other request as before", () => {
  const base = {
    options: COMMAND_OPTIONS,
    sessionId: "s-1",
    machine: "dev-pod",
    agent: "claude",
    about: "#7 x",
    expiresAt: 1e9,
    zone: "UTC",
    lang: "en",
  };
  const terminal = remoteAskCard({
    ...base,
    ask: { action_id: "a1", origin: "terminal", kind: "execute", tool: "Run", input: { command: "ls" } },
  });
  assert.equal((terminal.body as { view: { name: string } }).view.name, "terminalAsk");
  const other = remoteAskCard({ ...base, ask: { action_id: "a1", tool: "Bash" } });
  assert.equal((other.body as { view: { name: string } }).view.name, "remoteAsk");
});

test("review round 2: an answer's extra fields are shown, and markup-heavy content never makes a card Teams would refuse", () => {
  const q = card({
    action_id: "q2",
    origin: "terminal",
    kind: "question",
    tool: "Pick",
    input: { question: "Pick", options: [{ label: "A", description: "a", action: "rm -rf ~" }, { label: "B" }] },
    options: [
      { optionId: "a0", name: "A", kind: "allow_once" },
      { optionId: "a1", name: "B", kind: "allow_once" },
    ],
  });
  assert.match(all(q), /rm -rf/);
  // An answer that hides a field is still answerable, because the field is on the card.
  assert.deepEqual(ids(q), ["a0", "a1"]);

  // 15,920 asterisks: each is escaped on the card, so the rendered text is far longer than the request.
  const stars = card({
    action_id: "s1",
    origin: "terminal",
    kind: "execute",
    tool: "Run",
    input: { command: `printf '${"*".repeat(15_920)}'` },
    options: COMMAND_OPTIONS,
  });
  assert.deepEqual(ids(stars), ["deny", "deny-stop"]);
  assert.match(all(stars), /approve it at the terminal/);
  assert.ok(Buffer.byteLength(JSON.stringify(stars)) < 28_000, String(Buffer.byteLength(JSON.stringify(stars))));
  // Backslashes double once more in the card's JSON: the worst case still fits.
  const slashes = card({
    action_id: "s2",
    origin: "terminal",
    kind: "switch_mode",
    tool: "Plan",
    input: { plan: "\\".repeat(15_900) },
    options: COMMAND_OPTIONS.slice(0, 1),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(slashes)) < 28_000);
  assert.deepEqual(ids(slashes), []);
});

test("review round 3: many short answers count what each element adds, so the card still fits and is not approvable", () => {
  const answers = Array.from({ length: 420 }, (_, i) => ({ label: `o${String(i)}`, description: "d" }));
  const q = card({
    action_id: "q3",
    origin: "terminal",
    kind: "question",
    tool: "Pick",
    input: { question: "Pick", options: answers },
    options: [{ optionId: "a0", name: "o0", kind: "allow_once" }],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(q)) < 28_000, String(Buffer.byteLength(JSON.stringify(q))));
  assert.deepEqual(ids(q), []);
  assert.match(all(q), /approve it at the terminal/);
});
