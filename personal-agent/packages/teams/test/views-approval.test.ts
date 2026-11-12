// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The approval card tells a person what will change, on what and why; the raw call is a collapsed detail (test_approval_card). */
import assert from "node:assert/strict";
import { it } from "node:test";

import { DETAILS_ID, approvalTurnCards, cardQuestions, type JsonObject } from "@primusclaw/personal-agent";

import { hasCjk } from "../src/cards/cjk.js";
import { approvalRenderers } from "../src/views/approval/index.js";
import { RENDERERS, renderView } from "../src/views/index.js";
import { APPROVAL_CARDS } from "../../../test-support/card-catalog/approval.js";
import { SID } from "../../../test-support/card-catalog/catalog.js";

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
  for (const key of ["items", "columns"] as const) yield* lines(n[key] ?? [], hiddenToo);
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
  assert.ok(deny !== undefined);
  assert.equal(deny["title"], "拒绝");
  assert.ok(!Object.hasOwn(deny, "style"));
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

it("the turn's approval and question cards are the ones the turn engine drew itself, as the Python catalog has them", () => {
  // What the engine sent before the TurnCards port (its consume.ts built these views itself), and the catalog's snapshots.
  const PERM_EVENT = {
    summary: "删除 /workspace/PrimusClaw/build 下的旧产物",
    tool_description: "Run a shell command",
    intent: "清理构建产物，腾出磁盘空间",
  };
  const asked = (input: unknown, group: boolean, ownerName: string) => ({
    tool: "bash",
    input,
    sessionId: SID,
    toolUseId: "tu-1",
    group,
    ownerName,
    event: PERM_EVENT,
    lang: "zh" as const,
  });
  for (const [id, ask] of [
    ["approval_turn", asked({ command: "rm -rf /workspace/PrimusClaw/build && make clean" }, false, "")],
    ["approval_group", asked({ command: "make deploy" }, true, "Robin Lang")],
  ] as const) {
    const message = approvalTurnCards.approval(ask);
    assert.deepEqual(message, { body: { type: "view", view: { name: "approval", model: ask }, fallbackText: "bash" } });
    assert.ok(message.body.type === "view" && message.body.view.name === "approval");
    assert.deepEqual(renderView(RENDERERS, message.body.view), catalogCard(id));
  }
  const questions = [
    {
      id: "q1",
      question: "要把哪个分支作为基线？",
      options: [
        { id: "main", label: "main" },
        { id: "rel", label: "release/1.4" },
      ],
      allow_multiple: false,
    },
  ];
  const question = approvalTurnCards.question({
    questions,
    sessionId: SID,
    toolUseId: "tu-9",
    group: false,
    ownerName: "",
  });
  const model = {
    questions: cardQuestions(questions),
    sessionId: SID,
    toolUseId: "tu-9",
    group: false,
    ownerName: "",
    note: "",
    typedReply: true, // (a turn's question: a message typed in the chat answers it too)
  };
  assert.deepEqual(question, {
    body: { type: "view", view: { name: "question", model }, fallbackText: "ask_user_question" },
  });
  assert.ok(question.body.type === "view" && question.body.view.name === "question");
  assert.deepEqual(renderView(RENDERERS, question.body.view), catalogCard("question_typed_reply"));
  // Brain's questions are read here (Python card_questions): what is malformed is dropped, not shown.
  const bad = approvalTurnCards.question({
    questions: "x",
    sessionId: SID,
    toolUseId: "",
    group: false,
    ownerName: "",
  });
  assert.ok(bad.body.type === "view" && bad.body.view.name === "question");
  assert.deepEqual((bad.body.view.model as { questions: unknown }).questions, cardQuestions("x"));
});

function catalogCard(id: string): JsonObject {
  const entry = APPROVAL_CARDS.find((e) => e.id === id);
  assert.ok(entry, id);
  return entry.build();
}

it("a turn's question card says a message in the chat answers it too, in the card's language; a work item's does not", () => {
  const ask = (question: string, typedReply?: boolean, group = false) =>
    JSON.stringify(
      approvalRenderers.question({
        questions: cardQuestions([{ id: "q1", question, options: [{ id: "a", label: "A" }] }]),
        sessionId: SID,
        toolUseId: "tu-1",
        group,
        ownerName: "",
        note: "",
        ...(typedReply === undefined ? {} : { typedReply }),
      }),
    );
  assert.ok(ask("Which one?", true).includes("You can also just reply in the chat with your choice."));
  assert.ok(ask("选哪个？", true).includes("也可以直接在聊天里回复选项。"));
  assert.ok(!ask("Which one?").includes("reply in the chat"));
  // in a group only a message that @mentions the bot reaches it: the card says so
  assert.ok(ask("选哪个？", true, true).includes("也可以在聊天里 @我 直接回复选项。"));
  assert.ok(ask("Which one?", true, true).includes("reply in the chat with your choice, @mentioning me."));
  const turnCard = approvalTurnCards.question({
    questions: [],
    sessionId: SID,
    toolUseId: "t",
    group: false,
    ownerName: "",
  });
  assert.equal(
    turnCard.body.type === "view" && turnCard.body.view.name === "question" && turnCard.body.view.model.typedReply,
    true,
  );
});

it("a question answered in the chat says so on its card: the answer, then when", () => {
  const shown = JSON.stringify(
    approvalRenderers.questionAnswered({
      answers: [
        ["q1", "main"],
        ["q2", "main"],
      ],
      when: 0,
      zone: "UTC",
      replied: "en",
    }),
  );
  assert.ok(shown.includes("Answered: main"));
  assert.ok(!shown.includes("main / main")); // (one reply that answered both is said once)
  assert.ok(shown.includes("Replied in the chat, "));
});
