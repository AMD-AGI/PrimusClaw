// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The permission card built from the options the agent itself offered (test_remote_view), and the cards of its answer. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { remoteDomain, remoteView } from "@primusclaw/personal-agent";

import { cardOf, textsOf } from "../../../../test-support/adaptive-card.js";
import { assertValidCard } from "./card-schema.js";
import { CLAUDE_OPTIONS, CODEX_OPTIONS, CURSOR_OPTIONS } from "../../../../test-support/remote-fake-data.js";
import { decidedCard, permissionCard, remoteAskCard } from "../../src/views/remote/index.js";

type Json = Record<string, unknown>;
const data = (b: Json): Json => b["data"] as Json;
const REQUEST = { actionId: "a1", tool: "Edit README.md", kind: "edit", input: { path: "README.md" } };

function cardFor(options: unknown, request: Json = REQUEST): Json {
  const view = remoteView.permissionView(
    request,
    remoteDomain.parseOptions(options),
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
  assert.equal(buttons.length, remoteDomain.OPTION_BUTTONS_MAX);
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
      remoteDomain.parseOptions(raw).map((o) => o.optionId),
      kept,
    );
});

test("option ids are passed through untouched", () => {
  const odd = remoteDomain.parseOptions([{ optionId: "Allow_Once-v2.1:x", name: "Go", kind: "allow_once" }]);
  assert.equal(odd[0]?.optionId, "Allow_Once-v2.1:x");
  assert.equal(remoteView.optionButtons(odd, "s", "a")[0]?.optionId, "Allow_Once-v2.1:x");
});

test("a button without a name says what its kind means", () => {
  const title = (kind: string, name = "", optionId = "o") => remoteDomain.buttonTitle({ optionId, name, kind });
  assert.equal(title("allow_once"), "Allow once");
  assert.equal(title("allow_always"), "Always allow");
  assert.equal(title("reject_once"), "Reject");
  assert.equal(title("", "", "weird-id"), "weird-id");
  assert.ok(title("allow_once", "n".repeat(200)).length <= 40);
  assert.equal(remoteDomain.buttonTitle({ optionId: "o", name: "好的", kind: "allow_always" }, "zh"), "始终：好的");
  assert.equal(remoteDomain.buttonTitle({ optionId: "o", name: "始终允许", kind: "allow_always" }, "zh"), "始终允许");
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
  assert.deepEqual(remoteDomain.defang({ a: ["[x](u)", 3, null, true, { "<k>": "<v>" }] }), {
    a: ["[x]​(u)", 3, null, true, { "‹k›": "‹v›" }],
  });
  assert.equal(
    remoteDomain.defang("plain text [with] brackets (and parens)"),
    "plain text [with] brackets (and parens)",
  );
  assert.equal(remoteDomain.defang(7), 7);
  assert.equal(remoteDomain.defang(null), null);
});

test("the push of an agent that waits says what for and whose it is", () => {
  const view = remoteView.remoteAskView(
    {
      ask: { action_id: "act-2", tool: "Bash" },
      options: remoteDomain.parseOptions(CLAUDE_OPTIONS),
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

/** The card's text in reading order, each fact as `name: value` (the approval card tests' reading). */
function linesOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(linesOf);
  if (!node || typeof node !== "object") return [];
  const n = node as Json;
  const own: string[] = [];
  if (n["type"] === "TextBlock" && n["text"] !== "┃") own.push(String(n["text"]));
  if (n["type"] === "FactSet") {
    for (const fact of n["facts"] as Json[])
      own.push(`${String(fact["title"]).replaceAll("⁠", "")}: ${String(fact["value"])}`);
  }
  return [...own, ...linesOf(n["items"] ?? []), ...linesOf(n["columns"] ?? [])];
}

test("the card says whose agent what it wants and until when", () => {
  const card = cardFor(CODEX_OPTIONS);
  const lines = linesOf(card["body"]);
  assert.equal(lines[0], "⚠️ Approval needed");
  assert.equal(lines[1], "Codex on dev-pod asks permission (edit).");
  assert.ok(lines.includes("Action: Edit README.md") && lines.includes("path: README.md"), lines.join(" | "));
});

test("the raw input is collapsed and credentials in it are masked", () => {
  const request = {
    actionId: "a1",
    tool: "Run curl",
    kind: "execute",
    input: {
      command: "curl -H 'Authorization: Bearer sk-EXAMPLE-abcdef0123456789abcdef0123456789' https://x.example",
      api_key: "hunter2-hunter2",
    },
  };
  const card = cardFor(CODEX_OPTIONS, request);
  const blob = JSON.stringify(card);
  assert.ok(!blob.includes("sk-EXAMPLE-abcdef0123456789abcdef0123456789") && !blob.includes("hunter2"));
  assert.ok((card["body"] as Json[]).some((b) => b["isVisible"] === false));
});

test("arguments and raw details the agent supplied cannot make a link or a tag", () => {
  const request = {
    actionId: "a1",
    tool: "Run",
    kind: "execute",
    input: {
      command: "echo [Sign in](https://attacker.example) ![x](https://attacker.example/p.png) <a href=x>y</a>",
      "[evil](http://e) key": "v",
      nested: ["[a](http://b)", { k: "<b>x</b>" }],
    },
  };
  const blob = JSON.stringify(cardFor(CODEX_OPTIONS, request));
  for (const bad of ["](", "<a", "<b>", "</"]) assert.ok(!blob.includes(bad), bad);
  assert.ok(blob.includes("echo") && blob.includes("Sign in")); // still readable: only inert
});

test("a request with no input is still a card", () => {
  const lines = linesOf(cardFor(CODEX_OPTIONS, { actionId: "a1", tool: "Think hard", kind: "" })["body"]);
  assert.equal(lines[1], "Codex on dev-pod asks permission.");
  assert.ok(lines.includes("Action: Think hard"), lines.join(" | "));
});

test("an option kind that names a property of every object is an unknown kind", () => {
  // (Python: `_KIND_RANK.get(kind, 4)`, `_KIND_TITLE.get(kind)`, `_KIND_VERDICT.get(kind)`: a dict has no `constructor`)
  for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(remoteDomain.buttonTitle({ optionId: "odd-id", name: "", kind }), "odd-id", kind);
    assert.equal(remoteDomain.decidedVerdict({ optionId: "odd-id", name: "Later", kind }), "Later", kind);
  }
});

test("an option kind that names a property of every object sorts as an unknown kind", () => {
  // Python: sorted(options, key=lambda o: _KIND_RANK.get(o["kind"], 4)): known kinds by rank, every other kind after them in
  // the order the agent sent
  const cases: [string[], string[]][] = [
    [
      ["constructor", "reject_once", "__proto__", "allow_once"],
      ["allow_once", "reject_once", "constructor", "__proto__"],
    ],
    [
      ["__proto__", "allow_always", "constructor", "reject_always", "allow_once"],
      ["allow_once", "allow_always", "reject_always", "__proto__"],
    ],
    [
      ["toString", "valueOf", "reject_once", "constructor", "allow_always", "__proto__", "allow_once"],
      ["allow_once", "allow_always", "reject_once", "toString"],
    ],
  ];
  for (const [kinds, expected] of cases) {
    const options = remoteDomain.parseOptions(
      kinds.map((kind, i) => ({ optionId: `${kind}-${String(i)}`, name: kind, kind })),
    );
    const shown = remoteView.optionButtons(options, "s", "a").map((b) => b.optionId.replace(/-\d+$/, ""));
    assert.deepEqual(shown, expected, kinds.join(","));
  }
});
