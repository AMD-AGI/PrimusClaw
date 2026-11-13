// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The cards of the person's personal skills. What they say is `skillText`'s; a surface draws them. Their buttons carry only the id of
 * the card this worker recorded (`assistant_confirm_cards`): what a press means is read from the record, never from the click.
 */
import type { SkillCardEvent } from "../assistant/events.js";

/** The kind a skill card's record has: its Undo takes back the change it names (`confirmationId`, the change's id); `label` is the skill's name. */
export const SKILL_UNDO_KIND = "skill_undo";
/** The verb of the Undo, Edit and Save changes buttons (a draft's Save and Discard are the held write's own, `assistant_confirm`). */
export const SKILL_VERB = "assistant_skill";
/** The ids of the edit card's inputs. */
export const SKILL_EDIT_DESCRIPTION = "skill_description";
export const SKILL_EDIT_CONTENT = "skill_content";
/** The longest SKILL.md edited on a card (code points): a longer one is changed by telling the assistant. */
export const SKILL_EDIT_MAX = 6000;

/** A skill as its card shows it: what was saved, changed, turned off or deleted (with Undo and Edit), or a draft (Save, Discard). */
export interface SkillCardModel {
  readonly skill: SkillCardEvent;
  /** The card's record ("" none: no buttons). A draft's is its held write; any other's is its change, for Undo and Edit. */
  readonly cardId: string;
  /** A draft's Save, in Claw's word ("" for the catalog's). */
  readonly allowLabel: string;
  /** One line under it ("" none): what came of a press, or why to press again. */
  readonly note: string;
  /** Its buttons are gone: answered already. */
  readonly ended: boolean;
  readonly lang: "zh" | "en";
}

/** A skill's text and description to change, with Save changes. */
export interface SkillEditModel {
  readonly cardId: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  /** One line above Save changes ("" none): why the last Save did not go through. */
  readonly note: string;
  readonly lang: "zh" | "en";
}

declare module "../ports/surface.js" {
  interface ViewMap {
    skillCard: SkillCardModel;
    skillEdit: SkillEditModel;
  }
}
