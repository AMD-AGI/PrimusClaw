// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The cards of the person's personal skills: what was saved, changed, turned off or deleted (Undo; Edit for a saved one), a draft to
 * save (Save and Discard, the held write's own buttons), and the form that edits one. What they say is core's (`skillText`); the
 * buttons carry only the id of the card the worker recorded, never what the press means.
 */
import {
  SKILL_EDIT_CONTENT,
  SKILL_EDIT_DESCRIPTION,
  SKILL_VERB,
  skillText,
  type SkillCardModel,
  type SkillEditModel,
} from "@primusclaw/personal-agent";

import type { CardElement } from "../../cards/json.js";
import type { Meaning, Tone } from "../../cards/kit.js";
import { buttons, execute, facts, fold, header, message, note, text } from "../../cards/kit.js";
import type { Renderers, TeamsMessage } from "../registry.js";

function skillButton(title: string, op: string, cardId: string): CardElement {
  return execute(title, `primusclaw.${SKILL_VERB}_${op}`, { primusclaw: SKILL_VERB, op, card: cardId });
}

function heading(model: SkillCardModel): { title: string; tone: Tone; emoji: Meaning } {
  const t = skillText.in(model.lang);
  const { skill } = model;
  const version = skill.version ?? 1;
  switch (skill.kind) {
    case "saved":
      return skill.created
        ? { title: t.savedTitle({ name: skill.name, version }), tone: "good", emoji: "good" }
        : { title: t.updatedTitle({ name: skill.name, version }), tone: "good", emoji: "good" };
    case "deleted":
      return { title: t.deletedTitle({ name: skill.name }), tone: "default", emoji: "dropped" };
    case "disabled":
      return { title: t.disabledTitle({ name: skill.name }), tone: "default", emoji: "notice" };
    case "enabled":
      return { title: t.enabledTitle({ name: skill.name }), tone: "good", emoji: "good" };
    case "draft":
      return { title: t.draftTitle({ name: skill.name }), tone: "warning", emoji: "needs_you" };
  }
}

/**
 * A skill's card: what it is for and its files, the start of SKILL.md folded away, then its buttons. A draft's are Save and Discard
 * (the held write's own verb, answered as any held write is); anything done already has Undo, and a saved one Edit too.
 */
function skillCard(model: SkillCardModel): TeamsMessage {
  const t = skillText.in(model.lang);
  const { skill } = model;
  const head = heading(model);
  const body: CardElement[] = [header(head.title, { tone: head.tone, emoji: head.emoji })];
  body.push(
    ...facts([
      [t.whenToUse, skill.description],
      [t.files, skill.files.join(", ")],
    ]),
  );
  if (skill.kind === "saved" || skill.kind === "draft") {
    body.push(note(skill.kind === "draft" ? t.draftNote : skill.manual ? t.manual : t.autoNote));
  }
  if (skill.preview) body.push(...fold("skill-preview", [text(skill.preview, { subtle: true })], "SKILL.md"));
  if (model.note) body.push(text(model.note, { weight: "Bolder" }));
  if (model.ended || !model.cardId) return message(body);
  if (skill.kind === "draft") {
    const confirm = (title: string, op: string) =>
      execute(title, `primusclaw.assistant_confirm_${op}`, { primusclaw: "assistant_confirm", op, card: model.cardId });
    return message(body, buttons([confirm(model.allowLabel || t.save, "allow"), confirm(t.discard, "deny")]));
  }
  const actions = [skillButton(t.undo, "undo", model.cardId)];
  if (skill.kind === "saved") actions.push(skillButton(t.edit, "edit", model.cardId));
  return message(body, buttons(actions, ""));
}

/** The form that edits a skill: its description and its whole SKILL.md, and Save changes. */
function skillEdit(model: SkillEditModel): TeamsMessage {
  const t = skillText.in(model.lang);
  const body: CardElement[] = [
    header(t.editTitle({ name: model.name }), { tone: "accent", emoji: "changes" }),
    text(t.editDescription, { weight: "Bolder" }),
    { type: "Input.Text", id: SKILL_EDIT_DESCRIPTION, value: model.description, maxLength: 300, isMultiline: true },
    text(t.editContent, { weight: "Bolder" }),
    { type: "Input.Text", id: SKILL_EDIT_CONTENT, value: model.content, isMultiline: true },
  ];
  if (model.note) body.push(text(model.note, { weight: "Bolder" }));
  return message(body, buttons([skillButton(t.editSave, "save_edit", model.cardId)]));
}

export const skillRenderers = { skillCard, skillEdit } satisfies Partial<Renderers>;
