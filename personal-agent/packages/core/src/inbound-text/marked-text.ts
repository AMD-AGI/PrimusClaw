// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The text of a group message with each person it @mentions replaced by a marker ⟦i⟧ (the Python worker's
 * `activity.marked_text`), so a reader of the text (a review request: "请 ⟦0⟧ 帮我 review") can tell a person who was
 * @mentioned from a name that was only typed; mention i is the i-th of the list returned. The addresses behind the
 * links are added as `withLinks` adds them.
 *
 * Input is channel-neutral: the message's text (the bot's own mention already removed by the channel adapter) and its
 * mentions, whose `shown` is the mention as it stands in that text. Difference from the Python worker, which replaced
 * the mention's markup (`<at>Dana</at>`) in the raw text: here the first occurrence of the shown words is replaced, so
 * when the same words were also typed before the mention ("Dana, ask @Dana"), the typed ones get the marker.
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

export function markedText(
  text: string,
  mentions: readonly InboundMention[],
  options: MarkedTextOptions = {},
): MarkedText {
  // A marker the person typed is no mention.
  let out = text.replaceAll(MARK_OPEN, "").replaceAll(MARK_CLOSE, "");
  const marked: InboundMention[] = [];
  for (const mention of mentions) {
    const at = mention.shown ? out.indexOf(mention.shown) : -1;
    if (at < 0) continue;
    out = `${out.slice(0, at)}${MARK_OPEN}${String(marked.length)}${MARK_CLOSE}${out.slice(at + mention.shown.length)}`;
    marked.push(mention);
  }
  return { text: withLinks(pyStrip(out), options.links ?? [], options), mentions: marked };
}
