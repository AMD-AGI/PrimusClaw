// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What Teams puts into a message's text besides the person's words, found without parsing the HTML: the `<at>` tags of
 * a mention, the `<quoted messageId="..."/>` placeholder of a quote, the Reply blockquote of a quote (in a `text/html`
 * attachment, or in a text that is HTML), and the paragraph tags that come with such a text; and what a web address
 * is. The Python worker matched these with regular expressions (`_AT_TAG`, `_QUOTED_TAG`, `_QUOTED_ID`,
 * `_BLOCKQUOTE_TAG`, `_BLOCK_TAG`, `_WEB_URL`); the tag finders here give the same matches in one forward pass each,
 * where Python's patterns could take quadratic time on markup with many unterminated tags.
 */
import { cpLength, pyStr, pyStrip } from "@primusclaw/personal-agent";
import { caseless, NOT_WORD_NEXT, SPACE, SPACE_CHARS, WORD } from "./patterns.js";
import type { Activity } from "./schema.js";

/** `<at>` / `</at>`: the markup of a mention. */
export const AT_TAG = /<\/?[Aa][Tt]>/g;

const LINK_CHARS = 2000;
const WEB_URL = new RegExp(`^${caseless("http")}${caseless("s")}?://[^${SPACE_CHARS}<>"']+$`, "u");

/** `raw` when it is an http(s) address (nothing else: no other scheme, no spaces, a sane length), else "". */
export function webUrl(raw: unknown): string {
  const url = typeof raw === "string" ? pyStrip(raw) : "";
  return cpLength(url) <= LINK_CHARS && WEB_URL.test(url) ? url : "";
}

/** One tag a finder matched: where it stands, whether it closes, and what stands between its name and its `>`. */
export interface TagMatch {
  readonly start: number;
  readonly end: number;
  readonly closing: boolean;
  readonly attrs: string;
}

/**
 * Every `<name ...>` (and `</name ...>` when `closing`) of `text`, left to right and not overlapping: Python's
 * `re.finditer(r"<(/?)(?:names)\b([^>]*)>", text, re.IGNORECASE)`.
 */
export function findTags(text: string, names: readonly string[], closing: boolean): TagMatch[] {
  const head = new RegExp(`${closing ? "(/?)" : "()"}(?:${names.map(caseless).join("|")})${NOT_WORD_NEXT}`, "uy");
  const found: TagMatch[] = [];
  let gt = -1; // the first `>` at or after the last name end asked about
  let at = text.indexOf("<");
  while (at >= 0) {
    head.lastIndex = at + 1;
    const match = head.exec(text);
    if (match) {
      const nameEnd = head.lastIndex;
      if (gt < nameEnd) gt = text.indexOf(">", nameEnd);
      if (gt < 0) break; // no `>` after here: no later tag can end either
      found.push({ start: at, end: gt + 1, closing: match[1] === "/", attrs: text.slice(nameEnd, gt) });
      at = text.indexOf("<", gt + 1);
    } else {
      at = text.indexOf("<", at + 1);
    }
  }
  return found;
}

/** `text` with each of `tags` (from `findTags`) replaced by `by`. */
export function replaceTags(text: string, tags: readonly TagMatch[], by: string): string {
  let out = "";
  let resume = 0;
  for (const tag of tags) {
    out += text.slice(resume, tag.start) + by;
    resume = tag.end;
  }
  return out + text.slice(resume);
}

/** The itemtype of a Reply blockquote: the older way Teams marks a quote. */
export const REPLY_ITEMTYPE = new RegExp(caseless("schema.skype.com/Reply"), "u");

/**
 * (`markup` without its Reply blockquotes, [the attributes of each, what is inside it]). A blockquote inside a Reply
 * blockquote belongs to it; a blockquote that is not a Reply stays where it is; one never closed runs to the end.
 */
export function cutReplies(markup: string): { kept: string; cut: [attrs: string, inner: string][] } {
  const kept: string[] = [];
  const cut: [string, string][] = [];
  let depth = 0;
  let attrs = "";
  let start = 0;
  let resume = 0;
  for (const tag of findTags(markup, ["blockquote"], true)) {
    if (depth === 0) {
      if (!tag.closing && REPLY_ITEMTYPE.test(tag.attrs)) {
        kept.push(markup.slice(resume, tag.start));
        [depth, attrs, start] = [1, tag.attrs, tag.end];
      }
      continue;
    }
    depth += tag.closing ? -1 : 1;
    if (depth === 0) {
      cut.push([attrs, markup.slice(start, tag.start)]);
      resume = tag.end;
    }
  }
  if (depth) {
    cut.push([attrs, markup.slice(start)]);
    resume = markup.length;
  }
  kept.push(markup.slice(resume));
  return { kept: kept.join(""), cut };
}

/**
 * `text` as the person wrote it: without what Teams puts there for a quote (the `<quoted .../>` placeholder, and the
 * Reply blockquote of a text that is HTML, with the paragraph tags that come with such a text).
 */
export function written(activity: Activity): string {
  let text = pyStr(activity.text);
  if (REPLY_ITEMTYPE.test(text)) {
    const { kept } = cutReplies(text);
    text = replaceTags(kept, findTags(kept, ["p", "div", "br", "span"], true), " ");
  }
  return replaceTags(text, findTags(text, ["quoted"], true), "");
}

const MESSAGE_ID = new RegExp(caseless("messageId"), "gu");
const ID_HEAD = new RegExp(`${SPACE}*=${SPACE}*["']?`, "uy");
const VALUE_STOP = new RegExp(`["'/>${SPACE_CHARS}]`, "u");
const WORD_CHAR = new RegExp(`^${WORD}$`, "u");

interface IdCandidate {
  readonly start: number;
  readonly valueStart: number;
  readonly valueEnd: number;
}

/**
 * The end of the run of id characters at `at` (`[^"'\s/>]*`), for `at`s asked in increasing order: a position inside
 * the run found last ends where it ends, so every character is looked at once over all calls.
 */
function valueEnds(text: string): (at: number) => number {
  let runStart = 0;
  let runEnd = -1;
  return (at) => {
    if (at >= runStart && at < runEnd) return runEnd;
    let end = at;
    while (end < text.length && !VALUE_STOP.test(text[end] ?? "")) end++;
    [runStart, runEnd] = [at, end];
    return end;
  };
}

/** The code point that ends just before `at` (undefined at the start). */
function codePointBefore(text: string, at: number): string | undefined {
  if (at <= 0) return undefined;
  const low = text.charCodeAt(at - 1);
  const pair = low >= 0xdc00 && low <= 0xdfff && at >= 2 ? text.slice(at - 2, at) : text.slice(at - 1, at);
  return Array.from(pair).at(-1);
}

/** Every `\bmessageId\s*=\s*["']?<id>` of `text`, overlapping ones included. */
function idCandidates(text: string): IdCandidate[] {
  const end = valueEnds(text);
  const found: IdCandidate[] = [];
  for (const match of text.matchAll(MESSAGE_ID)) {
    const before = codePointBefore(text, match.index);
    if (before !== undefined && WORD_CHAR.test(before)) continue;
    ID_HEAD.lastIndex = match.index + match[0].length;
    if (!ID_HEAD.test(text)) continue;
    const valueStart = ID_HEAD.lastIndex;
    const valueEnd = end(valueStart);
    if (valueEnd > valueStart) found.push({ start: match.index, valueStart, valueEnd });
  }
  return found;
}

/**
 * The message ids the `<quoted messageId="..."/>` placeholders of `text` name, in order: Python's
 * `re.finditer(r"<quoted\b[^>]*?\bmessageId\s*=\s*[\"']?([^\"'\s/>]+)", text, re.IGNORECASE)`.
 */
export function quotedIds(text: string): string[] {
  const candidates = idCandidates(text);
  const ids: string[] = [];
  let next = 0;
  let resume = 0;
  let gt = -1;
  for (const tag of quotedStarts(text)) {
    if (tag.start < resume) continue;
    if (gt < tag.nameEnd) gt = text.indexOf(">", tag.nameEnd);
    const segmentEnd = gt < 0 ? text.length : gt;
    while (next < candidates.length && (candidates[next]?.start ?? 0) < tag.nameEnd) next++;
    const found = candidates[next];
    if (found === undefined || found.start >= segmentEnd) continue;
    ids.push(text.slice(found.valueStart, found.valueEnd));
    resume = found.valueEnd;
  }
  return ids;
}

const QUOTED_HEAD = new RegExp(`${caseless("quoted")}${NOT_WORD_NEXT}`, "uy");

/** Every `<quoted` of `text` (a `>` after it not needed), with where its name ends. */
function quotedStarts(text: string): { start: number; nameEnd: number }[] {
  const starts: { start: number; nameEnd: number }[] = [];
  for (let at = text.indexOf("<"); at >= 0; at = text.indexOf("<", at + 1)) {
    QUOTED_HEAD.lastIndex = at + 1;
    if (QUOTED_HEAD.test(text)) starts.push({ start: at, nameEnd: QUOTED_HEAD.lastIndex });
  }
  return starts;
}
