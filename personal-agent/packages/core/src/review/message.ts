// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message as a review request is read: every mention replaced by a marker ⟦i⟧ (mentions[i] is that person), so a reader
 * can tell a person who was @mentioned from a name that was only typed, and the address behind each link written after the
 * words shown for it, so a pull request linked under other words is still found.
 */

import type { InboundLink, InboundMention } from "../ports/surface.js";
import { pyStrip } from "../text/py-text.js";
import type { Mention } from "./names.js";
import { MARK_CLOSE, MARK_OPEN } from "./pull-ref.js";

const AT_TAG = /<\/?at>/giu;

export interface MarkedText {
  readonly text: string;
  /** The mentions the text holds, in marker order (one whose words are not in the text is not one). */
  readonly mentions: readonly Mention[];
}

/**
 * `text` with every mention as a marker and every link's address after it. A typed marker character is no mention: it is
 * taken out first. `mask` hides credential shapes in an address (a group sees what the request is read as).
 */
export function markText(
  text: string,
  mentions: readonly InboundMention[],
  links: readonly InboundLink[],
  mask: (text: string) => string = (t) => t,
): MarkedText {
  let marked = text.replaceAll(MARK_OPEN, "").replaceAll(MARK_CLOSE, "");
  const kept: Mention[] = [];
  for (const mention of mentions) {
    if (!mention.shown || !marked.includes(mention.shown)) continue;
    marked = marked.replace(mention.shown, () => `${MARK_OPEN}${String(kept.length)}${MARK_CLOSE}`);
    kept.push({ channelUserId: mention.channelUserId, userId: mention.userId, name: mention.name });
  }
  const masked = links.map((link) => ({ url: mask(link.url), title: link.title }));
  return { text: withLinks(pyStrip(marked.replace(AT_TAG, "")), masked), mentions: kept };
}

/**
 * `text` with the address of every link it does not already carry: right after the words that were shown for the link
 * ("fix the plugin check <https://...>"), or, when those are not in the text, on a line of its own.
 */
export function withLinks(text: string, links: readonly InboundLink[]): string {
  const inserts: [number, string][] = [];
  const taken: [number, number][] = [];
  const lines: string[] = [];
  for (const link of links) {
    if (text.includes(link.url)) continue;
    let at = link.title ? text.indexOf(link.title) : -1;
    while (at >= 0 && taken.some(([start, end]) => at < end && start < at + link.title.length)) {
      at = text.indexOf(link.title, at + 1);
    }
    if (at < 0) {
      lines.push(link.title ? `${link.title} <${link.url}>` : link.url);
      continue;
    }
    taken.push([at, at + link.title.length]);
    inserts.push([at + link.title.length, ` <${link.url}>`]);
  }
  let out = text;
  for (const [where, what] of inserts.sort((a, b) => b[0] - a[0] || (b[1] < a[1] ? -1 : b[1] > a[1] ? 1 : 0))) {
    out = out.slice(0, where) + what + out.slice(where);
  }
  return pyStrip([out, ...lines].join("\n"));
}
