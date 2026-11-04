// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two tables behind GitHub pull request review, created only while
 * `CLAW_GITHUB_REVIEW_ENABLED` is on:
 *
 *  - `claw_github_confirmations`: a high-risk write held for the acting user, a merge or an approving review (with its
 *    event, text and inline comments, so that what is posted is what they were shown). One row per
 *    (session, repository, pull request, head commit, write) while pending, single use,
 *    bound to the head commit it was asked about.
 *  - `claw_github_audit`: one row per tool call, written before the call does
 *    anything and finished after. Neither table holds a credential: not the GitHub
 *    token and not the session token. The audit table has no foreign key on
 *    purpose: it outlives the sessions it describes.
 */
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

/** Anything that can run a statement: the pool, a client, or a test's database. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

export const GITHUB_REVIEW_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS claw_github_confirmations (
      confirmation_id   UUID PRIMARY KEY,
      session_id        TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      actor_user_id     TEXT NOT NULL,
      repo              TEXT NOT NULL,
      pr                INTEGER NOT NULL,
      head_sha          TEXT NOT NULL,
      title             TEXT NOT NULL DEFAULT '',
      author            TEXT NOT NULL DEFAULT '',
      reasons           JSONB NOT NULL DEFAULT '[]'::jsonb,
      checks            JSONB NOT NULL DEFAULT '{}'::jsonb,
      status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'merging', 'merged', 'queued', 'submitted', 'denied', 'stale', 'expired', 'refused')),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at        TIMESTAMPTZ NOT NULL,
      decided_at        TIMESTAMPTZ,
      decided_by        TEXT,
      decided_via       JSONB,
      result            JSONB
    )`,
  // Who stood behind the decision when it was not the person themselves: the service client and its actor (RFC 8693 `act`).
  `ALTER TABLE claw_github_confirmations ADD COLUMN IF NOT EXISTS decided_via JSONB`,
  // What is held: a merge (approve if needed, then merge), or a review whose event, text and inline comments are kept as they were shown.
  `ALTER TABLE claw_github_confirmations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'merge'`,
  `ALTER TABLE claw_github_confirmations ADD COLUMN IF NOT EXISTS review JSONB`,
  // Tells one held review from another on the same head commit; empty for a merge.
  `ALTER TABLE claw_github_confirmations ADD COLUMN IF NOT EXISTS action_key TEXT NOT NULL DEFAULT ''`,
  // 'submitted' is the end of a held review that was posted, 'queued' the end of a merge that put the pull request in the base branch's merge queue.
  // A table made by an earlier release has a check without them (or without 'queued'), which is replaced.
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'claw_github_confirmations_status_check' AND pg_get_constraintdef(oid) LIKE '%queued%') THEN
       ALTER TABLE claw_github_confirmations DROP CONSTRAINT IF EXISTS claw_github_confirmations_status_check;
       ALTER TABLE claw_github_confirmations ADD CONSTRAINT claw_github_confirmations_status_check
         CHECK (status IN ('pending', 'merging', 'merged', 'queued', 'submitted', 'denied', 'stale', 'expired', 'refused'));
     END IF;
   END $$`,
  // One pending row per head commit and write, so asking twice shows the person one card. The index an earlier release made, on the commit alone,
  // would let a held review stand in for a merge.
  `DROP INDEX IF EXISTS uq_github_confirmations_pending`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_github_confirmations_pending_write
      ON claw_github_confirmations(session_id, repo, pr, head_sha, kind, action_key) WHERE status = 'pending'`,
  `CREATE INDEX IF NOT EXISTS idx_github_confirmations_session ON claw_github_confirmations(session_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_github_confirmations_actor ON claw_github_confirmations(actor_user_id, status)`,
  `CREATE TABLE IF NOT EXISTS claw_github_audit (
      id                  BIGSERIAL PRIMARY KEY,
      at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      requester_user_id   TEXT NOT NULL,
      actor_user_id       TEXT NOT NULL,
      session_id          TEXT NOT NULL,
      repo                TEXT NOT NULL DEFAULT '',
      pr                  INTEGER,
      head_sha            TEXT NOT NULL DEFAULT '',
      tool                TEXT NOT NULL,
      arguments           JSONB NOT NULL DEFAULT '{}'::jsonb,
      github_requests     INTEGER NOT NULL DEFAULT 0,
      github_request_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
      github_status       INTEGER,
      risk_reasons        JSONB NOT NULL DEFAULT '[]'::jsonb,
      confirmation_id     UUID,
      dry_run             BOOLEAN NOT NULL DEFAULT FALSE,
      write               BOOLEAN NOT NULL DEFAULT FALSE,
      result              TEXT NOT NULL DEFAULT 'started',
      detail              TEXT NOT NULL DEFAULT '',
      review_path         TEXT,
      review_path_reason  TEXT
    )`,
  // The acting user's review mode the call ran under (`high_risk_confirm` or `fully_auto`, their own setting in claw_github_review_settings).
  `ALTER TABLE claw_github_audit ADD COLUMN IF NOT EXISTS review_mode TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_github_audit_actor ON claw_github_audit(actor_user_id, at DESC)`,
  // One approval or merge decision at a time per acting user and pull request, across replicas (see acquireWriteLock).
  `CREATE TABLE IF NOT EXISTS claw_github_write_locks (
      lock_key    TEXT PRIMARY KEY,
      holder      TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL
    )`,
  // A person's own review mode for writes made with their GitHub account (see {@link getReviewMode}); no row is the default.
  `CREATE TABLE IF NOT EXISTS claw_github_review_settings (
      user_id      TEXT PRIMARY KEY,
      review_mode  TEXT NOT NULL CHECK (review_mode IN ('high_risk_confirm', 'fully_auto')),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  `CREATE INDEX IF NOT EXISTS idx_github_audit_session ON claw_github_audit(session_id)`,
  // What a review that was posted said, for the review item it belongs to (assistant/review-items.ts reviewRecord): its event and each inline
  // finding with the thread GitHub made for it. Written only for a review item's session; null for every other call.
  `ALTER TABLE claw_github_audit ADD COLUMN IF NOT EXISTS posted JSONB`,
];

export async function ensureGithubReviewSchema(client: pg.PoolClient): Promise<void> {
  for (const sql of GITHUB_REVIEW_SCHEMA_SQL) await client.query(sql);
}

// ---------------------------------------------------------------- write lock

/** The lock on one acting user's approvals and merges of one pull request: the key the tools and a stop of a review item share. */
export function writeLockKey(actorUserId: string, ref: { owner: string; repo: string; number: number }): string {
  return `${actorUserId}|${`${ref.owner}/${ref.repo}`.toLowerCase()}#${ref.number}`;
}

/**
 * Takes the lock on one acting user's approvals and merges of one pull request, or answers null when another call holds it. Between
 * deciding that an approval or a merge is not held and making it, another call of the same acting user on the same pull request could
 * open the hold that should have stopped it; the lock makes the two take turns. Its holder renews it while it works
 * ({@link renewWriteLock}); it lapses `ttlSeconds` after the last renewal, so a call that died does not hold it for ever.
 */
export async function acquireWriteLock(db: Queryable, key: string, ttlSeconds: number): Promise<string | null> {
  const holder = randomUUID();
  const r = await db.query(
    `INSERT INTO claw_github_write_locks (lock_key, holder, expires_at) VALUES ($1, $2, NOW() + ($3::bigint * INTERVAL '1 second'))
     ON CONFLICT (lock_key) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE claw_github_write_locks.expires_at <= NOW()
     RETURNING holder`,
    [key, holder, ttlSeconds],
  );
  return (r.rows[0] as { holder?: string } | undefined)?.holder === holder ? holder : null;
}

/** Keeps a held lock from lapsing while its call is still at work; false when it is no longer this holder's. */
export async function renewWriteLock(db: Queryable, key: string, holder: string, ttlSeconds: number): Promise<boolean> {
  const r = await db.query(
    "UPDATE claw_github_write_locks SET expires_at = NOW() + ($3::bigint * INTERVAL '1 second') WHERE lock_key = $1 AND holder = $2",
    [key, holder, ttlSeconds],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function releaseWriteLock(db: Queryable, key: string, holder: string): Promise<void> {
  await db.query("DELETE FROM claw_github_write_locks WHERE lock_key = $1 AND holder = $2", [key, holder]);
}

// ---------------------------------------------------------------- review mode

/**
 * How a person wants a held approval or merge made with their GitHub account confirmed, whoever asked: `high_risk_confirm` asks them
 * when the change needs a person, `fully_auto` only for what the repository itself requires. Their own setting, kept here by their
 * Claw user id; whether others may ask at all is the identity provider's `delegation`, not this.
 */
export type ReviewMode = "high_risk_confirm" | "fully_auto";
export const REVIEW_MODES: readonly ReviewMode[] = ["high_risk_confirm", "fully_auto"];
export const DEFAULT_REVIEW_MODE: ReviewMode = "high_risk_confirm";

/** The person's review mode; the default when they never set one. */
export async function getReviewMode(db: Queryable, userId: string): Promise<{ mode: ReviewMode; updatedAt: string | null }> {
  const r = await db.query("SELECT review_mode, updated_at FROM claw_github_review_settings WHERE user_id = $1", [userId]);
  const row = r.rows[0] as { review_mode?: string; updated_at?: Date | string } | undefined;
  if (!row || row.review_mode !== "fully_auto") return { mode: DEFAULT_REVIEW_MODE, updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null };
  return { mode: "fully_auto", updatedAt: new Date(row.updated_at as Date | string).toISOString() };
}

export async function setReviewMode(db: Queryable, userId: string, mode: ReviewMode): Promise<{ mode: ReviewMode; updatedAt: string }> {
  const r = await db.query(
    `INSERT INTO claw_github_review_settings (user_id, review_mode) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET review_mode = EXCLUDED.review_mode, updated_at = NOW()
     RETURNING review_mode, updated_at`,
    [userId, mode],
  );
  const row = r.rows[0] as { review_mode: ReviewMode; updated_at: Date | string };
  return { mode: row.review_mode, updatedAt: new Date(row.updated_at).toISOString() };
}

// ---------------------------------------------------------------- audit

export interface AuditStart {
  requesterUserId: string;
  actorUserId: string;
  sessionId: string;
  tool: string;
  /** A short summary of the arguments, never their full text and never a credential. */
  args: Record<string, unknown>;
}

export interface AuditFinish {
  repo?: string;
  pr?: number;
  headSha?: string;
  githubRequests: number;
  githubRequestIds: string[];
  githubStatus?: number;
  riskReasons?: string[];
  confirmationId?: string;
  dryRun: boolean;
  write: boolean;
  result: string;
  detail?: string;
  /** `api_diff` or `sandbox`, with why; set by the call that chose it. */
  reviewPath?: string;
  reviewPathReason?: string;
  reviewMode?: string;
  /** A posted review's record (`PostedReview`), for a review item's session only. */
  posted?: PostedReview | null;
}

/** One inline finding of a posted review: where it is, the thread GitHub opened for it (null when that could not be read) and its first words. */
export interface PostedFinding { path: string; line: number; thread_id: string | null; note: string }
/** What a posted review said, as `claw_github_audit.posted` keeps it. */
export interface PostedReview { event: string; review_id: number | null; findings: PostedFinding[] }

export async function auditStart(db: Queryable, a: AuditStart): Promise<number> {
  const r = await db.query(
    `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, tool, arguments)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [a.requesterUserId, a.actorUserId, a.sessionId, a.tool, JSON.stringify(a.args)],
  );
  return Number((r.rows[0] as { id: string | number }).id);
}

export async function auditFinish(db: Queryable, id: number, f: AuditFinish): Promise<void> {
  await db.query(
    `UPDATE claw_github_audit
        SET repo = COALESCE($2, repo), pr = COALESCE($3, pr), head_sha = COALESCE($4, head_sha),
            github_requests = $5, github_request_ids = $6::jsonb, github_status = $7,
            risk_reasons = $8::jsonb, confirmation_id = $9, dry_run = $10, write = $11,
            result = $12, detail = $13, review_path = $14, review_path_reason = $15, review_mode = COALESCE($16, review_mode),
            posted = COALESCE($17::jsonb, posted)
      WHERE id = $1`,
    [
      id, f.repo ?? null, f.pr ?? null, f.headSha ?? null, f.githubRequests, JSON.stringify(f.githubRequestIds.slice(-20)),
      f.githubStatus ?? null, JSON.stringify(f.riskReasons ?? []), f.confirmationId ?? null, f.dryRun, f.write,
      f.result, (f.detail ?? "").slice(0, 500), f.reviewPath ?? null, f.reviewPathReason ?? null, f.reviewMode ?? null,
      f.posted ? JSON.stringify(f.posted) : null,
    ],
  );
}

/** What this session has already asked of GitHub. */
export async function sessionRequestCount(db: Queryable, sessionId: string): Promise<number> {
  const r = await db.query("SELECT COALESCE(SUM(github_requests), 0)::int AS n FROM claw_github_audit WHERE session_id = $1", [sessionId]);
  return Number((r.rows[0] as { n: number }).n);
}

/**
 * Mark a call's audit row as a write on this head commit, before the write is
 * counted against the limits and before it is made. The row then counts for as long
 * as the call is in flight, and stays counted if the call dies before it can finish
 * the row; a call that ends without writing says so when it finishes the row.
 */
export async function reserveWrite(db: Queryable, id: number, headSha: string): Promise<void> {
  await db.query("UPDATE claw_github_audit SET write = TRUE, head_sha = $2 WHERE id = $1", [id, headSha]);
}

/**
 * Reviews written in the last window, by one acting user's token (`actorUserId`) or
 * by all of them (null). A review is a (session, head commit) pair that wrote, so a
 * review and the merge that follows it count once. A call in flight counts (see
 * {@link reserveWrite}), the asking call's own row included, and so does a call that
 * sent a write and was then refused (a merge that approved and found the merge state
 * not clean): the `write` flag is what says something was sent, not how the call ended.
 * `pairPresent` says whether the pair being asked about is already among them in a
 * row other than `pair.selfId`, so that the second half of a review is never refused
 * for the first half.
 */
export async function recentWrites(
  db: Queryable, actorUserId: string | null, sinceMs: number, pair?: { sessionId: string; headSha: string; selfId?: number },
): Promise<{ count: number; pairPresent: boolean }> {
  const r = await db.query(
    `SELECT COUNT(DISTINCT session_id || ':' || head_sha)::int AS n,
            COALESCE(BOOL_OR(session_id = $3 AND head_sha = $4 AND ($5::bigint IS NULL OR id <> $5)), FALSE) AS present
       FROM claw_github_audit
      WHERE write AND NOT dry_run
        AND at > NOW() - ($2::bigint * INTERVAL '1 millisecond')
        AND ($1::text IS NULL OR actor_user_id = $1)`,
    [actorUserId, sinceMs, pair?.sessionId ?? null, pair?.headSha ?? null, pair?.selfId ?? null],
  );
  const row = r.rows[0] as { n: number; present: boolean };
  return { count: Number(row.n), pairPresent: row.present === true };
}

/**
 * What this session did with one head commit of a pull request before an approval or a merge of it: whether it read it with `gh_pr_get`
 * (`read`), whether any of those reads chose the sandbox path, and whether a sub-agent of the session that was given this head commit (its
 * short form, in the first 2000 characters of its prompt that Brain's `subagentStart` keeps) used a tool, did not fail and ended after the
 * first of those reads (`secondPass`). Both events are Brain's, as the event consumer stored them; neither the model nor the pull request's
 * text can write one.
 */
export async function headReviewFacts(
  db: Queryable, sessionId: string, repo: string, pr: number, headSha: string,
): Promise<{ read: boolean; sandbox: boolean; secondPass: boolean }> {
  const r = await db.query(
    `WITH reads AS (
       SELECT MIN(at) AS first_at, COALESCE(BOOL_OR(review_path = 'sandbox'), FALSE) AS sandbox
         FROM claw_github_audit
        WHERE session_id = $1 AND tool = 'gh_pr_get' AND result = 'ok' AND lower(repo) = lower($2) AND pr = $3 AND head_sha = $4
     )
     SELECT first_at IS NOT NULL AS read, sandbox,
            EXISTS (
              SELECT 1 FROM claw_session_events ev
                JOIN claw_session_events st
                  ON st.session_id = ev.session_id AND st.event = 'subagentStart' AND st.deleted_at IS NULL
                 AND st.data->>'subagent_id' = ev.data->>'subagent_id'
               WHERE ev.session_id = $1 AND ev.event = 'subagentEnd' AND ev.deleted_at IS NULL AND ev.created_at >= reads.first_at
                 AND COALESCE(ev.data->>'failed', 'false') <> 'true'
                 AND CASE WHEN jsonb_typeof(ev.data->'tool_stats'->'total_calls') = 'number'
                          THEN (ev.data->'tool_stats'->>'total_calls')::numeric > 0 ELSE FALSE END
                 AND position(left($4, 7) IN lower(COALESCE(st.data->>'prompt', ''))) > 0
            ) AS second_pass
       FROM reads`,
    [sessionId, repo, pr, headSha],
  );
  const row = r.rows[0] as { read: boolean; sandbox: boolean; second_pass: boolean };
  return { read: row.read === true, sandbox: row.sandbox === true, secondPass: row.second_pass === true };
}

// ---------------------------------------------------------- confirmations

export type ConfirmationStatus = "pending" | "merging" | "merged" | "queued" | "submitted" | "denied" | "stale" | "expired" | "refused";

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES" | "APPROVE";
export interface ReviewComment { path: string; line: number; side: "RIGHT" | "LEFT"; body: string }
/** A review held for the acting user, as it will be posted (its footer is added when it is). */
export interface HeldReview { event: ReviewEvent; body: string; comments: ReviewComment[] }
/** What a confirmation holds: a merge (approve if needed, then merge), or a review. */
export type ConfirmationKind = "merge" | "review";

/** A digest of what a review says, its text and inline comments: the marker a posted review carries, and part of the key of a held one. */
export function reviewDigest(text: string, comments: ReviewComment[]): string {
  return createHash("sha256").update(JSON.stringify([text, comments.map((c) => [c.path, c.line, c.side, c.body])])).digest("hex").slice(0, 12);
}

function readHeldReview(value: unknown): HeldReview | null {
  const v = value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!v || !["COMMENT", "REQUEST_CHANGES", "APPROVE"].includes(String(v.event)) || typeof v.body !== "string" || !Array.isArray(v.comments)) return null;
  return { event: v.event as ReviewEvent, body: v.body, comments: v.comments as ReviewComment[] };
}

export interface Confirmation {
  id: string;
  sessionId: string;
  requesterUserId: string;
  actorUserId: string;
  repo: string;
  pr: number;
  headSha: string;
  title: string;
  author: string;
  reasons: string[];
  checks: Record<string, unknown>;
  kind: ConfirmationKind;
  /** What a `review` confirmation holds; null for a merge, and for a row that says it holds a review and does not (the decision refuses it). */
  review: HeldReview | null;
  status: ConfirmationStatus;
  createdAt: string;
  expiresAt: string;
  /** Whose decision it was (the acting user), once it was made. */
  decidedBy: string | null;
  /** Set when a service client answered for `decidedBy`: `{kind: "service", client_id, act_sub}`. Null when the person did. */
  decidedVia: Record<string, unknown> | null;
}

function toConfirmation(row: Record<string, unknown>): Confirmation {
  const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
  return {
    id: String(row.confirmation_id),
    sessionId: String(row.session_id),
    requesterUserId: String(row.requester_user_id),
    actorUserId: String(row.actor_user_id),
    repo: String(row.repo),
    pr: Number(row.pr),
    headSha: String(row.head_sha),
    title: String(row.title ?? ""),
    author: String(row.author ?? ""),
    reasons: Array.isArray(row.reasons) ? (row.reasons as string[]) : [],
    checks: (row.checks && typeof row.checks === "object" ? row.checks : {}) as Record<string, unknown>,
    kind: row.kind === "review" ? "review" : "merge",
    review: readHeldReview(row.review),
    status: row.status as ConfirmationStatus,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    decidedBy: typeof row.decided_by === "string" ? row.decided_by : null,
    decidedVia: row.decided_via && typeof row.decided_via === "object" ? (row.decided_via as Record<string, unknown>) : null,
  };
}

export interface NewConfirmation {
  sessionId: string;
  requesterUserId: string;
  actorUserId: string;
  repo: string;
  pr: number;
  headSha: string;
  title: string;
  author: string;
  kind: ConfirmationKind;
  review: HeldReview | null;
  reasons: string[];
  checks: Record<string, unknown>;
  ttlSeconds: number;
}

/** The pending confirmation for this head commit and this write, made if there is none. */
export async function openConfirmation(db: Queryable, c: NewConfirmation): Promise<Confirmation> {
  const actionKey = c.review ? `${c.review.event}:${reviewDigest(c.review.body, c.review.comments)}` : "";
  const same = `session_id = $1 AND repo = $2 AND pr = $3 AND head_sha = $4 AND kind = $5 AND action_key = $6`;
  const key = [c.sessionId, c.repo, c.pr, c.headSha, c.kind, actionKey];
  const existing = await db.query(`SELECT * FROM claw_github_confirmations WHERE ${same} AND status = 'pending' AND expires_at > NOW()`, key);
  if (existing.rows[0]) return toConfirmation(existing.rows[0] as Record<string, unknown>);
  // A pending row that ran out is closed first, or the unique index would refuse the new one.
  await db.query(`UPDATE claw_github_confirmations SET status = 'expired' WHERE ${same} AND status = 'pending' AND expires_at <= NOW()`, key);
  const inserted = await db.query(
    `INSERT INTO claw_github_confirmations
       (confirmation_id, session_id, requester_user_id, actor_user_id, repo, pr, head_sha, title, author, reasons, checks, kind, review, action_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14, NOW() + ($15::bigint * INTERVAL '1 second'))
     ON CONFLICT DO NOTHING RETURNING *`,
    [
      randomUUID(), c.sessionId, c.requesterUserId, c.actorUserId, c.repo, c.pr, c.headSha,
      c.title.slice(0, 300), c.author.slice(0, 100), JSON.stringify(c.reasons), JSON.stringify(c.checks),
      c.kind, c.review ? JSON.stringify(c.review) : null, actionKey, c.ttlSeconds,
    ],
  );
  if (inserted.rows[0]) return toConfirmation(inserted.rows[0] as Record<string, unknown>);
  // Lost a race with a concurrent identical call: theirs is the one.
  const raced = await db.query(`SELECT * FROM claw_github_confirmations WHERE ${same} AND status = 'pending'`, key);
  return toConfirmation(raced.rows[0] as Record<string, unknown>);
}

/** Confirmations still waiting for this acting user. */
export async function countPendingConfirmations(db: Queryable, actorUserId: string): Promise<number> {
  const r = await db.query(
    "SELECT COUNT(*)::int AS n FROM claw_github_confirmations WHERE actor_user_id = $1 AND status = 'pending' AND expires_at > NOW()",
    [actorUserId],
  );
  return Number((r.rows[0] as { n: number }).n);
}

/**
 * Whether an approval or a merge of this head commit, with this acting user's account, is already waiting for them, is being decided, was
 * refused by them, or was held and never answered: a later call for the same commit must not make that write without them, whatever it says of the change. GitHub's names are not
 * case sensitive, and neither is this: `amd-agi/DEMO#7` is the same pull request as `AMD-AGI/demo#7`.
 */
export async function heldOrDeniedOn(db: Queryable, actorUserId: string, repo: string, pr: number, headSha: string): Promise<"pending" | "denied" | "expired" | null> {
  const r = await db.query(
    `SELECT CASE WHEN status = 'pending' AND expires_at <= NOW() THEN 'expired' ELSE status END AS state
       FROM claw_github_confirmations
      WHERE actor_user_id = $1 AND lower(repo) = lower($2) AND pr = $3 AND head_sha = $4
        AND status IN ('pending', 'merging', 'denied', 'expired')`,
    [actorUserId, repo, pr, headSha],
  );
  const states = new Set((r.rows as Array<{ state?: string }>).map((row) => row.state));
  if (states.has("denied")) return "denied";
  // `merging` is a decision being carried out, a deny as much as an allow (claimConfirmation): until it is recorded it is still theirs.
  if (states.has("pending") || states.has("merging")) return "pending";
  // Nobody answered: the judgement that held it may be asked again until it says low, so the commit stays theirs to decide.
  return states.has("expired") ? "expired" : null;
}

export async function getConfirmation(db: Queryable, id: string): Promise<Confirmation | null> {
  const r = await db.query("SELECT * FROM claw_github_confirmations WHERE confirmation_id = $1", [id]);
  return r.rows[0] ? toConfirmation(r.rows[0] as Record<string, unknown>) : null;
}

/**
 * Confirmations a caller may see: those of the sessions they own and those that
 * ask them. Pending ones that have run out are closed on the way, so nobody is
 * shown a card that can no longer be answered.
 */
export async function listConfirmations(
  db: Queryable, callerUserId: string, filter: { sessionId?: string; status?: ConfirmationStatus },
): Promise<Confirmation[]> {
  await db.query(
    `UPDATE claw_github_confirmations SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= NOW() AND (requester_user_id = $1 OR actor_user_id = $1)`,
    [callerUserId],
  );
  const r = await db.query(
    `SELECT * FROM claw_github_confirmations
      WHERE (requester_user_id = $1 OR actor_user_id = $1)
        AND ($2::text IS NULL OR session_id = $2)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC LIMIT 50`,
    [callerUserId, filter.sessionId ?? null, filter.status ?? null],
  );
  return r.rows.map((row) => toConfirmation(row as Record<string, unknown>));
}

/** The service that answered for the acting user: its identity-provider client id and the actor the token names. */
export interface DecidedVia {
  clientId: string;
  actorSub: string;
}

export type ClaimResult =
  | { ok: true; confirmation: Confirmation }
  | { ok: false; reason: "not_found" | "not_pending" | "expired" };

/**
 * Take a pending confirmation for deciding, once. The conditional update is the
 * single-use guarantee: of two clicks, one gets the row.
 */
export async function claimConfirmation(db: Queryable, id: string, deciderUserId: string, via: DecidedVia | null = null): Promise<ClaimResult> {
  const claimed = await db.query(
    `UPDATE claw_github_confirmations
        SET status = 'merging', decided_at = NOW(), decided_by = $2, decided_via = $3::jsonb
      WHERE confirmation_id = $1 AND status = 'pending' AND expires_at > NOW() RETURNING *`,
    [id, deciderUserId, via ? JSON.stringify({ kind: "service", client_id: via.clientId, act_sub: via.actorSub }) : null],
  );
  if (claimed.rows[0]) return { ok: true, confirmation: toConfirmation(claimed.rows[0] as Record<string, unknown>) };
  const row = await getConfirmation(db, id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "pending") {
    await db.query("UPDATE claw_github_confirmations SET status = 'expired' WHERE confirmation_id = $1 AND status = 'pending'", [id]);
    return { ok: false, reason: "expired" };
  }
  return { ok: false, reason: row.status === "expired" ? "expired" : "not_pending" };
}

/**
 * Give a claimed confirmation back to the acting user, still pending, because the
 * decision could not be carried out for a reason that will pass (a limit, a rate
 * limit, the identity service being down). False when it can no longer be answered:
 * it ran out, or another pending one for the same commit was asked in the meantime.
 */
export async function reopenConfirmation(db: Queryable, id: string): Promise<boolean> {
  try {
    const r = await db.query(
      `UPDATE claw_github_confirmations
          SET status = 'pending', decided_at = NULL, decided_by = NULL, decided_via = NULL
        WHERE confirmation_id = $1 AND status = 'merging' AND expires_at > NOW() RETURNING confirmation_id`,
      [id],
    );
    return r.rows.length > 0;
  } catch (err) {
    // The unique index on pending rows: a newer confirmation for this commit stands. Anything else is not for this function to hide.
    if ((err as { code?: string })?.code === "23505") return false;
    throw err;
  }
}

export async function finishConfirmation(
  db: Queryable, id: string, status: Exclude<ConfirmationStatus, "pending" | "merging">, deciderUserId: string, result: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `UPDATE claw_github_confirmations
        SET status = $2, decided_at = COALESCE(decided_at, NOW()), decided_by = COALESCE(decided_by, $3), result = $4::jsonb
      WHERE confirmation_id = $1 AND status IN ('pending', 'merging')`,
    [id, status, deciderUserId, JSON.stringify(result)],
  );
}

/** Whether this session merged its pull request, or put it in the merge queue: by a confirmation a person allowed, or by a merge made at once. */
export async function sessionMerged(db: Queryable, sessionId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT EXISTS (SELECT 1 FROM claw_github_confirmations WHERE session_id = $1 AND status IN ('merged', 'queued'))
         OR EXISTS (SELECT 1 FROM claw_github_audit WHERE session_id = $1 AND tool = 'gh_pr_merge' AND result = 'ok' AND detail IN ('merged', 'queued'))
         AS merged`,
    [sessionId],
  );
  return (r.rows[0] as { merged?: boolean } | undefined)?.merged === true;
}

/**
 * The requester stopped this session's work: every write it holds for someone's answer is denied, so that a card left in a chat cannot
 * still make it. Run in the stop's own transaction. Answers why the stop must not go ahead instead, having denied nothing the caller
 * keeps (it rolls back): the pull request was merged (`already_merged`), or a person's allow is being carried out right now
 * (`merge_in_progress`), which the session's interrupt would not stop.
 *
 * The deny comes before the look for one being carried out: a decision that claims a row after this statement finds it denied, and one
 * that claimed it before is seen as `merging`.
 */
export async function closeConfirmationsForStop(
  db: Queryable, sessionId: string, stoppedBy: string, write: { actorUserId: string; pr: { owner: string; repo: string; number: number } },
): Promise<"already_merged" | "merge_in_progress" | null> {
  if (await sessionMerged(db, sessionId)) return "already_merged";
  // A merge or an approval the session is making right now holds this lock for as long as it works, and no confirmation says so. The
  // stop takes the lock in its own transaction, so a write that asks for it meanwhile waits for the stop and then finds the review stopped
  // (`GithubReview.oneAtATime`); one that holds it now is being made, and the stop says so instead of claiming it stopped anything.
  const key = writeLockKey(write.actorUserId, write.pr);
  const taken = await db.query(
    `INSERT INTO claw_github_write_locks (lock_key, holder, expires_at) VALUES ($1, $2, NOW() + INTERVAL '2 minutes')
     ON CONFLICT (lock_key) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
       WHERE claw_github_write_locks.expires_at <= NOW()
     RETURNING holder`,
    [key, `stop:${sessionId}`],
  );
  if (!taken.rows.length) return "merge_in_progress";
  // Released when the transaction commits; a waiter then takes it and reads the stop.
  await db.query("DELETE FROM claw_github_write_locks WHERE lock_key = $1 AND holder = $2", [key, `stop:${sessionId}`]);
  await db.query(
    `UPDATE claw_github_confirmations
        SET status = 'denied', decided_at = NOW(), decided_by = $2, result = '{"by":"requester","reason":"stopped"}'::jsonb
      WHERE session_id = $1 AND status = 'pending'`,
    [sessionId, stoppedBy],
  );
  const merging = await db.query("SELECT 1 FROM claw_github_confirmations WHERE session_id = $1 AND status = 'merging' LIMIT 1", [sessionId]);
  if (merging.rows.length > 0) return "merge_in_progress";
  // A decision that finished between the first look and the deny.
  return (await sessionMerged(db, sessionId)) ? "already_merged" : null;
}
