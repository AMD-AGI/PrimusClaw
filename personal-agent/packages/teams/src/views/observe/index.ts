// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How Teams shows a suggestion of an observed group (the Python worker's `observe.suggestion_card`): the group, what was
 * said, what the observer's assistant would have done, and Accept (primary) and Dismiss.
 */
import { OBSERVE_TEXT as T, type ObserveSuggestionView, suggestionButtons } from "@primusclaw/personal-agent";

import { clip } from "../../cards/cjk.js";
import { buttons, facts, header, message, note, text, type CardMessage } from "../../cards/kit.js";
import type { Renderers } from "../registry.js";
import { action } from "../turn/note.js";

export function suggestionCard(model: ObserveSuggestionView): CardMessage {
  return message(
    [
      header(T.cardTitle, { tone: "accent", subtitle: clip(model.group || T.groupChat, 80), emoji: "notice" }),
      ...facts([
        [T.said, clip(model.message, 300)],
        [T.would, model.kind],
      ]),
      text(model.what || T.empty),
      note(T.cardNote),
    ],
    buttons(suggestionButtons(model.cardId).map(action)),
  );
}

export const OBSERVE_RENDERERS = { observeSuggestion: suggestionCard } satisfies Partial<Renderers>;
