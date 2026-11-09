// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What reaches a person unasked, as cards (teams/tests/test_proactive_ux.py's card tests, test_show_here.py's card tests), and the
 * cards an approval or a question becomes once answered or run out.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  clockText,
  cpLength,
  itemRequestLabel,
  openUrl,
  publicRunEvent,
  type JsonObject as CoreJson,
  type PublicErrors,
} from "@primusclaw/personal-agent";
import { Ajv } from "ajv";

import type { JsonObject } from "../src/cards/json.js";
import { TITLE_MAX } from "../src/cards/kit.js";
import { approvalRenderers } from "../src/views/approval/index.js";
import { proactiveRenderers, showButton } from "../src/views/proactive/index.js";

const PUBLIC = "https://example.test";
const ZONE = "Asia/Shanghai";
const SUMMARY_MAX = 280;

/** A JSON value as the text it shows ("" when absent). */
function s(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

const schema = JSON.parse(
  readFileSync(new URL("../../../test-support/data/adaptive-card-1.5.schema.json", import.meta.url), "utf8"),
) as JsonObject;
const rules = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "id"));
const validate = new Ajv({ strict: false, allErrors: true }).compile({ ...rules, $id: s(schema["id"]) });

/** Epoch seconds of 2026-10-<day> HH:MM in Shanghai. */
function at(hour: number, minute = 0, day = 27): number {
  return Date.UTC(2026, 9, day, hour - 8, minute) / 1000;
}

function cardOf(activity: JsonObject): JsonObject {
  const attachments = activity["attachments"] as JsonObject[];
  assert.equal(attachments.length, 1);
  const [attachment] = attachments as [JsonObject];
  assert.equal(attachment["contentType"], "application/vnd.microsoft.card.adaptive");
  return attachment["content"] as JsonObject;
}

function* blocks(items: readonly JsonObject[]): Generator<JsonObject> {
  for (const b of items) {
    yield b;
    for (const key of ["items", "columns"]) yield* blocks((b[key] ?? []) as JsonObject[]);
  }
}

/** Every line a card shows, top down (not the header's bar), and each fact as "name: value" ("名：值" for a Chinese name). */
function textsIn(card: JsonObject): string[] {
  const out: string[] = [];
  for (const b of blocks(card["body"] as JsonObject[])) {
    if (b["type"] === "TextBlock" && b["text"] !== "┃") out.push(s(b["text"]));
    else if (b["type"] === "FactSet") {
      for (const fact of b["facts"] as JsonObject[]) {
        const name = s(fact["title"]).replace(/⁠/g, "");
        out.push(`${name}${/[⺀-￿]/.test(name) ? "：" : ": "}${s(fact["value"])}`);
      }
    }
  }
  return out;
}

function valid(card: JsonObject): void {
  assert.ok(validate(card), JSON.stringify(validate.errors));
}

function event(kind = "run.completed", eventId = "ev-1", extra: CoreJson = {}): CoreJson {
  return {
    event_id: eventId,
    type: kind,
    occurred_at: "2026-10-27T00:00:00Z",
    user_id: "u-alice",
    session_id: "s1",
    task_id: "t1",
    trigger_id: null,
    title: "Run completed: sweep",
    summary: "",
    link: "/primus-claw/sessions/s1",
    ...extra,
  };
}

function approvalEvent(): CoreJson {
  return event("approval.requested", "ap-1", {
    title: "Approval needed",
    session_id: "s-trig",
    approval: { tool_use_id: "tu1", tool: "workload_stop", target: "llama-70b-ft", expires_at: "2026-10-27T04:30:00Z" },
  });
}

const runEvent = (e: CoreJson, base = PUBLIC) => proactiveRenderers.runEvent({ event: e, publicBaseUrl: base });

function allCards(): Record<string, JsonObject> {
  return {
    completed: runEvent(event("run.completed", "ev-1", { summary: "3 of 3 steps finished" })),
    failed: runEvent(event("run.failed", "ev-1", { title: "Run failed: sweep", summary: "OOM in step 2" })),
    paused: runEvent(event("trigger.paused", "ev-1", { title: "Daily brief paused" })),
    approval: proactiveRenderers.proactiveApproval({
      event: approvalEvent(),
      publicBaseUrl: PUBLIC,
      expiresAt: at(8, 10),
      zone: ZONE,
    }),
    decided: approvalRenderers.approvalDecided({ tool: "workload_stop", action: "allow", when: at(8, 3), zone: ZONE }),
    expired: approvalRenderers.approvalExpired({ tool: "workload_stop" }),
    digest: proactiveRenderers.digest({
      events: [event(), event("run.failed", "e2", { title: "Run failed: b" })],
      expiredApprovals: 1,
      publicBaseUrl: PUBLIC,
    }),
  };
}

test("every card validates against adaptive cards 1 5", () => {
  for (const [name, activity] of Object.entries(allCards())) {
    const card = cardOf(activity);
    assert.equal(card["version"], "1.5", name);
    valid(card);
  }
});

test("the validator is not vacuous", () => {
  assert.equal(
    validate({ type: "AdaptiveCard", version: "1.5", body: [{ type: "TextBlock", text: "x", colour: "red" }] }),
    false,
  );
  assert.equal(validate({ type: "AdaptiveCard", version: "1.5", body: [{ type: "Nope" }] }), false);
});

test("cards are one column with at most three actions", () => {
  for (const [name, activity] of Object.entries(allCards())) {
    const card = cardOf(activity);
    const body = card["body"] as JsonObject[];
    for (const b of body) assert.ok(["TextBlock", "Container", "ColumnSet"].includes(s(b["type"])), name);
    assert.ok(
      body.slice(1).every((b) => b["type"] !== "ColumnSet"),
      name,
    ); // (a column set only as the header's bar)
    assert.ok(((card["actions"] ?? []) as JsonObject[]).length <= 3, name);
    assert.ok(body.length <= 7, name);
  }
});

test("failed run card has title one line summary and open in claw", () => {
  const card = cardOf(allCards()["failed"] as JsonObject);
  // (a title that says the status gets no subtitle saying it again)
  assert.deepEqual(textsIn(card), ["❌ Run failed: sweep", "OOM in step 2"]);
  const [show, open] = card["actions"] as [JsonObject, JsonObject];
  assert.equal(show["title"], "Show here");
  assert.equal(show["verb"], "primusclaw.show");
  assert.deepEqual(open, { type: "Action.OpenUrl", title: "Open in Claw", url: `${PUBLIC}/primus-claw/sessions/s1` });
});

test("long text is clipped and summary limited to three lines", () => {
  const card = cardOf(
    runEvent(event("run.completed", "ev-1", { title: "T".repeat(500), summary: "word ".repeat(400) })),
  );
  const [title = ""] = textsIn(card);
  assert.ok(title.startsWith("✅ ") && cpLength(title.slice(2)) <= TITLE_MAX);
  const summary = (card["body"] as JsonObject[])[1] as JsonObject;
  assert.ok(cpLength(s(summary["text"])) <= SUMMARY_MAX);
  assert.equal(summary["maxLines"], 3);
});

test("only a claw relative link becomes an open url", () => {
  for (const link of ["https://evil.test/x", "//evil.test/x", "javascript:alert(1)", "", null]) {
    const actions = (cardOf(runEvent(event("run.completed", "ev-1", { link })))["actions"] ?? []) as JsonObject[];
    assert.deepEqual(
      actions.filter((a) => a["type"] === "Action.OpenUrl"),
      [],
      String(link),
    );
  }
});

test("an http base never produces an open url", () => {
  const actions = (cardOf(runEvent(event(), "http://insecure.test"))["actions"] ?? []) as JsonObject[];
  assert.deepEqual(
    actions.filter((a) => a["type"] === "Action.OpenUrl"),
    [],
  );
});

test("approval card names action target and deadline and carries no credentials", () => {
  const card = cardOf(allCards()["approval"] as JsonObject);
  const texts = textsIn(card);
  assert.equal(texts[0], "⚠️ Approval needed: workload_stop");
  assert.equal(texts[2], "llama-70b-ft");
  assert.ok(texts[1]?.includes("08:10") && texts[1].includes("Asia/Shanghai"));
  const [approve, deny, details] = card["actions"] as [JsonObject, JsonObject, JsonObject];
  assert.deepEqual([approve["title"], (approve["data"] as JsonObject)["action"]], ["Approve", "allow"]);
  assert.deepEqual([deny["title"], (deny["data"] as JsonObject)["action"]], ["Deny", "deny"]);
  assert.equal(details["type"], "Action.OpenUrl");
  for (const button of [approve, deny]) {
    const data = button["data"] as JsonObject;
    assert.equal(button["type"], "Action.Execute");
    assert.equal(data["primusclaw"], "decision");
    assert.deepEqual([data["session_id"], data["tool_use_id"]], ["s-trig", "tu1"]);
    assert.deepEqual(Object.keys(data).sort(), ["action", "primusclaw", "session_id", "tool", "tool_use_id"]);
  }
});

test("run cards carry show here then open in claw", () => {
  for (const [kind, hasShow] of [
    ["run.completed", true],
    ["run.failed", true],
    ["trigger.paused", false],
  ] as const) {
    const card = cardOf(runEvent(event(kind)));
    const actions = card["actions"] as JsonObject[];
    assert.deepEqual(
      actions.map((a) => a["title"]),
      hasShow ? ["Show here", "Open in Claw"] : ["Open in Claw"],
      kind,
    );
    if (hasShow) assert.deepEqual(actions[0]?.["data"], { primusclaw: "show", session_id: "s1" });
    assert.ok(actions.length <= 3);
  }
});

test("digest card has at most three actions and show here is among them", () => {
  const events = [0, 1, 2, 3, 4, 5].map((i) =>
    event("run.failed", `e${String(i)}`, { session_id: `s${String(i)}`, title: `Run ${String(i)}` }),
  );
  const card = cardOf(proactiveRenderers.digest({ events, expiredApprovals: 0, publicBaseUrl: PUBLIC }));
  const actions = card["actions"] as JsonObject[];
  assert.ok(actions.length >= 1 && actions.length <= 3);
  assert.ok(actions.every((a) => a["verb"] === "primusclaw.show"));
  assert.equal((card["body"] as JsonObject[]).length, 6, "the header and five titles");
  assert.ok(
    actions.every((a) => a["style"] === undefined),
    "no primary in a digest",
  );
});

test("a digest counts what it held, and says so when nothing needs the person", () => {
  const card = cardOf(
    proactiveRenderers.digest({
      events: [event("trigger.paused", "p1", { title: "", link: "https://evil.test" }), event("other", "o2")],
      expiredApprovals: 2,
      publicBaseUrl: PUBLIC,
    }),
  );
  assert.deepEqual(textsIn(card), ["🔔 While you were away", "2 approvals expired and refused, 2 other notices"]);
  assert.equal(card["actions"], undefined);
  const one = cardOf(
    proactiveRenderers.digest({ events: [event("x")], expiredApprovals: 1, publicBaseUrl: "http://insecure.test" }),
  );
  assert.equal(textsIn(one)[1], "1 approval expired and refused, 1 other notice");
  const none = cardOf(proactiveRenderers.digest({ events: [], expiredApprovals: 0, publicBaseUrl: PUBLIC }));
  assert.equal(textsIn(none)[1], "Nothing needs you.");
  const linked = cardOf(
    proactiveRenderers.digest({
      events: [event("run.completed", "c", { title: "a [b]", link: "" })],
      expiredApprovals: 0,
      publicBaseUrl: PUBLIC,
    }),
  );
  assert.equal(
    textsIn(linked)[2],
    "Done: a (b)",
    "a title without a link is no link, and its brackets cannot make one",
  );
});

test("a plain notice has no status line and only open in claw", () => {
  const card = cardOf(runEvent(event("trigger.paused", "p", { title: "", summary: "" })));
  assert.deepEqual(textsIn(card), ["🔔 PrimusClaw"]);
  const titled = cardOf(runEvent(event("run.completed", "c", { title: "Weekly sweep" })));
  assert.deepEqual(
    textsIn(titled),
    ["✅ Weekly sweep", "Run completed"],
    "a title that does not say the status gets it under",
  );
});

test("a failed run's internal title and summary are withheld to the log under a reference", () => {
  const logged: unknown[] = [];
  const errors: PublicErrors = {
    withhold: (where, detail, ids) => {
      logged.push([where, detail, ids]);
      return "r-1";
    },
    publicReason: () => "",
  };
  const internal = (text: unknown) => String(text).includes("10.0.0.7");
  const failed = event("run.failed", "f", { title: "dial 10.0.0.7: refused", summary: "at 10.0.0.7:443" });
  const shown = publicRunEvent(failed, errors, internal);
  assert.equal(shown["title"], undefined);
  assert.equal(shown["summary"], "The run ended with an error (ref r-1).");
  assert.deepEqual(logged, [["run_failed_notice", "at 10.0.0.7:443", { session: "s1" }]]);
  assert.deepEqual(textsIn(cardOf(runEvent(shown))), ["❌ Run failed", "The run ended with an error (ref r-1)."]);
  const plain = event("run.failed", "f", { title: "OOM", summary: "OOM in step 2", session_id: 7 });
  assert.deepEqual(publicRunEvent(plain, errors, internal), plain);
  const completed = event("run.completed", "c", { title: "10.0.0.7" });
  assert.equal(publicRunEvent(completed, errors, internal), completed, "only a failed run's words are raw errors");
  publicRunEvent(event("run.failed", "f", { summary: "10.0.0.7", session_id: 7 }), errors, internal);
  assert.deepEqual(logged[1], ["run_failed_notice", "10.0.0.7", { session: null }]);
});

test("an approval of a run without a tool, a target or a link still names an action and has its two buttons", () => {
  const card = cardOf(
    proactiveRenderers.proactiveApproval({
      event: { type: "approval.requested", approval: "?" },
      publicBaseUrl: PUBLIC,
      expiresAt: at(0, 5),
      zone: ZONE,
    }),
  );
  assert.deepEqual(textsIn(card), [
    "⚠️ Approval needed: an action",
    "Valid until 00:05 (Asia/Shanghai). After that it is refused.",
  ]);
  assert.deepEqual(
    (card["actions"] as JsonObject[]).map((a) => a["title"]),
    ["Approve", "Deny"],
  );
});

test("a work item's approval says which task, masks its target and answers in the person's language", () => {
  const card = cardOf(
    proactiveRenderers.itemApproval({
      event: {
        type: "approval.requested",
        session_id: "s9",
        summary: "Push the branch",
        item: { seq: "x", title: "" },
        approval: { tool_use_id: "tu-9", target: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123'" },
      },
      publicBaseUrl: PUBLIC,
      expiresAt: at(23, 59),
      zone: ZONE,
    }),
  );
  const texts = textsIn(card);
  assert.equal(texts[0], "⚠️ Approval needed");
  assert.equal(texts[1], "Task #?: -");
  assert.ok(!texts.some((t) => t.includes("abcdefghijklmnopqrstuvwxyz0123")), texts.join("\n"));
  assert.equal(texts.at(-1), "Waits for you until 23:59 (Asia/Shanghai). After that it is refused.");
  const [approve, deny] = card["actions"] as [JsonObject, JsonObject];
  assert.deepEqual(approve["data"], {
    primusclaw: "decision",
    session_id: "s9",
    tool: "an action",
    tool_use_id: "tu-9",
    action: "allow",
  });
  assert.equal(deny["title"], "Deny");
  assert.equal((card["actions"] as JsonObject[]).length, 2, "no link: no Details");
});

test("a work item's question names the task that asks", () => {
  const card = cardOf(
    proactiveRenderers.itemQuestion({
      event: { item: { seq: 4, title: "Pick a channel" }, questions: [{ id: "q1", question: "Which channel?" }] },
    }),
  );
  assert.deepEqual(textsIn(card).slice(0, 3), [
    "❓ The agent has a question",
    "Task #4: Pick a channel asks you",
    "Which channel?",
  ]);
  const data = (card["actions"] as JsonObject[])[0]?.["data"] as JsonObject;
  assert.deepEqual([data["session_id"], data["tool_use_id"]], ["", ""]);
});

test("an item's label masks a credential in its title and clips it", () => {
  const label = itemRequestLabel(
    { item: { seq: 3, title: `token=ghp_${"a".repeat(36)} ${"x".repeat(200)}` } },
    "task",
    "zh",
  );
  assert.ok(label.startsWith("任务 #3：") && !label.includes("ghp_aaaa"), label);
  assert.ok(label.endsWith("…"));
});

test("only a claw relative link under an https base is opened, the base without its trailing slashes", () => {
  assert.equal(openUrl("/a", "https://x.test//"), "https://x.test/a");
  assert.equal(openUrl(5, "https://x.test"), null);
});

test("a clock time is the hour and minute in the zone, midnight as 00", () => {
  assert.equal(clockText(at(0, 0), ZONE), "00:00");
  assert.equal(clockText(at(13, 7), ZONE), "13:07");
  assert.equal(clockText(at(13, 7), "UTC"), "05:07");
});

test("an approval answered or run out, and a question answered", () => {
  const denied = cardOf(
    approvalRenderers.approvalDecided({ tool: "bash", action: "deny", when: at(9, 30), zone: ZONE }),
  );
  assert.deepEqual(textsIn(denied), ["🚫 Denied (you, 09:30)", "bash"]);
  const question = cardOf(approvalRenderers.approvalExpired({ tool: "ask_user_question" }));
  assert.deepEqual(textsIn(question), [
    "⌛ Expired",
    "The agent stopped waiting for this answer. Tell it in a message if you still want to answer.",
  ]);
  const answered = cardOf(
    approvalRenderers.questionAnswered({
      answers: [
        ["q1", "main"],
        ["q2", "y".repeat(300)],
      ],
      when: at(9, 30),
      zone: ZONE,
    }),
  );
  assert.equal(textsIn(answered)[0], "✅ Answered (you, 09:30)");
  assert.equal(cpLength(textsIn(answered)[2] ?? ""), 280);
});

test("an approval put back after a press that did not go through has its note and both buttons", () => {
  const card = cardOf(
    approvalRenderers.approvalAgain({ text: "Try again.", tool: "bash", sessionId: "s1", toolUseId: "tu-1" }),
  );
  valid(card);
  assert.deepEqual(textsIn(card), ["🔔 Approval needed: bash", "Try again."]);
  assert.deepEqual(
    (card["actions"] as JsonObject[]).map((a) => [a["title"], a["style"]]),
    [
      ["Approve", "positive"],
      ["Deny", undefined],
    ],
  );
});

test("show here carries only the session", () => {
  assert.deepEqual(showButton("s1"), {
    type: "Action.Execute",
    title: "Show here",
    verb: "primusclaw.show",
    data: { primusclaw: "show", session_id: "s1" },
  });
});
