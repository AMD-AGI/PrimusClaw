// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the asker is told when Claw starts none, or only some, of a request's reviews, and the acknowledgement's notes of
 * what Claw made: each item's number, which wait for a slot and why, how the merges will be made, and the model Claw chose.
 * Everything here is from Claw's answer, never from what a model said.
 */

import type { ReviewsRefused } from "../claw/errors.js";
import type { PublicErrors } from "../public-error/public-errors.js";
import { cpHead } from "../text/py-text.js";
import { oneLine } from "../review-text/names.js";
import { shortName } from "../review-text/pull-ref.js";
import type { PullRef } from "../claw/model.js";
import { type ReviewTurn, selfReview } from "./review-turn.js";
import { modelId } from "./receipt.js";

/** One request may name this many pull requests; each is reviewed in a session of its own. */
export const MAX_PULLS_PER_REQUEST = 30;
/** ... of which this many start at once; Claw queues the rest and starts each as one of the request's ends. */
export const REVIEWS_STARTED_AT_ONCE = 10;
export const MAX_MODELS_LISTED = 30;
export const ALREADY = "已经在 review 中";

/** Why Claw would not start a review of one pull request (`pr_check_failed`), as the asker is told it. */
export const PR_CHECK_REASONS: Readonly<Record<string, string>> = {
  owner_not_allowed: "不在允许代审的组织里",
  github_not_found: "GitHub 上没有这个仓库或 PR",
  repository_not_public: "不是公开仓库",
  repository_archived: "仓库已归档",
  already_merged: "已经合入了",
  not_open: "PR 已经关闭",
  draft: "PR 还是草稿",
};
/** ... and why it would start none for this reviewer: no pull request of theirs would fare better on its own. */
export const REVIEWER_REASONS: Readonly<Record<string, (who: string) => string>> = {
  delegation_off: (who) => `${who} 还没有授权我代 TA review（需要 TA 在 1:1 里发 \`/github auto-merge on\`）`,
  actor_not_bound: (who) => `${who} 还没有绑定 GitHub`,
  credential_expired: (who) => `${who} 的 GitHub 授权已过期，需要 TA 重新绑定`,
};
/** A refusal of one pull request of the request. */
export const ONE_PULL: readonly string[] = ["review_in_progress", "review_in_progress_by_other", "pr_check_failed"];

/** The reasons Claw gives for refusing a service's answer for a person, said as such. */
export const SERVICE_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  service_client_not_allowed:
    "PrimusClaw does not take answers from me yet: its operator has to allow this worker's client.",
  interactive_sign_in_required: "PrimusClaw did not take my credential for you as a sign-in; tell the operator.",
  only_the_acting_user_can_decide: "PrimusClaw says this answer is not yours to give.",
};

/** The sentence for a refusal of Claw's: its reason (a word it does not name is the last one) and what was not done. */
export function serviceRefusal(code: string, undone: string): string {
  const reason = Object.hasOwn(SERVICE_REFUSAL_REASONS, code) ? SERVICE_REFUSAL_REASONS[code] : undefined;
  return `${reason ?? SERVICE_REFUSAL_REASONS.only_the_acting_user_can_decide ?? ""} ${undone}`;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function activeItemsText(data: Readonly<Record<string, unknown>>, who: string): string {
  const cap = isInt(data.limit) ? `（${String(data.limit)} 个）` : "";
  if (data.scope === "reviewer") {
    return `${who} 手上别人请 TA 做、还没结束的代审已经到上限${cap}，所以这次一个也没有开始。等 TA 的代审结束一些后再发一次。`;
  }
  if (data.scope === "requester") {
    return `你请 ${who} 做、还没结束的代审已经到上限${cap}，所以这次一个也没有开始。等其中一些结束或停掉一些后再发一次。`;
  }
  return `你进行中的任务已经到上限${cap}，所以没有开始 review。请先停掉或等一些任务结束后再发一次。`;
}

function modelsAllowedText(data: Readonly<Record<string, unknown>>): string {
  const models = Array.isArray(data.models) ? (data.models as unknown[]) : [];
  const names = models.flatMap((m) =>
    typeof m === "object" && m !== null && typeof (m as { name?: unknown }).name === "string"
      ? [(m as { name: string }).name]
      : [],
  );
  const listed = names
    .slice(0, MAX_MODELS_LISTED)
    .map((n) => cpHead(n.replace(/[^A-Za-z0-9._:/-]/gu, ""), 100))
    .join("、");
  return `指定的模型不在 PrimusClaw 允许的模型里，所以没有开始 review。${listed ? `可以用的模型：${listed}。` : ""}`;
}

/** What the asker is told when Claw started none of the reviews. */
export function batchRefusal(err: ReviewsRefused, who: string, count: number, errors: PublicErrors): string {
  const data = err.data;
  const reason = typeof data.reason === "string" ? data.reason : "";
  const reviewer = Object.hasOwn(REVIEWER_REASONS, reason) ? REVIEWER_REASONS[reason] : undefined;
  if (err.error === "pr_check_failed" && reviewer) return `${reviewer(who)}，所以没有开始 review。`;
  switch (err.error) {
    case "rate_limited": {
      const whose = data.scope === "account" ? `${who} 的 GitHub 账号` : "整个平台";
      const left = isInt(data.remaining) ? `只剩 ${String(data.remaining)} 次，` : "";
      return `这一小时${whose}能代审的次数${left}不够这 ${String(count)} 个 PR（PrimusClaw 的代审限流），所以一个也没有开始。请少发几个，或稍后再试。`;
    }
    case "too_many_active_items": // (a Claw that queues answers this only once its queue is full too)
      return activeItemsText(data, who);
    case "pr_check_unavailable":
      return "我暂时没法向 GitHub 确认这些 PR（GitHub 或身份服务暂时不可用），所以一个也没有开始。请稍后再试。";
    case "model_not_allowed":
      return modelsAllowedText(data);
    case "model_unverifiable":
      return "暂时没法向模型网关确认指定的模型能不能用，所以没有开始 review。请稍后再试，或不指定模型。";
    default:
      break;
  }
  if (err.status === 403 && Object.hasOwn(SERVICE_REFUSAL_REASONS, err.error)) {
    return serviceRefusal(err.error, "没有开始 review。");
  }
  // (Claw's sentence may name hosts or paths)
  const why = oneLine(errors.publicReason(err.said || err.error, "review_batch_refused", { status: err.status }), 160);
  return `PrimusClaw 没有接受这次 review 请求（${why}），一个也没有开始。`;
}

/** Why a review waits for a slot, in the words of whoever is told: the asker, or the reviewer. */
export function queueReason(reason: string, reviewer: string, requester = "", toReviewer = false): string {
  if (reason === "too_many_requested_reviews") {
    return toReviewer ? "你手上别人请你做的代审已满" : `${reviewer} 手上别人请 TA 做的代审已满`;
  }
  if (reason === "too_many_from_requester") {
    return toReviewer ? `${requester}请你做的代审已满` : `你请 ${reviewer} 做的代审已满`;
  }
  if (reason === "too_many_in_request") {
    return `同一次请求最多同时进行 ${String(REVIEWS_STARTED_AT_ONCE)} 个，前面的结束一个就按顺序开始下一个`;
  }
  // (the asker's own limit: Claw queues a review asked of someone else only on that person's limits, named above)
  return toReviewer ? "代审名额已满" : "你进行中的任务已满";
}

/** The items Claw made for these reviews, by number, and which wait for a slot and why ('' when Claw made none). */
export function itemsNote(reviews: readonly ReviewTurn[], who: string): string {
  const made = reviews.filter((r) => r.item?.seq);
  const [first] = made;
  if (first === undefined) return "";
  const whose = first.forReviewer ? ` ${who} 看板上的事项` : "事项";
  let note = `\n\n已建${whose}：${made.map((r) => `${shortName(r.pull)} #${String(r.item?.seq ?? 0)}`).join("、")}。`;
  const waiting = made.filter((r) => r.item?.queued);
  if (!waiting.length) return note;
  const reasons = [...new Set(waiting.map((r) => queueReason(r.item?.queued ?? "", who)))].join("；");
  const began = made.filter((r) => !r.item?.queued);
  if (began.length) {
    note +=
      `已开始 ${String(began.length)} 个（${began.map((r) => shortName(r.pull)).join("、")}），排队 ${String(waiting.length)} 个` +
      `（${waiting.map((r) => shortName(r.pull)).join("、")}；${reasons}），排队的会自动开始，不用再发。`;
  } else {
    note += `还没有开始，已排队（${reasons}），名额空出后会自动开始，不用再发。`;
  }
  // (one's own review is followed here only as a turn, which a queued one does not have yet)
  if (!first.forReviewer) note += "排队的这些开始后，结果不会发在这里，请在看板上看（/board）。";
  return note;
}

export function shorts(pulls: readonly PullRef[]): string {
  return pulls.map(shortName).join(", ");
}

export function refusedText(refused: readonly (readonly [PullRef, string])[]): string {
  return refused.map(([pull, why]) => `${shortName(pull)}（${why}）`).join("；");
}

/**
 * What the receipt adds about the model when Claw chose it otherwise than asked: the model it was to run on and cannot (the
 * key that pays cannot use it), or a model the asker named for a review someone else runs on their own settings. '' else.
 */
export function modelChosenNote(review: ReviewTurn, who: string, asked: string): string {
  const item = review.item;
  if (item === undefined || !review.modelReported) return "";
  if (item.fellBackFrom) {
    const whose = selfReview(review) ? "你的" : `${who} 的`;
    return `${whose} key 用不了 ${modelId(item.fellBackFrom)}（没有权限，或还没有在 SaFE 绑定 APIM Key），改用 ${modelId(review.model) || "默认模型"}。`;
  }
  if (item.ignored.includes("model") && asked) {
    return `代 ${who} review 按 TA 自己的模型设置用 ${modelId(review.model) || "默认模型"}（额度由 TA 支付），没有用你指定的 ${modelId(asked)}。`;
  }
  return "";
}

/**
 * What the receipt says of how the merges will be made: only what the reviews started say. Every one waits for the
 * reviewer's confirmation: that, plainly. Otherwise the reviewer's fully automatic setting is said, a held one among the
 * others is named, and a merge Claw makes with the asker's own account is said. '' when there is nothing to say.
 */
export function mergeLine(reviews: readonly ReviewTurn[], who: string, merge: boolean, auto: boolean): string {
  if (!merge || !reviews.length) return "";
  const held = reviews.filter((r) => r.mergeHeld);
  if (held.length === reviews.length) return `合入要等 ${who} 本人确认，TA 确认之前不会合入。`;
  const some = held.length ? `其中 ${held.map((r) => shortName(r.pull)).join("、")} 的合入要等 ${who} 本人确认。` : "";
  const free = reviews.filter((r) => !r.mergeHeld);
  const byAsker = !auto && free.every((r) => r.item?.mergeByRequester === true);
  const asker = byAsker
    ? `合入不用等 ${who} 确认：${who} 批准后，只要 CI 全绿、没有未解决的评论，就会自动合入（${who} 那边被拦下的合入，会用你自己的 GitHub 账号合，前提是 PR 是你提的）。`
    : "";
  const automatic = auto ? `${who} 已设为全自动合入（无需人工确认，只有仓库自己要求确认的才会问 TA）。` : "";
  return automatic + asker + some;
}
