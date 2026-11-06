// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the user must never be shown: the assistant's own wiring. A tool's name, the marker of a worker's report, an item's or a run's
 * id (the user knows an item by its number and title), and an id of the UUID form (a session, a confirmation) unless the user wrote it
 * themselves in the message the turn answers, as they do when they ask about a run by its id.
 *
 * Asked of everything the router's words reach the user by: its `say` (refused, so it rewrites them) and the plain text a turn ended
 * with (`router-turn-end.ts`, which then sends a notice of its own instead).
 */
import { WORK_EVENT_PREFIX } from "./prompts.js";

const INTERNAL_TEXT: ReadonlyArray<{ what: string; re: RegExp }> = [
  { what: "a tool name (mcp__…)", re: /mcp__/i },
  { what: "the [work_event] marker", re: /\[work_event\]/i },
  { what: "an item_id", re: /\bkwi_[0-9a-z]{4,}|\bitem_id\b/i },
  { what: "a run id", re: /\bktsk_[0-9a-z_]{4,}/i },
];
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/** The first piece of internal text in a message, or null. `userWords` is what the user wrote in this turn's message. Pure, for the tests. */
export function internalTextIn(text: string, userWords: string): string | null {
  for (const { what, re } of INTERNAL_TEXT) if (re.test(text)) return what;
  const own = new Set((userWords.match(UUID_RE) ?? []).map((u) => u.toLowerCase()));
  for (const id of text.match(UUID_RE) ?? []) if (!own.has(id.toLowerCase())) return "an internal id";
  return null;
}

/** What the user wrote, of the messages a turn answers: a worker's report (`[work_event]`) is not the user's words. */
export function userWordsOf(prompts: readonly string[]): string {
  return prompts.filter((p) => !p.startsWith(WORK_EVENT_PREFIX)).join("\n");
}

/**
 * Item numbers said without the item: `#6、#8` tells the user nothing they can recognise, and they know an item by its number and
 * title. An `#N` counts only when N is the number of one of the user's own items (`items`), and only where nothing makes it something
 * else's number: a pull request, an issue, a run or a topic (`PR #6`, `owner/repo#6`, `run #6`). It is named when the item's title, or
 * its start, follows it (`#6 修复登录超时`, `#6: Fix CI…`), or the whole title is right before it (`修复登录超时（#6）`), or when it is the
 * item the message is sent with (`exceptItemSeq`), which the user sees with its number and title anyway.
 *
 * Returns the bare items, each once, in the order the text names them; empty when there is none. Pure, for the tests.
 */
export function bareItemNumbers(
  text: string, items: ReadonlyArray<{ seq: number; title: string }>, exceptItemSeq?: number | null,
): Array<{ seq: number; title: string }> {
  const bySeq = new Map(items.map((i) => [Number(i.seq), i]));
  const flat = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’「」『』《》()（）\[\]【】:：,，.。、*_`|\-–—]+/g, "");
  const bare = new Map<number, { seq: number; title: string }>();
  for (const m of text.matchAll(ITEM_NUMBER_RE)) {
    const seq = Number(m[1]);
    const item = bySeq.get(seq);
    if (!item || seq === exceptItemSeq || bare.has(seq)) continue;
    const at = m.index ?? 0;
    if (OTHER_NUMBER_BEFORE_RE.test(text.slice(Math.max(0, at - 24), at))) continue;
    const title = flat(item.title);
    // A title written out names the item; so does its start, for a title the sentence shortens (`#6 修复登录…`).
    const head = title.slice(0, Math.min(title.length, Math.max(TITLE_HEAD_MIN_CHARS, Math.min(TITLE_HEAD_CHARS, Math.ceil(title.length / 2)))));
    if (!head) continue;
    // Right after the number (`#6 修复登录超时`, `#6: Fix CI`), or the whole title right before it (`修复登录超时（#6）`): a word of the
    // title somewhere nearby (`#6 is done, please update me`) does not name it.
    const after = flat(text.slice(at + m[0].length, at + m[0].length + item.title.length + NAMED_WITHIN_CHARS));
    const before = flat(text.slice(Math.max(0, at - item.title.length - NAMED_WITHIN_CHARS), at));
    if (after.startsWith(head) || before.endsWith(title)) continue;
    bare.set(seq, item);
  }
  return [...bare.values()];
}

/** `#6`, `# 6`, `＃6`: not inside a word or a path (`repo#6`, `a/b#6`), and not the start of a longer token (`#6a`). */
const ITEM_NUMBER_RE = /(?<![\w/#＃-])[#＃]\s?(\d{1,9})(?![\w-])/gu;
/** What makes the `#N` after it something other than an item: a pull request, an issue, a run, a job, a topic, a commit. */
const OTHER_NUMBER_BEFORE_RE = /(?:\bPRs?|\bpull(?:\s+request)?s?|\bissues?|\bruns?|\bjobs?|\btopics?|\bcommits?|\btickets?|拉取请求|议题|话题|工单)\s*[:：]?\s*(?:[#＃]\s?\d{1,9}\s*(?:[,，、/]|and|和|及)\s*)*$/iu;
/** How many characters of a title, from its start, say which item is meant: half of it, at least two and at most six. */
const TITLE_HEAD_CHARS = 6;
const TITLE_HEAD_MIN_CHARS = 2;
/** How far from the number the title may be written, beyond the title's own length. */
const NAMED_WITHIN_CHARS = 12;
