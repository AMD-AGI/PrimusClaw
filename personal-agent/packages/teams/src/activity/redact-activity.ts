// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Credential masking of an outbound activity for a group chat: a copy with every credential shape masked in its text and
 * in its cards' text; when anything was masked, one line says so (after the text, or as a last card TextBlock). The masking
 * rules are core's (`redactText`); this walks a Teams activity with them. A Teams `Masker` is made of the two.
 */
import { isObject, type Json, type JsonObject } from "../cards/json.js";
import type { Masked, Masker } from "../messenger/masker.js";

/** A text masker: `text` with every credential shape masked, and whether anything was. */
export type RedactText = (text: string) => { readonly text: string; readonly masked: boolean };

/** Keys whose values are never a person's words (ids, verbs, styles, the card's data): left as they are. */
const SKIP_KEYS = new Set([
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

function walk(node: Json, redact: RedactText, hits: boolean[]): Json {
  if (typeof node === "string") {
    const out = redact(node);
    hits.push(out.masked);
    return out.text;
  }
  if (Array.isArray(node)) return node.map((item) => walk(item, redact, hits));
  if (isObject(node)) {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [key, SKIP_KEYS.has(key) ? value : walk(value, redact, hits)]),
    );
  }
  return node;
}

function withNote(out: JsonObject, note: string): JsonObject {
  const noted: JsonObject = typeof out["text"] === "string" ? { ...out, text: `${out["text"]}\n\n${note}` } : out;
  const attachments = noted["attachments"];
  if (!Array.isArray(attachments)) return noted;
  for (const attachment of attachments) {
    const content = isObject(attachment) ? attachment["content"] : undefined;
    const body = isObject(content) ? content["body"] : undefined;
    if (Array.isArray(body)) body.push({ type: "TextBlock", text: note, wrap: true, isSubtle: true });
  }
  return noted;
}

/** A copy of `activity` with credential shapes masked (the activity itself when nothing was). */
export function redactActivity(activity: JsonObject, redact: RedactText, note: string): JsonObject {
  const hits: boolean[] = [];
  const out: JsonObject = Object.fromEntries(
    Object.entries(activity).map(([key, value]) => [
      key,
      key === "type" || key === "textFormat" ? value : walk(value, redact, hits),
    ]),
  );
  return hits.some(Boolean) ? withNote(out, note) : activity;
}

/** The Teams masker of a group chat, from core's text masking rules and the line that says something was masked. */
export function teamsMasker(redact: RedactText, note: string): Masker {
  return {
    text: (text: string): Masked => {
      const out = redact(text);
      return { text: out.text, hit: out.masked };
    },
    activity: (activity: JsonObject) => redactActivity(activity, redact, note),
    note,
  };
}
