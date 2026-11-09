// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// TEMPORARY: the subset of the card kit (Python `cards.py`) the remote-agent cards use, until W3's kit lands; then these
// imports move to it and this file goes.

export type Block = Record<string, unknown>;

export const CARD_VERSION = "1.5";
export const SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
export const BUTTONS_MAX = 3;
const TITLE_MAX = 120;

/** One emoji per meaning, used for that meaning only. */
export const ICONS = {
  good: "✅",
  needs_you: "⚠️",
  working: "⏳",
  connect: "🔌",
  denied: "🚫",
  settings: "⚙️",
  session: "🗂️",
  machine: "🖥️",
} as const;
export type Meaning = keyof typeof ICONS;

export type Tone = "good" | "attention" | "warning" | "accent" | "default";

const CJK = "[\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef]";
const HALF_TO_FULL: Readonly<Record<string, string>> = { ",": "，", ":": "：", ";": "；", "?": "？", "!": "！" };
const AFTER_CJK = new RegExp(`(?<=${CJK}) ?([,:;?!])(?![A-Za-z0-9_/.]{0,40}://) ?`, "gu");
const BEFORE_CJK = new RegExp(` ?([,;?!]) ?(?=${CJK})`, "gu");
const PARENS = new RegExp(`\\(([^()\\n]*${CJK}[^()\\n]*)\\)`, "gu");
const CODE = /(`[^`]*`|\[[^[\]]*\]\([^()\s]*\)|https?:\/\/\S+)/u;
const HAS_CJK = new RegExp(CJK, "u");

/** `text` with the half-width , : ; ? ! ( ) that sit next to Chinese made full-width; code, links and URLs left as they are. */
export function zh(text: string): string {
  if (!HAS_CJK.test(text)) return text;
  const parts = text.split(CODE);
  for (let i = 0; i < parts.length; i += 2) {
    let part = (parts[i] ?? "").replace(AFTER_CJK, (_, p: string) => HALF_TO_FULL[p] ?? p);
    part = part.replace(BEFORE_CJK, (_, p: string) => HALF_TO_FULL[p] ?? p);
    parts[i] = part.replace(PARENS, (_, inner: string) => `（${inner.trim()}）`);
  }
  return parts.join("");
}

/** `text` on one line, at most `limit` characters, an ellipsis marking a cut. */
export function clip(text: string, limit: number): string {
  const flat = text.split(/\s+/u).filter(Boolean).join(" ");
  const chars = Array.from(flat);
  return chars.length <= limit ? flat : chars.slice(0, limit - 1).join("").trimEnd() + "…";
}

export interface TextOptions {
  readonly subtle?: boolean;
  readonly size?: string;
  readonly weight?: string;
  readonly spacing?: string;
  readonly mono?: boolean;
}

/** One wrapped TextBlock of body copy (Chinese made full-width). */
export function text(value: string, options: TextOptions = {}, extra: Block = {}): Block {
  const block: Block = { type: "TextBlock", text: zh(value), wrap: true };
  if (options.subtle) block["isSubtle"] = true;
  if (options.size) block["size"] = options.size;
  if (options.weight) block["weight"] = options.weight;
  if (options.spacing) block["spacing"] = options.spacing;
  if (options.mono) block["fontType"] = "Monospace";
  return { ...block, ...extra };
}

/** A subtle small line. */
export function note(value: string, extra: Block = {}): Block {
  return text(value, { subtle: true, size: "Small" }, extra);
}

function bar(tone: Tone): Block {
  const color = tone.charAt(0).toUpperCase() + tone.slice(1);
  return {
    type: "Column",
    width: "auto",
    spacing: "None",
    items: [{ type: "TextBlock", text: "┃", color, size: "Large", weight: "Bolder" }],
  };
}

/** The header row on top of a card: a short bar in the tone's colour beside one bold sentence (no bar for `default`). */
export function header(title: string, tone: Tone = "default", emoji: Meaning | "" = ""): Block {
  const words = clip(title, TITLE_MAX);
  const items = [text(emoji ? `${ICONS[emoji]} ${words}` : words, { weight: "Bolder", size: "Medium" })];
  if (tone === "default") return { type: "Container", items };
  return {
    type: "ColumnSet",
    columns: [
      bar(tone),
      { type: "Column", width: "stretch", spacing: "Small", verticalContentAlignment: "Center", items },
    ],
  };
}

/** The list that holds a header's title, to add one more subtle line under it. */
export function headerItems(block: Block): Block[] {
  if (block["type"] === "Container") return block["items"] as Block[];
  const columns = block["columns"] as Block[];
  return columns[columns.length - 1]?.["items"] as Block[];
}

/** The card's actions: the first is the primary one (`primary`), the others plain. */
export function buttons(actions: readonly Block[], primary = "positive"): Block[] {
  if (actions.length > BUTTONS_MAX) throw new Error(`a card has at most ${String(BUTTONS_MAX)} buttons`);
  return actions.map((action, i) => {
    const { style: _style, ...rest } = action;
    return i === 0 && primary ? { ...rest, style: primary } : rest;
  });
}

/** A message whose one attachment is the Adaptive Card of `body` and `actions`. */
export function message(body: readonly Block[], actions: readonly Block[] = [], buttonsMax = BUTTONS_MAX): Block {
  if (actions.length > buttonsMax) throw new Error(`a card has at most ${String(buttonsMax)} buttons`);
  const card: Block = { type: "AdaptiveCard", version: CARD_VERSION, $schema: SCHEMA, body };
  if (actions.length > 0) card["actions"] = actions;
  return { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] };
}
