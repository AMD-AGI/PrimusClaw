// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Approval and question cards (teams_agent/render.py permission_card, decision_buttons, question_card, answer_button; the body is
 * approval_view.card_body). What a card says is core's `approvalView`; this draws it on the card kit.
 */
import {
  ANSWER_MAX,
  COMMAND_MAX,
  DETAILS_ID,
  QUESTION_TOOL,
  TITLE_ID,
  approvalText,
  approvalView,
  clockText,
  proactiveText,
  questionWire,
  type ApprovalAgainModel,
  type ApprovalCardModel,
  type ApprovalDecidedModel,
  type ApprovalExpiredModel,
  type ApprovalView,
  type CardQuestion,
  type QuestionAnsweredModel,
  type QuestionCardModel,
} from "@primusclaw/personal-agent";

import { clip, hasCjk } from "../../cards/cjk.js";
import type { CardElement, JsonObject } from "../../cards/json.js";
import { TITLE_MAX, buttons, execute, facts, fold, header, message, note, text } from "../../cards/kit.js";
import { noteCard } from "../assistant/index.js";
import type { Renderers, TeamsMessage } from "../registry.js";

/** The longest answer an answered card shows. */
const ANSWER_SHOWN_MAX = 280;

/** Approve (the primary button) and Deny: what an approval card's buttons carry. */
export function decisionButtons(tool: string, sessionId: string, toolUseId: string, lang: string): CardElement[] {
  const t = approvalText.in(lang === "zh" ? "zh" : "en");
  const button = (title: string, action: string): CardElement =>
    execute(title, "primusclaw.decision", {
      primusclaw: "decision",
      session_id: sessionId,
      tool,
      tool_use_id: toolUseId,
      action,
    });
  return buttons([button(t.allow, "allow"), button(t.deny, "deny")]);
}

/** The body of a permission card: the warning header, the summary or the agent's words, the facts and the folded raw call. */
export function approvalBody(view: ApprovalView): CardElement[] {
  const t = approvalText.in(view.lang);
  const body: CardElement[] = [
    header(view.group ? t.titleGroup : t.title, { tone: "warning", titleId: TITLE_ID, emoji: "needs_you" }),
  ];
  if (view.summary) {
    body.push(text(view.summary, { weight: "Bolder" }));
    body.push(note(t.model, { spacing: "None" }));
  } else if (view.intent) {
    body.push(text(`${t.said}${t.sep}${view.intent}`, { subtle: true }));
  }
  const name = view.action || t.fallbackTool;
  const action: readonly [string, string] = [t.action, view.description ? `${name} — ${view.description}` : name];
  if (view.group) {
    return [...body, ...facts([action]), note(t.only({ who: view.owner || t.asker }))];
  }
  const rows: (readonly [string, string])[] = [action, ...view.args];
  if (view.reason !== undefined) rows.push([t.reason, view.reason]);
  body.push(...facts(rows, COMMAND_MAX + 10));
  if (view.ruleLabel) body.push(note(t.rule({ label: view.ruleLabel })));
  if (view.moreFields) body.push(note(t.more({ n: view.moreFields })));
  if (view.details) {
    body.push(...fold(DETAILS_ID, [text(view.details, { subtle: true, size: "Small", mono: true })], t.details));
  }
  return body;
}

function approvalCard(model: ApprovalCardModel) {
  const view = approvalView({
    tool: model.tool,
    toolInput: model.input,
    event: model.event,
    lang: model.lang,
    group: model.group,
    owner: model.ownerName,
  });
  return message(approvalBody(view), decisionButtons(model.tool, model.sessionId, model.toolUseId, view.lang));
}

function zhQuestions(questions: readonly CardQuestion[], extra = ""): boolean {
  return questions.some((q) => hasCjk(q.question)) || hasCjk(extra);
}

/** Send: what a question card's button carries; the questions travel with it so the card can be drawn again. */
export function answerButton(sessionId: string, toolUseId: string, questions: readonly CardQuestion[]): CardElement {
  const t = approvalText.in(zhQuestions(questions) ? "zh" : "en");
  return {
    ...execute(t.send, "primusclaw.answer", {
      primusclaw: "answer",
      session_id: sessionId,
      tool: QUESTION_TOOL,
      tool_use_id: toolUseId,
      questions: questions.map((q) => questionWire(q) as JsonObject),
    }),
    style: "positive",
  };
}

function questionInputs(q: CardQuestion, i: number, t: ReturnType<typeof approvalText.in>): CardElement[] {
  const out: CardElement[] = [text(q.question, { weight: "Bolder", spacing: "Medium" })];
  if (q.options.length) {
    out.push({
      type: "Input.ChoiceSet",
      id: `choice_${String(i)}`,
      style: "expanded",
      isMultiSelect: q.allowMultiple,
      choices: q.options.map((o) => ({ title: o.label, value: o.id })),
    });
  }
  out.push({
    type: "Input.Text",
    id: `text_${String(i)}`,
    maxLength: ANSWER_MAX,
    placeholder: q.options.length ? t.questionOr : t.questionYours,
  });
  return out;
}

/** The agent asks before it goes on: each question with its options as choices, a box for a free answer, and one Send button. */
function questionCard(model: QuestionCardModel) {
  const t = approvalText.in(zhQuestions(model.questions, model.note) ? "zh" : "en");
  const body: CardElement[] = [
    header(t.questionTitle, { tone: "accent", subtitle: model.note, emoji: "question" }),
    ...model.questions.flatMap((q, i) => questionInputs(q, i, t)),
  ];
  if (model.group) body.push(note(t.questionOnly({ who: model.ownerName || t.questionAsker })));
  return message(body, [answerButton(model.sessionId, model.toolUseId, model.questions)]);
}

/** What replaces an approval card once it was answered: who answered (you), when, and on what. */
function approvalDecided(model: ApprovalDecidedModel): TeamsMessage {
  const allow = model.action === "allow";
  const said = proactiveText.in("en").decided({ allow, at: clockText(model.when, model.zone) });
  return message([
    header(said, {
      tone: allow ? "good" : "attention",
      subtitle: clip(model.tool, TITLE_MAX),
      emoji: allow ? "good" : "denied",
    }),
  ]);
}

/** An approval or a question that ran out, and what the person can still do. */
function approvalExpired(model: ApprovalExpiredModel): TeamsMessage {
  const t = proactiveText.in("en");
  const line =
    model.tool === QUESTION_TOOL ? t.questionExpired : t.approvalExpired({ tool: clip(model.tool, TITLE_MAX) });
  return message([header(t.expired, { tone: "attention", emoji: "expired" }), text(line, { subtle: true })]);
}

/** What replaces a question card once it was answered: when, and each answer. */
function questionAnswered(model: QuestionAnsweredModel): TeamsMessage {
  const said = proactiveText.in("en").answered({ at: clockText(model.when, model.zone) });
  return message([
    header(said, { tone: "good", emoji: "good" }),
    ...model.answers.map(([, answer]) => text(clip(answer, ANSWER_SHOWN_MAX))),
  ]);
}

/** An approval card put back after a press that did not go through: the note, then Approve and Deny again. */
function approvalAgain(model: ApprovalAgainModel): TeamsMessage {
  return noteCard(
    model.text,
    decisionButtons(model.tool, model.sessionId, model.toolUseId, "en"),
    proactiveText.in("en").approvalNeeded({ tool: model.tool }),
  );
}

export const approvalRenderers = {
  approval: approvalCard,
  approvalAgain,
  approvalDecided,
  approvalExpired,
  question: questionCard,
  questionAnswered,
} satisfies Partial<Renderers>;
