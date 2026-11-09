// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { NoteModel, NoteTone, ViewButton } from "@primusclaw/personal-agent";

import type { CardElement, JsonObject } from "../../cards/json.js";
import { execute, header, message, openUrl, text, type Meaning } from "../../cards/kit.js";

/** The emoji a note's headline leads with, by its tone. */
const MEANING: Readonly<Partial<Record<NoteTone, Meaning>>> = {
  good: "good",
  attention: "failed",
  warning: "needs_you",
};

/** A view's button as a card action. */
export function action(button: ViewButton): CardElement {
  // (the click data is core's read-only JSON; the card holds its own copy)
  const built =
    "url" in button
      ? openUrl(button.title, button.url)
      : execute(button.title, button.verb, structuredClone(button.data) as JsonObject);
  return button.style ? { ...built, style: button.style } : built;
}

/**
 * What replaces a card the person just clicked: a short note (under a headline in `tone`, when there is one), and the
 * buttons again when the click has to be repeated.
 */
export function noteCard(model: NoteModel): ReturnType<typeof message> {
  const tone = model.tone ?? "default";
  const body: CardElement[] = [];
  if (model.title) body.push(header(model.title, { tone, emoji: MEANING[tone] ?? "notice" }));
  body.push(text(model.text));
  return message(body, (model.buttons ?? []).map(action));
}
