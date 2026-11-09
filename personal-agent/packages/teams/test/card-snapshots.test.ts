// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Snapshots of every kind of card the personal agent sends (`test-support/card-catalog`), and the card kit's rules checked on each.
 * A card's JSON must equal `test-support/data/card_snapshots/<id>.json` byte for byte (the Python worker's snapshots).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { pyJsonDumps, remoteView } from "@primusclaw/personal-agent";
import { Ajv } from "ajv";

import { CJK } from "../src/cards/cjk.js";
import { isObject, walk, type JsonObject } from "../src/cards/json.js";
import {
  ADAPTIVE_CARD,
  BUTTONS_MAX,
  CARD_VERSION,
  emojiBudget,
  emojiIn,
  execute,
  facts,
  ICONS,
  message,
  text,
} from "../src/cards/kit.js";
import { CATALOG, PENDING } from "../../../test-support/card-catalog/index.js";

const DATA = new URL("../../../test-support/data/", import.meta.url);
const SNAPSHOTS = new URL("card_snapshots/", DATA);
const schema = JSON.parse(readFileSync(new URL("adaptive-card-1.5.schema.json", DATA), "utf8")) as JsonObject;
// (draft-06: Ajv validates it with the draft-07 vocabulary, which is a superset for every keyword this schema uses)
const validate = new Ajv({ strict: false, allErrors: false }).compile({
  ...omit(schema, "$schema", "id"),
  $id: s(schema["id"]),
});

/** The cards whose buttons are someone else's whole set of choices, each of which must stay one tap away. */
const FOUR_BUTTONS = new Set(["remote_permission", "remote_status", "remote_window", "remote_window_en"]);
const HALF_NEXT_TO_CJK = new RegExp(`${CJK}[,:;?!]|[,;?!]${CJK}`);
/** Besides the kit's own: the thumbs, a remote agent's kind icons, and the robot. */
const EXTRA_EMOJI = ["\u{1f44d}", "\u{1f44e}", "\u{1f916}"];
let allowedEmoji = new Set<string>([...Object.values(ICONS), ...EXTRA_EMOJI, ...remoteView.KIND_ICONS]);

/** Lines that port cards with their own emoji (a remote agent's kind icons) add them here. */
export function allowEmoji(...emoji: string[]): void {
  allowedEmoji = new Set([...allowedEmoji, ...emoji]);
}

/** A JSON value as the text it shows (Python's `str(node.get(key, ""))`: an absent value is ""). */
function s(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** What Python's `json.dumps(value, ensure_ascii=False, indent=1, sort_keys=True)` writes, with the file's final newline. */
function pythonJson(value: unknown): string {
  return pyJsonDumps(value, { indent: 1, sortKeys: true }) + "\n";
}

function omit(object: JsonObject, ...keys: string[]): JsonObject {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

function content(activity: JsonObject): JsonObject {
  assert.equal(activity["type"], "message");
  const attachments = activity["attachments"];
  assert.ok(Array.isArray(attachments) && attachments.length === 1);
  const attachment = attachments[0];
  assert.ok(isObject(attachment) && attachment["contentType"] === ADAPTIVE_CARD);
  const card = attachment["content"];
  assert.ok(isObject(card));
  return card;
}

function* words(card: JsonObject): Generator<readonly ["text" | "fact" | "button", string]> {
  for (const node of walk(card)) {
    const type = s(node["type"]);
    if (type === "TextBlock") yield ["text", s(node["text"])];
    else if (type === "FactSet") {
      for (const fact of node["facts"] as JsonObject[]) yield ["fact", s(fact["title"]) + s(fact["value"])];
    } else if (type.startsWith("Action.") && "title" in node) yield ["button", s(node["title"])];
  }
}

test("the words of a card skip nodes without a type (a button's data) and read texts, facts and buttons", () => {
  const built = message(
    [text("✅ done"), ...facts([["作者", "林"]])],
    [execute("🔍 Review", "primusclaw.review", { pr: { number: 7, repo: "o/r" } })],
  );
  assert.deepEqual(
    [...words(content(built))],
    [
      ["text", "✅ done"],
      ["fact", "作\u2060者林"],
      ["button", "🔍 Review"],
    ],
  );
});

test("the catalog names each card once", () => {
  const ids = CATALOG.map((e) => e.id);
  assert.equal(ids.length, new Set(ids).size);
});

test("no snapshot is left without a card", () => {
  const files = readdirSync(SNAPSHOTS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
  const ids = new Set(CATALOG.map((e) => e.id));
  assert.deepEqual(files.filter((id) => !ids.has(id) && !PENDING.has(id)).sort(), []);
  assert.deepEqual(
    [...ids].filter((id) => !files.includes(id)),
    [],
  );
  assert.deepEqual(
    [...PENDING].filter((id) => ids.has(id)),
    [],
    "an entry that is ported is no longer pending",
  );
});

test("every snapshot file is written as Python writes it (indent 1, sorted keys), so a formatter cannot rewrite one unseen", () => {
  const files = readdirSync(SNAPSHOTS).filter((f) => f.endsWith(".json"));
  assert.ok(files.length >= 50);
  for (const file of files) {
    const written = readFileSync(new URL(file, SNAPSHOTS), "utf8");
    assert.equal(pythonJson(JSON.parse(written)), written, file);
  }
});

for (const entry of CATALOG) {
  test(`card matches its snapshot: ${entry.id}`, () => {
    const expected = readFileSync(new URL(`${entry.id}.json`, SNAPSHOTS), "utf8");
    assert.equal(pythonJson(entry.build()), expected, `${entry.id} changed`);
  });

  test(`card keeps the kit rules: ${entry.id}`, () => {
    const card = content(entry.build());
    const checked = omit(card, "msteams"); // (msteams: Teams' own extension)
    assert.ok(validate(checked), JSON.stringify(validate.errors));
    assert.equal(card["version"], CARD_VERSION);
    const actions = (card["actions"] ?? []) as JsonObject[];
    assert.ok(actions.length <= (FOUR_BUTTONS.has(entry.id) ? 4 : BUTTONS_MAX), "at most three buttons");
    const styled = actions.filter((a) => a["style"] === "positive" || a["style"] === "destructive");
    assert.ok(styled.length <= 1 && (styled.length === 0 || styled[0] === actions[0]), "one primary button, first");
    for (const node of walk(card)) {
      if (node["type"] === "TextBlock") {
        assert.ok(node["wrap"] === true || node["text"] === "┃", "every text wraps on a phone");
        if (node["text"] !== "┃")
          assert.ok(node["color"] !== "Good" && node["color"] !== "Warning", "no yellow or green");
        assert.ok(!HALF_NEXT_TO_CJK.test(s(node["text"]).replace(/`[^`]*`/g, "")), s(node["text"]));
      }
      if (node["type"] === "FactSet") {
        for (const fact of node["facts"] as JsonObject[]) {
          assert.ok(!HALF_NEXT_TO_CJK.test(s(fact["title"]) + s(fact["value"])));
        }
      }
    }
  });

  test(`card uses emoji as the kit says: ${entry.id}`, () => {
    const card = content(entry.build());
    const found: string[] = [];
    for (const [where, line] of words(card)) {
      const emoji = emojiIn(line);
      found.push(...emoji);
      assert.ok(emoji.length <= 1, `${where}: ${line}`);
      for (const e of emoji) assert.ok(allowedEmoji.has(e), `${where}: ${line}`);
      const first = emoji[0];
      if (first !== undefined && where !== "fact") {
        assert.ok(line.replace(/^\d+\.\s*/, "").startsWith(first), `an emoji leads its line: ${line}`);
      }
    }
    assert.ok(found.length <= emojiBudget(card), found.join(" "));
    const body = card["body"] as JsonObject[];
    const top = body[0] ?? {};
    const columns = (top["columns"] ?? []) as JsonObject[];
    const head = (top["items"] ?? columns[columns.length - 1]?.["items"] ?? []) as JsonObject[];
    const title = head[0];
    if (title && title["type"] === "TextBlock" && title["size"] === "Medium" && title["weight"] === "Bolder") {
      const lead = emojiIn(s(title["text"]))[0];
      assert.ok(lead !== undefined && s(title["text"]).startsWith(lead), s(title["text"]));
    }
  });
}
