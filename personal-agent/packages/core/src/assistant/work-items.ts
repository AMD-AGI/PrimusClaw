// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the assistant says about a work item, in words any channel shows (teams_agent/render.py item_label, card_paragraphs,
 * fits_work_card, work_event_text, retryable, board_line, _board_detail, _board_meaning, _ago, asked_line, _asked_meaning and the
 * translation in asked_section). The cards that carry these words are the channel's; these are its pure helpers.
 */
import type { ReviewAskedOfOther, AskerView, WorkItem } from "../claw/model.js";
import { asText, pickLang } from "../language/detect.js";
import { ASKED_STATE_ZH, ASKED_VERDICT, ASKED_WAITING, assistantCardText } from "../locales/assistant-cards.js";
import type { Lang } from "../locales/lang.js";
import { isoSeconds as pyIsoSeconds } from "../feedback/iso-time.js";
import { isoSeconds } from "../proactive/quiet.js";
import { clip } from "../text/plain.js";
import { cpLength, cpSlice, pyRstrip, pyStrip } from "../text/py-text.js";

/** What the assistant may say at most (Claw refuses a longer one); a card shows all of it. */
export const WORK_TEXT_MAX = 600;
/** Items listed per section of the board; the rest is one "and N older" line. */
export const BOARD_LINES = 8;
/** Items waiting for the person that get a card of their own under the board, at most. */
export const BOARD_CARDS = 5;
/** Retry buttons on the board, beside Accept all within a card's three: tasks that failed or were stopped, newest first. */
export const BOARD_RETRY_MAX = 3;
/**
 * A stopped task offers Retry only this long after it was stopped. Every stop is the person's own (the Stop button, or the
 * assistant asked to), and the board lists what ended in the last seven days: past this, Retry would keep offering, for days, to
 * undo a decision the person made on purpose. A failed task waits on the person (needs_you) and keeps its Retry while it waits.
 */
export const RETRY_STOPPED_SECONDS = 3600;
/** Rows a section of the board shows; the rest of BOARD_LINES opens in place. */
export const BOARD_SHOWN: Readonly<Record<string, number>> = { needs_you: 4, in_progress: 3, done: 3 };
/** The longest title line a card has (the card kit's TITLE_MAX). */
export const LABEL_MAX = 120;
/** The longest detail on a board row (a question asked, a progress report). */
export const DETAIL_MAX = 80;

/** Claw's states of a review asked of someone else that wait for the reviewer; with these, the open ones. */
const ASKER_WAITING = new Set(["needs_you", "waiting", "waiting_for_reviewer"]);
const ASKER_OPEN = new Set(["", "in_progress", "running", "queued", "pending", ...ASKER_WAITING]);

const MARKDOWN = /([\\`*_[\]<])/g;
/** What Python's `str.splitlines` breaks a line at ("\r\n" counts as one). */
const LINE_BREAKS = new Set(["\n", "\r", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"]);

/** `words[key]` when `key` is one of its own keys (never an inherited `constructor`), else undefined. */
function own(words: Readonly<Record<string, string>>, key: string): string | undefined {
  return Object.hasOwn(words, key) ? words[key] : undefined;
}

/** `text` for a card's markdown: its markup characters escaped, so that `__init__.py` is not bold (render._plain). */
export function markdownPlain(text: string): string {
  return text.replace(MARKDOWN, "\\$1");
}

/** `lang` when it is "zh" or "en", else the language of the first of `texts` that says anything (`pickLang`). */
export function cardLang(lang: string | null | undefined, ...texts: unknown[]): Lang {
  return lang === "zh" || lang === "en" ? lang : pickLang(...texts);
}

/** `#seq title`, one line. */
export function itemLabel(item: Pick<WorkItem, "seq" | "title">): string {
  return clip(pyStrip(`#${String(item.seq)} ${item.title}`), LABEL_MAX);
}

/** `text.splitlines()` (with a last empty line, which the callers drop). */
function pyLines(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text.replace(/\r\n/g, "\n")) {
    if (LINE_BREAKS.has(ch)) {
      lines.push(line);
      line = "";
    } else {
      line += ch;
    }
  }
  lines.push(line);
  return lines;
}

/** `text` with every line its own paragraph (a card runs lines that are separated by one newline together). */
export function cardParagraphs(text: string): string {
  return pyLines(text)
    .map((line) => pyStrip(line))
    .filter((line) => line !== "")
    .join("\n\n");
}

/** Whether a work item's card shows all of `text` (as its card lays it out), not clipped. */
export function fitsWorkCard(text: string): boolean {
  return cpLength(cardParagraphs(text)) <= WORK_TEXT_MAX;
}

/** `text` as a work card shows it (`cardParagraphs`), cut to `limit` with an ellipsis. */
export function workCardText(text: string, limit: number = WORK_TEXT_MAX): string {
  const laid = cardParagraphs(text);
  return cpLength(laid) <= limit ? laid : `${pyRstrip(cpSlice(laid, 0, limit - 1))}…`;
}

/** What an assistant event says: its own text, or (a fallback notice carries none) that the item needs the person. */
export function workEventText(item: WorkItem | null, text: unknown): string {
  const said = pyStrip(asText(text));
  if (said || item === null) return said;
  return assistantCardText.in("en").needsYou({ label: itemLabel(item) });
}

/**
 * A task Claw runs again on Retry (`POST /v1/work-items/:id/retry`): its worker reported failed, or it was stopped in the last
 * RETRY_STOPPED_SECONDS before `now` (seconds since the epoch). A stop whose time (`updatedAt`) is not known is not offered.
 */
export function retryable(item: WorkItem, now: number): boolean {
  if (item.kind !== "task") return false;
  if (item.boardState === "needs_you" && item.lastReportKind === "failed") return true;
  const stoppedAt = pyIsoSeconds(item.updatedAt);
  return (
    item.boardState === "done" &&
    item.outcome === "stopped" &&
    stoppedAt !== undefined &&
    now - stoppedAt <= RETRY_STOPPED_SECONDS
  );
}

/** What matters about an item in its section: what it waits for, or the progress its worker last reported; "" for a done one. */
export function boardDetail(item: WorkItem, lang: Lang): string {
  const t = assistantCardText.in(lang);
  if (item.boardState === "done") return "";
  if (item.boardState !== "needs_you") return clip(item.summary, DETAIL_MAX);
  if (item.canAccept) return t.ready({ version: item.resultVersion });
  if (item.pendingQuestion) return t.asks({ question: clip(item.pendingQuestion, DETAIL_MAX) });
  return t.report({ kind: item.lastReportKind ?? "" });
}

/** One item on the board as a line of text: `#2 title`, and what matters about it in its column. */
export function boardLine(item: WorkItem, lang: Lang = "en"): string {
  const detail =
    item.boardState === "done"
      ? assistantCardText.in(lang).outcome({ outcome: item.outcome ?? "" })
      : boardDetail(item, lang);
  return itemLabel(item) + (detail ? ` — ${detail}` : "");
}

/** The status of a row on the board, as the card kit's meanings name it. */
export type RowMeaning =
  "good" | "stopped" | "dropped" | "needs_you" | "question" | "failed" | "review" | "working" | "handoff";

/** The emoji of an item's row: what state it is in, at a glance. */
export function boardMeaning(item: WorkItem): RowMeaning {
  if (item.boardState === "done") {
    return item.outcome === "stopped" || item.outcome === "dropped" ? item.outcome : "good";
  }
  if (item.boardState === "needs_you") {
    if (item.canAccept) return "needs_you";
    if (item.pendingQuestion) return "question";
    return item.lastReportKind === "failed" || item.lastReportKind === "blocked" ? "failed" : "needs_you";
  }
  return item.kind === "review" ? "review" : "working";
}

/** How long ago Claw last changed an item (`updatedAt`, ISO 8601), short: "5 分钟前" / "5 min ago"; "" when not known. */
export function ago(at: string, now: number, lang: Lang): string {
  const then = isoSeconds(at);
  if (then === undefined) return "";
  const t = assistantCardText.in(lang);
  const minutes = Math.max(0, Math.floor(Math.trunc(now - then) / 60));
  if (minutes < 1) return t.justNow;
  if (minutes < 60) return t.minutesAgo({ n: minutes });
  if (minutes < 48 * 60) return t.hoursAgo({ n: Math.floor(minutes / 60) });
  return t.daysAgo({ n: Math.floor(minutes / 1440) });
}

/** The review is over (Claw no longer lists it as open). */
export function askerFinished(view: AskerView): boolean {
  return !ASKER_OPEN.has(view.status);
}

/** The review waits for its reviewer (a confirmation, a retry, their start). */
export function askerWaits(view: AskerView): boolean {
  return ASKER_WAITING.has(view.status);
}

/** A pull request's address as Claw writes it, read only when the whole value is one (as the review's own lines read it). */
const PULL_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,6})$/;

/** owner/repo#N of the review's pull request, or its item id: a value that is not exactly an address could carry a link. */
function pullOf(asked: ReviewAskedOfOther): string {
  const found = PULL_URL.exec(asked.view.prUrl);
  return found === null ? asked.itemId : `${found[1] ?? ""}/${found[2] ?? ""}#${found[3] ?? ""}`;
}

function askedState(view: AskerView, who: string): string {
  const verdict = own(ASKED_VERDICT, view.verdict) ?? "";
  if (askerFinished(view)) {
    return (view.status === "stopped" ? "stopped" : verdict || "done") + (view.merged ? ", merged" : ", not merged");
  }
  if (askerWaits(view)) {
    const waits = (own(ASKED_WAITING, view.waitingFor) ?? "waits for {who}").replace("{who}", () => who);
    return verdict && view.waitingFor !== "failed" ? `${verdict}, ${waits}` : waits;
  }
  return verdict || "being reviewed";
}

/** One review asked of someone else: the pull request, who reviews it, and how it stands (the asker's view only), in English. */
export function askedLine(asked: ReviewAskedOfOther): string {
  const who = asked.reviewer || "the reviewer";
  return `${pullOf(asked)} (${who}) - ${askedState(asked.view, who)}`;
}

/** The emoji of an asked review's row. */
export function askedMeaning(asked: ReviewAskedOfOther): RowMeaning {
  const view = asked.view;
  if (askerFinished(view)) {
    return view.merged || (view.verdict === "approve" && view.status !== "stopped") ? "good" : "stopped";
  }
  if (askerWaits(view)) return view.waitingFor === "failed" ? "failed" : "handoff";
  return "review";
}

/** An asked review's line split for a board row: (the pull request and its reviewer, how it stands in `lang`). */
export function askedRow(asked: ReviewAskedOfOther, lang: Lang): readonly [string, string] {
  const line = askedLine(asked);
  const cut = line.lastIndexOf(" - ");
  const pullWho = cut < 0 ? "" : line.slice(0, cut);
  let state = cut < 0 ? line : line.slice(cut + 3);
  if (lang === "zh") {
    state = state
      .split(", ")
      .map((part) => {
        const p = pyStrip(part);
        return own(ASKED_STATE_ZH, p) ?? p;
      })
      .join("，");
    state = state.replace(
      /(merge|the approval) waits for (.+)/g,
      (_m, what: string, who: string) => `${what === "merge" ? "合入" : "批准"}等 ${who} 确认`,
    );
    state = state.replace(/^waits for (.+)/, "等 $1");
  }
  return [pullWho, state];
}
