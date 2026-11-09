/**
 * Clawy's card kit: the one look every Adaptive Card it sends in Teams has, as the few builders every card is made of.
 *
 * A card reads top down, the same way everywhere (header, body copy, 1-3 primary actions; built for a phone's width first):
 * - `header`: one bold sentence and at most one subtle line under it, beside a short bar in one of Teams' semantic container
 *   styles (no bar when nothing is at stake). The bar is the only coloured mark; every word keeps the theme's default colours.
 * - `facts`: what a person checks before they press a button, as one FactSet of short names and clipped values.
 * - `text` / `note`: body copy and a subtle line under it; always wrapped.
 * - `fold`: what most people never need, behind one "详情 / Details" line that opens in place (never counts as a button).
 * - `buttons`: at most three, the first the primary one, the rest plain.
 * - `ICONS`: one emoji per meaning, the same everywhere; a card carries at most EMOJI_MAX plus one per list row, band and badge.
 * - `badges` / `band` / `row`: a list card's (the board's) look.
 * - `zh`: Chinese text gets full-width punctuation next to Chinese.
 *
 * Every card goes out as `cardActivity(card)`: one Adaptive Card 1.5 attachment. Building a card with anything else (an unknown
 * tone, a fourth button) throws: the snapshot tests keep every card on this kit.
 */
import { clip, unbroken, zh } from "./cjk.js";
import type { CardElement, Json, JsonObject } from "./json.js";
import { walk } from "./json.js";
import { str, strip } from "../text/pystr.js";

export const CARD_VERSION = "1.5";
export const SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
export const ADAPTIVE_CARD = "application/vnd.microsoft.card.adaptive";

/** One emoji per meaning, used for that meaning only (a header, a section, a badge, a list row, at most one in a button). */
export const ICONS = {
  review: "🔍",
  good: "✅",
  needs_you: "⚠️",
  failed: "❌",
  working: "⏳",
  handoff: "🤝",
  board: "📋",
  connect: "🔌",
  feedback: "💬",
  question: "❓",
  denied: "🚫",
  stopped: "⏹️",
  expired: "⌛",
  notice: "🔔",
  settings: "⚙️",
  session: "🗂️",
  repo: "📦",
  changes: "📝",
  file: "📎",
  machine: "🖥️",
  dropped: "🗑️",
} as const;
export type Meaning = keyof typeof ICONS;

export const EMOJI_MAX = 3;
/** The status a header can say; "default" draws Teams' emphasis band. */
export const TONES = ["good", "attention", "warning", "accent", "default"] as const;
export type Tone = (typeof TONES)[number];
export type ButtonStyle = "positive" | "destructive" | "";
export const BUTTONS_MAX = 3;
export const TITLE_MAX = 120;
export const FACT_TITLE_MAX = 40;
export const FACT_VALUE_MAX = 200;
export const BUTTON_TITLE_MAX = 40;

/** The kit was asked for something no card may have (an unknown tone, a fourth button). */
export class CardKitError extends Error {
  override name = "CardKitError";
}

function checkTone(tone: string): asserts tone is Tone {
  if (!(TONES as readonly string[]).includes(tone)) throw new CardKitError(`unknown tone '${tone}'`);
}

export interface TextOptions {
  subtle?: boolean;
  size?: string;
  weight?: string;
  maxLines?: number;
  spacing?: string;
  mono?: boolean;
  /** Further TextBlock properties, added last (an `id`, `horizontalAlignment`, `color` of a fold's label...). */
  extra?: JsonObject;
}

/** One wrapped TextBlock of body copy (Chinese made full-width). Colour is not an option: status belongs in the header. */
export function text(value: string, options: TextOptions = {}): CardElement {
  const block: CardElement = { type: "TextBlock", text: zh(value), wrap: true };
  if (options.subtle) block["isSubtle"] = true;
  if (options.size) block["size"] = options.size;
  if (options.weight) block["weight"] = options.weight;
  if (options.maxLines) block["maxLines"] = options.maxLines;
  if (options.spacing) block["spacing"] = options.spacing;
  if (options.mono) block["fontType"] = "Monospace";
  return { ...block, ...options.extra };
}

/** A subtle small line: when a card runs out, who else can answer, what a button does not do. */
export function note(value: string, extra?: JsonObject): CardElement {
  return text(value, { subtle: true, size: "Small", ...(extra ? { extra } : {}) });
}

/** The status bar: a heavy vertical stroke in the tone's text colour (decoration: the words beside it say the status). */
function bar(tone: Tone, size = "Large"): CardElement {
  const color = tone.charAt(0).toUpperCase() + tone.slice(1);
  return {
    type: "Column",
    width: "auto",
    spacing: "None",
    items: [{ type: "TextBlock", text: "┃", color, size, weight: "Bolder" }],
  };
}

/** `words` after the emoji of `meaning`; '' meaning: the words alone. */
export function icon(meaning: Meaning | "", words: string): string {
  return meaning ? `${ICONS[meaning]} ${words}` : words;
}

export interface HeaderOptions {
  tone?: Tone;
  subtitle?: string;
  titleId?: string;
  emoji?: Meaning | "";
}

function barred(tone: Tone, items: CardElement[], spacing?: string, barSize?: string): CardElement {
  return {
    type: "ColumnSet",
    ...(spacing ? { spacing } : {}),
    columns: [
      bar(tone, barSize),
      { type: "Column", width: "stretch", spacing: "Small", verticalContentAlignment: "Center", items },
    ],
  };
}

/** The header row on top of a card: a short bar in the tone's colour beside one bold sentence and at most one subtle line. */
export function header(title: string, options: HeaderOptions = {}): CardElement {
  const tone = options.tone ?? "default";
  checkTone(tone);
  const items: CardElement[] = [
    text(icon(options.emoji ?? "", clip(title, TITLE_MAX)), {
      weight: "Bolder",
      size: "Medium",
      ...(options.titleId ? { extra: { id: options.titleId } } : {}),
    }),
  ];
  if (options.subtitle) items.push(text(options.subtitle, { subtle: true, size: "Small", spacing: "None" }));
  if (tone === "default") return { type: "Container", items };
  return barred(tone, items);
}

/** The list that holds a header's title and subtitle, to add one more subtle line under them. */
export function headerItems(block: CardElement): CardElement[] {
  if (block.type === "Container") return block["items"] as CardElement[];
  const columns = block["columns"] as CardElement[];
  const last = columns[columns.length - 1];
  if (!last) throw new CardKitError("a header without columns");
  return last["items"] as CardElement[];
}

/** A heading inside a card (a column of the board): the same bar as the header, with one bold line of default size. */
export function section(title: string, tone: Tone = "default"): CardElement {
  checkTone(tone);
  const line = text(clip(title, TITLE_MAX), { weight: "Bolder" });
  if (tone === "default") return { type: "Container", spacing: "Medium", items: [line] };
  return barred(tone, [line], "Medium", "Medium");
}

export interface Badge {
  meaning: Meaning;
  label: string;
  count: number;
  tone: Tone;
}

/** Count badges side by side: a box in the tone's container style with the emoji, the count and its label on one line. */
export function badges(counts: readonly Badge[]): CardElement {
  return {
    type: "ColumnSet",
    spacing: "Small",
    columns: counts.map(({ meaning, label, count, tone }) => ({
      type: "Column",
      id: `badge-${meaning}`,
      width: "stretch",
      style: tone === "default" ? "emphasis" : tone,
      spacing: "Small",
      verticalContentAlignment: "Center",
      items: [text(`${icon(meaning, `**${count}**`)} ${label}`, { size: "Small", extra: { horizontalAlignment: "Center" } })],
    })),
  };
}

/** A section head on a band of the tone's container style: one bold line, with the section's emoji first. */
export function band(title: string, tone: Tone = "default", meaning: Meaning | "" = ""): CardElement {
  checkTone(tone);
  return {
    type: "Container",
    id: `band-${meaning || "plain"}`,
    style: tone === "default" ? "emphasis" : tone,
    spacing: "Large",
    items: [text(icon(meaning, clip(title, TITLE_MAX)), { weight: "Bolder" })],
  };
}

/** One entry of a list on one line: its status emoji, then its words and, after " · ", what matters about it. */
export function row(rowId: string, meaning: Meaning, words: string, detail = ""): CardElement {
  return {
    type: "ColumnSet",
    id: `row-${rowId}`,
    spacing: "Small",
    columns: [
      { type: "Column", width: "auto", items: [text(ICONS[meaning])] },
      {
        type: "Column",
        width: "stretch",
        spacing: "Small",
        items: [text(words + (detail ? ` · ${detail}` : ""), { maxLines: 1 })],
      },
    ],
  };
}

export const EMOJI = /[\u{1f000}-\u{1faff}←-⇿⌀-⏿☀-➿⬀-⯿]️?/gu;

export function emojiIn(value: string): string[] {
  return value.match(EMOJI) ?? [];
}

/** What a card may carry: EMOJI_MAX, and one more for each list row, section band and count badge in it. */
export function emojiBudget(card: JsonObject): number {
  let budget = EMOJI_MAX;
  for (const node of walk(card)) {
    const id = str(node["id"]);
    if (id.startsWith("row-") || id.startsWith("band-") || id.startsWith("badge-")) budget += 1;
  }
  return budget;
}

/** The rows that have a value, as one FactSet (an empty list when none has): short names, clipped values. */
export function facts(rows: ReadonlyArray<readonly [string, unknown]>, limit: number = FACT_VALUE_MAX): CardElement[] {
  const kept = rows
    .filter(([, value]) => strip(str(value)) !== "")
    .map(([name, value]) => ({ title: unbroken(zh(clip(name, FACT_TITLE_MAX))), value: zh(clip(value, limit)) }));
  return kept.length ? [{ type: "FactSet", facts: kept }] : [];
}

/** `items` hidden behind one subtle "label ▾" line that shows them in place. `foldId` must be unique in the card. */
export function fold(foldId: string, items: CardElement[], label = "详情"): CardElement[] {
  if (items.length === 0) return [];
  return [
    {
      type: "Container",
      id: `${foldId}-toggle`,
      spacing: "Small",
      selectAction: { type: "Action.ToggleVisibility", title: label, targetElements: [foldId] },
      items: [text(`${label} ▾`, { size: "Small", extra: { color: "Accent", weight: "Bolder" } })],
    },
    { type: "Container", id: foldId, isVisible: false, spacing: "Small", items },
  ];
}

/** The card's actions: the first is the primary one (`primary`), the others plain. At most BUTTONS_MAX; absent entries left out. */
export function buttons(actions: ReadonlyArray<CardElement | null | undefined>, primary: ButtonStyle = "positive"): CardElement[] {
  const kept = actions.filter((a): a is CardElement => Boolean(a)).map((a) => ({ ...a }));
  if (kept.length > BUTTONS_MAX) throw new CardKitError(`a card has at most ${BUTTONS_MAX} buttons, not ${kept.length}`);
  return kept.map((action, i) => {
    const { style: _dropped, ...plain } = action;
    return i === 0 && primary ? { ...plain, style: primary } : plain;
  });
}

/** An Action.Execute (what Teams desktop and mobile both send back to the worker). */
export function execute(title: string, verb: string, data: JsonObject): CardElement {
  return { type: "Action.Execute", title: zh(clip(title, BUTTON_TITLE_MAX)), verb, data };
}

export function openUrl(title: string, url: string): CardElement {
  return { type: "Action.OpenUrl", title: zh(clip(title, BUTTON_TITLE_MAX)), url };
}

export interface AdaptiveCard extends JsonObject {
  type: "AdaptiveCard";
  version: string;
  $schema: string;
  body: CardElement[];
}

/** The Adaptive Card itself. `buttonsMax` is raised only where the buttons are someone else's choices that must all stay reachable. */
export function card(
  body: CardElement[],
  actions: CardElement[] = [],
  buttonsMax: number = BUTTONS_MAX,
  extra: JsonObject = {},
): AdaptiveCard {
  if (actions.length > buttonsMax) throw new CardKitError(`a card has at most ${buttonsMax} buttons`);
  const out: AdaptiveCard = { type: "AdaptiveCard", version: CARD_VERSION, $schema: SCHEMA, body };
  if (actions.length) out["actions"] = actions;
  return { ...out, ...extra } as AdaptiveCard;
}

export interface CardAttachment extends JsonObject {
  contentType: string;
  content: Json;
}

export interface CardMessage extends JsonObject {
  type: "message";
  attachments: CardAttachment[];
}

/** A message whose one attachment is the card. */
export function cardActivity(content: JsonObject): CardMessage {
  return { type: "message", attachments: [{ contentType: ADAPTIVE_CARD, content }] };
}

/** `cardActivity(card(body, actions))`: what most builders return. */
export function message(
  body: CardElement[],
  actions: CardElement[] = [],
  buttonsMax: number = BUTTONS_MAX,
  extra: JsonObject = {},
): CardMessage {
  return cardActivity(card(body, actions, buttonsMax, extra));
}
