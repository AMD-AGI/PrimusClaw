// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Teams side of the cards world (the Python tests' `valid`, `body_text`, `titles`, `column_text`, `badges_of`): every view
 * drawn by the Teams renderers, the note card a press is settled with, the Adaptive Card 1.5 schema, and the words of a card as
 * those tests read them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { JsonObject, OutMessage } from "@primusclaw/personal-agent";
import { Ajv } from "ajv";

import { hasCjk } from "../../packages/teams/src/cards/cjk.js";
import { noteCard } from "../../packages/teams/src/views/assistant/index.js";
import { RENDERERS, renderView } from "../../packages/teams/src/views/index.js";
import type { Out } from "./cards-world.js";

const schema = JSON.parse(
  readFileSync(new URL("../data/adaptive-card-1.5.schema.json", import.meta.url), "utf8"),
) as JsonObject;
const rules = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$schema" && key !== "id"));
const validate = new Ajv({ strict: false, allErrors: true }).compile({
  ...rules,
  $id: typeof schema["id"] === "string" ? schema["id"] : "",
});

/** The card's content validates against Adaptive Card 1.5. */
export function valid(card: JsonObject): void {
  assert.ok(validate(card), JSON.stringify(validate.errors));
}

/** The card content of a Teams message (undefined: it carries none). */
export function contentOf(activity: JsonObject): JsonObject | undefined {
  const attachments = activity["attachments"];
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  return (attachments[0] as JsonObject)["content"] as JsonObject;
}

/** What Teams shows for a message: a view's card, or (an edit with words) the note card that replaces the pressed one. */
export function render(message: OutMessage, op: Out["op"]): JsonObject | undefined {
  if (message.body.type === "view") return contentOf(renderView(RENDERERS, message.body.view));
  if (op === "update")
    return contentOf(noteCard(message.body.type === "text" ? message.body.text : message.body.markdown));
  return undefined;
}

export const BAR = "┃";

/** A JSON value as the text it shows. */
export function str(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The words of a card element, in order, wherever they sit (containers, columns, facts as "title value"); not the bar. */
export function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts);
  if (typeof node !== "object" || node === null) return [];
  const n = node as JsonObject;
  if (n["type"] === "TextBlock") return n["text"] === BAR ? [] : [str(n["text"])];
  if (n["type"] === "FactSet") {
    return (n["facts"] as JsonObject[]).map((f) => `${str(f["title"])} ${str(f["value"])}`.replaceAll("⁠", ""));
  }
  return [...texts(n["items"] ?? []), ...texts(n["columns"] ?? [])];
}

export function bodyText(card: JsonObject): string {
  return texts(card["body"]).join(" ");
}

export function body(card: JsonObject): JsonObject[] {
  return card["body"] as JsonObject[];
}

export function titles(buttons: readonly JsonObject[]): string[] {
  return buttons.map((b) => str(b["title"]));
}

export function dataOf(button: JsonObject | undefined): JsonObject {
  assert.ok(button !== undefined, "no such button");
  return button["data"] as JsonObject;
}

/** The button of `op` among `buttons`. */
export function opOf(buttons: readonly JsonObject[], op: string): JsonObject {
  return dataOf(buttons.find((b) => (b["data"] as JsonObject)["op"] === op));
}

/** Every element of a card, depth first (items and columns). */
export function walk(node: unknown): JsonObject[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (typeof node !== "object" || node === null) return [];
  const n = node as JsonObject;
  return [n, ...walk(n["items"] ?? []), ...walk(n["columns"] ?? [])];
}

function idOf(block: JsonObject | undefined): string {
  const id = block?.["id"];
  return typeof id === "string" ? id : "";
}

/** (id, style, words) of each count badge of the board. */
export function badgesOf(board: JsonObject): [string, string, string[]][] {
  const rows = body(board).filter(
    (b) => b["type"] === "ColumnSet" && idOf((b["columns"] as JsonObject[])[0]).startsWith("badge-"),
  );
  assert.equal(rows.length, 1);
  const columns = (rows[0]?.["columns"] ?? []) as JsonObject[];
  return columns.map((c) => [idOf(c), str(c["style"]), texts(c)]);
}

/** The board's sections: 0 in progress, 1 needs you, 2 done. */
const SECTION_BANDS = ["band-working", "band-needs_you", "band-good"];

/** The words of the board's section `n`: its band, then each of its rows and the "N more" line; a missing section fails. */
export function columnText(board: JsonObject, n: number): string {
  const blocks = body(board);
  const at = blocks.findIndex((b) => idOf(b) === SECTION_BANDS[n]);
  assert.ok(at >= 0, `no section ${String(SECTION_BANDS[n])}`);
  const out = [texts(blocks[at]).join(" ")];
  for (const block of blocks.slice(at + 1)) {
    if (idOf(block).startsWith("band-")) break;
    out.push(texts(block).join(" "));
  }
  return out.join("\n\n");
}

export { idOf };

function* lines(node: unknown, hiddenToo: boolean): Generator<string> {
  if (Array.isArray(node)) {
    for (const item of node) yield* lines(item, hiddenToo);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const n = node as JsonObject;
  if (!hiddenToo && n["isVisible"] === false) return;
  if (n["type"] === "TextBlock" && n["text"] !== BAR) yield str(n["text"]);
  else if (n["type"] === "FactSet") {
    for (const fact of n["facts"] as JsonObject[]) {
      const name = str(fact["title"]).replaceAll("\u2060", "");
      yield `${name}${hasCjk(name) ? "：" : ": "}${str(fact["value"])}`;
    }
  }
  for (const key of ["items", "columns"] as const) yield* lines(n[key] ?? [], hiddenToo);
}

/** The card's text in reading order (test_approval_card `visible`): facts as "name: value", hidden elements left out. */
export function visible(card: JsonObject): string[] {
  return [...lines(card["body"], false)];
}

/** The same with what is hidden (test_approval_card `texts`). */
export function allLines(card: JsonObject): string[] {
  return [...lines(card["body"], true)];
}
