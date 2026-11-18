// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What reaches a person unasked (teams_agent/render.py event_card, digest_card, approval_card, item_approval_card,
 * item_question_card, show_button and the open and show actions). What they say is core's (`proactiveText`, the proactive
 * helpers); the approval body and its buttons are the approval cards' own (`../approval`).
 */
import {
  NOTICE_SUMMARY_MAX,
  TARGET_LINES,
  TARGET_MAX,
  approvalView,
  cardQuestions,
  clockText,
  itemLang,
  itemRequestLabel,
  maskedTarget,
  openUrl as clawUrl,
  proactiveText,
  pyStr,
  type DigestModel,
  type ItemQuestionModel,
  type JsonObject,
  type ProactiveApprovalModel,
  type RunEventModel,
} from "@primusclaw/personal-agent";

import { clip } from "../../cards/cjk.js";
import type { CardElement } from "../../cards/json.js";
import type { Meaning, Tone } from "../../cards/kit.js";
import { TITLE_MAX, buttons, execute, header, message, note, openUrl, text } from "../../cards/kit.js";
import { approvalBody, approvalRenderers, decisionButtons } from "../approval/index.js";
import type { Renderers, TeamsMessage } from "../registry.js";

const en = proactiveText.in("en");
const RUN_ENDS = ["run.completed", "run.failed"];

/** Show here: what a finished or failed run's card carries; the worker checks the clicker owns the session. */
export function showButton(sessionId: string, title: string = en.showHere): CardElement {
  return execute(title, "primusclaw.show", { primusclaw: "show", session_id: sessionId });
}

/** Show here, only for a finished or failed run (only those have an answer to show). */
function showAction(event: JsonObject, title: string = en.showHere): CardElement[] {
  const sessionId = pyStr(event["session_id"]);
  if (!RUN_ENDS.includes(pyStr(event["type"])) || !sessionId) return [];
  return [showButton(sessionId, title)];
}

/** Open in Claw, only for a Claw-relative link under an https base. */
function openAction(event: JsonObject, publicBaseUrl: string, title: string = en.openInClaw): CardElement[] {
  const url = clawUrl(event["link"], publicBaseUrl);
  return url ? [openUrl(title, url)] : [];
}

function objectOf(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

const LOOK: Readonly<Record<string, readonly [string, Tone, Meaning]>> = {
  "run.completed": [en.runCompleted, "good", "good"],
  "run.failed": [en.runFailed, "attention", "failed"],
};

/** run.completed, run.failed and any other plain notice: a header in the run's colour, its summary, Show here and Open in Claw. */
function runEvent(model: RunEventModel): TeamsMessage {
  const { event } = model;
  const kind = pyStr(event["type"]);
  const plain: readonly [string, Tone, Meaning] = ["", "default", "notice"];
  const [status, tone, meaning] = Object.hasOwn(LOOK, kind) ? (LOOK[kind] ?? plain) : plain;
  const title = pyStr(event["title"]);
  const said = clip(title || status || en.notice, TITLE_MAX);
  const subtitle = title && status && !said.toLowerCase().includes(status.toLowerCase()) ? status : "";
  const body = [header(said, { tone, subtitle, emoji: meaning })];
  const summary = clip(pyStr(event["summary"]), NOTICE_SUMMARY_MAX);
  if (summary) body.push(text(summary, { maxLines: 3 }));
  return message(body, buttons([...showAction(event), ...openAction(event, model.publicBaseUrl)]));
}

function digestCounts(model: DigestModel, completed: number, failed: number): string {
  const counts: string[] = [];
  if (completed) counts.push(en.finished({ n: completed }));
  if (failed) counts.push(en.failed({ n: failed }));
  if (model.expiredApprovals) counts.push(en.expiredApprovals({ n: model.expiredApprovals }));
  const other = model.events.length - completed - failed;
  if (other > 0) counts.push(en.otherNotices({ n: other }));
  return counts.join(", ") || en.nothingNeedsYou;
}

/** One card for everything held back: counts first (in the header), then up to five titles, and Show here for the first three. */
function digest(model: DigestModel): TeamsMessage {
  const completed = model.events.filter((e) => e["type"] === "run.completed");
  const failed = model.events.filter((e) => e["type"] === "run.failed");
  const body: CardElement[] = [
    header(en.away, {
      tone: failed.length ? "attention" : "accent",
      subtitle: digestCounts(model, completed.length, failed.length),
      emoji: "notice",
    }),
  ];
  const named = (e: JsonObject): string => pyStr(e["title"]) || pyStr(e["type"]);
  for (const e of [...failed, ...completed]) {
    if (body.length >= 6) break;
    const url = clawUrl(e["link"], model.publicBaseUrl);
    const label = clip(named(e), 80).replace(/\[/g, "(").replace(/\]/g, ")");
    const mark = e["type"] === "run.failed" ? en.markFailed : en.markDone;
    body.push(text(`${mark}: ${url ? `[${label}](${url})` : label}`, { maxLines: 2 }));
  }
  const actions = [...failed, ...completed]
    .slice(0, 3) // (a card carries at most three actions)
    .flatMap((e) => showAction(e, en.showHereOf({ title: clip(named(e), 24) })));
  return message(body, buttons(actions, ""));
}

function targetText(target: string): CardElement {
  return text(target, { maxLines: TARGET_LINES, mono: true, size: "Small" });
}

/** approval.requested of a run: what, on what, until when, with Approve and Deny that call Claw as the clicker. */
function proactiveApproval(model: ProactiveApprovalModel): TeamsMessage {
  const { event } = model;
  const approval = objectOf(event["approval"]);
  const tool = clip(pyStr(approval["tool"]) || en.anAction, TITLE_MAX);
  const until = clockText(model.expiresAt, model.zone);
  const body = [
    header(en.approvalNeeded({ tool }), {
      tone: "warning",
      subtitle: en.validUntil({ until, zone: model.zone }),
      emoji: "needs_you",
    }),
  ];
  const target = pyStr(approval["target"]);
  if (target) body.push(targetText(clip(target, TARGET_MAX)));
  const actions = [
    ...decisionButtons(tool, pyStr(event["session_id"]), pyStr(approval["tool_use_id"]), "en"),
    ...openAction(event, model.publicBaseUrl, en.details),
  ];
  return message(body, actions);
}

/**
 * approval.requested of a work item: which task waits, what it would do and why (the approval body, in the person's language),
 * on what (Claw's target, masked), until when, with Approve and Deny, which answer the item's worker session as the clicker.
 */
function itemApproval(model: ProactiveApprovalModel): TeamsMessage {
  const { event } = model;
  const approval = objectOf(event["approval"]);
  const tool = pyStr(approval["tool"]);
  const lang = itemLang(event);
  const t = proactiveText.in(lang);
  const view = approvalView({ tool, toolInput: null, event: { summary: event["summary"] }, lang, group: false });
  const body = approvalBody(view);
  body.splice(1, 0, text(itemRequestLabel(event, "task", lang), { subtle: true, size: "Small" }));
  if (pyStr(approval["target"])) body.push(targetText(maskedTarget(approval["target"])));
  body.push(note(t.until({ until: clockText(model.expiresAt, model.zone), zone: model.zone })));
  const actions = [
    ...decisionButtons(tool || en.anAction, pyStr(event["session_id"]), pyStr(approval["tool_use_id"]), lang),
    ...openAction(event, model.publicBaseUrl, t.details),
  ];
  return message(body, actions);
}

/** A work item's question to its person: the question card a turn's own question gets, under a line naming the task. */
function itemQuestion(model: ItemQuestionModel): TeamsMessage {
  const { event } = model;
  return approvalRenderers.question({
    questions: cardQuestions(event["questions"]),
    sessionId: pyStr(event["session_id"]),
    toolUseId: pyStr(objectOf(event["approval"])["tool_use_id"]),
    group: false,
    ownerName: "",
    note: itemRequestLabel(event, "asks", itemLang(event)),
  });
}

export const proactiveRenderers = {
  digest,
  itemApproval,
  itemQuestion,
  proactiveApproval,
  runEvent,
} satisfies Partial<Renderers>;
