// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The permission card built from the options the agent itself offered (test_remote_view), and the cards of its answer. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteView } from "@primusclaw/personal-agent";

import { assertValidCard, cardOf, textsOf } from "../../../../test-support/adaptive-card.js";
import { CLAUDE_OPTIONS, CODEX_OPTIONS, CURSOR_OPTIONS } from "../../../../test-support/remote-fake-data.js";
import { decidedCard, permissionCard, remoteAskCard } from "../../src/views/remote/index.js";

type Json = Record<string, unknown>;
const data = (b: Json): Json => b["data"] as Json;
const REQUEST = { actionId: "a1", tool: "Edit README.md", kind: "edit", input: { path: "README.md" } };

function cardFor(options: unknown, request: Json = REQUEST): Json {
  const view = remoteView.permissionView(
    request,
    remoteView.parseOptions(options),
    "sess-1",
    "Codex on dev-pod",
    1_000_000,
    "UTC",
  );
  const card = cardOf(permissionCard(view));
  assertValidCard(card);
  return card;
}
const actionsOf = (card: Json): Json[] => card["actions"] as Json[];

test("the buttons are the options the adapter offered with their own ids", () => {
  const cases: [string, unknown, string[], string[]][] = [
    [
      "Claude",
      CLAUDE_OPTIONS,
      ["Allow once", "Always: Allow and update my settings", "Reject"],
      ["allow-once", "allow-with-updates", "reject"],
    ],
    [
      "Codex",
      CODEX_OPTIONS,
      ["Allow once", "Always allow this command", "Cancel"],
      ["allow_once", "accept_execpolicy_amendment", "cancel"],
    ],
    ["Cursor", CURSOR_OPTIONS, ["Allow once", "Allow always", "Reject"], ["allow-once", "allow-always", "reject-once"]],
  ];
  for (const [name, options, titles, ids] of cases) {
    const buttons = actionsOf(cardFor(options));
    assert.deepEqual(
      buttons.map((b) => data(b)["option_id"]),
      ids,
      name,
    );
    assert.deepEqual(
      buttons.map((b) => b["title"]),
      titles,
      name,
    );
    assert.deepEqual(
      buttons.map((b) => b["style"]),
      ["positive", undefined, undefined],
      name,
    );
    for (const b of buttons) {
      assert.equal(b["type"], "Action.Execute");
      assert.equal(b["verb"], "primusclaw.remote_decision");
      assert.deepEqual(
        [data(b)["primusclaw"], data(b)["session_id"], data(b)["action_id"]],
        ["remote_decision", "sess-1", "a1"],
      );
    }
  }
});

test("the allow always option is shown labelled and explained", () => {
  const card = cardFor(CLAUDE_OPTIONS);
  const always = actionsOf(card).filter((b) => data(b)["option_id"] === "allow-with-updates");
  assert.equal(always.length, 1);
  assert.ok(String(always[0]?.["title"]).startsWith("Always"));
  assert.ok(textsOf(card).some((t) => t.includes("changes what this agent may do on your machine")));
  const plain = cardFor(CLAUDE_OPTIONS.filter((o) => o.kind !== "allow_always"));
  assert.ok(!textsOf(plain).some((t) => t.includes("changes what this agent may do")));
});

test("buttons come in a fixed order whatever order the agent sent", () => {
  const shuffled = [CODEX_OPTIONS[2], CODEX_OPTIONS[1], CODEX_OPTIONS[0]];
  assert.deepEqual(
    actionsOf(cardFor(shuffled)).map((b) => data(b)["option_id"]),
    ["allow_once", "accept_execpolicy_amendment", "cancel"],
  );
});

test("no more than four buttons and the allow and reject ones survive", () => {
  const many = [
    ...Array.from({ length: 6 }, (_, n) => ({ optionId: `x${String(n)}`, name: `Odd ${String(n)}`, kind: "mystery" })),
    ...CURSOR_OPTIONS,
    { optionId: "reject-always", name: "Never", kind: "reject_always" },
  ];
  const buttons = actionsOf(cardFor(many));
  assert.equal(buttons.length, remoteView.OPTION_BUTTONS_MAX);
  assert.deepEqual(
    buttons.map((b) => data(b)["option_id"]),
    ["allow-once", "allow-always", "reject-once", "reject-always"],
  );
});

test("an option with an unknown kind is still a button with its own name", () => {
  const card = cardFor([{ optionId: "maybe", name: "Ask me later", kind: "snooze" }]);
  assert.deepEqual(
    actionsOf(card).map((b) => [b["title"], data(b)["option_id"], b["style"]]),
    [["Ask me later", "maybe", undefined]],
  );
});

test("only usable options are kept and each once", () => {
  const cases: [unknown, string[]][] = [
    [
      [
        { optionId: "a", name: "A", kind: "allow_once" },
        { optionId: "a", name: "again", kind: "allow_once" },
      ],
      ["a"],
    ],
    [[{ name: "no id", kind: "allow_once" }, { optionId: "", name: "empty" }, { optionId: 7 }], []],
    [["not an object", null, 3], []],
    ["not a list", []],
    [[{ optionId: "x".repeat(200), name: "too long" }, { optionId: "bad\nid" }, { optionId: "ok" }], ["ok"]],
  ];
  for (const [raw, kept] of cases)
    assert.deepEqual(
      remoteView.parseOptions(raw).map((o) => o.optionId),
      kept,
    );
});

test("option ids are passed through untouched", () => {
  const odd = remoteView.parseOptions([{ optionId: "Allow_Once-v2.1:x", name: "Go", kind: "allow_once" }]);
  assert.equal(odd[0]?.optionId, "Allow_Once-v2.1:x");
  assert.equal(remoteView.optionButtons(odd, "s", "a")[0]?.optionId, "Allow_Once-v2.1:x");
});

test("a button without a name says what its kind means", () => {
  const title = (kind: string, name = "", optionId = "o") => remoteView.buttonTitle({ optionId, name, kind });
  assert.equal(title("allow_once"), "Allow once");
  assert.equal(title("allow_always"), "Always allow");
  assert.equal(title("reject_once"), "Reject");
  assert.equal(title("", "", "weird-id"), "weird-id");
  assert.ok(title("allow_once", "n".repeat(200)).length <= 40);
  assert.equal(remoteView.buttonTitle({ optionId: "o", name: "好的", kind: "allow_always" }, "zh"), "始终：好的");
  assert.equal(remoteView.buttonTitle({ optionId: "o", name: "始终允许", kind: "allow_always" }, "zh"), "始终允许");
});

test("the card says whose agent and until when", () => {
  const texts = textsOf(cardFor(CODEX_OPTIONS));
  assert.ok(texts.includes("Codex on dev-pod asks permission (edit)."));
  assert.ok(texts.some((t) => t.startsWith("Valid until ") && t.endsWith("(UTC). After that it is refused.")));
  const plain = textsOf(cardFor(CODEX_OPTIONS, { actionId: "a1", tool: "Think hard", kind: "" }));
  assert.ok(plain.includes("Codex on dev-pod asks permission."));
});

test("the title the agent wrote cannot make a link or leak a secret", () => {
  const card = cardFor(CODEX_OPTIONS, {
    actionId: "a1",
    tool: "Open [update](https://evil.example/x) with ghp_" + "a".repeat(36),
    kind: "execute",
  });
  const blob = JSON.stringify(card);
  assert.ok(!blob.includes("](") && !blob.includes("ghp_" + "a".repeat(36)));
});

test("defang keeps text whole and leaves other values alone", () => {
  assert.deepEqual(remoteView.defang({ a: ["[x](u)", 3, null, true, { "<k>": "<v>" }] }), {
    a: ["[x]​(u)", 3, null, true, { "‹k›": "‹v›" }],
  });
  assert.equal(remoteView.defang("plain text [with] brackets (and parens)"), "plain text [with] brackets (and parens)");
  assert.equal(remoteView.defang(7), 7);
  assert.equal(remoteView.defang(null), null);
});

test("the push of an agent that waits says what for and whose it is", () => {
  const view = remoteView.remoteAskView(
    {
      ask: { action_id: "act-2", tool: "Bash" },
      options: remoteView.parseOptions(CLAUDE_OPTIONS),
      sessionId: "s",
      machine: "devbox-7",
      agent: "cx-main",
      about: "#3 fix",
      expiresAt: 0,
      zone: "Asia/Shanghai",
    },
    "en",
  );
  const card = cardOf(remoteAskCard(view));
  assertValidCard(card);
  const texts = textsOf(card);
  assert.ok(texts.includes("**Bash**") && texts.includes("cx-main on devbox-7 waits for you: #3 fix"));
  assert.ok(texts.includes("Valid until 08:00 (Asia/Shanghai). After that it is refused."));
  assert.equal((card["actions"] as Json[]).length, 3);
});

test("what a permission card becomes once answered says who and when", () => {
  const allowed = cardOf(
    decidedCard(remoteView.decidedView({ optionId: "o", name: "", kind: "allow_once" }, 0, "UTC", "zh")),
  );
  assert.ok(textsOf(allowed).includes("✅ 已允许一次（你，00:00）"));
  const odd = cardOf(decidedCard(remoteView.decidedView({ optionId: "o", name: "Later", kind: "snooze" }, 0, "UTC")));
  assert.ok(textsOf(odd).includes("🚫 Later (you, 00:00)"));
});
