// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Text an agent, its connector or a machine supplied is untrusted: it is shown only as inert text. `neutral` makes one short
 * line of it (credential shapes masked before the cut, so a cut cannot leave half a credential; no link or tag can be built
 * from it); `defang` keeps a JSON value whole but inert; `lit` is `neutral` for a card TextBlock, which reads markdown.
 */
import { redactText as redact } from "../security/redact.js";
import { neutral as neutralText } from "../text/neutral.js";
import { pyStr } from "../text/py-text.js";

const MARKDOWN = /([\\`*_[\]<])/g;

/** `text` for a card TextBlock, which reads markdown: its markup characters escaped, so that `__init__.py` is not bold. */
export function plain(text: string): string {
  return text.replace(MARKDOWN, "\\$1");
}

/** One short line of untrusted text, safe in a card or a list (`text/neutral`), from whatever a connector reported: a value that
 * is not text is read as Python's `str(value or "")` would. */
export function neutral(text: unknown, limit = 200): string {
  return neutralText(pyStr(text), limit);
}

/** `neutral`, then markup escaped: text supplied by an agent, a machine or a session as it goes into a card TextBlock. */
export function lit(text: unknown, limit: number): string {
  return plain(neutral(text, limit));
}

/** `text` whole, but unable to make a markdown link or image (`](` gets a zero-width space inside) or a tag (`<`/`>` look-alikes). */
export function inertLinks(text: string): string {
  return text.replaceAll("](", "]\u{200b}(").replaceAll("<", "\u{2039}").replaceAll(">", "\u{203a}");
}

/** A copy of an agent's JSON with every string unable to make a link or a tag: `](` gets a zero-width space inside, and
 * `<`/`>` become look-alikes. Unlike `neutral` it keeps the text whole. */
export function defang(value: unknown): unknown {
  if (typeof value === "string") return inertLinks(value);
  if (Array.isArray(value)) return value.map(defang);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [defang(pyStr(k)) as string, defang(v)]));
  }
  return value;
}

/** `text` with credential-shaped values masked. */
export function masked(text: string): string {
  return redact(text).text;
}
