// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A message's text with the address behind each of its links: what is sent on to the model, and what a review request
 * reads (the Python worker's `activity.with_links` / `_with_links`). A link shown as other words ("fix the plugin
 * check" over a pull request's address) gets its address right after those words; a link whose words are not in the
 * text gets a line of its own. The commands are never read from this text, only from the words alone.
 */
import type { InboundLink } from "../ports/surface.js";
import { pyStrip } from "../text/py-text.js";
import { noRedact, type Redact } from "./redact.js";

export interface WithLinksOptions {
  /** A group conversation: every member sees what is sent on, so a credential in an address is masked. */
  readonly group?: boolean;
  readonly redact?: Redact;
}

function overlaps(taken: readonly (readonly [number, number])[], at: number, length: number): boolean {
  return taken.some(([start, end]) => at < end && start < at + length);
}

/**
 * `text` with the address of every link it does not already carry: after the first place the link's words stand that
 * no earlier link took, or on a line of its own (`_with_links`). Places are looked up in the original text only.
 */
export function insertLinks(text: string, links: readonly InboundLink[]): string {
  const inserts: [number, string][] = [];
  const taken: [number, number][] = [];
  const lines: string[] = [];
  for (const { url, title } of links) {
    if (text.includes(url)) continue;
    let at = title ? text.indexOf(title) : -1;
    while (at >= 0 && overlaps(taken, at, title.length)) at = text.indexOf(title, at + 1);
    if (at < 0) {
      lines.push(title ? `${title} <${url}>` : url);
      continue;
    }
    taken.push([at, at + title.length]);
    inserts.push([at + title.length, ` <${url}>`]);
  }
  let out = text;
  for (const [where, what] of inserts.sort((a, b) => b[0] - a[0])) out = out.slice(0, where) + what + out.slice(where);
  return pyStrip([out, ...lines].join("\n"));
}

/** `activity.with_links(text, activity)`: `insertLinks`, the addresses masked in a group. */
export function withLinks(text: string, links: readonly InboundLink[], options: WithLinksOptions = {}): string {
  const redact = options.redact ?? noRedact;
  const shown = options.group ? links.map((link) => ({ url: redact(link.url), title: link.title })) : links;
  return insertLinks(text, shown);
}
