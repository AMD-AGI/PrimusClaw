// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Core's `OutMessage` as the Teams activity it is posted as: the body (markdown text, rich text as Teams' HTML subset, or a
 * view rendered as a card) and the decorations core asked for (the AI label, @mentions, Teams' thumbs, suggested replies,
 * citations), each applied only where Teams takes it.
 */
import type { Citation, OutMessage, UserRef } from "@primusclaw/personal-agent";

import type { JsonObject } from "../cards/json.js";
import type { Style } from "../config/style.js";
import { withAiLabel, withCitationEntities, withSuggestedReplies } from "../activity/decorations.js";
import { withFeedbackLoop } from "../activity/feedback-loop.js";
import { withLineBreaks } from "../activity/line-breaks.js";
import { textActivity, withMention } from "../activity/outbound.js";
import { richTextActivity, unescapeMarkdown } from "../richtext/index.js";
import { renderView, type Renderers } from "../views/registry.js";
import type { Masker } from "./masker.js";

/** The abstract of a citation, as Teams shows it under the source's name. */
const CITATION_ABSTRACT_MAX = 160;

export interface RenderContext {
  readonly style: Style;
  readonly renderers: Renderers;
  /** In a group chat: what everyone sees is masked. */
  readonly masker: Masker | undefined;
}

/**
 * A final answer as an xml-format message. In a group the masking runs on the markdown BEFORE it is converted (a mask that
 * swallows to the end of an unfinished private key must not swallow a closing tag); conversion also resolves markdown
 * escapes, which can make a secret recognisable only afterwards, so then the escapes are resolved first and the answer is
 * masked again. Markup that still holds a secret shape is never sent: the masked markdown goes out instead.
 */
export function richActivity(markdown: string, lead: boolean, masker: Masker | undefined): JsonObject {
  if (masker === undefined) return richTextActivity(markdown, { lead });
  let first: string | undefined;
  for (const candidate of [markdown, unescapeMarkdown(markdown)]) {
    const masked = masker.text(candidate);
    const text = masked.hit ? `${masked.text}\n\n${masker.note}` : masked.text;
    first ??= text;
    const activity = richTextActivity(text, { lead });
    const html = activity["text"];
    if (activity["textFormat"] !== "xml" || typeof html !== "string" || !masker.text(html).hit) return activity;
  }
  return textActivity(withLineBreaks(first ?? ""));
}

function bodyActivity(message: OutMessage, context: RenderContext): JsonObject {
  const body = message.body;
  switch (body.type) {
    case "text":
      // (Teams' markdown joins lines a single "\n" separates. A group chat's masking runs on the activity after this: it
      // only adds a "\n" next to a "\n", and every credential shape the masking knows reads any run of whitespace alike)
      return textActivity(withLineBreaks(body.text));
    case "rich":
      return richActivity(body.markdown, body.lead, context.masker);
    case "view":
      return renderView(context.renderers, body.view);
  }
}

/** A citation as Teams' Claim entity; its position is the `[n]` the text cites it by. */
export function claimOf(citation: Citation): JsonObject {
  return {
    "@type": "Claim",
    position: citation.position,
    appearance: {
      "@type": "DigitalDocument",
      name: citation.title,
      url: citation.url,
      abstract: Array.from(citation.abstract).slice(0, CITATION_ABSTRACT_MAX).join(""),
    },
  };
}

function mentioned(activity: JsonObject, people: readonly UserRef[]): JsonObject {
  // (each mention goes in front of the text: the last one first, so the text starts with the first person named)
  return [...people].reverse().reduce((out, who) => withMention(out, who.channelUserId, who.name), activity);
}

/** The activity Teams is sent for `message` (before a group chat's masking of the whole activity). */
export function activityOf(message: OutMessage, context: RenderContext): JsonObject {
  let activity = bodyActivity(message, context);
  if (message.mentions?.length) activity = mentioned(activity, message.mentions);
  if (message.aiGenerated && context.style.aiLabel) activity = withAiLabel(activity);
  if (message.citations?.length) activity = withCitationEntities(activity, message.citations.map(claimOf));
  if (message.feedback) activity = withFeedbackLoop(activity);
  if (message.suggestions?.length) activity = withSuggestedReplies(activity, message.suggestions);
  return activity;
}
