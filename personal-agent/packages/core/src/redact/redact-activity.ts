// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { redactText } from "./redact-text.js";

/** The one line a masked outbound message carries (the Python worker's text, byte for byte). */
export const NOTE = "Some sensitive-looking values were hidden. Ask me in a 1:1 chat if you need them.";

/** Card and activity fields that are machinery, not text a person reads: left as they are. */
const SKIP_KEYS: ReadonlySet<string> = new Set([
  "data",
  "verb",
  "url",
  "id",
  "type",
  "contentType",
  "$schema",
  "version",
  "style",
  "fontType",
  "weight",
  "size",
  "wrap",
  "isSubtle",
  "operation",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function walk(node: unknown, hits: { masked: boolean }): unknown {
  if (typeof node === "string") {
    const { text, masked } = redactText(node);
    if (masked) hits.masked = true;
    return text;
  }
  if (Array.isArray(node)) return node.map((child) => walk(child, hits));
  if (isRecord(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, SKIP_KEYS.has(key) ? value : walk(value, hits)]),
    );
  }
  return node;
}

function addNote(out: Record<string, unknown>): void {
  if (typeof out["text"] === "string") out["text"] = `${out["text"]}\n\n${NOTE}`;
  const attachments = out["attachments"];
  if (!Array.isArray(attachments)) return;
  for (const attachment of attachments) {
    const content = isRecord(attachment) ? attachment["content"] : undefined;
    if (isRecord(content) && Array.isArray(content["body"])) {
      content["body"].push({ type: "TextBlock", text: NOTE, wrap: true, isSubtle: true });
    }
  }
}

/**
 * A copy of an outbound activity (its text and its Adaptive Card text) with credential shapes masked; when anything was
 * masked, one line says so (after the text, or as the card's last TextBlock). Nothing masked: the activity itself.
 */
export function redactActivity<T extends Readonly<Record<string, unknown>>>(activity: T): T {
  const hits = { masked: false };
  const out = Object.fromEntries(
    Object.entries(activity).map(([key, value]) => [
      key,
      key === "type" || key === "textFormat" ? value : walk(value, hits),
    ]),
  );
  if (!hits.masked) return activity;
  addNote(out);
  return out as T;
}
