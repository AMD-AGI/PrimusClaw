// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { test } from "node:test";

import { agent } from "../../../../test-support/card-catalog/remote.js";
import {
  agentRef,
  agentRoots,
  approvalChoice,
  canTakeOver,
  kindLabel,
  startsUnattended,
  unattendedAllowed,
  withdraws,
} from "../../src/remote/agents.js";
import { cleanSubfolder, joinPath, resumableOf } from "../../src/remote/conversations.js";
import { neutral } from "../../src/remote/inert.js";

const SUBFOLDERS: [unknown, string | null][] = [
  ["", ""],
  ["   ", ""],
  [null, ""],
  ["src", "src"],
  ["src/app", "src/app"],
  [" src//app/ ", "src/app"],
  ["./src/./app", "src/app"],
  ["src\\app", "src/app"],
  ["a b/c d", "a b/c d"],
  ["..", null],
  ["../x", null],
  ["a/../b", null],
  ["a\\..\\b", null],
  ["/etc", null],
  ["\\etc", null],
  ["~", null],
  ["~/x", null],
  ["C:\\x", null],
  ["c:x", null],
  ["a\nb", null],
  ["a\x00b", null],
  ["x".repeat(201), null],
  ["x".repeat(200), "x".repeat(200)],
];

test("a typed subfolder stays below its root", () => {
  for (const [typed, expected] of SUBFOLDERS) assert.equal(cleanSubfolder(typed), expected, JSON.stringify(typed));
});

test("a subfolder is joined with the separator its root uses", () => {
  const cases: [string, string, string][] = [
    ["/home/me/work", "", "/home/me/work"],
    ["/home/me/work", "src/app", "/home/me/work/src/app"],
    ["/home/me/work/", "src", "/home/me/work/src"],
    ["C:\\Users\\me", "src/app", "C:\\Users\\me\\src\\app"],
    ["C:\\Users\\me\\", "src", "C:\\Users\\me\\src"],
    ["/", "x", "/x"],
  ];
  for (const [root, sub, expected] of cases) assert.equal(joinPath(root, sub), expected);
});

test("the folders an agent reports are strings each once at most eight", () => {
  const roots = [
    "/a",
    "/a",
    "",
    "  ",
    3,
    null,
    ["/x"],
    "/b\nc",
    "x".repeat(301),
    ...Array.from({ length: 12 }, (_, n) => `/r${String(n)}`),
  ];
  assert.deepEqual(agentRoots(agent({ agentId: "a", capabilities: { roots } })), [
    "/a",
    ...Array.from({ length: 7 }, (_, n) => `/r${String(n)}`),
  ]);
  for (const caps of [{}, { roots: "/a" }, { roots: { a: 1 } }])
    assert.deepEqual(agentRoots(agent({ agentId: "a", capabilities: caps })), []);
});

const UNATTENDED: [string, Record<string, unknown>, boolean, boolean, { default: string } | null][] = [
  ["nothing reported", {}, false, false, null],
  [
    "a connector from before the keys",
    { ask_mode: "default", modes: ["default", "plan"], roots: ["/a"] },
    false,
    false,
    null,
  ],
  ["asks, a client may not switch", { unattended: false, unattended_allowed: false }, false, false, null],
  ["asks, a client may switch", { unattended: false, unattended_allowed: true }, false, true, { default: "ask" }],
  [
    "starts unattended, a client may switch",
    { unattended: true, unattended_allowed: true },
    true,
    true,
    { default: "unattended" },
  ],
  ["starts unattended, fixed", { unattended: true, unattended_allowed: false }, true, false, null],
  ["allowed alone: the start is not said", { unattended_allowed: true }, false, true, { default: "ask" }],
  ["the flags are not booleans", { unattended: "yes", unattended_allowed: 1 }, false, false, null],
  ["a key of the older guess", { unattended_modes: ["bypass"], ask_mode: "bypass" }, false, false, null],
];

test("unattended is read from the documented keys and absent is unknown", () => {
  for (const [label, caps, starts, allowed, choice] of UNATTENDED) {
    const a = agent({ agentId: "a", capabilities: caps });
    assert.equal(startsUnattended(a), starts, label);
    assert.equal(unattendedAllowed(a), allowed, label);
    assert.deepEqual(approvalChoice(a), choice, label);
  }
});

test("an agent without capabilities at all is read as knowing nothing", () => {
  const a = agent({ agentId: "a" });
  assert.equal(startsUnattended(a), false);
  assert.equal(unattendedAllowed(a), false);
  assert.equal(approvalChoice(a), null);
  assert.equal(withdraws(null), false);
  assert.equal(withdraws(agent({ agentId: "a", capabilities: { withdraw: true } })), true);
  assert.equal(canTakeOver(agent({ agentId: "a", capabilities: { takeover: true } })), true);
});

test("the kind picks a label and an icon", () => {
  const cases: [unknown, string][] = [
    ["claude", "Claude Code"],
    ["claude-code", "Claude Code"],
    ["CODEX", "Codex"],
    ["cursor", "Cursor"],
    ["gemini", "Agent"],
    ["", "Agent"],
    [null, "Agent"],
  ];
  for (const [kind, label] of cases) {
    const got = kindLabel(kind);
    assert.equal(got.label, label);
    assert.ok(got.icon);
  }
});

test("untrusted text is one masked clipped line", () => {
  assert.equal(neutral("a\n\tb\x00c   d"), "a b c d");
  assert.equal(neutral("[x](http://e)"), "(x)(http://e)");
  assert.ok(neutral("x".repeat(300), 50).endsWith("…") && neutral("x".repeat(300), 50).length === 50);
  assert.ok(!neutral("tok ghp_" + "b".repeat(36)).includes("ghp_" + "b".repeat(36)));
  assert.equal(neutral(null), "");
  assert.equal(neutral(12), "12");
});

test("agent refs are inert in a list of names", () => {
  const ref = agentRef({ name: "evil`[x](https://e.example)<b>" }, { agentId: "a`b]\u0007(c)" });
  for (const ch of ["`", "[", "]", "<", ">", "\u0007"]) assert.ok(!ref.includes(ch), ch);
  assert.equal(agentRef({ name: "devbox-7" }, { agentId: "cx" }), "devbox-7/cx");
});

const RESUMABLE: [string, unknown, unknown[]][] = [
  ["nothing", null, []],
  ["not a list", { ref: "a" }, []],
  ["an empty list", [], []],
  [
    "a good entry",
    [{ ref: "r1", title: "T", cwd: "/a", updated_at: 1000, state: "idle" }],
    [{ ref: "r1", title: "T", cwd: "/a", updatedAt: 1000, state: "idle" }],
  ],
  [
    "a state that is none of the four is unknown",
    [{ ref: "r1", cwd: "/a", state: "busy" }],
    [{ ref: "r1", title: "", cwd: "/a", updatedAt: null, state: "unknown" }],
  ],
  [
    "a time that is no number",
    [
      { ref: "r1", cwd: "/a", updated_at: "yesterday" },
      { ref: "r2", cwd: "/a", updated_at: true },
    ],
    [
      { ref: "r1", title: "", cwd: "/a", updatedAt: null, state: "unknown" },
      { ref: "r2", title: "", cwd: "/a", updatedAt: null, state: "unknown" },
    ],
  ],
  [
    "entries without a usable ref or folder, and a repeated ref, are dropped",
    [
      3,
      { ref: 3, cwd: "/a" },
      { ref: "", cwd: "/a" },
      { ref: "x".repeat(129), cwd: "/a" },
      { ref: "a\nb", cwd: "/a" },
      { ref: "r", cwd: "" },
      { ref: "r", cwd: "a\nb" },
      { ref: "r", cwd: "/ok", state: "live" },
      { ref: "r", cwd: "/again" },
    ],
    [{ ref: "r", title: "", cwd: "/ok", updatedAt: null, state: "live" }],
  ],
  [
    "a title is one inert line",
    [{ ref: "r", cwd: "/a", title: "[x](http://e)\n<b>" }],
    [{ ref: "r", title: "(x)(http://e) ‹b›", cwd: "/a", updatedAt: null, state: "unknown" }],
  ],
];

test("the conversations an agent offers to take over are read defensively", () => {
  for (const [label, raw, expected] of RESUMABLE) {
    assert.deepEqual(resumableOf(agent({ agentId: "a", capabilities: { resumable: raw } })), expected, label);
  }
  assert.deepEqual(resumableOf(agent({ agentId: "a" })), []);
});

test("what a terminal is doing is read only for one it has open", () => {
  const cases: [Record<string, unknown>, Record<string, string>][] = [
    [
      { state: "live", activity: "waiting", waiting_for: "input needed" },
      { activity: "waiting", waitingFor: "input needed" },
    ],
    [
      { state: "live", activity: "waiting", waiting_for: "[x](http://e)\n" + "y".repeat(100) },
      { activity: "waiting", waitingFor: "(x)(http://e) " + "y".repeat(45) + "…" },
    ],
    [{ state: "live", activity: "working", waiting_for: "ignored" }, { activity: "working" }],
    [{ state: "idle", activity: "waiting", waiting_for: "x" }, {}],
    [{ state: "live", activity: "sleeping" }, {}],
    [{ state: "live", activity: ["waiting"] }, {}],
  ];
  for (const [raw, expected] of cases) {
    const entry = resumableOf(
      agent({ agentId: "a", capabilities: { resumable: [{ ref: "r", cwd: "/a", ...raw }] } }),
    )[0];
    const got: Record<string, string> = {};
    if (entry?.activity) got["activity"] = entry.activity;
    if (entry?.waitingFor) got["waitingFor"] = entry.waitingFor;
    assert.deepEqual(got, expected);
  }
});

test("at most twelve conversations are read", () => {
  const many = Array.from({ length: 20 }, (_, n) => ({ ref: `r${String(n)}`, cwd: "/a", state: "idle" }));
  assert.equal(resumableOf(agent({ agentId: "a", capabilities: { resumable: many } })).length, 12);
});
