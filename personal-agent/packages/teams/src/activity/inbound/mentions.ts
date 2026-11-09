// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether an activity is for the bot, and the person's words: the bot's @mention, a targeted (private) message, a
 * message that starts by naming the bot, the text without the mention markup, and the other people it @mentions (the
 * Python worker's `is_mentioned`, `is_targeted`, `addressed_to_bot`, `message_text`, and the mention half of
 * `marked_text`).
 */
import type { InboundMention } from "@primusclaw/personal-agent";
import { cpLength, pyLstrip, pyStr, pyStrip } from "@primusclaw/personal-agent";
import { AT_TAG, written } from "./markup.js";
import { caseless, NOT_WORD_NEXT, SPACE } from "./patterns.js";
import { botIdOf, entitiesOf, isFields, partOf, truthy, type Activity, type Fields } from "./schema.js";

/** The bot's display name where the caller gives none (the Python worker's `branding.BOT_NAME`). */
export const DEFAULT_BOT_NAME = "Clawy";

function isMention(entity: Fields): boolean {
  return entity["type"] === "mention";
}

/** Whether `entity` is a mention of the bot (`botId` its id here; never when the id is unknown). */
export function mentionsBot(entity: Fields, botId: string): boolean {
  const mentioned = entity["mentioned"];
  return isMention(entity) && Boolean(botId) && isFields(mentioned) && mentioned["id"] === botId;
}

/** True when the bot itself is @mentioned (a mention of another person does not count). */
export function isMentioned(activity: Activity): boolean {
  const botId = botIdOf(activity);
  return entitiesOf(activity).some((entity) => mentionsBot(entity, botId));
}

/**
 * True for a targeted (private) message: in a group chat the person picked the bot under / and only the bot sees what
 * they wrote. Teams marks it on the recipient.
 */
export function isTargeted(activity: Activity): boolean {
  const recipient = partOf(activity, "recipient");
  return recipient["isTargeted"] === true || recipient["is_targeted"] === true;
}

const toBot = new Map<string, RegExp>();

/**
 * "@<name> ..." typed as words, or the bot's own mention (`<at>name</at>`) put first, after any paragraph tags and
 * spaces of a text that is HTML. Python's `\s*@?\s*` is written `\s*(?:@\s*)?` (the same words, in linear time).
 */
function toBotPattern(botName: string): RegExp {
  let pattern = toBot.get(botName);
  if (pattern === undefined) {
    const name = caseless(botName);
    const lead = `(?:${SPACE}|&${caseless("nbsp")};|<(?:${["p", "div", "span"].map(caseless).join("|")})${NOT_WORD_NEXT}[^>]*>)*`;
    const at = `<${caseless("at")}>${SPACE}*(?:@${SPACE}*)?${name}${SPACE}*</${caseless("at")}>`;
    pattern = new RegExp(`^${lead}(?:${at}|@${SPACE}*${name})(?![\\p{L}\\p{N}_-])`, "u");
    toBot.set(botName, pattern);
  }
  return pattern;
}

/**
 * True when the message starts by naming the bot ("@Clawy ..."): in a 1:1 chat attached to a remote session, the way
 * the person says these words are for the bot and not for the session.
 */
export function addressedToBot(activity: Activity, botName: string = DEFAULT_BOT_NAME): boolean {
  return toBotPattern(botName).test(written(activity));
}

/**
 * The person's text without the bot's @mention markup and without what Teams adds for a quote: the words the commands
 * are read from. With no recipient id every mention is removed (the 1:1 behaviour); in a group chat a mention of
 * another person stays, minus its `<at>` tags, because it is part of what the person wrote.
 */
export function messageText(activity: Activity): string {
  let text = written(activity);
  const botId = botIdOf(activity);
  for (const entity of entitiesOf(activity)) {
    if (isMention(entity) && (!botId || mentionsBot(entity, botId) || !truthy(entity["mentioned"]))) {
      text = text.replaceAll(pyStr(entity["text"]), "");
    }
  }
  return pyStrip(text.replace(AT_TAG, ""));
}

/** Private-use characters that stand for a mention while the text is worked out (a text holding them is read the slow way). */
const HOLD_OPEN = String.fromCharCode(0xe000);
const HOLD_CLOSE = String.fromCharCode(0xe001);
const HELD = new RegExp(`${HOLD_OPEN}([0-9]+)${HOLD_CLOSE}`, "g");

interface Other {
  readonly entity: Fields;
  readonly mentioned: Fields;
  /** The mention as it stands in `messageText`: its markup without the `<at>` tags. */
  readonly shown: string;
}

/**
 * `written(activity)` with each other person's mention held by a placeholder (where Python's `marked_text` put its
 * marker: the first place the mention's markup stands), the bot's own removed, then everything else `messageText`
 * does.
 */
function holdMentions(activity: Activity, botId: string): { held: string; others: Other[] } {
  let text = written(activity);
  const others: Other[] = [];
  for (const entity of entitiesOf(activity).filter(isMention)) {
    const raw = pyStr(entity["text"]);
    const mentioned = entity["mentioned"];
    if (!raw || !text.includes(raw)) continue;
    if (mentionsBot(entity, botId)) {
      text = text.replaceAll(raw, "");
    } else if (isFields(mentioned) && truthy(mentioned)) {
      const at = text.indexOf(raw);
      text = `${text.slice(0, at)}${HOLD_OPEN}${String(others.length)}${HOLD_CLOSE}${text.slice(at + raw.length)}`;
      others.push({ entity, mentioned, shown: raw.replace(AT_TAG, "") });
    }
  }
  for (const entity of entitiesOf(activity).filter(isMention)) {
    if (!truthy(entity["mentioned"])) text = text.replaceAll(pyStr(entity["text"]), "");
  }
  return { held: text.replace(AT_TAG, ""), others };
}

/** The held text with each placeholder put back as the mention's words, and where each starts (code points). */
function release(held: string, others: readonly Other[]): { text: string; offsets: Map<number, number> } {
  const offsets = new Map<number, number>();
  let text = "";
  let resume = 0;
  for (const match of held.matchAll(HELD)) {
    text += held.slice(resume, match.index);
    const index = Number(match[1]);
    offsets.set(index, cpLength(text));
    text += others[index]?.shown ?? "";
    resume = match.index + match[0].length;
  }
  text += held.slice(resume);
  const lead = cpLength(text) - cpLength(pyLstrip(text));
  for (const [index, offset] of offsets) offsets.set(index, offset - lead);
  return { text: pyStrip(text), offsets };
}

function inbound(other: Other, offset: number): InboundMention {
  return {
    channelUserId: pyStr(other.mentioned["id"]),
    userId: pyStr(other.mentioned["aadObjectId"]),
    name: pyStr(other.mentioned["name"]),
    shown: other.shown,
    offset,
  };
}

/**
 * The people the message @mentions, the bot excluded, in the order of its entities: those whose mention stands in
 * what the person wrote (not in a quote). `shown` is the mention as it stands in `messageText` (its `<at>` tags
 * removed) and `offset` where (in code points), so core's `markedText` replaces the mention and not the same name
 * typed elsewhere. With no recipient id there are none: `messageText` then removes every mention.
 */
export function mentionsOf(activity: Activity): InboundMention[] {
  const botId = botIdOf(activity);
  if (!botId) return [];
  const words = messageText(activity);
  const { held, others } = holdMentions(activity, botId);
  const { text, offsets } = release(held, others);
  const exact = text === words && !written(activity).includes(HOLD_OPEN);
  const found: InboundMention[] = [];
  others.forEach((other, index) => {
    // Markup this reading cannot follow (a mention inside another, a placeholder character typed): where the words first stand.
    const offset = exact ? (offsets.get(index) ?? -1) : cpIndexOf(words, other.shown);
    if (offset >= 0 && other.shown) found.push(inbound(other, offset));
  });
  return found;
}

/** The code point index of the first `part` in `text`, -1 when it is not there. */
function cpIndexOf(text: string, part: string): number {
  const at = text.indexOf(part);
  return at < 0 ? -1 : cpLength(text.slice(0, at));
}
