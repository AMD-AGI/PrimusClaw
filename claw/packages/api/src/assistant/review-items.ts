// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A GitHub review on someone's behalf, as a work item of the requester's assistant.
 *
 * The review itself is what it always was: an ordinary session with `config.acting_as` and `config.review_target`, made by the same
 * check as `POST /v1/sessions` (`checkSessionCreate`) and holding the same review tools and gates. What the item adds is a place on the
 * requester's board, one open review per pull request whoever asked, a stop that also denies what the session holds for someone's answer
 * (`stopWorkItem`), and a state that nobody reports: it is read off what the session did, in the audit and confirmation tables
 * (`reviewState`), when its turn ends, when a held write is answered and on every sweep.
 *
 * A review item's session gets no report tool and no worker prompt (`role-profile.ts`): a model does not say how its review went, the
 * tables do. A finished review is accepted by policy: what a person decided was the merge they allowed (or their own fully automatic
 * setting), and a review that only comments needs no acceptance. Anything else needs them.
 */
import { randomUUID } from "node:crypto";
import pino from "pino";
import { sessionCredentialPatch } from "../auth/session-credentials.js";
import type { UserInfo } from "../auth/models.js";
import { CLAW_ASSISTANT_MAX_ACTIVE_ITEMS, CLAW_ASSISTANT_REVIEW_ITEMS } from "../config.js";
import { checkSessionCreate, type AttendedProof } from "../github-review/acting-session.js";
import { isValidPrRef, type PrRef } from "../github-review/github.js";
import type { ReviewActor, ToolOutcome } from "../github-review/service.js";
import { readGithubReviewSettings } from "../github-review/settings.js";
import { closeConfirmationsForStop, finishConfirmation } from "../github-review/store.js";
import { db, inTransaction, type Querier, type StatementRunner } from "../infra/db.js";
import { insertSessionRow } from "../routes/sessions.js";
import { SWEEPABLE_RUN_STATUSES, stopSessionRuns } from "../tasks/chat-run.js";
import { getOrCreateAssistant } from "./assistant.js";
import { drainSessionIfIdle, queueServerMessage } from "./messages.js";
import { queueRouterWake } from "./reports.js";
import { clipOneLine, getWorkItem, insertWorkItem, itemView, type Outcome, type WorkItemView } from "./work-items.js";

const logger = pino({ name: "assistant-review-items" });

/** Pull requests one request may start reviews of. */
export const MAX_REVIEWS_PER_REQUEST = 10;
const BRIEF_MAX_CHARS = 20_000;
const NAME_MAX_CHARS = 100;
const HOUR_MS = 3_600_000;
const UNIQUE_VIOLATION = "23505";
export const REVIEW_SWEEP_BATCH = 200;

/** What a review item was asked with: `claw_work_items.params` of a `review` item. */
export interface ReviewParams {
  pr: PrRef;
  acting_as: string;
  acting_as_name: string | null;
  model: string | null;
  effort: string | null;
  review_only: boolean;
  /** The first message of the review's session, as it was sent; a restart that changes nothing about it sends it again. */
  brief: string;
}

/** A refusal with the HTTP status and the code the API answers with (the C1 contract). */
export class ReviewItemRefused extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
    this.name = "ReviewItemRefused";
  }
}

/** The pull request check, a port so that a test can answer it without GitHub. Set by the GitHub review routes. */
export const reviewItemPorts: { checkPullRequest: ((actor: ReviewActor, ref: PrRef) => Promise<ToolOutcome>) | null } = {
  checkPullRequest: null,
};

export function reviewItemsEnabled(): boolean {
  return CLAW_ASSISTANT_REVIEW_ITEMS;
}

const prName = (pr: PrRef): string => `${pr.owner}/${pr.repo}#${pr.number}`;
const prUrl = (pr: PrRef): string => `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`;

/** The first message when the channel sent none: which pull request, and whether to stop at the review. */
export function defaultBrief(pr: PrRef, reviewOnly: boolean): string {
  return reviewOnly
    ? `Review ${prUrl(pr)}. Review only: post your review and do not merge it.`
    : `Review ${prUrl(pr)}. If the review finds nothing that blocks it, approve and merge it; the tools decide whether the merge waits for a person's confirmation first.`;
}

function title(pr: PrRef, reviewOnly: boolean): string {
  return clipOneLine(`${reviewOnly ? "Review" : "Review+merge"} ${pr.repo}#${pr.number}`, 40);
}

// ------------------------------------------------------------------------------------------------ the request

export interface ReviewRequest {
  prs: Array<{ pr: PrRef; message: string | null }>;
  actingAs: string | null;
  actingAsName: string | null;
  model: unknown;
  effort: unknown;
  reviewOnly: boolean;
}

const bad = (field: string, message: string): ReviewItemRefused => new ReviewItemRefused(400, "invalid_request", message, { field });

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw bad(field, `${field} must be a string`);
  const text = value.trim();
  if (text.length > max) throw bad(field, `${field} is longer than ${max} characters`);
  return text || null;
}

/** The body of `POST /v1/assistant/reviews`, or the 400 that says what is wrong with it. */
export function parseReviewRequest(body: unknown): ReviewRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw bad("body", "the body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.prs) || b.prs.length === 0 || b.prs.length > MAX_REVIEWS_PER_REQUEST) {
    throw bad("prs", `prs must name 1 to ${MAX_REVIEWS_PER_REQUEST} pull requests`);
  }
  const seen = new Set<string>();
  const prs = b.prs.map((raw, i) => {
    const e = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const pr = e && typeof e.owner === "string" && typeof e.repo === "string" && typeof e.number === "number"
      ? { owner: e.owner, repo: e.repo, number: e.number } : null;
    if (!pr || !isValidPrRef(pr)) throw bad(`prs[${i}]`, `prs[${i}] must be {owner, repo, number} of a GitHub pull request`);
    const key = prName(pr).toLowerCase();
    if (seen.has(key)) throw bad(`prs[${i}]`, `${prName(pr)} is named twice`);
    seen.add(key);
    return { pr, message: optionalText(e?.message, `prs[${i}].message`, BRIEF_MAX_CHARS) };
  });
  if (b.review_only !== undefined && typeof b.review_only !== "boolean") throw bad("review_only", "review_only must be true or false");
  return {
    prs,
    actingAs: optionalText(b.acting_as, "acting_as", 128),
    actingAsName: optionalText(b.acting_as_name, "acting_as_name", NAME_MAX_CHARS),
    model: b.model,
    effort: b.effort,
    // Merging is asked for, never assumed.
    reviewOnly: b.review_only !== false,
  };
}

/** The changes a restart asks for; what it leaves out is the old item's. */
export function parseRestartRequest(body: unknown): { model?: unknown; effort?: unknown; reviewOnly?: boolean; message?: string | null } {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw bad("body", "the body must be a JSON object");
  const b = body as Record<string, unknown>;
  if (b.review_only !== undefined && typeof b.review_only !== "boolean") throw bad("review_only", "review_only must be true or false");
  return {
    ...(b.model !== undefined ? { model: b.model } : {}),
    ...(b.effort !== undefined ? { effort: b.effort } : {}),
    ...(b.review_only !== undefined ? { reviewOnly: b.review_only as boolean } : {}),
    ...(b.message !== undefined ? { message: optionalText(b.message, "message", BRIEF_MAX_CHARS) } : {}),
  };
}

// ------------------------------------------------------------------------------------------------ the guards before anything is made

/**
 * Who may be named and on what: the same check as `POST /v1/sessions` makes of a session that acts as a user, for each pull request.
 * The proof it hands back is what lets the server queue the session's first message (`queueServerMessage`).
 */
function checkAsCreate(user: UserInfo, method: string | null, actingAs: string, pr: PrRef, reviewOnly: boolean, model: unknown, effort: unknown): {
  config: Record<string, unknown>; model: string | null; effort: string | null; attended: AttendedProof;
} {
  const config: Record<string, unknown> = { acting_as: actingAs, review_target: { ...pr }, review_only: reviewOnly };
  const checked = checkSessionCreate({ config, model, effort, user, method });
  if (!checked.ok) {
    throw checked.status === 400
      ? new ReviewItemRefused(400, "invalid_request", checked.error, {})
      : new ReviewItemRefused(checked.status, checked.error, checked.error);
  }
  if (!checked.attended) throw new ReviewItemRefused(403, "interactive_sign_in_required", "interactive_sign_in_required");
  return { config, model: checked.model, effort: checked.effort, attended: checked.attended };
}

/** The open review of a pull request, whoever asked. */
async function openReviewOf(q: StatementRunner, pr: PrRef): Promise<{ item_id: string; seq: number; user_id: string } | null> {
  const row = (await q.query(
    `SELECT item_id, seq, user_id FROM claw_work_items
      WHERE kind = 'review' AND board_state <> 'done'
        AND lower(params->'pr'->>'owner') = lower($1) AND lower(params->'pr'->>'repo') = lower($2) AND params->'pr'->>'number' = $3`,
    [pr.owner, pr.repo, String(pr.number)],
  )).rows[0] as { item_id: string; seq: number; user_id: string } | undefined;
  return row ?? null;
}

async function refuseIfReviewed(q: StatementRunner, userId: string, pr: PrRef, except: string | null = null): Promise<void> {
  const open = await openReviewOf(q, pr);
  if (!open || open.item_id === except) return;
  // Another person's item is not theirs to see: only that somebody is reviewing it.
  if (open.user_id !== userId) {
    throw new ReviewItemRefused(409, "review_in_progress_by_other", `${prName(pr)} is already being reviewed by someone else`, { pr });
  }
  throw new ReviewItemRefused(409, "review_in_progress", `${prName(pr)} is already being reviewed as item #${open.seq}; restart it to change how`,
    { pr, item_id: open.item_id, seq: Number(open.seq) });
}

/**
 * Whether `wanted` more reviews fit the hour: the limits the review tools count when they write (`recentWrites`), asked before any session
 * is made, so a batch is refused whole rather than half made and then refused on the way. A session that wrote in the hour and an open
 * review that has not written yet both count: the second will.
 */
async function refuseOverLimit(q: StatementRunner, actingAs: string, wanted: number, except: string | null = null): Promise<void> {
  const settings = readGithubReviewSettings();
  const count = async (actor: string | null): Promise<number> => Number(((await q.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT session_id FROM claw_github_audit
        WHERE write AND NOT dry_run AND at > NOW() - ($2::bigint * INTERVAL '1 millisecond') AND ($1::text IS NULL OR actor_user_id = $1)
       UNION
       SELECT worker_session_id FROM claw_work_items
        WHERE kind = 'review' AND board_state <> 'done' AND ($1::text IS NULL OR params->>'acting_as' = $1) AND item_id IS DISTINCT FROM $3
     ) s`,
    [actor, HOUR_MS, except],
  )).rows[0] as { n: number }).n);
  for (const [scope, limit, used] of [
    ["account", settings.reviewsPerTokenPerHour, await count(actingAs)],
    ["deployment", settings.reviewsPerHour, await count(null)],
  ] as const) {
    const remaining = Math.max(0, limit - used);
    if (wanted > remaining) {
      throw new ReviewItemRefused(429, "rate_limited",
        `${limit} reviews an hour is the limit for ${scope === "account" ? "one GitHub account" : "this deployment"}; ${remaining} more can start now`,
        { scope, limit, remaining });
    }
  }
}

/** Codes of the pull request check that will pass by themselves: the request may be made again. */
const TRANSIENT_CHECKS = new Set(["identity_unavailable", "audit_unavailable", "github_rate_limited", "github_error", "too_many_concurrent", "internal_error", "write_in_progress"]);

/** That GitHub has the pull request and the acting user's account may review it, before a session is made for it (a typo costs nothing). */
async function checkPullRequests(actor: Omit<ReviewActor, "sessionId">, prs: Array<{ pr: PrRef; sessionId: string }>): Promise<void> {
  const check = reviewItemPorts.checkPullRequest;
  if (!check) throw new ReviewItemRefused(503, "pr_check_unavailable", "GitHub review is not set up on this deployment", {});
  for (const { pr, sessionId } of prs) {
    const outcome = await check({ ...actor, sessionId, reviewTarget: pr }, pr);
    if (!outcome.isError) continue;
    const reason = String(outcome.body.reason ?? "refused");
    const message = `${prName(pr)}: ${String(outcome.body.message ?? reason)}`;
    throw TRANSIENT_CHECKS.has(reason)
      ? new ReviewItemRefused(503, "pr_check_unavailable", message, { pr, reason })
      : new ReviewItemRefused(422, "pr_check_failed", message, { pr, reason });
  }
}

// ------------------------------------------------------------------------------------------------ making the items

export interface CreatedReview {
  item_id: string;
  seq: number;
  title: string;
  session_id: string;
  pr: PrRef;
}

interface Planned {
  pr: PrRef;
  sessionId: string;
  config: Record<string, unknown>;
  attended: AttendedProof;
  params: ReviewParams;
}

/** The session, the item and the session's first message, in the caller's transaction. */
async function insertReview(q: StatementRunner, user: UserInfo, plan: Planned): Promise<CreatedReview> {
  const name = title(plan.pr, plan.params.review_only);
  await insertSessionRow(q, {
    sessionId: plan.sessionId,
    name,
    userId: user.userId,
    mode: "claw",
    agentStatus: "idle",
    systemPrompt: "",
    // The requester's own credentials, as their own first message would stamp them: the turn runs as them.
    config: { ...plan.config, notify_on_finish: true, ...sessionCredentialPatch(user) },
    parentSid: null,
    role: "",
    model: plan.params.model,
    effort: plan.params.effort,
  }, { parentSid: null });
  const item = await insertWorkItem(q, {
    userId: user.userId, title: name, workerSessionId: plan.sessionId, kind: "review", params: plan.params as unknown as Record<string, unknown>,
  });
  if (!item.ok) {
    throw item.error === "too_many_active_items"
      ? new ReviewItemRefused(409, "too_many_active_items",
        `you already have ${CLAW_ASSISTANT_MAX_ACTIVE_ITEMS} unfinished items, the most one person may have; stop or finish one first`,
        { limit: CLAW_ASSISTANT_MAX_ACTIVE_ITEMS })
      : new ReviewItemRefused(503, "no_assistant", "the requester has no assistant", {});
  }
  const queued = await queueServerMessage(q, {
    sessionId: plan.sessionId, userId: user.userId, content: plan.params.brief, dedupeKey: `start:${item.itemId}`, attended: plan.attended,
  });
  if (!queued.ok) throw new ReviewItemRefused(503, queued.error, "the review could not be started", {});
  return { item_id: item.itemId, seq: item.seq, title: name, session_id: plan.sessionId, pr: plan.pr };
}

/** The unique index on open reviews of one pull request, met by a create that raced another: answered as the check before it would. */
async function inReviewTransaction<T>(userId: string, prs: PrRef[], run: (query: Querier) => Promise<T>): Promise<T> {
  try {
    return await inTransaction(run);
  } catch (err) {
    if ((err as { code?: string })?.code !== UNIQUE_VIOLATION) throw err;
    for (const pr of prs) await refuseIfReviewed(db, userId, pr);
    throw err;
  }
}

/**
 * `POST /v1/assistant/reviews`: one item per pull request, all of them or none. Every refusal comes before anything is made, in the
 * order of what it costs to ask: the request, the open reviews, the hourly limits, then GitHub.
 */
export async function startReviews(user: UserInfo, method: string | null, request: ReviewRequest): Promise<CreatedReview[]> {
  const actingAs = request.actingAs ?? user.userId;
  const plans: Planned[] = request.prs.map(({ pr, message }) => {
    const checked = checkAsCreate(user, method, actingAs, pr, request.reviewOnly, request.model, request.effort);
    return {
      pr, sessionId: randomUUID(), config: checked.config, attended: checked.attended,
      params: {
        pr, acting_as: actingAs, acting_as_name: request.actingAsName, model: checked.model, effort: checked.effort,
        review_only: request.reviewOnly, brief: message ?? defaultBrief(pr, request.reviewOnly),
      },
    };
  });
  for (const plan of plans) await refuseIfReviewed(db, user.userId, plan.pr);
  await refuseOverLimit(db, actingAs, plans.length);
  await checkPullRequests({ requesterUserId: user.userId, actorUserId: actingAs, requesterLabel: plans[0]?.config.acting_as_requester as string },
    plans.map((p) => ({ pr: p.pr, sessionId: p.sessionId })));
  await getOrCreateAssistant(user.userId);
  const created = await inReviewTransaction(user.userId, plans.map((p) => p.pr), async (query) => {
    const q = { query };
    // The assistant row first, as `insertWorkItem` takes it: two requests of one user meet here, and the limits are asked again behind it.
    await query("SELECT 1 FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [user.userId]);
    for (const plan of plans) await refuseIfReviewed(q, user.userId, plan.pr);
    await refuseOverLimit(q, actingAs, plans.length);
    const out: CreatedReview[] = [];
    for (const plan of plans) out.push(await insertReview(q, user, plan));
    return out;
  });
  for (const c of created) await drainSessionIfIdle(c.session_id, user.userId);
  logger.info({ userId: user.userId, actingAs, items: created.map((c) => c.item_id) }, "assistant.reviews_started");
  return created;
}

function readParams(row: Record<string, unknown>): ReviewParams | null {
  const p = row.params as Partial<ReviewParams> | null;
  if (row.kind !== "review" || !p || !p.pr || typeof p.acting_as !== "string") return null;
  return {
    pr: p.pr, acting_as: p.acting_as, acting_as_name: p.acting_as_name ?? null, model: p.model ?? null, effort: p.effort ?? null,
    review_only: p.review_only !== false, brief: typeof p.brief === "string" ? p.brief : defaultBrief(p.pr, p.review_only !== false),
  };
}

/**
 * `POST /v1/assistant/reviews/:id/restart`: the same pull request again, with what the request changes and the rest as it was. A session's
 * config cannot change once it is made, so this is a stop of the old item (by the stop's rules) and a new item, in one transaction.
 */
export async function restartReview(
  user: UserInfo, method: string | null, itemId: string, change: ReturnType<typeof parseRestartRequest>,
): Promise<{ stopped: { item_id: string; seq: number }; item: CreatedReview }> {
  const old = await getWorkItem(user.userId, itemId);
  if (!old) throw new ReviewItemRefused(404, "not_found", "no such item");
  const was = readParams(old);
  if (!was) throw new ReviewItemRefused(400, "not_a_review_item", "only a review item can be restarted");
  const reviewOnly = change.reviewOnly ?? was.review_only;
  const checked = checkAsCreate(user, method, was.acting_as, was.pr, reviewOnly,
    "model" in change ? change.model : was.model, "effort" in change ? change.effort : was.effort);
  // The old words are sent again only if they still say what is asked: a review that now merges, or now does not, gets new ones.
  const brief = change.message ?? (reviewOnly === was.review_only ? was.brief : defaultBrief(was.pr, reviewOnly));
  const plan: Planned = {
    pr: was.pr, sessionId: randomUUID(), config: checked.config, attended: checked.attended,
    params: { ...was, model: checked.model, effort: checked.effort, review_only: reviewOnly, brief },
  };
  await refuseIfReviewed(db, user.userId, was.pr, itemId);
  await refuseOverLimit(db, was.acting_as, 1, itemId);
  await checkPullRequests({ requesterUserId: user.userId, actorUserId: was.acting_as, requesterLabel: checked.config.acting_as_requester as string },
    [{ pr: was.pr, sessionId: plan.sessionId }]);
  await getOrCreateAssistant(user.userId);
  const result = await inReviewTransaction(user.userId, [was.pr], async (query) => {
    const q = { query };
    await query("SELECT 1 FROM claw_assistants WHERE user_id = $1 FOR UPDATE", [user.userId]);
    const row = (await query(
      "SELECT board_state, worker_session_id, seq FROM claw_work_items WHERE item_id = $1 AND user_id = $2 FOR UPDATE", [itemId, user.userId],
    )).rows[0] as { board_state: string; worker_session_id: string; seq: number } | undefined;
    if (!row) throw new ReviewItemRefused(404, "not_found", "no such item");
    const refusal = await closeConfirmationsForStop(q, row.worker_session_id, user.userId);
    if (refusal) {
      throw new ReviewItemRefused(409, refusal, refusal === "already_merged"
        ? `${prName(was.pr)} is already merged; nothing to review again` : `the merge of ${prName(was.pr)} is being made right now`, {});
    }
    if (row.board_state !== "done") {
      await query(
        `UPDATE claw_work_items SET board_state = 'done', outcome = 'stopped', pending_question = NULL, generation = generation + 1,
                closed_at = NOW(), updated_at = NOW() WHERE item_id = $1`,
        [itemId],
      );
      await query(
        "INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary) SELECT item_id, 'stopped', 'user', generation, 'restarted' FROM claw_work_items WHERE item_id = $1",
        [itemId],
      );
      await query("DELETE FROM claw_pending_messages WHERE session_id = $1", [row.worker_session_id]);
    }
    await refuseIfReviewed(q, user.userId, was.pr, itemId);
    await refuseOverLimit(q, was.acting_as, 1, itemId);
    return { oldSession: row.worker_session_id, seq: Number(row.seq), item: await insertReview(q, user, plan) };
  });
  await stopSessionRuns(result.oldSession);
  await drainSessionIfIdle(result.item.session_id, user.userId);
  logger.info({ userId: user.userId, stopped: itemId, item: result.item.item_id }, "assistant.review_restarted");
  return { stopped: { item_id: itemId, seq: result.seq }, item: result.item };
}

// ------------------------------------------------------------------------------------------------ the state, read off what happened

/** What the tables say a review session did. */
export interface ReviewFacts {
  ownerUserId: string;
  actingAs: string;
  actingAsName: string | null;
  reviewOnly: boolean;
  pr: PrRef;
  /** Every confirmation of the session; a pending one that ran out is `expired`. `at` is when it was last decided, or opened. */
  confirmations: Array<{ status: string; kind: string; at: number }>;
  /** The session's review and merge calls: `result` ok or refused, `detail` the status or the refusal. */
  writes: Array<{ tool: string; result: string; detail: string; at: number }>;
  /** `running`: a turn is open or queued. `none`: no turn ever ran. */
  turn: "running" | "failed" | "finished" | "none";
}

export type ReviewState =
  | { boardState: "in_progress"; summary: string; question: string | null }
  | { boardState: "needs_you"; reportKind: "blocked" | "failed"; summary: string; question: string }
  | { boardState: "done"; outcome: Extract<Outcome, "accepted" | "stopped">; summary: string };

/**
 * Where a review item stands, from the facts alone. Every status of a confirmation lands somewhere (`merged`, `queued`, `submitted`,
 * `denied`, `pending`, `merging`, `stale`, `expired`, `refused`): a closed one that did not do the write is the owner's to look at, never
 * a done item, so nobody reads "done" for a review that was turned away.
 */
export function reviewState(f: ReviewFacts): ReviewState {
  const pr = prName(f.pr);
  const own = f.actingAs === f.ownerUserId;
  const latest = <T extends { at: number }>(xs: T[]): T | null => xs.reduce<T | null>((a, x) => (!a || x.at >= a.at ? x : a), null);
  const merged = f.confirmations.find((c) => c.status === "merged" || c.status === "queued")
    ?? f.writes.find((w) => w.tool === "gh_pr_merge" && w.result === "ok" && (w.detail === "merged" || w.detail === "queued"));
  if (merged) {
    const queued = ("status" in merged ? merged.status : merged.detail) === "queued";
    return { boardState: "done", outcome: "accepted", summary: queued ? `${pr} is in the merge queue` : `${pr} was merged` };
  }
  if (f.confirmations.some((c) => c.status === "merging")) {
    return { boardState: "in_progress", summary: `the confirmed write to ${pr} is being made`, question: null };
  }
  const pending = f.confirmations.find((c) => c.status === "pending");
  if (pending) {
    const what = pending.kind === "review" ? "the approval" : "the merge";
    // Waiting for someone else is still work in progress for the owner; waiting for the owner is theirs to do.
    if (own) return { boardState: "needs_you", reportKind: "blocked", summary: `${what} of ${pr} is held`, question: `Confirm or deny ${what} of ${pr}` };
    return { boardState: "in_progress", summary: `${what} of ${pr} is held`, question: `Waiting for ${f.actingAsName || f.actingAs} to confirm ${what}` };
  }
  if (f.turn === "running" || f.turn === "none") return { boardState: "in_progress", summary: `reviewing ${pr}`, question: null };
  const submitted = latest([
    ...f.confirmations.filter((c) => c.status === "submitted"),
    ...f.writes.filter((w) => w.tool === "gh_review_submit" && w.result === "ok" && (w.detail === "submitted" || w.detail === "already_submitted")),
  ]);
  const closed = latest(f.confirmations.filter((c) => ["denied", "stale", "expired", "refused"].includes(c.status)));
  if (closed && (!submitted || closed.at >= submitted.at)) {
    switch (closed.status) {
      case "denied": return { boardState: "done", outcome: "stopped", summary: `the held write to ${pr} was denied` };
      case "stale": return { boardState: "needs_you", reportKind: "blocked", summary: `${pr} got new commits, so the held write lapsed`, question: `Review ${pr} again?` };
      case "expired": return { boardState: "needs_you", reportKind: "blocked", summary: `nobody answered the held write to ${pr} in time`, question: `Review ${pr} again?` };
      default: return { boardState: "needs_you", reportKind: "blocked", summary: `the confirmed write to ${pr} was refused by a gate`, question: `Look at ${pr}` };
    }
  }
  const mergeRefused = latest(f.writes.filter((w) => w.tool === "gh_pr_merge" && w.result === "refused"));
  if (!f.reviewOnly && mergeRefused && (!submitted || mergeRefused.at >= submitted.at)) {
    return { boardState: "needs_you", reportKind: "blocked", summary: `the merge of ${pr} was refused: ${mergeRefused.detail}`, question: `Look at ${pr}` };
  }
  if (submitted) return { boardState: "done", outcome: "accepted", summary: `the review of ${pr} was posted` };
  if (f.turn === "failed") return { boardState: "needs_you", reportKind: "failed", summary: `the review of ${pr} failed`, question: `Restart the review of ${pr}?` };
  if (f.writes.some((w) => w.result === "ok" && w.detail === "dry_run")) {
    return { boardState: "needs_you", reportKind: "blocked", summary: `writes are off on this deployment: nothing was posted to ${pr}`, question: `Look at ${pr}` };
  }
  return { boardState: "needs_you", reportKind: "blocked", summary: `the review of ${pr} ended without posting anything`, question: `Look at the review session of ${pr}` };
}

async function readFacts(q: StatementRunner, row: { user_id: string; worker_session_id: string; params: ReviewParams }): Promise<ReviewFacts> {
  const sessionId = row.worker_session_id;
  const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());
  const confirmations = (await q.query(
    `SELECT CASE WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired' ELSE status END AS status, kind,
            COALESCE(decided_at, CASE WHEN status = 'pending' AND expires_at <= NOW() THEN expires_at END, created_at) AS at
       FROM claw_github_confirmations WHERE session_id = $1`,
    [sessionId],
  )).rows as Array<{ status: string; kind: string; at: unknown }>;
  const writes = (await q.query(
    `SELECT tool, result, detail, at FROM claw_github_audit
      WHERE session_id = $1 AND tool IN ('gh_pr_merge', 'gh_review_submit') AND result <> 'started'`,
    [sessionId],
  )).rows as Array<{ tool: string; result: string; detail: string; at: unknown }>;
  const turn = (await q.query(
    `SELECT (EXISTS (SELECT 1 FROM claw_tasks WHERE session_id = $1 AND origin = 'chat' AND status = ANY($2::text[]))
             OR EXISTS (SELECT 1 FROM claw_pending_messages WHERE session_id = $1)) AS busy,
            (SELECT status FROM claw_tasks WHERE session_id = $1 AND origin = 'chat' ORDER BY created_at DESC LIMIT 1) AS last`,
    [sessionId, SWEEPABLE_RUN_STATUSES],
  )).rows[0] as { busy: boolean; last: string | null };
  return {
    ownerUserId: row.user_id, actingAs: row.params.acting_as, actingAsName: row.params.acting_as_name, reviewOnly: row.params.review_only,
    pr: row.params.pr,
    confirmations: confirmations.map((c) => ({ status: c.status, kind: c.kind, at: ms(c.at) })),
    writes: writes.map((w) => ({ tool: w.tool, result: w.result, detail: w.detail, at: ms(w.at) })),
    turn: turn.busy ? "running" : turn.last === null ? "none" : turn.last === "failed" || turn.last === "cancelled" ? "failed" : "finished",
  };
}

/**
 * Bring one open review item to what its facts say, under the item's row lock. Writes only a change; entering "needs you", or a new reason
 * to, is the one change that wakes the assistant (a finished review is told by the channel's own review card, so it is not said twice).
 */
export async function syncReviewItem(itemId: string): Promise<WorkItemView | null> {
  const woke = await inTransaction(async (query) => {
    const q = { query };
    const row = (await query(
      `SELECT item_id, user_id, worker_session_id, params, kind, board_state, last_report_kind, summary, pending_question, generation, attention_seq
         FROM claw_work_items WHERE item_id = $1 AND kind = 'review' AND board_state <> 'done' FOR UPDATE`,
      [itemId],
    )).rows[0] as Record<string, unknown> | undefined;
    const params = row ? readParams(row) : null;
    if (!row || !params) return null;
    const state = reviewState(await readFacts(q, { user_id: row.user_id as string, worker_session_id: row.worker_session_id as string, params }));
    const reportKind = state.boardState === "needs_you" ? state.reportKind : state.boardState === "done" ? null : "progress";
    const question = state.boardState === "done" ? null : state.question;
    const summary = clipOneLine(state.summary, 80);
    if (row.board_state === state.boardState && (row.last_report_kind ?? null) === reportKind
      && (row.pending_question ?? null) === question && row.summary === summary) return null;
    const attention = state.boardState === "needs_you" ? 1 : 0;
    const outcome = state.boardState === "done" ? state.outcome : null;
    await query(
      `UPDATE claw_work_items
          SET board_state = $2, last_report_kind = COALESCE($3, last_report_kind), summary = $4, pending_question = $5, outcome = $6,
              attention_seq = attention_seq + $7::int, closed_at = CASE WHEN $2 = 'done' THEN NOW() ELSE closed_at END, updated_at = NOW()
        WHERE item_id = $1`,
      [itemId, state.boardState, reportKind, summary, question, outcome, attention],
    );
    const eventKind = state.boardState === "done" ? (outcome === "stopped" ? "stopped" : "accepted") : reportKind;
    const event = (await query(
      `INSERT INTO claw_work_item_events (item_id, kind, source, generation, summary, question)
       VALUES ($1, $2, 'policy', $3, $4, $5) RETURNING id`,
      [itemId, eventKind, row.generation, state.summary, question],
    )).rows[0] as { id: string | number };
    if (state.boardState !== "needs_you") return null;
    return queueRouterWake(q, {
      itemId, userId: row.user_id as string, eventId: Number(event.id), kind: state.reportKind, version: 0, summary: state.summary, question,
    });
  });
  if (woke) await drainSessionIfIdle(woke.sessionId, woke.userId);
  const after = (await db.query("SELECT * FROM claw_work_items WHERE item_id = $1", [itemId])).rows[0] as Record<string, unknown> | undefined;
  return after ? itemView(after) : null;
}

/** For a session whose turn ended or whose held write was answered: true when it is a review item's (synced), false when it is not. */
export async function syncReviewItemOfSession(sessionId: string): Promise<boolean> {
  if (!CLAW_ASSISTANT_REVIEW_ITEMS) return false;
  const row = (await db.query(
    "SELECT item_id FROM claw_work_items WHERE worker_session_id = $1 AND kind = 'review'", [sessionId],
  )).rows[0] as { item_id: string } | undefined;
  if (!row) return false;
  await syncReviewItem(row.item_id);
  return true;
}

/**
 * Whether a confirmation was held by the session of a review item its requester stopped. Such a write is not made whatever the answer:
 * the stop denied what was pending then, and this is the one that was opened by a tool call still in flight when the stop came.
 */
export async function confirmationOfStoppedReview(confirmationId: string): Promise<boolean> {
  if (!CLAW_ASSISTANT_REVIEW_ITEMS) return false;
  const r = await db.query(
    `SELECT 1 FROM claw_github_confirmations c JOIN claw_work_items w ON w.worker_session_id = c.session_id
      WHERE c.confirmation_id = $1 AND w.kind = 'review' AND w.outcome = 'stopped'`,
    [confirmationId],
  );
  return r.rows.length > 0;
}

/** Deny one held write of a stopped review, as the stop would have. */
export async function denyForStoppedReview(confirmationId: string): Promise<void> {
  await finishConfirmation(db, confirmationId, "denied", "stopped", { by: "requester", reason: "stopped" });
}

/**
 * Every tick: the open review items, brought to what their facts say (a held write that ran out, an answer given anywhere, a turn whose
 * end was lost), and the held writes of stopped reviews denied.
 */
export async function sweepReviewItems(): Promise<number> {
  if (!CLAW_ASSISTANT_REVIEW_ITEMS) return 0;
  await db.query(
    `UPDATE claw_github_confirmations c SET status = 'denied', decided_at = NOW(), decided_by = 'stopped',
            result = '{"by":"requester","reason":"stopped"}'::jsonb
       FROM claw_work_items w
      WHERE w.worker_session_id = c.session_id AND w.kind = 'review' AND w.outcome = 'stopped' AND c.status = 'pending'`,
  );
  const open = (await db.query(
    "SELECT item_id FROM claw_work_items WHERE kind = 'review' AND board_state <> 'done' ORDER BY updated_at LIMIT $1", [REVIEW_SWEEP_BATCH],
  )).rows as Array<{ item_id: string }>;
  let changed = 0;
  for (const { item_id } of open) {
    try {
      const before = (await db.query("SELECT updated_at FROM claw_work_items WHERE item_id = $1", [item_id])).rows[0] as { updated_at: Date } | undefined;
      const after = await syncReviewItem(item_id);
      if (after && before && after.updated_at.getTime() !== new Date(before.updated_at).getTime()) changed += 1;
    } catch (err) {
      logger.warn({ err, itemId: item_id }, "assistant.review_sync_failed");
    }
  }
  return changed;
}
