// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The approval card tells a person what will change, on what and why; the raw call is a collapsed detail (test_approval_card). */
import assert from "node:assert/strict";
import { it } from "node:test";

import { DETAILS_ID, type JsonObject } from "@primusclaw/personal-agent";

import { hasCjk } from "../src/cards/cjk.js";
import { approvalRenderers } from "../src/views/approval/index.js";

const TOOL = "mcp__ops__patch_plans_plan_id_labels";
const INPUT = { plan_id: 85, labels: { "clawy-test": "1" }, reason: "clawy MCP verification" };
const FULL = {
  summary: "Clawy 想给计划 85 (nightly-eval) 加标签 clawy-test=1；理由：clawy MCP verification",
  summary_by: "model",
  tool_description: "Replace the labels of a plan.",
  intent: "我来给计划 85 加上验证标签。",
};
const BAR = "┃";

type Node = Record<string, unknown>;

function card(
  options: {
    tool?: string;
    input?: unknown;
    event?: JsonObject | null;
    group?: boolean;
    owner?: string;
    lang?: string | null;
  } = {},
): Node {
  const message = approvalRenderers.approval({
    tool: options.tool ?? TOOL,
    input: options.input === undefined ? INPUT : options.input,
    sessionId: "s1",
    toolUseId: "tu1",
    group: options.group ?? false,
    ownerName: options.owner ?? "",
    event: options.event === undefined ? null : options.event,
    lang: options.lang ?? null,
  });
  const attachments = message["attachments"] as Node[];
  return (attachments[0] as Node)["content"] as Node;
}

function* lines(node: unknown, hiddenToo: boolean): Generator<string> {
  if (Array.isArray(node)) {
    for (const item of node) yield* lines(item, hiddenToo);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const n = node as Node;
  if (!hiddenToo && n["isVisible"] === false) return;
  if (n["type"] === "TextBlock" && n["text"] !== BAR) yield String(n["text"]);
  else if (n["type"] === "FactSet") {
    for (const fact of n["facts"] as Node[]) {
      const name = String(fact["title"]).replaceAll("⁠", "");
      yield `${name}${hasCjk(name) ? "：" : ": "}${String(fact["value"])}`;
    }
  }
  for (const key of ["items", "columns"]) yield* lines(n[key] ?? [], hiddenToo);
}

const visible = (c: Node): string[] => [...lines(c["body"], false)];
const texts = (c: Node): string[] => [...lines(c["body"], true)];

function blocks(c: Node): Node[] {
  const out: Node[] = [];
  const todo = [...(c["body"] as Node[])];
  for (let node = todo.shift(); node !== undefined; node = todo.shift()) {
    out.push(node);
    const items = Array.isArray(node["items"]) ? (node["items"] as Node[]) : [];
    const columns = Array.isArray(node["columns"]) ? (node["columns"] as Node[]) : [];
    todo.unshift(...items, ...columns);
  }
  return out;
}

const toggles = (c: Node): Node[] =>
  blocks(c).flatMap((b) => {
    const action = b["selectAction"] as Node | undefined;
    return action?.["type"] === "Action.ToggleVisibility" ? [action] : [];
  });

const blob = (c: Node): string => JSON.stringify(c);

it("the card leads with what will change then the action then the arguments then the reason", () => {
  const c = card({ event: FULL });
  const shown = visible(c);
  assert.equal(shown[0], "⚠️ 需要你批准");
  const body = c["body"] as Node[];
  assert.equal(shown[1], FULL.summary);
  assert.equal(body[1]?.["weight"], "Bolder");
  assert.ok(String(shown[2]).includes("模型生成"));
  assert.equal(shown[3], "操作：patch plans plan id labels (ops) — Replace the labels of a plan.");
  assert.deepEqual(shown.slice(4, 7), ["plan_id: 85", 'labels: {"clawy-test":"1"}', "理由：clawy MCP verification"]);
  assert.ok(!blob(c).includes("我来给计划 85"));
});

it("the raw call is collapsed behind a details toggle", () => {
  const c = card({ event: FULL });
  const all = toggles(c);
  assert.equal(all.length, 1);
  const toggle = all.at(0) ?? {};
  assert.equal(toggle["title"], "详情");
  assert.deepEqual(toggle["targetElements"], [DETAILS_ID]);
  const fold = (c["body"] as Node[]).find((b) => b["id"] === DETAILS_ID) ?? {};
  const raw = (fold["items"] as Node[]).at(0) ?? {};
  const rawText = String(raw["text"]);
  assert.equal(fold["isVisible"], false);
  assert.equal(raw["fontType"], "Monospace");
  assert.ok(rawText.includes(TOOL) && rawText.includes('"plan_id": 85'));
  assert.ok(visible(c).every((t) => !t.includes(rawText)));
});

it("the buttons are unchanged", () => {
  const c = card({ event: FULL });
  const [approve, deny] = c["actions"] as Node[];
  assert.deepEqual(
    [approve?.["title"], approve?.["style"], approve?.["verb"]],
    ["批准", "positive", "primusclaw.decision"],
  );
  assert.equal(deny?.["title"], "拒绝");
  assert.ok(!Object.hasOwn(deny ?? {}, "style"));
  const english = card({ event: { summary: "Stop workload w1" }, lang: "en" })["actions"] as Node[];
  assert.deepEqual(
    english.map((b) => b["title"]),
    ["Approve", "Deny"],
  );
  for (const button of [approve, deny]) {
    const data = button?.["data"] as Node;
    assert.deepEqual(Object.keys(data).sort(), ["action", "primusclaw", "session_id", "tool", "tool_use_id"]);
    assert.deepEqual([data["session_id"], data["tool"], data["tool_use_id"]], ["s1", TOOL, "tu1"]);
  }
});

it("without a summary the agents own words say why", () => {
  const c = card({ event: { intent: "I will add the verification label to plan 85." }, lang: "en" });
  assert.ok(visible(c).includes("The agent said: I will add the verification label to plan 85."));
});

it("a summary alone is enough", () => {
  const c = card({ event: { summary: "Stop workload w1" }, lang: "en" });
  assert.deepEqual(visible(c).slice(0, 2), ["⚠️ Approval needed", "Stop workload w1"]);
  assert.ok(String(visible(c)[2]).includes("Summary written by the model"));
});

it("the card speaks the users language", () => {
  for (const [lang, title, action, reason, details] of [
    ["zh", "⚠️ 需要你批准", "操作", "理由", "详情"],
    ["en", "⚠️ Approval needed", "Action", "Reason", "Details"],
  ] as const) {
    const c = card({ event: FULL, lang });
    const sep = lang === "zh" ? "：" : ": ";
    assert.equal(visible(c)[0], title);
    assert.ok(visible(c).some((t) => t.startsWith(`${action}${sep}`)));
    assert.ok(visible(c).some((t) => t.startsWith(`${reason}${sep}`)));
    assert.deepEqual(
      toggles(c).map((t) => t["title"]),
      [details],
    );
  }
});

it("a group card names the only person who can answer", () => {
  assert.ok(
    texts(card({ group: true, owner: "Alice", lang: "en" })).some((t) =>
      t.includes("Only Alice can approve or deny this"),
    ),
  );
  assert.ok(
    texts(card({ group: true, owner: "Alice", lang: "zh" })).some((t) => t.includes("只有Alice可以批准或拒绝")),
  );
  assert.ok(texts(card({ group: true, lang: "en" })).some((t) => t.includes("Only the person who asked can approve")));
  assert.ok(!blob(card({ event: FULL, group: true, owner: "Alice" })).includes("Replace the labels"));
});

it("a group card carries no input no details no arguments", () => {
  const secrets = {
    workload_id: "w-7777",
    note: "Ada",
    reason: "because-of-this-reason",
    api_token: "tok-SECRET-0123456789abcdef",
  };
  for (const event of [null, FULL, { intent: "I will use the token for plan 85", summary: "" }]) {
    for (const lang of ["zh", "en"]) {
      const c = card({ input: secrets, event, group: true, owner: "Alice", lang });
      for (const leaked of [
        "SECRET",
        "tok-",
        "because-of-this-reason",
        "workload_id",
        "api_token",
        "note",
        DETAILS_ID,
      ]) {
        assert.ok(!blob(c).includes(leaked), leaked);
      }
      assert.equal(toggles(c).length, 0);
      assert.ok(texts(c).join("").includes("Alice"));
      assert.deepEqual(
        (c["actions"] as Node[]).map((a) => (a["data"] as Node)["action"]),
        ["allow", "deny"],
      );
    }
  }
});

it("an empty input has no details toggle", () => {
  for (const empty of [null, {}, []]) {
    const c = card({ input: empty });
    assert.equal(toggles(c).length, 0);
    assert.ok(!(c["body"] as Node[]).some((b) => b["id"] === DETAILS_ID));
  }
});

it("the tool name never decides what is hidden", () => {
  assert.equal(visible(card({ tool: "", input: null, lang: "en" }))[1], "Action: an action");
});
