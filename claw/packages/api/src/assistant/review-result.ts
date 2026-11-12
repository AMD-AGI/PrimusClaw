// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the owner of their own review (one their assistant started, `review_start`) is told when it ends without an approval, in their
 * language: why it did not approve (the blocking findings, with where they are, or the checks that were not green, by name, or what else the
 * review tools refused), and what happens next. An approval needs no word from here: it goes on to the merge's confirmation card.
 *
 * 2026-11-11 (#195, Primus-SaFE#873): the review found nothing to block it, the review tools refused its approval because one check was red
 * (codecov/patch), it posted a comment-only review instead, and the item closed as done. The owner had been told "the merge waits for your
 * confirmation" when it started, and then nothing: no card, no word, only a "Run completed" notice with no verdict. A review whose only
 * obstacle is CI now waits for CI on its head to turn green and is run once more (`ciWaitOf`, `followReviewItems` in `review-items.ts`); the
 * owner is told that it waits, and told again if the wait ends without it.
 *
 * A review someone asked of another person is not told here: the chat that started it follows its turn and tells the one who asked
 * (`personal-agent`'s review service), and the item belongs to the reviewer. Started after the sync's commit (`syncReviewItem`), not waited
 * for. Each notice is told once: its key is the item, the kind, the head, the turn and why a wait ended.
 *
 * Except a re-review of a head already reviewed that posted nothing (`unchanged_wait`, `unchanged`; 2026-11-11, N25): no chat tells anyone of
 * a review that posted nothing, and the reviewer was asked to look at it as if it were stuck. Whoever asked for it is told, the owner of
 * their own review or the person who asked someone else for it, within what that person may know of it (`requester-view.ts`): the pull
 * request, its head, and that it has no new commits since that head was reviewed; then that it waits for CI on that head before it is run
 * once more, or why it does not.
 */
import pino from "pino";
import { CLAW_ASSISTANT_ENABLED, CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { db, type Querier } from "../infra/db.js";
import { personWritesChinese, recordSystemNotice } from "./outbound.js";
import type { CiWaitEnd, ReviewResult } from "./review-items.js";

const logger = pino({ name: "assistant-review-result" });

/** The facts a notice is written from, all read off the database. */
export interface ResultFacts {
  /** `owner/repo#number`, and its URL. */
  pr: string;
  url: string;
  /** The item's number, which `再审 #N` / `review again #N` names. */
  seq: number;
  /** The last review posted: its head, event and GitHub id (null when unknown). */
  headSha: string;
  event: string;
  reviewId: number | null;
  /** The open inline findings of the review (path, line and its first words). */
  findings: Array<{ path: string; line: number; note: string }>;
  /** The checks the last `ci_not_green` refusal of this head named, or null when CI did not stop the approval. */
  ci: { failed: string[]; pending: string[] } | null;
  /** Another refusal of the approval on this head: `threads_unresolved`, `cannot_approve_own_pull_request`, or null. */
  refused: string | null;
  /** A review only (no merge asked for). */
  reviewOnly: boolean;
  /** How many turns the review has had: the second is the one run when CI turned green. */
  turns: number;
  /** Why the wait for CI ended, or null. */
  ended: CiWaitEnd | null;
}

const MAX_FINDINGS_SHOWN = 5;
const WAIT_HOURS = 24;

function names(xs: string[]): string {
  return xs.map((x) => `\`${x}\``).join(", ");
}

function ciLine(ci: { failed: string[]; pending: string[] }, sha: string, zh: boolean): string {
  const parts: string[] = [];
  if (ci.failed.length) parts.push(zh ? `没通过：${names(ci.failed)}` : `failed: ${names(ci.failed)}`);
  if (ci.pending.length) parts.push(zh ? `还在跑：${names(ci.pending)}` : `not finished: ${names(ci.pending)}`);
  const which = parts.length ? (zh ? `（${parts.join("；")}）` : ` (${parts.join("; ")})`) : "";
  return zh ? `head \`${sha}\` 上 CI 没全绿${which}` : `CI is not green on head \`${sha}\`${which}`;
}

const ENDED_ZH: Record<Exclude<CiWaitEnd, "threads_open">, string> & Partial<Record<CiWaitEnd, string>> = {
  head_moved: "PR 有了新提交，原来那个 head 的 CI 不再等了",
  timeout: `等了 ${WAIT_HOURS} 小时 CI 还没全绿，不再等了`,
  not_queued: "没能自动再审（这次评审的会话已经不能再排队）",
};
const ENDED_EN: Record<Exclude<CiWaitEnd, "threads_open">, string> & Partial<Record<CiWaitEnd, string>> = {
  head_moved: "the pull request got new commits, so I stopped waiting for CI on the old head",
  timeout: `CI was still not green after ${WAIT_HOURS} hours, so I stopped waiting`,
  not_queued: "the review could not be run again by itself (its session could not take another turn)",
};

/** The notice, by language. `kind` is what the sync decided (`ReviewState.result`). */
export function resultText(kind: ReviewResult, f: ResultFacts, zh: boolean): string {
  const sha = f.headSha.slice(0, 7);
  const reviewLink = f.reviewId ? `${f.url}#pullrequestreview-${f.reviewId}` : f.url;
  const again = zh ? `\`再审 #${f.seq}\`` : `\`review again #${f.seq}\``;
  const link = zh ? `- 评审：${reviewLink}` : `- The review: ${reviewLink}`;
  if (kind === "ci_wait") {
    const after = f.reviewOnly ? (zh ? "审过就批准" : "approve it if it passes") : (zh ? "审过就发合入确认卡片" : "send you the merge confirmation card if it passes");
    return zh
      ? [
        `**${f.pr} 审完了，还没批准：在等 CI**`, "",
        `- 代码里没发现阻塞问题；没批准是因为 ${ciLine(f.ci ?? { failed: [], pending: [] }, sha, true)}。`,
        `- 接下来：我盯着这个 PR，这个 head 的 CI 全绿后自动再审一次（只再审一次，最多等 ${WAIT_HOURS} 小时），${after}。`,
        `- 不想等，或者 PR 有了新提交：回复 ${again}。`,
        link,
      ].join("\n")
      : [
        `**${f.pr} is reviewed, not approved yet: waiting for CI**`, "",
        `- The review found nothing blocking; it did not approve because ${ciLine(f.ci ?? { failed: [], pending: [] }, sha, false)}.`,
        `- Next: I am watching the pull request. Once CI on this head is all green I review it once more (once, for up to ${WAIT_HOURS} hours) and ${after}.`,
        `- To not wait, or after new commits: reply ${again}.`,
        link,
      ].join("\n");
  }
  if (f.findings.length > 0) {
    const shown = f.findings.slice(0, MAX_FINDINGS_SHOWN).map((x) => `- \`${x.path}:${x.line}\` ${x.note}`);
    const more = f.findings.length > MAX_FINDINGS_SHOWN ? [zh ? `- 还有 ${f.findings.length - MAX_FINDINGS_SHOWN} 个，见评审。` : `- ${f.findings.length - MAX_FINDINGS_SHOWN} more in the review.`] : [];
    return zh
      ? [`**${f.pr} 审完了，没批准：有 ${f.findings.length} 个阻塞问题**`, "", ...shown, ...more, `- 接下来：作者改完推送后，回复 ${again} 再审一遍。`, link].join("\n")
      : [`**${f.pr} is reviewed and not approved: ${f.findings.length} blocking finding(s)**`, "", ...shown, ...more, `- Next: once the author pushes a fix, reply ${again}.`, link].join("\n");
  }
  if (f.ended === "threads_open") {
    return zh
      ? [`**${f.pr} 审完了，没批准：PR 上还有没解决的评审讨论**`, "", "- 代码里没发现阻塞问题；CI 已经全绿，但还有没解决的评审讨论，所以没有自动再审。", `- 接下来：讨论都解决后回复 ${again}。`, link].join("\n")
      : [`**${f.pr} is reviewed and not approved: review threads are still open**`, "", "- The review found nothing blocking; CI is green now, but review threads are still open, so it was not run again.", `- Next: once every thread is resolved, reply ${again}.`, link].join("\n");
  }
  if (f.ci) {
    const why = f.ended ? (zh ? ENDED_ZH[f.ended] : ENDED_EN[f.ended])
      : f.turns > 1 ? (zh ? "已经在 CI 转绿后自动再审过一次，这次 CI 还是没全绿" : "it was already run again once after CI turned green, and CI is still not green")
        : null;
    return zh
      ? [
        `**${f.pr} 审完了，没批准：CI 没全绿**`, "",
        `- 代码里没发现阻塞问题；${ciLine(f.ci, sha, true)}。`,
        ...(why ? [`- ${why}。`] : []),
        `- 接下来：CI 全绿以后回复 ${again}。`,
        link,
      ].join("\n")
      : [
        `**${f.pr} is reviewed and not approved: CI is not green**`, "",
        `- The review found nothing blocking; ${ciLine(f.ci, sha, false)}.`,
        ...(why ? [`- ${why.charAt(0).toUpperCase()}${why.slice(1)}.`] : []),
        `- Next: once CI is all green, reply ${again}.`,
        link,
      ].join("\n");
  }
  if (f.refused === "cannot_approve_own_pull_request") {
    return zh
      ? [`**${f.pr} 审完了，没批准：这个 PR 是你自己写的**`, "", "- GitHub 不允许自己批准自己的 PR，评审只留了评论。", "- 接下来：请别人审批。", link].join("\n")
      : [`**${f.pr} is reviewed and not approved: you wrote it**`, "", "- GitHub does not let you approve your own pull request, so the review only commented.", "- Next: ask someone else to approve it.", link].join("\n");
  }
  if (f.refused === "threads_unresolved") {
    return zh
      ? [`**${f.pr} 审完了，没批准：PR 上还有没解决的评审讨论**`, "", "- 代码里没发现新的阻塞问题。", `- 接下来：讨论都解决后回复 ${again}。`, link].join("\n")
      : [`**${f.pr} is reviewed and not approved: review threads are still open**`, "", "- The review found nothing new that blocks it.", `- Next: once every thread is resolved, reply ${again}.`, link].join("\n");
  }
  const verdict = f.event === "REQUEST_CHANGES" ? (zh ? "要求修改" : "changes requested") : (zh ? "只留了评论" : "a comment only");
  return zh
    ? [`**${f.pr} 审完了，没批准**`, "", `- 结论：${verdict}，原因写在评审里。`, `- 接下来：要再审一遍就回复 ${again}。`, link].join("\n")
    : [`**${f.pr} is reviewed and not approved**`, "", `- Verdict: ${verdict}; the review says why.`, `- Next: to review it again, reply ${again}.`, link].join("\n");
}

/** The facts of a re-review of a head already reviewed that posted nothing (`unchanged_wait`, `unchanged`). */
export interface UnchangedFacts {
  pr: string;
  url: string;
  seq: number;
  headSha: string;
  reviewOnly: boolean;
  turns: number;
  ended: CiWaitEnd | null;
  /** Told to the person who asked someone else for the review, not to its owner. */
  forRequester: boolean;
}

/** What whoever asked for a re-review that had nothing new to post is told, by language. */
export function unchangedText(kind: "unchanged_wait" | "unchanged", f: UnchangedFacts, zh: boolean): string {
  const sha = f.headSha.slice(0, 7);
  const title = zh
    ? `**${f.forRequester ? "你请人评审的 " : ""}${f.pr} 这次没有发新评审：代码和上次审过的一样**`
    : `**No new review of ${f.pr}${f.forRequester ? ", which you asked for" : ""}: the code is what was already reviewed**`;
  const same = zh
    ? `- head \`${sha}\` 已经审过，之后没有新提交，所以没有重复发评审。`
    : `- Head \`${sha}\` was already reviewed and has no new commits since, so no second review was posted.`;
  const again = f.forRequester
    ? (zh ? "再请一次评审" : "ask for a review again")
    : (zh ? `回复 \`再审 #${f.seq}\`` : `reply \`review again #${f.seq}\``);
  const link = zh ? `- PR：${f.url}` : `- The pull request: ${f.url}`;
  if (kind === "unchanged_wait") {
    const after = f.reviewOnly ? (zh ? "审过就批准" : "approve it if it passes") : (zh ? "审过就批准并继续合入" : "approve it and go on to the merge if it passes");
    return zh
      ? [title, "", same, `- 接下来：我盯着这个 PR，这个 head 的 CI 全绿后自动再审一次（只再审一次，最多等 ${WAIT_HOURS} 小时），${after}。`, `- PR 有了新提交：${again}。`, link].join("\n")
      : [title, "", same, `- Next: I am watching the pull request. Once CI on this head is all green I review it once more (once, for up to ${WAIT_HOURS} hours) and ${after}.`, `- After new commits: ${again}.`, link].join("\n");
  }
  const why = f.ended === "threads_open"
    ? (zh ? "CI 已经全绿，但 PR 上还有没解决的评审讨论，所以没有自动再审" : "CI is green now, but review threads are still open, so it was not run again")
    : f.ended ? (zh ? ENDED_ZH[f.ended] : ENDED_EN[f.ended])
      : f.turns > 1 ? (zh ? "已经在 CI 转绿后自动再审过一次，还是没有新内容可发" : "it was already run again once after CI turned green, and still had nothing new to post")
        : null;
  const next = f.ended === "threads_open"
    ? (zh ? `- 接下来：讨论都解决后${again}。` : `- Next: once every thread is resolved, ${again}.`)
    : (zh ? `- 接下来：PR 有了新提交后${again}。` : `- Next: once the pull request has new commits, ${again}.`);
  return [title, "", same, ...(why ? [zh ? `- ${why}。` : `- ${why.charAt(0).toUpperCase()}${why.slice(1)}.`] : []), next, link].join("\n");
}

/** The checks a `ci_not_green` refusal named on its audit row (`ciEvidence` in the review service): failed and not finished. */
export function ciNamesOf(riskReasons: unknown): { failed: string[]; pending: string[] } {
  const lines = Array.isArray(riskReasons) ? riskReasons.filter((x): x is string => typeof x === "string") : [];
  const after = (prefix: string): string[] => lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length).trim()).filter(Boolean);
  return { failed: after("ci_failed:"), pending: after("ci_pending:") };
}

/** The ports a test stands in for: what reaches the owner. */
export const reviewResultPorts = { recordSystemNotice };

const inflight = new Set<Promise<boolean>>();

/** Start `tellReviewResult` without waiting for it: the sync it follows is committed. */
export function tellReviewResultLater(itemId: string, kind: ReviewResult): void {
  const p = tellReviewResult(itemId, kind);
  inflight.add(p);
  void p.finally(() => inflight.delete(p));
}

/** Resolves when every notice started so far has finished (tests). */
export async function reviewResultsSettled(): Promise<void> {
  await Promise.all([...inflight]);
}

/** Tell the owner of their own review how it ended (see the header). True when told now. Never throws. */
export async function tellReviewResult(itemId: string, kind: ReviewResult): Promise<boolean> {
  const skipped = (reason: string, extra: Record<string, unknown> = {}): false => {
    logger.info({ itemId, kind, reason, ...extra }, "assistant.review_result_skipped");
    return false;
  };
  if (!CLAW_ASSISTANT_ENABLED || !CLAW_GITHUB_REVIEW_ENABLED) return skipped("disabled");
  try {
    const q: Querier = (t, p) => db.query(t, p);
    const item = (await q(
      "SELECT item_id, user_id, seq, params, worker_session_id, kind FROM claw_work_items WHERE item_id = $1", [itemId],
    )).rows[0] as { item_id: string; user_id: string; seq: number; params: Record<string, unknown> | null; worker_session_id: string; kind: string } | undefined;
    if (!item || item.kind !== "review" || !item.params) return skipped("no_review_item");
    const requester = typeof item.params.requested_by === "string" && item.params.requested_by ? item.params.requested_by : null;
    if (requester && kind !== "unchanged_wait" && kind !== "unchanged") return skipped("asked_by_someone_else");
    const pr = item.params.pr as { owner?: unknown; repo?: unknown; number?: unknown } | undefined;
    if (!pr || typeof pr.owner !== "string" || typeof pr.repo !== "string" || typeof pr.number !== "number") return skipped("no_pr");
    if (kind === "unchanged_wait" || kind === "unchanged") {
      if (requester === item.user_id) return skipped("requested_by_is_owner");
      const to = requester ?? item.user_id;
      const read = (await q(
        `SELECT head_sha FROM claw_github_audit WHERE session_id = $1 AND tool = 'gh_pr_get' AND result = 'ok' AND head_sha <> ''
          ORDER BY at DESC, id DESC LIMIT 1`,
        [item.worker_session_id],
      )).rows[0] as { head_sha: string } | undefined;
      if (!read) return skipped("no_head_read");
      const turns = Number((await q(
        "SELECT COUNT(*)::int AS n FROM claw_tasks WHERE session_id = $1 AND origin = 'chat'", [item.worker_session_id],
      )).rows[0]?.n ?? 0);
      const ended = (item.params.ci_wait_ended as { reason?: unknown } | undefined)?.reason;
      const facts: UnchangedFacts = {
        pr: `${pr.owner}/${pr.repo}#${pr.number}`, url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, seq: Number(item.seq),
        headSha: String(read.head_sha).toLowerCase(), reviewOnly: String(item.params.review_only ?? "true") !== "false", turns,
        ended: ended === "head_moved" || ended === "timeout" || ended === "not_queued" || ended === "threads_open" ? ended : null,
        forRequester: requester !== null,
      };
      const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [to])).rows[0]?.session_id as string | undefined;
      if (!sessionId) return skipped(requester ? "requester_has_no_assistant" : "owner_has_no_assistant");
      const told = await reviewResultPorts.recordSystemNotice({
        userId: to, sessionId, text: unchangedText(kind, facts, await personWritesChinese(q, to)),
        key: `review_result:${item.item_id}:${kind}:${facts.headSha}:${turns}:${facts.ended ?? "-"}`,
      });
      if (told === null) return skipped("already_told");
      logger.info({ itemId, kind, pr: facts.pr, head: facts.headSha, toRequester: requester !== null }, "assistant.review_result_told");
      return true;
    }
    const last = (await q(
      `SELECT head_sha, COALESCE(posted->>'event', arguments->>'event', '') AS event, posted FROM claw_github_audit
        WHERE session_id = $1 AND tool = 'gh_review_submit' AND result = 'ok' AND detail IN ('submitted', 'already_submitted')
          AND posted IS NOT NULL ORDER BY at DESC, id DESC LIMIT 1`,
      [item.worker_session_id],
    )).rows[0] as { head_sha: string; event: string; posted: { review_id?: unknown } | null } | undefined;
    if (!last) return skipped("nothing_posted");
    if (last.event === "APPROVE") return skipped("approved");
    const head = String(last.head_sha).toLowerCase();
    const refusals = (await q(
      `SELECT detail, risk_reasons FROM claw_github_audit WHERE session_id = $1 AND tool = 'gh_review_submit' AND result = 'refused'
          AND lower(head_sha) = $2 ORDER BY at DESC, id DESC`,
      [item.worker_session_id, head],
    )).rows as Array<{ detail: string; risk_reasons: unknown }>;
    // The latest refusal of the head says what held the review last: a CI refusal from before CI turned green says nothing of a thread
    // the run after it was refused for.
    const latest = refusals.find((r) => ["ci_not_green", "threads_unresolved", "cannot_approve_own_pull_request"].includes(r.detail));
    const ciRow = latest?.detail === "ci_not_green" ? latest : undefined;
    const other = latest && latest.detail !== "ci_not_green" ? latest : undefined;
    const turns = Number((await q(
      "SELECT COUNT(*)::int AS n FROM claw_tasks WHERE session_id = $1 AND origin = 'chat'", [item.worker_session_id],
    )).rows[0]?.n ?? 0);
    const record = item.params.record as { findings?: unknown } | null | undefined;
    const findings = (Array.isArray(record?.findings) ? record!.findings as Array<Record<string, unknown>> : [])
      .filter((x) => x && x.resolved !== true && typeof x.path === "string")
      .map((x) => ({ path: String(x.path), line: Number(x.line) || 0, note: String(x.note ?? "").replace(/\s+/g, " ").slice(0, 160) }));
    const ended = (item.params.ci_wait_ended as { reason?: unknown } | undefined)?.reason;
    const facts: ResultFacts = {
      pr: `${pr.owner}/${pr.repo}#${pr.number}`, url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`, seq: Number(item.seq),
      headSha: head, event: String(last.event), reviewId: typeof last.posted?.review_id === "number" ? last.posted.review_id : null,
      findings, ci: ciRow ? ciNamesOf(ciRow.risk_reasons) : null, refused: other ? other.detail : null,
      reviewOnly: String(item.params.review_only ?? "true") !== "false", turns,
      ended: ended === "head_moved" || ended === "timeout" || ended === "not_queued" || ended === "threads_open" ? ended : null,
    };
    const sessionId = (await q("SELECT session_id FROM claw_assistants WHERE user_id = $1", [item.user_id])).rows[0]?.session_id as string | undefined;
    if (!sessionId) return skipped("owner_has_no_assistant");
    const zh = await personWritesChinese(q, item.user_id);
    const told = await reviewResultPorts.recordSystemNotice({
      userId: item.user_id, sessionId, text: resultText(kind, facts, zh),
      key: `review_result:${item.item_id}:${kind}:${head || "-"}:${turns}:${facts.ended ?? "-"}`,
    });
    if (told === null) return skipped("already_told");
    logger.info({ itemId, kind, pr: facts.pr, head }, "assistant.review_result_told");
    return true;
  } catch (err) {
    logger.warn({ err, itemId, kind }, "assistant.review_result_not_told");
    return false;
  }
}
