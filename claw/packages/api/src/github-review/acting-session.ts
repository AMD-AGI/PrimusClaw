// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a request that creates a session asks of it, checked once for every place that creates one: `POST /v1/sessions` and the review
 * items of the assistant (`assistant/review-items.ts`). A session that acts as a user is the person's say, so the two must not be able to
 * drift apart: the same parse of `acting_as`, `review_target` and `review_only`, the same model and effort, and the same credential check.
 *
 * The answer for a session that acts as a user carries `attended`, the proof that the request was a person's (or an allowed service's)
 * identity-provider token. It can only be made here, and it is what the server needs to put a first message in front of such a session's
 * model by itself (`assistant/messages.ts`): a message the server queues has no request of its own to be checked.
 */
import type { UserInfo } from "../auth/models.js";
import { CLAW_GITHUB_REVIEW_ENABLED } from "../config.js";
import { parseSessionEffort, parseSessionModel } from "../sessions/session-model.js";
import type { PrRef } from "./github.js";
import { parseActingAs } from "./acting-as.js";
import { classifyAttendedCaller } from "./attended.js";
import { parseReviewOnly, parseReviewTarget } from "./review-target.js";
import { readGithubReviewSettings } from "./settings.js";
import type { DecidedVia } from "./store.js";

declare const ATTENDED: unique symbol;
/** Made only by {@link checkSessionCreate}, for a request whose credential is a person's: see the module comment. */
export interface AttendedProof {
  readonly [ATTENDED]: true;
  /** The service that answered for the person, or null when it was the person. */
  readonly via: DecidedVia | null;
}

export type SessionCreateCheck =
  | {
    ok: true;
    actingAs: string | null;
    target: PrRef | null;
    reviewOnly: boolean;
    model: string | null;
    effort: string | null;
    /** Set exactly when `actingAs` is. */
    attended: AttendedProof | null;
  }
  | { ok: false; status: 400 | 401 | 403; error: string; log?: string };

/**
 * Check what a create asks for. `config` is the session's config as the caller sent it; for a session that acts as a user,
 * `acting_as_requester` (the footer's name for who asked) is written into it from the verified caller. `model` and `effort` are the
 * request's fields, undefined when it sent none.
 */
export function checkSessionCreate(input: {
  config: Record<string, unknown>;
  model: unknown;
  effort: unknown;
  user: UserInfo | null;
  /** How the request was authenticated (`getAuthMethod`). */
  method: string | null;
}): SessionCreateCheck {
  const { config, user } = input;
  // The user whose GitHub account this session's review tools act as. A reference only; refused while the feature is off so that a
  // session never silently goes without the tools it asked for.
  const parsedActingAs = parseActingAs(config.acting_as);
  if (!parsedActingAs.ok) return { ok: false, status: 400, error: parsedActingAs.error };
  let attended: AttendedProof | null = null;
  if (parsedActingAs.actingAs !== null) {
    if (!CLAW_GITHUB_REVIEW_ENABLED) return { ok: false, status: 400, error: "config.acting_as is not enabled on this deployment" };
    if (!user) return { ok: false, status: 401, error: "authentication required" };
    // A session that acts as a user is the person's say, and the key a sandbox holds (or a sign-in that key can complete) must not be
    // able to start one: a model injected in any ordinary session of the user would otherwise review and merge with their account
    // on its own. The same credentials as answering a held merge (attended.ts).
    const caller = classifyAttendedCaller(input.method, user, readGithubReviewSettings().decisionClientIds);
    if (!caller.ok) return { ok: false, status: 403, error: caller.error, log: `github_review.acting_as_refused_${caller.error}` };
    attended = { via: caller.via } as AttendedProof;
    config.acting_as_requester = (user.userName || user.userId).slice(0, 100);
  }
  // The one pull request the session's review tools may touch, and whether they may only review it. Both bind nothing without
  // `acting_as`, which is why asking for either without one is refused rather than silently ignored.
  const parsedTarget = parseReviewTarget(config.review_target);
  if (!parsedTarget.ok) return { ok: false, status: 400, error: parsedTarget.error };
  if (parsedTarget.target !== null && parsedActingAs.actingAs === null) {
    return { ok: false, status: 400, error: "config.review_target needs config.acting_as" };
  }
  const parsedReviewOnly = parseReviewOnly(config.review_only);
  if (!parsedReviewOnly.ok) return { ok: false, status: 400, error: parsedReviewOnly.error };
  if (parsedReviewOnly.reviewOnly && parsedActingAs.actingAs === null) {
    return { ok: false, status: 400, error: "config.review_only needs config.acting_as" };
  }
  // Absent and null both mean no choice; whether the gateway serves the name is its answer to give, on the first turn that uses it.
  let model: string | null = null;
  if (input.model !== undefined) {
    const parsed = parseSessionModel(input.model);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    model = parsed.model;
  }
  // What the session's creator asked for, nothing the deployment adds.
  let effort: string | null = null;
  if (input.effort !== undefined) {
    const parsed = parseSessionEffort(input.effort);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    effort = parsed.effort;
  }
  return {
    ok: true, actingAs: parsedActingAs.actingAs, target: parsedTarget.target, reviewOnly: parsedReviewOnly.reviewOnly, model, effort, attended,
  };
}

/**
 * The one other proof there is: for queueing again, once, the first message of a session that acts as a user, after the gateway refused the
 * model of its first turn for want of a key binding and before that model ran (`assistant/model-fallback.ts`, by way of
 * `assistant/review-items.ts`). The person's say was for that message in that session, which the proof `checkSessionCreate` made let the
 * server queue; it is the same words given again, on another model. So it is made only when the database shows exactly that: the session
 * acts as a user, has had one turn and no other, that turn failed, and its words are `content`. Null otherwise.
 */
export async function proofForFirstMessageAgain(
  q: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, sessionId: string, content: string,
): Promise<AttendedProof | null> {
  const row = (await q.query(
    `SELECT s.config->'acting_as' AS acting_as,
            (SELECT COUNT(*)::int FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat') AS turns,
            (SELECT COUNT(*)::int FROM claw_pending_messages p WHERE p.session_id = s.session_id) AS queued,
            (SELECT t.status FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat' ORDER BY t.created_at DESC, t.task_id DESC LIMIT 1) AS status,
            (SELECT COALESCE(t.prompt, t.input->>'prompt', '') FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat' ORDER BY t.created_at DESC, t.task_id DESC LIMIT 1) AS words
       FROM claw_sessions s WHERE s.session_id = $1 AND s.deleted_at IS NULL`,
    [sessionId],
  )).rows[0] as { acting_as: unknown; turns: number; queued: number; status: string | null; words: string | null } | undefined;
  if (!row || typeof row.acting_as !== "string" || Number(row.turns) !== 1 || Number(row.queued) !== 0) return null;
  if (row.status !== "failed" || row.words !== content) return null;
  return { via: null } as AttendedProof;
}

/**
 * The proof for running a review once more when CI turned green (`assistant/review-items.ts`, `followReviewItems`): the person asked for this
 * review of their own account, its one turn ended with a comment-only review because CI was not green on the head (its approval was refused
 * `ci_not_green`), and that head is green now. It is the same words in the same session, given once more, as a person who said "review and
 * merge it" means "once CI lets it". Made only when the database shows exactly that: the session acts as a user, has had one turn and no
 * other, that turn completed and its words are `content`, nothing is queued, its approval was refused `ci_not_green`, and it is the session of
 * an open review item of the owner's own (nobody else asked for it) whose wait for CI has not ended. Null otherwise: never twice, since the
 * turn it lets through is the session's second.
 *
 * Or, for a review asked of anyone (2026-11-11, N25): its one completed turn read a head the same acting account had already reviewed in
 * another session and tried no review or merge call at all (a refused or failed one is not this), as a re-review of a pull request with no
 * new commits does, and the head is green now.
 * The same words, once more; a review someone asked of the owner still passes every gate a queued turn does (`gateRequestedReviewTurn`:
 * the reviewer's say asked again, and the turn budget).
 */
export async function proofForReviewAfterGreenCi(
  q: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, sessionId: string, content: string,
): Promise<AttendedProof | null> {
  const row = (await q.query(
    `SELECT s.config->'acting_as' AS acting_as,
            (SELECT COUNT(*)::int FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat') AS turns,
            (SELECT COUNT(*)::int FROM claw_pending_messages p WHERE p.session_id = s.session_id) AS queued,
            (SELECT t.status FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat' ORDER BY t.created_at DESC, t.task_id DESC LIMIT 1) AS status,
            (SELECT COALESCE(t.prompt, t.input->>'prompt', '') FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat' ORDER BY t.created_at DESC, t.task_id DESC LIMIT 1) AS words,
            EXISTS (SELECT 1 FROM claw_work_items w WHERE w.worker_session_id = s.session_id AND w.kind = 'review' AND w.board_state <> 'done'
                     AND NOT (w.params ? 'ci_wait_ended')
                     AND ((NOT (w.params ? 'requested_by')
                           AND EXISTS (SELECT 1 FROM claw_github_audit a WHERE a.session_id = s.session_id AND a.tool = 'gh_review_submit'
                                        AND a.result = 'refused' AND a.detail = 'ci_not_green'))
                       OR (NOT EXISTS (SELECT 1 FROM claw_github_audit a WHERE a.session_id = s.session_id
                                        AND a.tool IN ('gh_review_submit', 'gh_pr_merge'))
                           AND NOT EXISTS (SELECT 1 FROM claw_github_confirmations c WHERE c.session_id = s.session_id)
                           AND EXISTS (SELECT 1 FROM (SELECT g.repo, g.pr, g.head_sha FROM claw_github_audit g
                                                       WHERE g.session_id = s.session_id AND g.tool = 'gh_pr_get' AND g.result = 'ok'
                                                         AND g.head_sha <> '' AND g.pr IS NOT NULL
                                                       ORDER BY g.at DESC, g.id DESC LIMIT 1) g
                                        WHERE EXISTS (SELECT 1 FROM claw_github_audit a
                                                       WHERE a.actor_user_id = s.config->>'acting_as' AND a.session_id <> s.session_id
                                                         AND a.tool = 'gh_review_submit' AND a.result = 'ok'
                                                         AND a.detail IN ('submitted', 'already_submitted') AND lower(a.repo) = lower(g.repo)
                                                         AND a.pr = g.pr AND lower(a.head_sha) = lower(g.head_sha)))))) AS waiting
       FROM claw_sessions s WHERE s.session_id = $1 AND s.deleted_at IS NULL`,
    [sessionId],
  )).rows[0] as { acting_as: unknown; turns: number; queued: number; status: string | null; words: string | null; waiting: boolean } | undefined;
  if (!row || typeof row.acting_as !== "string" || Number(row.turns) !== 1 || Number(row.queued) !== 0) return null;
  if (row.status !== "completed" || row.words !== content || !row.waiting) return null;
  return { via: null } as AttendedProof;
}

/**
 * The proof for running a review someone asked of the owner once more after its merge waited for the pull request's author
 * (`assistant/review-items.ts`, `AuthorWait`: GitHub refused the merge on a conflict, the branch rules or the missing `workflow` scope) and
 * the pull request got new commits. It is the same words in the same session, given once more, as "review and merge it" means once the
 * author has cleared what only they could: the new head is reviewed afresh, and the reviewer's say is asked again (`gateRequestedReviewTurn`).
 * Made only when the database shows exactly that: the session acts as a user, has had one turn and no other, that turn completed and its
 * words are `content`, nothing is queued, and it is the session of an open review item someone asked for that is marked as waiting for the
 * author. Null otherwise: never twice, since the turn it lets through is the session's second.
 */
export async function proofForReviewAfterAuthor(
  q: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, sessionId: string, content: string,
): Promise<AttendedProof | null> {
  const row = (await q.query(
    `SELECT s.config->'acting_as' AS acting_as,
            (SELECT COUNT(*)::int FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat') AS turns,
            (SELECT COUNT(*)::int FROM claw_pending_messages p WHERE p.session_id = s.session_id) AS queued,
            (SELECT t.status FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat' ORDER BY t.created_at DESC, t.task_id DESC LIMIT 1) AS status,
            (SELECT COALESCE(t.prompt, t.input->>'prompt', '') FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat' ORDER BY t.created_at DESC, t.task_id DESC LIMIT 1) AS words,
            EXISTS (SELECT 1 FROM claw_work_items w WHERE w.worker_session_id = s.session_id AND w.kind = 'review' AND w.board_state = 'in_progress'
                     AND w.params ? 'requested_by' AND w.params ? 'author_waiting') AS waiting
       FROM claw_sessions s WHERE s.session_id = $1 AND s.deleted_at IS NULL`,
    [sessionId],
  )).rows[0] as { acting_as: unknown; turns: number; queued: number; status: string | null; words: string | null; waiting: boolean } | undefined;
  if (!row || typeof row.acting_as !== "string" || Number(row.turns) !== 1 || Number(row.queued) !== 0) return null;
  if (row.status !== "completed" || row.words !== content || !row.waiting) return null;
  return { via: null } as AttendedProof;
}

/**
 * The proof for running a review once more whose one turn called no review tool at all (`assistant/review-items.ts`, `syncReviewItem`;
 * 2026-11-13, N31: the review tools did not connect in time, the turn ended in seconds having read and posted nothing, and the reviewer was
 * woken for it). It is the same words in the same session, given once more, as the turn did nothing of what they asked. Made only when the
 * database shows exactly that: the session acts as a user, has had one turn and no other, that turn completed and its words are `content`,
 * nothing is queued, the session has no review tool call since its turn began (the pull request check the server audits in it before then,
 * and the server's own follow-ups, `gh_pr_follow`, aside) and no confirmation, and it
 * is the session of an open review item that was not run again this way before (`empty_rerun`). Null otherwise: never twice, since the
 * turn it lets through is the session's second. A review someone asked of the owner still passes every gate a queued turn does.
 */
export async function proofForReviewAfterNoCall(
  q: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, sessionId: string, content: string,
): Promise<AttendedProof | null> {
  const row = (await q.query(
    `SELECT s.config->'acting_as' AS acting_as,
            (SELECT COUNT(*)::int FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat') AS turns,
            (SELECT COUNT(*)::int FROM claw_pending_messages p WHERE p.session_id = s.session_id) AS queued,
            (SELECT t.status FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat' ORDER BY t.created_at DESC, t.task_id DESC LIMIT 1) AS status,
            (SELECT COALESCE(t.prompt, t.input->>'prompt', '') FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat' ORDER BY t.created_at DESC, t.task_id DESC LIMIT 1) AS words,
            (EXISTS (SELECT 1 FROM claw_work_items w WHERE w.worker_session_id = s.session_id AND w.kind = 'review' AND w.board_state <> 'done'
                      AND NOT (w.params ? 'empty_rerun'))
             AND NOT EXISTS (SELECT 1 FROM claw_github_audit a WHERE a.session_id = s.session_id AND a.tool <> 'gh_pr_follow'
                              AND a.at > (SELECT MIN(t.created_at) FROM claw_tasks t WHERE t.session_id = s.session_id AND t.origin = 'chat'))
             AND NOT EXISTS (SELECT 1 FROM claw_github_confirmations c WHERE c.session_id = s.session_id)) AS waiting
       FROM claw_sessions s WHERE s.session_id = $1 AND s.deleted_at IS NULL`,
    [sessionId],
  )).rows[0] as { acting_as: unknown; turns: number; queued: number; status: string | null; words: string | null; waiting: boolean } | undefined;
  if (!row || typeof row.acting_as !== "string" || Number(row.turns) !== 1 || Number(row.queued) !== 0) return null;
  if (row.status !== "completed" || row.words !== content || !row.waiting) return null;
  return { via: null } as AttendedProof;
}

/**
 * The proof for the first message of a review that waited for a slot (`params.queued`, `assistant/review-items.ts`): the request that made
 * it was checked as `checkSessionCreate` checks any, and its item and session were made then, with the person's say, but its first message
 * was held back so that nothing of it could run before a slot was free. Made only when the database shows exactly that: the session acts
 * as a user, is a queued review item's, and has had no turn and has no message queued. Null otherwise.
 */
export async function proofForQueuedFirstMessage(
  q: { query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, sessionId: string,
): Promise<AttendedProof | null> {
  const row = (await q.query(
    `SELECT s.config->'acting_as' AS acting_as,
            (SELECT COUNT(*)::int FROM claw_tasks t WHERE t.session_id = s.session_id) AS turns,
            (SELECT COUNT(*)::int FROM claw_pending_messages p WHERE p.session_id = s.session_id) AS queued,
            EXISTS (SELECT 1 FROM claw_work_items w WHERE w.worker_session_id = s.session_id AND w.kind = 'review'
                     AND w.board_state <> 'done' AND w.params ? 'queued') AS waiting
       FROM claw_sessions s WHERE s.session_id = $1 AND s.deleted_at IS NULL`,
    [sessionId],
  )).rows[0] as { acting_as: unknown; turns: number; queued: number; waiting: boolean } | undefined;
  if (!row || typeof row.acting_as !== "string" || Number(row.turns) !== 0 || Number(row.queued) !== 0 || !row.waiting) return null;
  return { via: null } as AttendedProof;
}
