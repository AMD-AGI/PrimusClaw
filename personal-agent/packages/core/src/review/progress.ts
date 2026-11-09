// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the asker of a review someone else runs hears of it: only its asker view (state, link, conclusion, merged, what a
 * waiting one waits for, what it found), as one line for one review, or one message for a request's several. And what the
 * reviewer hears when the reviews asked of them end. `viewStage` is the key that changes exactly when there is news.
 */

import type { AskerView } from "../claw/model.js";
import { pullUrl, shortName } from "../review-text/pull-ref.js";
import { oneLine } from "../review-text/names.js";
import { askerName, type ReviewTurn, reviewerName, viewFinished, viewWaitsForReviewer } from "./review-turn.js";
import { type Redact, prSummaryLine, withSummaryLine } from "./summary.js";

const VERDICT_ZH: Readonly<Record<string, string>> = {
  approve: "批准",
  approved: "批准",
  request_changes: "要求修改",
  changes_requested: "要求修改",
  comment: "评论",
  commented: "评论",
};
const STATUS_ZH: Readonly<Record<string, string>> = { stopped: "已停止", failed: "没有完成", done: "已完成" };
export const ITEM_STOPPED_ZH = "已停止";

const verdictZh = (verdict: string): string => (Object.hasOwn(VERDICT_ZH, verdict) ? (VERDICT_ZH[verdict] ?? "") : "");

/** One review someone else runs while its asker follows it. */
export interface Followed {
  readonly review: ReviewTurn;
  /** What the asker was told of it last (`viewStage`). */
  said: string;
  /** Its reviewer was told it waits for them. */
  reviewerTold: boolean;
  /** Followed again after a restart: this worker has no card of it to close. */
  readonly resumed: boolean;
  /** Claw said it waits for a slot: only then is its start news. */
  seenQueued: boolean;
}

export function followedItemId(entry: Followed): string {
  return entry.review.item?.itemId ?? "";
}

/** The words of how a view stands: its conclusion and whether it merged, or how it ended. */
export function viewWords(view: AskerView): string {
  const verdict = verdictZh(view.verdict);
  const merged = view.merged ? "，已合入" : "，没有合入";
  if (view.status === "done" || (viewFinished(view) && verdict))
    return (verdict ? `结论：${verdict}` : "已完成") + merged;
  const status = Object.hasOwn(STATUS_ZH, view.status) ? STATUS_ZH[view.status] : undefined;
  return (status ?? `已结束（${oneLine(view.status, 30)}）`) + merged;
}

function viewLink(review: ReviewTurn, view: AskerView): string {
  return view.prUrl.startsWith("https://github.com/") ? view.prUrl : pullUrl(review.pull);
}

/** What the asker of a review someone else ran hears of it, once. */
export function requesterResultText(review: ReviewTurn, view: AskerView, mask: Redact): string {
  return withSummaryLine(
    `${shortName(review.pull)}（${reviewerName(review)} 代审）：${viewWords(view)}\n${viewLink(review, view)}`,
    prSummaryLine(view.prSummary, mask),
  );
}

/** How a review item ended, as its card in the asker's chat shows it once its Stop is gone. */
export function itemEndText(view: AskerView): string {
  const words = viewWords(view);
  return view.status === "stopped" ? words : `已结束：${words}`;
}

/** How a review of one's own ended, as its card shows it: from what its turn left on GitHub. */
export function ownItemEndText(review: ReviewTurn): string {
  const events = review.wrote.filter((w) => w[2]).map((w) => w[2]);
  const statuses = new Set(review.wrote.map((w) => w[1]));
  const last = events.at(-1);
  const verdict = last === undefined ? "" : verdictZh(last.toLowerCase());
  if (!verdict && !statuses.has("merged") && !statuses.has("queued")) return "已结束，结果见回答";
  const merge = statuses.has("merged") ? "，已合入" : statuses.has("queued") ? "，已加入合并队列" : "，没有合入";
  return `已结束：${verdict ? `结论：${verdict}` : "已完成"}${merge}`;
}

/** What the reviewer hears when a review asked of them ends. */
export function reviewerResultText(review: ReviewTurn, view: AskerView, mask: Redact): string {
  const line = prSummaryLine(view.prSummary, mask);
  return `${askerName(review)}请你代审的 ${shortName(review.pull)}：${viewWords(view)}。${line ? `\n${line}\n` : ""}详情在你的看板上（/board）。`;
}

/** What the asker has been told of a review, as a key that changes exactly when there is news ('' nothing yet). */
export function viewStage(view: AskerView): string {
  if (view.status === "queued") return "queued";
  if (viewFinished(view)) return `end:${view.status}:${view.verdict}:${view.merged ? "1" : "0"}`;
  if (view.waitingFor === "failed") return "failed";
  if (viewWaitsForReviewer(view)) return `wait:${view.verdict}:${view.waitingFor}`;
  return view.verdict ? `verdict:${view.verdict}` : "";
}

/** `viewStage` for one followed review, with one more piece of news: a review that waited for a slot has 'started'. */
export function entryStage(entry: Followed, view: AskerView): string {
  const stage = viewStage(view);
  return !stage && entry.said === "queued" && entry.seenQueued ? "started" : stage;
}

/** The conclusion a `viewStage` key holds ('' none). */
export function stageVerdict(stage: string): string {
  const parts = stage.split(":");
  if (parts[0] === "end") return parts[2] ?? "";
  return (parts[0] === "wait" || parts[0] === "verdict") && parts.length > 1 ? (parts[1] ?? "") : "";
}

function foundWords(view: AskerView): string {
  if (view.findings === null) return "";
  if (view.findings === 0) return view.verdict ? "；没有提出待改的问题" : "";
  const note = view.note ? oneLine(view.note, 120) : "";
  return `；${String(view.findings)} 个待处理的问题${note ? `，如：${note}` : ""}`;
}

/** How a review someone else runs stands, as its asker is told. `started`: it waited for a slot, and has just started. */
export function progressWords(review: ReviewTurn, view: AskerView, started = false): string {
  if (view.status === "queued") return "排队中，名额空出后会自动开始";
  const waits = viewWaitsForReviewer(view);
  if (started && !view.verdict && !waits && !viewFinished(view)) return "排队结束，已开始 review";
  if (viewFinished(view)) return viewWords(view) + foundWords(view);
  if (view.waitingFor === "failed") {
    return `这次代审没有完成（失败），没有合入。要重试，在这里说「重新 review ${shortName(review.pull)}」`;
  }
  return settledWords(review, view);
}

/** A review that runs, or waits for its reviewer: its conclusion so far and what it waits for. */
function settledWords(review: ReviewTurn, view: AskerView): string {
  const who = reviewerName(review);
  const verdict = verdictZh(view.verdict);
  const said = verdict ? `结论：${verdict}` : "还没有结论";
  if (!viewWaitsForReviewer(view)) return said + foundWords(view);
  if (view.waitingFor === "confirm_review") return `${said}，提交前在等 ${who} 确认`;
  // (a Claw that does not say what it waits for: an approved review whose merge was held waits for the merge)
  const heldMerge =
    view.waitingFor === "confirm_merge" ||
    (!view.waitingFor && view.verdict === "approve" && review.mergeHeld && !review.reviewOnly);
  return heldMerge
    ? `${said}${foundWords(view)}，合入在等 ${who} 确认`
    : `${said}${foundWords(view)}，在等 ${who} 处理`;
}

/**
 * One message for what is news of a request's reviews asked of someone else: one line for a request of one review; for
 * several, a count of how many have a conclusion and how many ended, then the news, then what the others are doing.
 */
export function progressText(
  entries: readonly Followed[],
  told: readonly (readonly [Followed, AskerView])[],
  mask: Redact,
): string {
  const [first] = told;
  if (entries.length === 1 && first !== undefined) {
    const [entry, view] = first;
    return withSummaryLine(
      `${shortName(entry.review.pull)}（${reviewerName(entry.review)} 代审）：${progressWords(entry.review, view, entry.said === "started")}\n${viewLink(entry.review, view)}`,
      prSummaryLine(view.prSummary, mask),
    );
  }
  const who = entries[0] ? reviewerName(entries[0].review) : "对方";
  const stages = entries.map((e) => e.said);
  const concluded = stages.filter((st) => stageVerdict(st)).length;
  const ended = stages.filter((st) => st.startsWith("end:")).length;
  const lines = [
    `${who} 代审进度（${String(entries.length)} 个 PR：${String(concluded)} 个有结论，${String(ended)} 个已结束）：`,
  ];
  for (const [entry, view] of told) {
    const line = prSummaryLine(view.prSummary, mask);
    lines.push(
      `- ${shortName(entry.review.pull)}：${progressWords(entry.review, view, entry.said === "started")}  ${viewLink(entry.review, view)}` +
        (line ? `\n  ${line}` : ""),
    );
  }
  const reviewing = entries.filter((e) => e.said === "" || e.said === "started").map((e) => shortName(e.review.pull));
  if (reviewing.length) lines.push(`还在 review：${reviewing.join("、")}`);
  const waiting = entries.filter((e) => e.said === "queued").map((e) => shortName(e.review.pull));
  if (waiting.length) lines.push(`还在排队（会自动开始）：${waiting.join("、")}`);
  return lines.join("\n");
}

/** The asker's last line when the reviews they follow are still open at the deadline. */
export function unfinishedText(left: readonly Followed[]): string {
  const [first] = left;
  if (first === undefined) return "";
  const who = reviewerName(first.review);
  if (left.length === 1) {
    return `${shortName(first.review.pull)}：${who} 的代审还没有结束，结果请看 PR：${pullUrl(first.review.pull)}`;
  }
  return `${who} 的代审还有 ${String(left.length)} 个没有结束，结果请看 PR：\n${left.map((e) => `- ${pullUrl(e.review.pull)}`).join("\n")}`;
}

/** What the reviewer hears when reviews asked of them end. */
export function reviewerEndedText(ended: readonly (readonly [Followed, AskerView])[], mask: Redact): string {
  const [first] = ended;
  if (first === undefined) return "";
  if (ended.length === 1) return reviewerResultText(first[0].review, first[1], mask);
  const lines = ended.map(([e, v]) => {
    const line = prSummaryLine(v.prSummary, mask);
    return `- ${shortName(e.review.pull)}：${viewWords(v)}${line ? `\n  ${line}` : ""}`;
  });
  return `${askerName(first[0].review)}请你代审的 ${String(ended.length)} 个 PR 结束了：\n${lines.join("\n")}\n详情在你的看板上（/board）。`;
}
