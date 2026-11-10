// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How Claw's answer to a held write reads to the reviewer (the card that replaces the click) and to the group, in that
 * order. A status that is not the kind's own (`merged` for a merge, `submitted` for a review) is a refusal and says why when
 * Claw did; a merge put in the base branch's merge queue is queued, never merged; and a try that already wrote to GitHub is
 * never said not to have happened.
 */

import type { PublicErrors } from "../public-error/public-errors.js";
import { own } from "../own.js";
import { cpHead, squashSpaces } from "../text/py-text.js";
import { oneLine, plainText } from "../review-text/names.js";

/** What one confirmation flow says for what Claw holds: only these sentences differ between a merge and a review. */
export interface HeldWords {
  /** Of the note card that replaces a click. */
  readonly title: string;
  /** What is acted on. */
  readonly thing: string;
  /** What did not happen when it was refused. */
  readonly verb: string;
  /** The status Claw answers when it did. */
  readonly done: string;
  readonly review: boolean;
}

/** The held write a confirmation row records. */
export interface HeldRow {
  readonly repo: string;
  readonly pr: number;
  readonly kind: string;
  readonly event: string;
}

export function heldWords(row: HeldRow): HeldWords {
  const pull = `${row.repo}#${String(row.pr)}`;
  if (row.kind === "review") {
    return {
      title: "Review needs confirmation",
      thing: `the ${row.event} review on ${pull}`,
      verb: "posted",
      done: "submitted",
      review: true,
    };
  }
  return { title: "Merge needs confirmation", thing: pull, verb: "merged", done: "merged", review: false };
}

export type Lines = readonly [card: string, group: string];

const QUEUE_STATE = /^[A-Z][A-Z_]{0,31}$/u;
const ENQUEUE_PREFIX = "GitHub refused to put the pull request in the merge queue: ";
const WROTE_TRAILER = " A review, an approval or a merge was already sent to GitHub in this try";

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** A merge Claw put in the merge queue: queued, and not merged (the queue merges it, or takes it out, later). */
export function queuedLines(pull: string, name: string, outcome: Readonly<Record<string, unknown>>): Lines {
  const { queue_position: position, queue_state: state } = outcome;
  const en: string[] = [];
  const zh: string[] = [];
  if (isInt(position) && position > 0) {
    en.push(`position ${String(position)}`);
    zh.push(`第 ${String(position)} 位`);
  }
  if (typeof state === "string" && QUEUE_STATE.test(state)) {
    en.push(`state ${state}`);
    zh.push(`状态 ${state}`);
  }
  const enPlace = en.length ? ` (${en.join(", ")})` : "";
  const zhPlace = zh.length ? `（${zh.join("，")}）` : "";
  return [
    `Queued ${pull} for merge${enPlace}. It is not merged yet: the merge queue runs its own checks and merges it or takes it out.`,
    `${name} 已确认，${pull} 已加入合并队列${zhPlace}，尚未合入：队列会自行运行检查，通过后合入，否则将其移出。`,
  ];
}

function enqueueRefused(pull: string, outcome: Readonly<Record<string, unknown>>, errors: PublicErrors): Lines {
  const message = plainText(outcome.message);
  let why = "";
  if (message.startsWith(ENQUEUE_PREFIX)) {
    why = oneLine(message.slice(ENQUEUE_PREFIX.length).split(WROTE_TRAILER)[0] ?? "", 160).replace(/[ .]+$/u, "");
  }
  why = errors.publicReason(why, "github_enqueue_refused", { pr: pull }); // GitHub's words as Claw passed them on
  // (the approval is written before the queue is asked, so a refusal here follows one)
  const approved = outcome.wrote === true;
  return [
    `GitHub refused to put ${pull} in the merge queue${why ? ` (${why})` : ""}, so it was not queued or merged${approved ? "; the approval may already be on the pull request." : "."}`,
    `GitHub 拒绝把 ${pull} 加入合并队列${why ? `（${why}）` : ""}，没有排队也没有合入${approved ? "；批准可能已经留在 PR 上。" : "。"}`,
  ];
}

/** The lines for a reason Claw's gates name when an allowed write was refused anyway; undefined keeps the generic line. */
export function refusalLines(
  reason: string,
  pull: string,
  name: string,
  review: boolean,
  outcome: Readonly<Record<string, unknown>>,
  errors: PublicErrors,
): Lines | undefined {
  const [enUndone, zhUndone] = review ? ["nothing was posted", "没有发布"] : ["nothing was merged", "没有合入"];
  const [enAct, zhAct] = review ? ["approved", "批准"] : ["approved or merged", "批准或合入"];
  switch (reason) {
    case "cannot_approve_own_pull_request":
      return [
        `${pull} was written by your own GitHub account, so it cannot be ${enAct} with it (it would be no second person's review): ${enUndone}. Ask another committer.`,
        `${pull} 是 ${name} 自己的账号提交的，不能用同一个账号${zhAct}，${zhUndone}；请另外指定一位 committer。`,
      ];
    case "acting_login_unknown":
      return [
        `The identity service does not know the GitHub login of your account, so I cannot check that you did not write ${pull}: ${enUndone}. Send \`/github unbind\`, then \`/github bind\` again, or tell the operator.`,
        `身份服务里没有 ${name} 的 GitHub 用户名，无法确认 TA 不是 ${pull} 的作者，${zhUndone}；请 TA 在 1:1 聊天里先 \`/github unbind\` 再 \`/github bind\`，或联系管理员。`,
      ];
    case "delegation_off":
      return [
        `Auto-merge is off for your GitHub account, so nothing was done with it on ${pull}: ${enUndone}. Send \`/github auto-merge on\` in a 1:1 chat with me, then ask again.`,
        `${name} 已关闭自动合入，没有用 TA 的账号对 ${pull} 做任何事，${zhUndone}；请 TA 在 1:1 聊天里发 \`/github auto-merge on\` 后再发起。`,
      ];
    case "review_target_mismatch":
      return [
        `This review is bound to another pull request than ${pull}, so nothing was done on ${pull}. Ask for a new review of it.`,
        `这次 review 绑定的不是 ${pull}，没有对 ${pull} 做任何事；请重新发起。`,
      ];
    case "enqueue_refused":
      return enqueueRefused(pull, outcome, errors);
    case "enqueue_unconfirmed":
      return [
        `GitHub did not confirm that ${pull} is in the merge queue, so it is not known to be queued or merged. Look at the pull request before asking again.`,
        `GitHub 没有确认 ${pull} 已进入合并队列，是否排队、是否合入都不确定；请先看 PR 再决定。`,
      ];
    default:
      return undefined;
  }
}

function reviewLines(row: HeldRow, words: HeldWords, status: string, reason: string, name: string): Lines {
  const pull = `${row.repo}#${String(row.pr)}`;
  const thing = words.thing;
  const zh = `${pull} 的 ${row.event} review`;
  switch (status) {
    case "submitted":
      return [`Posted ${thing}.`, `${name} 已确认，${zh} 已发布。`];
    case "denied":
      return [`Not posted: ${thing} was dropped.`, `${name} 选择不发布 ${zh}。`];
    case "stale":
      return [
        `${pull} changed after the review, so nothing was posted. Ask for a new review.`,
        `${pull} 在 review 之后又有新提交，没有发布；需要的话请重新发起。`,
      ];
    case "expired":
      return [`This confirmation ran out, so ${thing} was not posted.`, `${zh} 的确认已过期，没有发布。`];
    default:
      return [
        `${thing.slice(0, 1).toUpperCase()}${thing.slice(1)} was not posted${reason ? `: ${reason}` : "."}`,
        `${zh} 没有发布${reason ? `：${reason}` : "。"}`,
      ];
  }
}

function mergeLines(pull: string, status: string, reason: string, sha: string, name: string): Lines {
  switch (status) {
    case "merged":
      return [
        `Merged ${pull}${sha ? ` (${sha}).` : "."}`,
        `${name} 已确认，${pull} 已合入${sha ? `（${sha}）。` : "。"}`,
      ];
    case "denied":
      return [`Not merged: ${pull} stays open.`, `${name} 选择不合入 ${pull}。`];
    case "stale":
      return [
        `${pull} changed after the review, so nothing was merged. Ask for a new review.`,
        `${pull} 在 review 之后又有新提交，没有合入；需要的话请重新发起。`,
      ];
    case "expired":
      return [`This confirmation ran out, so ${pull} was not merged.`, `${pull} 的确认已过期，没有合入。`];
    default:
      return [
        `${pull} was not merged${reason ? `: ${reason}` : "."}`,
        `${pull} 没有合入${reason ? `：${reason}` : "。"}`,
      ];
  }
}

/** How Claw's answer to a decision reads: [the reviewer's card, the group]. */
export function outcomeLines(
  row: HeldRow,
  words: HeldWords,
  outcome: Readonly<Record<string, unknown>>,
  name: string,
  errors: PublicErrors,
): Lines {
  const pull = `${row.repo}#${String(row.pr)}`;
  const status = plainText(outcome.status);
  const reason = cpHead(squashSpaces(plainText(outcome.reason)), 200);
  const sha = cpHead(plainText(outcome.merge_sha), 8);
  if (status === "queued" && !words.review) return queuedLines(pull, name, outcome);
  if (status === "refused") {
    const lines = refusalLines(reason, pull, name, words.review, outcome, errors);
    if (lines !== undefined) return lines;
  }
  // (a reason Claw passed on as it got it may name hosts or paths)
  const shown = errors.publicReason(reason, "github_outcome", { status, pr: pull });
  if (status !== words.done && outcome.wrote === true) {
    // Claw had already sent a write to GitHub in this try: "not merged" would be a claim nobody has checked.
    return [
      `A request was already sent to GitHub for ${pull} in this try, so I cannot say it was not ${words.verb}. Look at the pull request first.`,
      `${pull} 已向 GitHub 发出请求，结果不确定，请先看 PR 再决定。`,
    ];
  }
  return words.review ? reviewLines(row, words, status, shown, name) : mergeLines(pull, status, shown, sha, name);
}

/** "3 passed, 1 failed, 2 pending" of a confirmation's checks ('' when Claw gave none). */
export function checksText(checks: unknown): string {
  if (typeof checks !== "object" || checks === null) return "";
  const counts = checks as Readonly<Record<string, unknown>>;
  return ["passed", "failed", "pending"]
    .filter((k) => isInt(own(counts, k)))
    .map((k) => `${String(own(counts, k))} ${k}`)
    .join(", ");
}
