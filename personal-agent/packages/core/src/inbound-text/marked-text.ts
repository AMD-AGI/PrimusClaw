// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The text of a group message with each person it @mentions replaced by a marker ⟦i⟧ (the Python worker's
 * `activity.marked_text`), so a reader of the text (a review request: "请 ⟦0⟧ 帮我 review") can tell a person who was
 * @mentioned from a name that was only typed; mention i is the i-th of the list returned. The addresses behind the
 * links are added as `withLinks` adds them.
 *
 * Input is channel-neutral: the message's text (the bot's own mention already removed by the channel adapter) and its
 * mentions, each replaced where it stands (`offset`), so a name typed before the same person's mention stays a name.
 */
import type { InboundLink, InboundMention } from "../ports/surface.js";
import { pyStrip } from "../text/py-text.js";
import { withLinks, type WithLinksOptions } from "./with-links.js";

/** What a mention is replaced with: ⟦0⟧, ⟦1⟧, ... */
export const MARK_OPEN = "⟦";
export const MARK_CLOSE = "⟧";

export interface MarkedText {
  readonly text: string;
  /** The mentions that were found in the text, in marker order. */
  readonly mentions: readonly InboundMention[];
}

export interface MarkedTextOptions extends WithLinksOptions {
  readonly links?: readonly InboundLink[];
}

/** The mentions that stand where they say (their `shown` at their `offset`), not overlapping, by their offset. */
function placed(points: readonly string[], mentions: readonly InboundMention[]): Map<number, InboundMention> {
  const byOffset = new Map<number, InboundMention>();
  let taken = -1;
  const order = mentions
    .map((mention, index) => ({ mention, index }))
    .sort((a, b) => a.mention.offset - b.mention.offset || a.index - b.index);
  for (const { mention } of order) {
    const shown = Array.from(mention.shown);
    const at = mention.offset;
    if (!shown.length || at <= taken || points.slice(at, at + shown.length).join("") !== mention.shown) continue;
    byOffset.set(at, mention);
    taken = at + shown.length - 1;
  }
  return byOffset;
}

export function markedText(
  text: string,
  mentions: readonly InboundMention[],
  options: MarkedTextOptions = {},
): MarkedText {
  const points = Array.from(text);
  const byOffset = placed(points, mentions);
  // Markers are numbered in the order of the mentions given (Python: the order of the entities).
  const marked = mentions.filter((mention) => byOffset.get(mention.offset) === mention);
  let out = "";
  for (let at = 0; at < points.length;) {
    const mention = byOffset.get(at);
    if (mention !== undefined) {
      out += `${MARK_OPEN}${String(marked.indexOf(mention))}${MARK_CLOSE}`;
      at += Array.from(mention.shown).length;
      continue;
    }
    const point = points[at] ?? "";
    // A marker the person typed is no mention.
    if (point !== MARK_OPEN && point !== MARK_CLOSE) out += point;
    at++;
  }
  return { text: withLinks(pyStrip(out), options.links ?? [], options), mentions: marked };
}
