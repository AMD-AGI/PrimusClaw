// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's views: a work item that waits for the person, what replaces it once pressed, the board, a command or a write
 * put to the person (the arguments of teams_agent/render.py work_card, work_done_card, note_card with
 * work_buttons, board_card with board_buttons, action_card and confirm_write_card, one for one).
 */
import type { ReviewAskedOfOther, WorkItem } from "../claw/model.js";

/** A work item that waits for the person (render.work_card). */
export interface WorkCardModel {
  readonly item: WorkItem;
  /** What the assistant said about it ("" none). */
  readonly text: string;
  /** The card the worker recorded; the buttons carry only its id. */
  readonly cardId: string;
  /** One bold line when the card replaces an older one ("" none). */
  readonly note: string;
  /** Offer "Auto-reply to PR comments" (a task whose result is a pull request). */
  readonly watch: boolean;
  /** Auto-reply is on: offer to turn it off instead. */
  readonly watching: boolean;
  /** "zh" or "en"; null to follow what was said, or the item's title. */
  readonly lang: string | null;
}

/** What replaces a work card after Accept or Stop went through (render.work_done_card). */
export interface WorkDoneModel {
  /** "Accepted" (the version is said), or how it ended otherwise. */
  readonly verb: string;
  readonly item: WorkItem;
}

/** A work card put back after a press that did not go through: the note, then its buttons again (note_card + work_buttons). */
export interface WorkNoteModel {
  readonly text: string;
  readonly cardId: string;
  readonly version: number;
  readonly canAccept: boolean;
}

/** A task the board offers to run again, with the card recorded for its button. */
export interface BoardRetry {
  readonly cardId: string;
  readonly item: WorkItem;
}

/** The person's board (render.board_card, its buttons render.board_buttons). */
export interface BoardModel {
  readonly items: readonly WorkItem[];
  /** The reviews the person asked of others, shown beside their own. */
  readonly asked: readonly ReviewAskedOfOther[];
  /** Epoch seconds: how long ago each item changed is counted from here. */
  readonly now: number;
  /** The cards recorded for the results that wait (Accept all; none: no button). */
  readonly accept: readonly string[];
  /** Tasks that failed or were stopped (Retry each, within a card's three buttons). */
  readonly retry: readonly BoardRetry[];
  /** "zh" or "en"; null to follow the items' titles. */
  readonly lang: string | null;
}

/** A command the assistant put to the person instead of running it (render.action_card). */
export interface ActionCardModel {
  readonly text: string;
  readonly cardId: string;
  readonly command: string;
  /** "zh" or "en"; null to follow what was said. */
  readonly lang: string | null;
}

/** A write Claw holds until the person answers (render.confirm_write_card). */
export interface ConfirmWriteModel {
  readonly text: string;
  readonly cardId: string;
  /** Claw's word for letting it through ("" for "Confirm"). */
  readonly allowLabel: string;
  readonly lang: string;
}

declare module "../ports/surface.js" {
  interface ViewMap {
    actionCard: ActionCardModel;
    board: BoardModel;
    confirmWrite: ConfirmWriteModel;
    workCard: WorkCardModel;
    workDone: WorkDoneModel;
    workNote: WorkNoteModel;
  }
}
