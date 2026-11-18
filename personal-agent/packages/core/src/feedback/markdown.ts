// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { cpHead, squashSpaces } from "../text/py-text.js";

/**
 * Markdown that cannot be read as anything but text: what a report puts in an issue is partly the reporter's and partly
 * what Claw said, and neither may ping, link, format or forge the hidden retry marker.
 */

const CODE_CHARS = 120;

/** An inline code span: one line, no backtick, no opening of an HTML comment, at most 120 characters. */
export function code(value: string | number): string {
  const text = cpHead(squashSpaces(String(value).replaceAll("`", "'").replaceAll("<!--", "<! --")), CODE_CHARS);
  return `\`${text}\``;
}

/** A fenced block whose fence is longer than any run of backticks inside it. */
export function fence(text: string, info = ""): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const ticks = "`".repeat(Math.max(3, longest + 1));
  return `${ticks}${info}\n${text}\n${ticks}`;
}
