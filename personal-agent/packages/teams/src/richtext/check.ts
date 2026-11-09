// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The allow-list the converted HTML is re-read against: only the tags, attributes, styles and entities the converter
 * writes. A bug in the converter fails closed here.
 */
import { LABEL_PX, LEAD_PX, RichTextError, STATUS_COLORS } from "./constants.js";
import { safeUrl } from "./url.js";

/** An HTML tag: closing slash, name, attributes. */
export const TAG = /<(\/?)([A-Za-z0-9]+)((?:[^<>A-Za-z0-9][^<>]*)?)>/gu;
const SPAN_STYLES: ReadonlySet<string> = new Set([
  `font-size:${String(LEAD_PX)}px`,
  `font-size:${String(LABEL_PX)}px`,
  ...Object.values(STATUS_COLORS).map((c) => `color:${c}`),
]);
const HREF = /^ href="([^"<>]*)"$/u;
const STYLE = /^ style="([^"<>]*)"$/u;
const PAIRED: ReadonlySet<string> = new Set(["b", "i", "u", "s", "a", "code", "pre", "span"]);
const ENTITY = /&(?:amp|lt|gt|nbsp|#x27|quot);/g;
const ENTITY_TEXT: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
  "&#x27;": "'",
  "&quot;": '"',
};

/**
 * Python's `html.unescape` for an attribute whose every "&" starts one of ENTITY (any other "&" is refused before
 * this matters).
 */
function unescapeEntities(text: string): string {
  return text.replace(ENTITY, (entity) => ENTITY_TEXT[entity] ?? entity);
}

function checkText(text: string): void {
  if (text.includes("<") || text.includes(">") || text.replace(ENTITY, "").includes("&")) {
    throw new RichTextError("unescaped markup in the converted text");
  }
}

function checkAttrs(name: string, attrs: string): void {
  if (name === "a") {
    const href = HREF.exec(attrs)?.[1];
    if (href === undefined || !safeUrl(unescapeEntities(href)) || href.replace(ENTITY, "").includes("&")) {
      throw new RichTextError("link not allowed");
    }
  } else if (name === "span") {
    const style = STYLE.exec(attrs)?.[1];
    if (style === undefined || !SPAN_STYLES.has(style)) throw new RichTextError("style not allowed");
  } else if (attrs) {
    throw new RichTextError("attributes not allowed");
  }
}

/** Throws RichTextError unless `markup` uses only the tags, attributes and entities the converter emits. */
export function checkHtml(markup: string): void {
  const stack: string[] = [];
  let pos = 0;
  for (const m of markup.matchAll(TAG)) {
    checkText(markup.slice(pos, m.index));
    pos = m.index + m[0].length;
    const closing = m[1] === "/";
    const name = m[2] ?? "";
    const attrs = m[3] ?? "";
    if (name === "br" && !closing && !attrs) continue;
    if (!PAIRED.has(name)) throw new RichTextError(`tag not allowed: ${name}`);
    if (closing) {
      if (attrs || stack.pop() !== name) throw new RichTextError("unbalanced tags");
      continue;
    }
    checkAttrs(name, attrs);
    stack.push(name);
  }
  checkText(markup.slice(pos));
  if (stack.length) throw new RichTextError("unbalanced tags");
}
