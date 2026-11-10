// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { OBSERVE_TEXT as T } from "../locales/observe.js";
import type { ViewButton, OutMessage } from "../ports/surface.js";

/** One suggestion of an observed group, on the observer's /board: what their assistant would have done there. */
export interface ObserveSuggestionView {
  readonly cardId: string;
  /** The group's name ("" when the channel gave none). */
  readonly group: string;
  /** What was said in the group. */
  readonly message: string;
  readonly kind: string;
  readonly what: string;
}

declare module "../ports/surface.js" {
  interface ViewMap {
    observeSuggestion: ObserveSuggestionView;
  }
}

/** Accept (the primary button) and Dismiss: what a suggestion card has, and what a press that did nothing puts back. */
export function suggestionButtons(cardId: string): ViewButton[] {
  const data = { primusclaw: "observe", card: cardId };
  return [
    { title: T.accept, verb: "primusclaw.observe_accept", data: { ...data, op: "accept" }, style: "positive" },
    { title: T.dismiss, verb: "primusclaw.observe_dismiss", data: { ...data, op: "dismiss" } },
  ];
}

export function suggestionMessage(model: ObserveSuggestionView): OutMessage {
  return { body: { type: "view", view: { name: "observeSuggestion", model }, fallbackText: T.cardTitle } };
}
